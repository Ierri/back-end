import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { createClient } from 'redis';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureHttp } from '../src/common/http/configure-http.js';
import { PerfilUpdateService } from '../src/usuarios/perfil-update.service.js';
import { UsuariosStacksService } from '../src/usuarios/stacks.service.js';

const baseMongoUri = process.env.MONGODB_URI;
const baseRedisUrl = process.env.REDIS_URL;
const originalSessionPrefix = process.env.REDIS_SESSION_PREFIX;
const originalRatePrefix = process.env.REDIS_CHECK_EMAIL_RATE_PREFIX;
const secret = process.env.JWT_SECRET;
const config = (() => {
  if (!baseMongoUri || !baseRedisUrl || !secret || Buffer.byteLength(secret) < 32) return null;
  try {
    const mongo = new URL(baseMongoUri);
    const redis = new URL(baseRedisUrl);
    if (
      mongo.protocol !== 'mongodb:' ||
      redis.protocol !== 'redis:' ||
      !['127.0.0.1', 'localhost'].includes(mongo.hostname) ||
      !['127.0.0.1', 'localhost'].includes(redis.hostname)
    ) return null;
    const runId = randomBytes(8).toString('hex');
    mongo.pathname = `/ierri_perfis_test_${runId}`;
    return {
      mongoUri: mongo.toString(),
      sessionPrefix: `ierri:e2e:perfis:session:${runId}:`,
      ratePrefix: `ierri:e2e:perfis:rate:${runId}:`,
    };
  } catch {
    return null;
  }
})();

describe.runIf(config)('perfis e stacks com MongoDB e Redis locais', () => {
  let app: INestApplication;
  let connection: Connection;
  let inspector: ReturnType<typeof createClient>;
  let aliceToken: string;
  let bobToken: string;
  let aliceId: string;
  let bobId: string;
  let aliceUsername: string;
  let bobUsername: string;
  const technologies = Array.from({ length: 22 }, (_, index) => ({
    _id: new Types.ObjectId(),
    nome: `Tech ${String(index + 1).padStart(2, '0')}`,
    slug: `tech-${String(index + 1).padStart(2, '0')}`,
    categoria: 'Teste',
    icone_url: null,
    ativo: true,
  }));
  const inactive = {
    _id: new Types.ObjectId(),
    nome: 'Tech Inativa',
    slug: 'tech-inativa',
    categoria: 'Teste',
    icone_url: null,
    ativo: false,
  };
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sessionKey = (token: string) => {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { sid: string };
    return `${config!.sessionPrefix}${createHash('sha256').update(payload.sid).digest('hex')}`;
  };

  beforeAll(async () => {
    process.env.MONGODB_URI = config!.mongoUri;
    process.env.REDIS_SESSION_PREFIX = config!.sessionPrefix;
    process.env.REDIS_CHECK_EMAIL_RATE_PREFIX = config!.ratePrefix;
    inspector = createClient({ url: baseRedisUrl });
    inspector.on('error', () => {});
    await inspector.connect();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureHttp(app);
    await app.init();
    connection = module.get<Connection>(getConnectionToken());
    await Promise.all([
      connection.model('Usuario').init(),
      connection.model('Tecnologia').init(),
    ]);
    await connection.db!.collection('tecnologias').insertMany([...technologies, inactive]);

    const alice = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Ana Integração', email: 'ana.perfis@example.test', password: 'SenhaTeste123!' })
      .expect(201);
    const bob = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Bruno Teste', email: 'bruno.perfis@example.test', password: 'SenhaTeste123!' })
      .expect(201);
    aliceToken = alice.body.data.access_token as string;
    bobToken = bob.body.data.access_token as string;
    aliceId = alice.body.data.user.id as string;
    bobId = bob.body.data.user.id as string;
    aliceUsername = alice.body.data.user.username as string;
    bobUsername = bob.body.data.user.username as string;
  });

  afterAll(async () => {
    if (inspector?.isReady) {
      const sessionKeys = await inspector.keys(`${config!.sessionPrefix}*`);
      if (sessionKeys.length) await inspector.del(sessionKeys);
      const rateKeys = await inspector.keys(`${config!.ratePrefix}*`);
      if (rateKeys.length) await inspector.del(rateKeys);
      await inspector.close();
    }
    if (connection?.db) await connection.db.dropDatabase();
    if (app) await app.close();
    if (baseMongoUri) process.env.MONGODB_URI = baseMongoUri;
    if (originalSessionPrefix) process.env.REDIS_SESSION_PREFIX = originalSessionPrefix;
    else delete process.env.REDIS_SESSION_PREFIX;
    if (originalRatePrefix) process.env.REDIS_CHECK_EMAIL_RATE_PREFIX = originalRatePrefix;
    else delete process.env.REDIS_CHECK_EMAIL_RATE_PREFIX;
  });

  it('lists only active technologies with bounded cursor pagination and name or slug search', async () => {
    const first = await request(app.getHttpServer()).get('/tecnologias?limite=10').expect(200);
    expect(first.body.data.items).toHaveLength(10);
    expect(first.body.data.hasMore).toBe(true);
    expect(first.body.data.nextCursor).toBeTypeOf('string');
    expect(first.body.data.items[0]).toEqual({
      id: technologies[0]._id.toString(),
      nome: 'Tech 01',
      slug: 'tech-01',
      categoria: 'Teste',
      iconeUrl: null,
    });
    expect(first.body.data.items[0]).not.toHaveProperty('ativo');
    const second = await request(app.getHttpServer())
      .get('/tecnologias')
      .query({ limite: '10', cursor: first.body.data.nextCursor as string })
      .expect(200);
    expect(second.body.data.items).toHaveLength(10);
    expect(new Set([...first.body.data.items, ...second.body.data.items].map((item: { id: string }) => item.id)).size).toBe(20);
    const byName = await request(app.getHttpServer()).get('/tecnologias?busca=Tech%2001').expect(200);
    expect(byName.body.data.items.map((item: { slug: string }) => item.slug)).toEqual(['tech-01']);
    const bySlug = await request(app.getHttpServer()).get('/tecnologias?busca=tech-0').expect(200);
    expect(bySlug.body.data.items).toHaveLength(9);
    expect(bySlug.body.data.items.every((item: { slug: string }) => item.slug !== inactive.slug)).toBe(true);
  });

  it('rejects unbounded or malformed catalogue queries and mismatched cursors', async () => {
    await request(app.getHttpServer()).get('/tecnologias?limite=51').expect(400);
    await request(app.getHttpServer()).get('/tecnologias?extra=1').expect(400);
    await request(app.getHttpServer()).get('/tecnologias?cursor=invalid').expect(400);
    const first = await request(app.getHttpServer()).get('/tecnologias?limite=1&busca=tech').expect(200);
    await request(app.getHttpServer())
      .get('/tecnologias')
      .query({ limite: '1', busca: 'figma', cursor: first.body.data.nextCursor as string })
      .expect(400);
  });

  it('replaces stacks atomically, preserves their order and accepts an empty list', async () => {
    const stackIds = [technologies[1]._id.toString(), technologies[0]._id.toString()];
    const updated = await request(app.getHttpServer())
      .put('/usuarios/me/stacks')
      .set(auth(aliceToken))
      .send({ stackIds })
      .expect(200);
    expect(updated.body.data.stackIds).toEqual(stackIds);
    const me = await request(app.getHttpServer()).get('/usuarios/me').set(auth(aliceToken)).expect(200);
    expect(me.body.data.stackIds).toEqual(stackIds);
    expect(me.body.data.stacks.map((item: { id: string }) => item.id)).toEqual(stackIds);
    expect(me.body.data.email).toBe('ana.perfis@example.test');
    await request(app.getHttpServer())
      .put('/usuarios/me/stacks')
      .set(auth(aliceToken))
      .send({ stackIds: [] })
      .expect(200);
    expect((await connection.db!.collection('usuarios').findOne({ _id: new Types.ObjectId(aliceId) }))?.stack_ids).toEqual([]);
  });

  it('accepts twenty stacks and rejects duplicates, invalid, missing, inactive or excessive selections without partial writes', async () => {
    const twenty = technologies.slice(0, 20).map((item) => item._id.toString());
    await request(app.getHttpServer())
      .put('/usuarios/me/stacks').set(auth(aliceToken)).send({ stackIds: twenty }).expect(200);
    const attempts = [
      { stackIds: [twenty[0], twenty[0]], status: 400 },
      { stackIds: ['invalid'], status: 400 },
      { stackIds: [new Types.ObjectId().toString()], status: 422 },
      { stackIds: [inactive._id.toString()], status: 422 },
      { stackIds: technologies.slice(0, 21).map((item) => item._id.toString()), status: 400 },
    ];
    for (const attempt of attempts) {
      await request(app.getHttpServer())
        .put('/usuarios/me/stacks').set(auth(aliceToken)).send({ stackIds: attempt.stackIds }).expect(attempt.status);
    }
    const stored = await connection.db!.collection('usuarios').findOne({ _id: new Types.ObjectId(aliceId) });
    expect(stored?.stack_ids.map((id: Types.ObjectId) => id.toString())).toEqual(twenty);
  });

  it('preserves an inactive historical stack while blocking its reselection', async () => {
    const id = technologies[0]._id;
    const collection = connection.db!.collection('tecnologias');
    try {
      await collection.updateOne({ _id: id }, { $set: { ativo: false } });
      const own = await request(app.getHttpServer()).get('/usuarios/me').set(auth(aliceToken)).expect(200);
      expect(own.body.data.stacks.map((item: { id: string }) => item.id)).toContain(id.toString());
      await request(app.getHttpServer())
        .put('/usuarios/me/stacks')
        .set(auth(aliceToken))
        .send({ stackIds: own.body.data.stackIds })
        .expect(422);
      const stored = await connection.db!.collection('usuarios').findOne({ _id: new Types.ObjectId(aliceId) });
      expect(stored?.stack_ids.map((item: Types.ObjectId) => item.toString())).toContain(id.toString());
    } finally {
      await collection.updateOne({ _id: id }, { $set: { ativo: true } });
    }
  });

  it('requires a live JWT and Redis session for profile changes', async () => {
    await request(app.getHttpServer()).get('/usuarios/me').expect(401);
    await request(app.getHttpServer()).patch('/usuarios/me').send({ nome: 'Indevido' }).expect(401);
    await request(app.getHttpServer()).put('/usuarios/me/stacks').send({ stackIds: [] }).expect(401);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ana.perfis@example.test', password: 'SenhaTeste123!' })
      .expect(200);
    const token = login.body.data.access_token as string;
    await inspector.del(sessionKey(token));
    await request(app.getHttpServer()).get('/usuarios/me').set(auth(token)).expect(401);
    await request(app.getHttpServer()).patch('/usuarios/me').set(auth(token)).send({ nome: 'Indevido' }).expect(401);
    await request(app.getHttpServer()).put('/usuarios/me/stacks').set(auth(token)).send({ stackIds: [] }).expect(401);
    await request(app.getHttpServer()).get(`/usuarios/${aliceUsername}`).set(auth('invalid')).expect(401);
  });

  it('updates only permitted profile fields, normalizes username and clears optional fields explicitly', async () => {
    await connection.db!.collection('usuarios').updateOne(
      { _id: new Types.ObjectId(aliceId) },
      { $set: { atualizado_em: new Date('2000-01-01T00:00:00Z') } },
    );
    const before = await connection.db!.collection('usuarios').findOne({ _id: new Types.ObjectId(aliceId) });
    const result = await request(app.getHttpServer())
      .patch('/usuarios/me')
      .set(auth(aliceToken))
      .send({
        nome: '  Ana Atualizada  ',
        username: '  ANA_NOVA  ',
        biografia: '  Design e interfaces  ',
        avatarUrl: '/brand/ierri/social/github-avatar-512.png',
        visibilidadePerfil: 'privado',
      })
      .expect(200);
    expect(result.body.data).toMatchObject({
      nome: 'Ana Atualizada',
      username: 'ana_nova',
      biografia: 'Design e interfaces',
      avatarUrl: '/brand/ierri/social/github-avatar-512.png',
      visibilidadePerfil: 'privado',
    });
    expect(result.body.data.criadoEm).toBe(new Date(before!.criado_em as Date).toISOString());
    expect(new Date(result.body.data.atualizadoEm as string).getTime()).toBeGreaterThan(new Date('2000-01-01T00:00:00Z').getTime());
    aliceUsername = 'ana_nova';
    const cleared = await request(app.getHttpServer())
      .patch('/usuarios/me')
      .set(auth(aliceToken))
      .send({ biografia: null, avatarUrl: null })
      .expect(200);
    expect(cleared.body.data.biografia).toBeNull();
    expect(cleared.body.data.avatarUrl).toBeNull();
  });

  it('returns 409 for username conflicts and rejects mass assignment or unsafe avatars', async () => {
    await request(app.getHttpServer())
      .patch('/usuarios/me').set(auth(aliceToken)).send({ username: bobUsername }).expect(409);
    for (const body of [
      {},
      { email: 'alterado@example.test' },
      { papeis: ['administrador'] },
      { status: 'ativo' },
      { contadores: { seguidores: 999 } },
      { avatarUrl: 'https://example.test/avatar.png' },
      { avatarUrl: '/brand/ierri/../segredo.png' },
    ]) await request(app.getHttpServer()).patch('/usuarios/me').set(auth(aliceToken)).send(body).expect(400);
    const me = await request(app.getHttpServer()).get('/usuarios/me').set(auth(aliceToken)).expect(200);
    expect(me.body.data.email).toBe('ana.perfis@example.test');
    expect(me.body.data.username).toBe(aliceUsername);
    expect(me.body.data).not.toHaveProperty('papeis');
    expect(me.body.data).not.toHaveProperty('senha_hash');
  });

  it('shows public profiles without secrets and hides private fields from third parties', async () => {
    const bobStack = [technologies[2]._id.toString()];
    await request(app.getHttpServer()).put('/usuarios/me/stacks').set(auth(bobToken)).send({ stackIds: bobStack }).expect(200);
    await request(app.getHttpServer()).patch('/usuarios/me').set(auth(bobToken)).send({ biografia: 'Perfil público' }).expect(200);
    const publicBob = await request(app.getHttpServer()).get(`/usuarios/${bobUsername}`).expect(200);
    expect(publicBob.body.data).toMatchObject({ id: bobId, biografia: 'Perfil público' });
    expect(publicBob.body.data.stacks.map((item: { id: string }) => item.id)).toEqual(bobStack);
    for (const field of ['email', 'senha_hash', 'papeis', 'status', 'contadores']) {
      expect(publicBob.body.data).not.toHaveProperty(field);
    }
    const privateAlice = await request(app.getHttpServer()).get(`/usuarios/${aliceUsername}`).set(auth(bobToken)).expect(200);
    expect(privateAlice.body.data).toEqual({ id: aliceId, nome: 'Ana Atualizada', username: aliceUsername, avatarUrl: null, visibilidadePerfil: 'privado' });
    const ownPublic = await request(app.getHttpServer()).get(`/usuarios/${aliceUsername}`).set(auth(aliceToken)).expect(200);
    expect(ownPublic.body.data.stacks).toHaveLength(20);
    expect(ownPublic.body.data).not.toHaveProperty('email');
    const ownMe = await request(app.getHttpServer()).get('/usuarios/me').set(auth(aliceToken)).expect(200);
    expect(ownMe.body.data.email).toBe('ana.perfis@example.test');
    await request(app.getHttpServer()).get('/auth/me').set(auth(aliceToken)).expect(200);
    await request(app.getHttpServer()).get('/publicacoes').expect(200);
  });

  it('does not expose blocked, deleted or nonexistent profiles publicly', async () => {
    await request(app.getHttpServer()).get('/usuarios/nao_existe').expect(404);
    const users = connection.db!.collection('usuarios');
    try {
      await users.updateOne({ _id: new Types.ObjectId(bobId) }, { $set: { status: 'bloqueado' } });
      await request(app.getHttpServer()).get(`/usuarios/${bobUsername}`).expect(404);
      await users.updateOne({ _id: new Types.ObjectId(bobId) }, { $set: { status: 'excluido', excluido_em: new Date() } });
      await request(app.getHttpServer()).get(`/usuarios/${bobUsername}`).expect(404);
    } finally {
      await users.updateOne({ _id: new Types.ObjectId(bobId) }, { $set: { status: 'ativo', excluido_em: null } });
    }
  });

  it('reads legacy users whose social fields are absent', async () => {
    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'A', email: 'legado.perfis@example.test', password: 'SenhaTeste123!' })
      .expect(201);
    const token = registered.body.data.access_token as string;
    const id = new Types.ObjectId(registered.body.data.user.id as string);
    const username = registered.body.data.user.username as string;
    expect(username).toBe('a');
    await connection.db!.collection('usuarios').updateOne(
      { _id: id },
      { $unset: { stack_ids: '', visibilidade_perfil: '', status: '', contadores: '', atualizado_em: '' } },
    );
    const me = await request(app.getHttpServer()).get('/usuarios/me').set(auth(token)).expect(401);
    expect(me.body.error.code).toBe('INVALID_TOKEN');
    const publicProfile = await request(app.getHttpServer()).get(`/usuarios/${username}`).expect(200);
    expect(publicProfile.body.data.stacks).toEqual([]);
    expect(publicProfile.body.data).not.toHaveProperty('email');
  });

  it('blocks a profile write when account status changes after the guard check', async () => {
    const registered = await request(app.getHttpServer()).post('/auth/register')
      .send({ name: 'Race Profile', email: 'race.profile@example.test', password: 'SenhaTeste123!' }).expect(201);
    const userId = new Types.ObjectId(registered.body.data.user.id as string);
    const service = app.get(PerfilUpdateService);
    const original = service.update.bind(service);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(service, 'update').mockImplementation(async (id, dto) => {
      await pending;
      return original(id, dto);
    });
    try {
      const response = request(app.getHttpServer()).patch('/usuarios/me')
        .set(auth(registered.body.data.access_token as string))
        .send({ nome: 'Nome indevido' }).then((result) => result);
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce(), { timeout: 5000 });
      await connection.db!.collection('usuarios').updateOne(
        { _id: userId }, { $set: { status: 'bloqueado' } },
      );
      release();
      expect((await response).status).toBe(404);
      const stored = await connection.db!.collection('usuarios').findOne({ _id: userId });
      expect(stored?.nome).toBe('Race Profile');
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('blocks a stack replacement when account status changes after the guard check', async () => {
    const registered = await request(app.getHttpServer()).post('/auth/register')
      .send({ name: 'Race Stack', email: 'race.stack@example.test', password: 'SenhaTeste123!' }).expect(201);
    const userId = new Types.ObjectId(registered.body.data.user.id as string);
    const service = app.get(UsuariosStacksService);
    const original = service.replace.bind(service);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(service, 'replace').mockImplementation(async (id, stackIds) => {
      await pending;
      return original(id, stackIds);
    });
    try {
      const response = request(app.getHttpServer()).put('/usuarios/me/stacks')
        .set(auth(registered.body.data.access_token as string))
        .send({ stackIds: [technologies[0]._id.toString()] }).then((result) => result);
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce(), { timeout: 5000 });
      await connection.db!.collection('usuarios').updateOne(
        { _id: userId }, { $set: { status: 'bloqueado' } },
      );
      release();
      expect((await response).status).toBe(401);
      const stored = await connection.db!.collection('usuarios').findOne({ _id: userId });
      expect(stored?.stack_ids).toEqual([]);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('arbitrates concurrent username claims and never combines competing stack replacements', async () => {
    const sameUsername = 'disputado_perfis';
    const results = await Promise.all([
      request(app.getHttpServer()).patch('/usuarios/me').set(auth(aliceToken)).send({ username: sameUsername }),
      request(app.getHttpServer()).patch('/usuarios/me').set(auth(bobToken)).send({ username: sameUsername }),
    ]);
    expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect(await connection.db!.collection('usuarios').countDocuments({ username: sameUsername })).toBe(1);
    const first = [technologies[0]._id.toString(), technologies[1]._id.toString()];
    const second = [technologies[2]._id.toString(), technologies[3]._id.toString()];
    const writes = await Promise.all([
      request(app.getHttpServer()).put('/usuarios/me/stacks').set(auth(aliceToken)).send({ stackIds: first }),
      request(app.getHttpServer()).put('/usuarios/me/stacks').set(auth(aliceToken)).send({ stackIds: second }),
    ]);
    expect(writes.map((result) => result.status)).toEqual([200, 200]);
    const stored = await connection.db!.collection('usuarios').findOne({ _id: new Types.ObjectId(aliceId) });
    const finalIds = stored?.stack_ids.map((id: Types.ObjectId) => id.toString());
    expect([first, second]).toContainEqual(finalIds);
  });
});
