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
import { SeguidoresService } from '../src/usuarios/seguidores.service.js';

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
    mongo.pathname = `/ierri_seguidores_test_${runId}`;
    return {
      mongoUri: mongo.toString(),
      sessionPrefix: `ierri:e2e:seguidores:session:${runId}:`,
      ratePrefix: `ierri:e2e:seguidores:rate:${runId}:`,
    };
  } catch {
    return null;
  }
})();

type Account = { id: string; username: string; token: string };
type ListedUser = { id: string; nome: string; username: string; avatarUrl: string | null; visibilidadePerfil: string };

describe.runIf(config)('seguidores com MongoDB e Redis locais', () => {
  let app: INestApplication;
  let connection: Connection;
  let inspector: ReturnType<typeof createClient>;
  let alice: Account;
  let bob: Account;
  let carla: Account;
  let davi: Account;
  let eva: Account;
  const auth = (account: Account) => ({ Authorization: `Bearer ${account.token}` });
  const users = () => connection.db!.collection('usuarios');
  const followers = () => connection.db!.collection('seguidores');
  const pair = (from: Account, to: Account) => ({
    seguidor_id: new Types.ObjectId(from.id),
    seguido_id: new Types.ObjectId(to.id),
  });
  const sessionKey = (token: string) => {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { sid: string };
    return `${config!.sessionPrefix}${createHash('sha256').update(payload.sid).digest('hex')}`;
  };
  const register = async (name: string, email: string): Promise<Account> => {
    const result = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name, email, password: 'SenhaTeste123!' })
      .expect(201);
    return {
      id: result.body.data.user.id as string,
      username: result.body.data.user.username as string,
      token: result.body.data.access_token as string,
    };
  };
  const follow = (from: Account, to: Account) => request(app.getHttpServer())
    .put(`/usuarios/${to.id}/seguir`).set(auth(from));
  const unfollow = (from: Account, to: Account) => request(app.getHttpServer())
    .delete(`/usuarios/${to.id}/seguir`).set(auth(from));
  const privateProfile = (account: Account) => request(app.getHttpServer())
    .patch('/usuarios/me').set(auth(account)).send({ visibilidadePerfil: 'privado' });
  const ownCounts = async (account: Account) => {
    const result = await request(app.getHttpServer()).get('/usuarios/me').set(auth(account)).expect(200);
    return result.body.data.contadores as { seguidores: number; seguindo: number };
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
    await Promise.all([connection.model('Usuario').init(), connection.model('Seguidor').init()]);
    [alice, bob, carla, davi, eva] = await Promise.all([
      register('Alice Seguidora', 'alice.seguidores@example.test'),
      register('Bob Seguido', 'bob.seguidores@example.test'),
      register('Carla Teste', 'carla.seguidores@example.test'),
      register('Davi Teste', 'davi.seguidores@example.test'),
      register('Eva Teste', 'eva.seguidores@example.test'),
    ]);
  });

  beforeEach(async () => {
    await followers().deleteMany({});
    await users().updateMany({}, {
      $set: {
        status: 'ativo',
        excluido_em: null,
        visibilidade_perfil: 'publico',
        'contadores.seguidores': 0,
        'contadores.seguindo': 0,
      },
    });
  });

  afterAll(async () => {
    if (app) await app.get(SeguidoresService).onModuleDestroy();
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

  it('follows a public profile once and exposes accepted relationship and exact totals', async () => {
    const result = await follow(alice, bob).expect(200);
    expect(result.body.data.estado).toBe('aceita');
    expect(result.body.data.contadores).toEqual({ seguidores: 1, seguindo: 1 });
    expect(await followers().countDocuments({ ...pair(alice, bob), status: 'aceito' })).toBe(1);
    const profile = await request(app.getHttpServer()).get(`/usuarios/${bob.username}`).set(auth(alice)).expect(200);
    expect(profile.body.data.relacao.enviada).toBe('aceita');
    expect(profile.body.data.contadores).toMatchObject({ seguidores: 1, seguindo: 0 });
    expect(await ownCounts(alice)).toMatchObject({ seguidores: 0, seguindo: 1 });
    expect(await ownCounts(bob)).toMatchObject({ seguidores: 1, seguindo: 0 });
  });

  it('creates a pending request for a private profile without increasing totals', async () => {
    await privateProfile(bob).expect(200);
    const result = await follow(alice, bob).expect(200);
    expect(result.body.data.estado).toBe('pendente');
    const stored = await followers().findOne(pair(alice, bob));
    expect(stored?.status).toBe('pendente');
    expect(stored?.aceito_em).toBeNull();
    expect(await ownCounts(alice)).toMatchObject({ seguidores: 0, seguindo: 0 });
    expect(await ownCounts(bob)).toMatchObject({ seguidores: 0, seguindo: 0 });
    const profile = await request(app.getHttpServer()).get(`/usuarios/${bob.username}`).set(auth(alice)).expect(200);
    expect(profile.body.data.relacao.enviada).toBe('pendente');
    expect(profile.body.data).not.toHaveProperty('biografia');
    expect(profile.body.data).not.toHaveProperty('stacks');
  });

  it('accepts only the recipient request and keeps the relationship idempotent', async () => {
    await privateProfile(bob).expect(200);
    await follow(alice, bob).expect(200);
    const stored = await followers().findOne(pair(alice, bob));
    const path = `/usuarios/me/solicitacoes/${stored!._id.toString()}/aceitar`;
    const accepted = await request(app.getHttpServer()).put(path).set(auth(bob)).expect(200);
    expect(accepted.body.data.estado).toBe('aceita');
    expect((await followers().findOne(pair(alice, bob)))?.aceito_em).toBeInstanceOf(Date);
    await request(app.getHttpServer()).put(path).set(auth(bob)).expect(200);
    expect(await followers().countDocuments(pair(alice, bob))).toBe(1);
    expect(await ownCounts(alice)).toMatchObject({ seguidores: 0, seguindo: 1 });
    expect(await ownCounts(bob)).toMatchObject({ seguidores: 1, seguindo: 0 });
  });

  it('lets the recipient decline a pending request without affecting totals', async () => {
    await privateProfile(bob).expect(200);
    await follow(alice, bob).expect(200);
    const stored = await followers().findOne(pair(alice, bob));
    const path = `/usuarios/me/solicitacoes/${stored!._id.toString()}`;
    const declined = await request(app.getHttpServer()).delete(path).set(auth(bob)).expect(200);
    expect(declined.body.data.estado).toBe('nenhuma');
    expect(await followers().findOne(pair(alice, bob))).toBeNull();
    expect(await ownCounts(alice)).toMatchObject({ seguidores: 0, seguindo: 0 });
    expect(await ownCounts(bob)).toMatchObject({ seguidores: 0, seguindo: 0 });
  });

  it('lets the sender cancel a pending request and repeat cancellation safely', async () => {
    await privateProfile(bob).expect(200);
    await follow(alice, bob).expect(200);
    expect((await unfollow(alice, bob).expect(200)).body.data.estado).toBe('nenhuma');
    expect((await unfollow(alice, bob).expect(200)).body.data.estado).toBe('nenhuma');
    expect(await followers().countDocuments(pair(alice, bob))).toBe(0);
    expect(await ownCounts(alice)).toMatchObject({ seguidores: 0, seguindo: 0 });
    expect(await ownCounts(bob)).toMatchObject({ seguidores: 0, seguindo: 0 });
  });

  it('unfollows an accepted relationship without leaving counted records', async () => {
    await follow(alice, bob).expect(200);
    await unfollow(alice, bob).expect(200);
    await unfollow(alice, bob).expect(200);
    expect(await followers().countDocuments(pair(alice, bob))).toBe(0);
    expect(await ownCounts(alice)).toMatchObject({ seguidores: 0, seguindo: 0 });
    expect(await ownCounts(bob)).toMatchObject({ seguidores: 0, seguindo: 0 });
  });

  it('rejects self-follow, malformed or missing users and inactive targets', async () => {
    await follow(alice, alice).expect(422);
    await request(app.getHttpServer()).put('/usuarios/invalid/seguir').set(auth(alice)).expect(400);
    await request(app.getHttpServer()).put(`/usuarios/${new Types.ObjectId().toString()}/seguir`).set(auth(alice)).expect(404);
    for (const status of ['bloqueado', 'excluido']) {
      await users().updateOne({ _id: new Types.ObjectId(bob.id) }, {
        $set: { status, excluido_em: status === 'excluido' ? new Date() : null },
      });
      await follow(alice, bob).expect(404);
      expect(await followers().countDocuments(pair(alice, bob))).toBe(0);
    }
  });

  it('requires a valid session and an active actor for private operations', async () => {
    await request(app.getHttpServer()).put(`/usuarios/${bob.id}/seguir`).expect(401);
    await request(app.getHttpServer()).delete(`/usuarios/${bob.id}/seguir`).expect(401);
    await request(app.getHttpServer()).get('/usuarios/me/solicitacoes').expect(401);
    await request(app.getHttpServer()).put(`/usuarios/me/solicitacoes/${new Types.ObjectId().toString()}/aceitar`).expect(401);
    await request(app.getHttpServer()).delete(`/usuarios/me/solicitacoes/${new Types.ObjectId().toString()}`).expect(401);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'alice.seguidores@example.test', password: 'SenhaTeste123!' })
      .expect(200);
    const revoked = login.body.data.access_token as string;
    await inspector.del(sessionKey(revoked));
    await request(app.getHttpServer())
      .put(`/usuarios/${bob.id}/seguir`)
      .set({ Authorization: `Bearer ${revoked}` })
      .expect(401);
    await users().updateOne({ _id: new Types.ObjectId(carla.id) }, { $set: { status: 'bloqueado' } });
    await follow(carla, bob).expect(401);
    expect(await followers().countDocuments({})).toBe(0);
  });

  it('does not let a third party accept, decline or cancel another relation', async () => {
    await privateProfile(bob).expect(200);
    await follow(alice, bob).expect(200);
    const stored = await followers().findOne(pair(alice, bob));
    const id = stored!._id.toString();
    await request(app.getHttpServer()).put(`/usuarios/me/solicitacoes/${id}/aceitar`).set(auth(carla)).expect(404);
    await request(app.getHttpServer()).delete(`/usuarios/me/solicitacoes/${id}`).set(auth(carla)).expect(404);
    await unfollow(carla, bob).expect(200);
    expect((await followers().findOne(pair(alice, bob)))?.status).toBe('pendente');
  });

  it('does not duplicate a relationship or counts on repeated follow requests', async () => {
    await follow(alice, bob).expect(200);
    await follow(alice, bob).expect(200);
    expect(await followers().countDocuments(pair(alice, bob))).toBe(1);
    expect(await ownCounts(alice)).toMatchObject({ seguidores: 0, seguindo: 1 });
    expect(await ownCounts(bob)).toMatchObject({ seguidores: 1, seguindo: 0 });
  });

  it('arbitrates concurrent requests for the same relationship', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => follow(alice, bob)));
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(await followers().countDocuments(pair(alice, bob))).toBe(1);
    expect(await ownCounts(alice)).toMatchObject({ seguidores: 0, seguindo: 1 });
    expect(await ownCounts(bob)).toMatchObject({ seguidores: 1, seguindo: 0 });
  });

  it('keeps counts equal to accepted relations when acceptance races cancellation', async () => {
    await privateProfile(bob).expect(200);
    await follow(alice, bob).expect(200);
    const stored = await followers().findOne(pair(alice, bob));
    const results = await Promise.all([
      request(app.getHttpServer()).put(`/usuarios/me/solicitacoes/${stored!._id.toString()}/aceitar`).set(auth(bob)),
      unfollow(alice, bob),
    ]);
    expect(results.every((result) => result.status < 500)).toBe(true);
    const accepted = await followers().countDocuments({ ...pair(alice, bob), status: 'aceito' });
    expect(accepted).toBeLessThanOrEqual(1);
    expect(await ownCounts(alice)).toMatchObject({ seguidores: 0, seguindo: accepted });
    expect(await ownCounts(bob)).toMatchObject({ seguidores: accepted, seguindo: 0 });
  });

  it('keeps the persisted relation and counters aligned when follow races unfollow', async () => {
    const results = await Promise.all([follow(alice, bob), unfollow(alice, bob)]);
    expect(results.every((result) => result.status === 200)).toBe(true);
    const accepted = await followers().countDocuments({ ...pair(alice, bob), status: 'aceito' });
    expect(accepted).toBeLessThanOrEqual(1);
    expect(await ownCounts(alice)).toMatchObject({ seguidores: 0, seguindo: accepted });
    expect(await ownCounts(bob)).toMatchObject({ seguidores: accepted, seguindo: 0 });
  });

  it('lets only one of acceptance and refusal finish a pending request', async () => {
    await privateProfile(bob).expect(200);
    await follow(alice, bob).expect(200);
    const stored = await followers().findOne(pair(alice, bob));
    const path = `/usuarios/me/solicitacoes/${stored!._id.toString()}`;
    const results = await Promise.all([
      request(app.getHttpServer()).put(`${path}/aceitar`).set(auth(bob)),
      request(app.getHttpServer()).delete(path).set(auth(bob)),
    ]);
    expect(results.map((result) => result.status).sort((left, right) => left - right)).toEqual([200, 404]);
    const accepted = await followers().countDocuments({ ...pair(alice, bob), status: 'aceito' });
    expect(await ownCounts(alice)).toMatchObject({ seguidores: 0, seguindo: accepted });
    expect(await ownCounts(bob)).toMatchObject({ seguidores: accepted, seguindo: 0 });
  });

  it('paginates accepted followers and followed users without duplicates or private fields', async () => {
    await Promise.all([alice, carla, davi, eva].map((account) => follow(account, bob)));
    const first = await request(app.getHttpServer()).get(`/usuarios/${bob.id}/seguidores?limite=2`).expect(200);
    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.hasMore).toBe(true);
    const second = await request(app.getHttpServer())
      .get(`/usuarios/${bob.id}/seguidores`)
      .query({ limite: '2', cursor: first.body.data.nextCursor as string })
      .expect(200);
    const all = [...first.body.data.items, ...second.body.data.items] as ListedUser[];
    expect(all).toHaveLength(4);
    expect(new Set(all.map((item) => item.id)).size).toBe(4);
    for (const item of all) {
      expect(item).toEqual({
        id: expect.any(String),
        nome: expect.any(String),
        username: expect.any(String),
        avatarUrl: null,
        visibilidadePerfil: 'publico',
      });
    }
    await Promise.all([carla, davi, eva].map((account) => follow(bob, account)));
    const following = await request(app.getHttpServer()).get(`/usuarios/${bob.id}/seguindo?limite=2`).expect(200);
    expect(following.body.data.items).toHaveLength(2);
    expect(following.body.data.hasMore).toBe(true);
    const next = await request(app.getHttpServer())
      .get(`/usuarios/${bob.id}/seguindo`)
      .query({ limite: '2', cursor: following.body.data.nextCursor as string })
      .expect(200);
    const followedIds = [...following.body.data.items, ...next.body.data.items].map((item: ListedUser) => item.id);
    expect(new Set(followedIds).size).toBe(3);
  });

  it('lists only received requests with stable pagination and no sensitive fields', async () => {
    await privateProfile(bob).expect(200);
    await Promise.all([alice, carla, davi].map((account) => follow(account, bob)));
    const first = await request(app.getHttpServer()).get('/usuarios/me/solicitacoes?limite=2').set(auth(bob)).expect(200);
    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.hasMore).toBe(true);
    const second = await request(app.getHttpServer())
      .get('/usuarios/me/solicitacoes')
      .query({ limite: '2', cursor: first.body.data.nextCursor as string })
      .set(auth(bob)).expect(200);
    const all = [...first.body.data.items, ...second.body.data.items];
    expect(new Set(all.map((item: { id: string }) => item.id)).size).toBe(3);
    for (const item of all) {
      expect(item).toEqual({
        id: expect.any(String),
        usuario: expect.objectContaining({ id: expect.any(String), username: expect.any(String) }),
        solicitadoEm: expect.any(String),
      });
      expect(item.usuario).not.toHaveProperty('email');
      expect(item.usuario).not.toHaveProperty('senha_hash');
      expect(item.usuario).not.toHaveProperty('papeis');
    }
    const others = await request(app.getHttpServer()).get('/usuarios/me/solicitacoes').set(auth(alice)).expect(200);
    expect(others.body.data.items).toEqual([]);
  });

  it('hides private relationship lists from third parties and rejects invalid cursors', async () => {
    await privateProfile(bob).expect(200);
    await follow(alice, bob).expect(200);
    await request(app.getHttpServer()).get(`/usuarios/${bob.id}/seguidores`).expect(404);
    await request(app.getHttpServer()).get(`/usuarios/${bob.id}/seguindo`).set(auth(carla)).expect(404);
    await request(app.getHttpServer()).get(`/usuarios/${bob.id}/seguidores`).set(auth(bob)).expect(200);
    await request(app.getHttpServer()).get(`/usuarios/${bob.id}/seguidores?limite=51`).set(auth(bob)).expect(400);
    await request(app.getHttpServer()).get(`/usuarios/${bob.id}/seguidores?cursor=invalid`).set(auth(bob)).expect(400);
  });

  it('preserves accepted relations and pending requests across privacy changes', async () => {
    await follow(alice, bob).expect(200);
    await privateProfile(bob).expect(200);
    await follow(carla, bob).expect(200);
    expect((await followers().findOne(pair(alice, bob)))?.status).toBe('aceito');
    expect((await followers().findOne(pair(carla, bob)))?.status).toBe('pendente');
    await request(app.getHttpServer()).patch('/usuarios/me').set(auth(bob)).send({ visibilidadePerfil: 'publico' }).expect(200);
    expect((await followers().findOne(pair(carla, bob)))?.status).toBe('pendente');
    expect(await ownCounts(bob)).toMatchObject({ seguidores: 1, seguindo: 0 });
  });

  it('repairs corrupted stored counters using accepted relationships as the source of truth', async () => {
    await follow(alice, bob).expect(200);
    const before = await users().findOne({ _id: new Types.ObjectId(bob.id) });
    await users().updateOne({ _id: new Types.ObjectId(alice.id) }, { $set: { 'contadores.seguindo': 9 } });
    await users().updateOne({ _id: new Types.ObjectId(bob.id) }, { $set: { 'contadores.seguidores': 7 } });
    expect((await users().findOne({ _id: new Types.ObjectId(alice.id) }))?.contadores.seguindo).toBe(9);
    expect((await users().findOne({ _id: new Types.ObjectId(bob.id) }))?.contadores.seguidores).toBe(7);
    await app.get(SeguidoresService).reconcileBatch();
    await app.get(SeguidoresService).reconcileBatch();
    expect((await users().findOne({ _id: new Types.ObjectId(alice.id) }))?.contadores.seguindo).toBe(1);
    expect((await users().findOne({ _id: new Types.ObjectId(bob.id) }))?.contadores.seguidores).toBe(1);
    expect((await users().findOne({ _id: new Types.ObjectId(bob.id) }))?.atualizado_em).toEqual(before?.atualizado_em);
    expect(await ownCounts(alice)).toMatchObject({ seguidores: 0, seguindo: 1 });
    expect(await ownCounts(bob)).toMatchObject({ seguidores: 1, seguindo: 0 });
  });
});
