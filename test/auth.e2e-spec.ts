import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { createClient } from 'redis';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http.js';
import { AppModule } from '../src/app.module.js';
import { RedisSessionClient } from '../src/auth/redis-session.client.js';
import { SessoesService } from '../src/auth/sessoes.service.js';
import { UsuariosService } from '../src/usuarios/usuarios.service.js';
import { SeguidoresService } from '../src/usuarios/seguidores.service.js';

const baseMongoUri = process.env.MONGODB_URI;
const baseRedisUrl = process.env.REDIS_URL;
const originalPrefix = process.env.REDIS_SESSION_PREFIX;
const originalRatePrefix = process.env.REDIS_CHECK_EMAIL_RATE_PREFIX;
const secret = process.env.JWT_SECRET;
const testConfig = (() => {
  if (
    !baseMongoUri ||
    !baseRedisUrl ||
    !secret ||
    Buffer.byteLength(secret) < 32
  )
    return null;
  try {
    const mongo = new URL(baseMongoUri);
    const redis = new URL(baseRedisUrl);
    if (
      mongo.protocol !== 'mongodb:' ||
      !['127.0.0.1', 'localhost'].includes(mongo.hostname)
    )
      return null;
    if (
      redis.protocol !== 'redis:' ||
      !['127.0.0.1', 'localhost'].includes(redis.hostname)
    )
      return null;
    const runId = randomBytes(8).toString('hex');
    mongo.pathname = `/ierri_auth_test_${runId}`;
    return {
      mongoUri: mongo.toString(),
      prefix: `ierri:e2e:session:${runId}:`,
      ratePrefix: `ierri:e2e:rate:check-email:${runId}:`,
    };
  } catch {
    return null;
  }
})();

describe.runIf(testConfig)('Auth HTTP with isolated MongoDB and Redis', () => {
  let app: INestApplication;
  let connection: Connection;
  let sessionClient: RedisSessionClient;
  let sessoesService: SessoesService;
  let usersService: UsuariosService;
  const inspector = createClient({ url: baseRedisUrl });
  const body = {
    name: 'Ana Integração',
    email: 'ana.integracao@example.com',
    password: 'SenhaTeste123!',
  };
  const sessionKey = (token: string) => {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString(),
    ) as { sid: string };
    return `${testConfig!.prefix}${createHash('sha256').update(payload.sid).digest('hex')}`;
  };

  beforeAll(async () => {
    process.env.MONGODB_URI = testConfig!.mongoUri;
    process.env.REDIS_SESSION_PREFIX = testConfig!.prefix;
    process.env.REDIS_CHECK_EMAIL_RATE_PREFIX = testConfig!.ratePrefix;
    inspector.on('error', () => {});
    await inspector.connect();
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    configureHttp(app);
    await app.init();
    connection = module.get<Connection>(getConnectionToken());
    sessionClient = module.get(RedisSessionClient);
    sessoesService = module.get(SessoesService);
    usersService = module.get(UsuariosService);
  });

  afterAll(async () => {
    if (app) await app.get(SeguidoresService).onModuleDestroy();
    if (inspector.isReady) {
      const keys = await inspector.keys(`${testConfig!.prefix}*`);
      if (keys.length) await inspector.del(keys);
      const rateKeys = await inspector.keys(`${testConfig!.ratePrefix}*`);
      if (rateKeys.length) await inspector.del(rateKeys);
      await inspector.close();
    }
    if (connection?.db) await connection.db.dropDatabase();
    if (app) await app.close();
    if (baseMongoUri) process.env.MONGODB_URI = baseMongoUri;
    if (originalPrefix) process.env.REDIS_SESSION_PREFIX = originalPrefix;
    else delete process.env.REDIS_SESSION_PREFIX;
    if (originalRatePrefix)
      process.env.REDIS_CHECK_EMAIL_RATE_PREFIX = originalRatePrefix;
    else delete process.env.REDIS_CHECK_EMAIL_RATE_PREFIX;
  });

  it('allows anonymous public reads with a stale cookie only', async () => {
    const cookie = 'ierri_session=invalid';
    await request(app.getHttpServer()).get('/publicacoes')
      .set('Cookie', cookie).expect(200);
    await request(app.getHttpServer()).get('/publicacoes')
      .set('Authorization', 'Bearer invalid').expect(401);
    await request(app.getHttpServer()).get('/auth/me')
      .set('Cookie', cookie).expect(401);
  });

  it('persists users in MongoDB and expiring sessions in Redis', async () => {
    const agent = request.agent(app.getHttpServer());
    const registered = await agent
      .post('/auth/register')
      .send(body)
      .expect(201);
    const token = registered.body.data.access_token as string;
    const user = await connection
      .db!.collection('usuarios')
      .findOne({ email: body.email });
    expect(user).not.toBeNull();
    expect(await inspector.get(sessionKey(token))).toBe(user?._id.toString());
    const ttl = await inspector.pTTL(sessionKey(token));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900_000);
    expect(await inspector.get(sessionKey(token))).not.toContain(token);
    await agent.get('/auth/me').expect(200);
    expect(await inspector.pTTL(sessionKey(token))).toBeLessThanOrEqual(ttl);
  });

  it('creates a login session, revokes it and rejects token reuse', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: body.email, password: body.password })
      .expect(200);
    const token = login.body.data.access_token as string;
    expect(await inspector.get(sessionKey(token))).toBeTypeOf('string');
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    expect(await inspector.get(sessionKey(token))).toBeNull();
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
  });

  it('rejects missing, expired and foreign-user sessions', async () => {
    const login = async () =>
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: body.email, password: body.password })
          .expect(200)
      ).body.data.access_token as string;
    const me = (token: string) =>
      request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);

    const missing = await login();
    await inspector.del(sessionKey(missing));
    await me(missing).expect(401);

    const expired = await login();
    await inspector.pExpire(sessionKey(expired), 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await me(expired).expect(401);

    const foreign = await login();
    const otherUser = new Types.ObjectId().toString();
    await inspector.set(sessionKey(foreign), otherUser, { PX: 60_000 });
    await me(foreign).expect(401);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${foreign}`)
      .send({})
      .expect(200);
    expect(await inspector.get(sessionKey(foreign))).toBe(otherUser);
  });

  it('keeps public validation and invalid-login behavior', async () => {
    await request(app.getHttpServer())
      .post('/auth/check-email')
      .send({ email: body.email })
      .expect(200);
    const count = (await inspector.keys(`${testConfig!.prefix}*`)).length;
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: body.email, password: 'wrong' })
      .expect(401);
    expect((await inspector.keys(`${testConfig!.prefix}*`)).length).toBe(count);
    const invalid = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'invalid', password: '' })
      .expect(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    await request(app.getHttpServer()).get('/auth/me').expect(401);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({})
      .expect(200);
  });

  it('allows login after a registration session write fails', async () => {
    const email = 'sessao.indisponivel@example.com';
    const set = vi
      .spyOn(sessionClient.client, 'set')
      .mockRejectedValueOnce(new Error('connection lost'));
    try {
      const failedRegistration = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ ...body, email })
        .expect(503);
      expect(failedRegistration.body).toEqual({
        success: false,
        error: {
          code: 'REGISTRATION_COMPLETED_SESSION_UNAVAILABLE',
          message:
            'Sua conta foi criada, mas não foi possível iniciar a sessão. Tente entrar novamente quando o serviço estiver disponível.',
          details: [],
        },
      });
      expect(failedRegistration.headers['set-cookie']).toBeUndefined();
      expect(JSON.stringify(failedRegistration.body)).not.toContain(
        'access_token',
      );
    } finally {
      set.mockRestore();
    }
    const user = await connection.db!.collection('usuarios').findOne({ email });
    expect(user).not.toBeNull();
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: body.password })
      .expect(200);
    expect(await inspector.get(sessionKey(login.body.data.access_token))).toBe(
      user?._id.toString(),
    );
  });

  it('limits check-email atomically without changing authentication sessions', async () => {
    const clearRateKeys = async () => {
      const keys = await inspector.keys(`${testConfig!.ratePrefix}*`);
      if (keys.length) await inspector.del(keys);
    };
    await clearRateKeys();

    for (let index = 0; index < 30; index++) {
      await request(app.getHttpServer())
        .post('/auth/check-email')
        .send({ email: `lookup${index}@example.com` })
        .expect(404);
    }
    const originLimited = await request(app.getHttpServer())
      .post('/auth/check-email')
      .send({ email: 'lookup30@example.com' })
      .expect(429);
    expect(originLimited.body.error.code).toBe('CHECK_EMAIL_RATE_LIMITED');
    expect(Number(originLimited.headers['retry-after'])).toBeGreaterThan(0);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: body.email, password: body.password })
      .expect(200);
    expect(
      await inspector.get(sessionKey(login.body.data.access_token)),
    ).not.toBeNull();

    await clearRateKeys();
    for (let index = 0; index < 10; index++) {
      await request(app.getHttpServer())
        .post('/auth/check-email')
        .send({
          email: index % 2 ? 'REPEATED@EXAMPLE.COM' : 'repeated@example.com',
        })
        .expect(404);
    }
    const emailLimited = await request(app.getHttpServer())
      .post('/auth/check-email')
      .send({ email: 'repeated@example.com' })
      .expect(429);
    expect(emailLimited.body.error.code).toBe('CHECK_EMAIL_RATE_LIMITED');
    expect(Number(emailLimited.headers['retry-after'])).toBeGreaterThan(0);
    const keys = await inspector.keys(`${testConfig!.ratePrefix}*`);
    expect(keys).toHaveLength(2);
    expect(keys.join('')).not.toContain('repeated@example.com');
    for (const key of keys) {
      expect(await inspector.pTTL(key)).toBeGreaterThan(0);
      await inspector.pExpire(key, 0);
    }
    await request(app.getHttpServer())
      .post('/auth/check-email')
      .send({ email: 'repeated@example.com' })
      .expect(404);
  });

  it.each(['bloqueado', 'excluido'] as const)(
    'denies new login and existing access after an account becomes %s while preserving logout',
    async (status) => {
      const agent = request.agent(app.getHttpServer());
      const email = `status-${status}@example.com`;
      const registered = await agent.post('/auth/register')
        .send({ ...body, email }).expect(201);
      const token = registered.body.data.access_token as string;
      const userId = new Types.ObjectId(registered.body.data.user.id as string);
      expect(await inspector.get(sessionKey(token))).toBe(userId.toString());
      await connection.db!.collection('usuarios').updateOne(
        { _id: userId },
        { $set: {
          status,
          excluido_em: status === 'excluido' ? new Date() : null,
        } },
      );
      const createSession = vi.spyOn(sessoesService, 'create');
      let deniedLogin;
      try {
        deniedLogin = await request(app.getHttpServer()).post('/auth/login')
          .send({ email, password: body.password }).expect(401);
        expect(createSession).not.toHaveBeenCalled();
      } finally {
        createSession.mockRestore();
      }
      expect(deniedLogin.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(deniedLogin.headers['set-cookie']).toBeUndefined();
      expect(JSON.stringify(deniedLogin.body)).not.toContain('access_token');
      expect(await inspector.get(sessionKey(token))).toBe(userId.toString());
      for (const path of ['/auth/me', '/usuarios/me', '/publicacoes']) {
        const denied = await request(app.getHttpServer()).get(path)
          .set('Authorization', `Bearer ${token}`).expect(401);
        expect(denied.body.error.code).toBe('INVALID_TOKEN');
      }
      for (const path of ['/publicacoes', '/tecnologias', '/'])
        await request(app.getHttpServer()).get(path).expect(200);
      const deniedOptional = await agent.get('/publicacoes').expect(401);
      expect(deniedOptional.body.error.code).toBe('INVALID_TOKEN');
      for (const operation of [
        () => agent.patch('/usuarios/me').send({ nome: 'Novo nome' }),
        () => agent.put('/usuarios/me/stacks').send({ stackIds: [] }),
        () => agent.post('/publicacoes').send({ conteudo: 'Texto' }),
        () => agent.post(`/publicacoes/${new Types.ObjectId().toString()}/comentarios`).send({ conteudo: 'Texto' }),
        () => agent.put(`/publicacoes/${new Types.ObjectId().toString()}/voto`).send({ valor: 1 }),
        () => agent.post('/publicacoes/midias'),
      ]) await operation().expect(401);
      const logout = await agent.post('/auth/logout').send({}).expect(200);
      expect(logout.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970');
      expect(await inspector.get(sessionKey(token))).toBeNull();
    },
  );

  it('rejects a legacy account without persisted status', async () => {
    const email = 'legacy-status-auth@example.com';
    const registered = await request(app.getHttpServer()).post('/auth/register')
      .send({ ...body, email }).expect(201);
    const token = registered.body.data.access_token as string;
    await connection.db!.collection('usuarios').updateOne(
      { _id: new Types.ObjectId(registered.body.data.user.id as string) },
      { $unset: { status: '' } },
    );
    await request(app.getHttpServer()).get('/auth/me')
      .set('Authorization', `Bearer ${token}`).expect(401);
    const login = await request(app.getHttpServer()).post('/auth/login')
      .send({ email, password: body.password }).expect(401);
    expect(login.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(login.headers['set-cookie']).toBeUndefined();
  });

  it('returns 503 if the MongoDB status check fails and restores access afterward', async () => {
    const login = await request(app.getHttpServer()).post('/auth/login')
      .send({ email: body.email, password: body.password }).expect(200);
    const token = login.body.data.access_token as string;
    const statusCheck = vi.spyOn(usersService, 'hasActiveStatus')
      .mockRejectedValueOnce(new Error('MongoDB unavailable'));
    try {
      const failed = await request(app.getHttpServer()).get('/auth/me')
        .set('Authorization', `Bearer ${token}`).expect(503);
      expect(failed.body.error.code).toBe('AUTH_STATUS_UNAVAILABLE');
      expect(JSON.stringify(failed.body)).not.toContain('MongoDB unavailable');
    } finally {
      statusCheck.mockRestore();
    }
    await request(app.getHttpServer()).get('/auth/me')
      .set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('fails closed when the Redis connection is unavailable', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: body.email, password: body.password })
      .expect(200);
    const token = login.body.data.access_token as string;
    sessionClient.client.destroy();
    const failedCheckEmail = await request(app.getHttpServer())
      .post('/auth/check-email')
      .send({ email: body.email })
      .expect(503);
    expect(failedCheckEmail.body.error.code).toBe(
      'CHECK_EMAIL_RATE_LIMIT_UNAVAILABLE',
    );
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(500);
    const failedLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: body.email, password: body.password })
      .expect(500);
    expect(failedLogin.headers['set-cookie']).toBeUndefined();
    const failedLogout = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(500);
    expect(failedLogout.headers['set-cookie']).toBeUndefined();
    const failedRegistration = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...body, email: 'falha.redis@example.com' })
      .expect(503);
    expect(failedRegistration.body.error.code).toBe(
      'REGISTRATION_COMPLETED_SESSION_UNAVAILABLE',
    );
    expect(failedRegistration.headers['set-cookie']).toBeUndefined();
    expect(JSON.stringify(failedRegistration.body)).not.toContain(
      'access_token',
    );
    expect(
      await connection
        .db!.collection('usuarios')
        .findOne({ email: 'falha.redis@example.com' }),
    ).not.toBeNull();
  });
});
