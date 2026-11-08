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

const baseMongoUri = process.env.MONGODB_URI;
const baseRedisUrl = process.env.REDIS_URL;
const originalPrefix = process.env.REDIS_SESSION_PREFIX;
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
    };
  } catch {
    return null;
  }
})();

describe.runIf(testConfig)('Auth HTTP with isolated MongoDB and Redis', () => {
  let app: INestApplication;
  let connection: Connection;
  let sessionClient: RedisSessionClient;
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
  });

  afterAll(async () => {
    if (inspector.isReady) {
      const keys = await inspector.keys(`${testConfig!.prefix}*`);
      if (keys.length) await inspector.del(keys);
      await inspector.close();
    }
    if (connection?.db) await connection.db.dropDatabase();
    if (app) await app.close();
    if (baseMongoUri) process.env.MONGODB_URI = baseMongoUri;
    if (originalPrefix) process.env.REDIS_SESSION_PREFIX = originalPrefix;
    else delete process.env.REDIS_SESSION_PREFIX;
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

  it('fails closed when the Redis connection is unavailable', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: body.email, password: body.password })
      .expect(200);
    const token = login.body.data.access_token as string;
    sessionClient.client.destroy();
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
      .expect(500);
    expect(failedRegistration.headers['set-cookie']).toBeUndefined();
    expect(
      await connection.db!
        .collection('usuarios')
        .findOne({ email: 'falha.redis@example.com' }),
    ).not.toBeNull();
  });
});
