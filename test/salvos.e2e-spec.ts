import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import { createClient } from 'redis';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureHttp } from '../src/common/http/configure-http.js';
import { PublicacoesCacheClient } from '../src/publicacoes/publicacoes-cache.client.js';
import { PublicacoesCacheService } from '../src/publicacoes/publicacoes-cache.service.js';
import { PublicacaoSalva } from '../src/publicacoes/schemas/publicacao-salva.schema.js';
import { Publicacao } from '../src/publicacoes/schemas/publicacao.schema.js';
import { SalvosService } from '../src/publicacoes/salvos.service.js';
import { VotosService } from '../src/publicacoes/votos.service.js';
import { SeguidoresService } from '../src/usuarios/seguidores.service.js';

const runId = randomBytes(8).toString('hex');
const mongoBase = process.env.MONGODB_URI;
const redisBase = process.env.REDIS_URL;
const config = (() => {
  try {
    if (!mongoBase || !redisBase || !process.env.JWT_SECRET || Buffer.byteLength(process.env.JWT_SECRET) < 32) return null;
    const mongo = new URL(mongoBase);
    const redis = new URL(redisBase);
    if (mongo.protocol !== 'mongodb:' || redis.protocol !== 'redis:' ||
      !['127.0.0.1', 'localhost'].includes(mongo.hostname) ||
      !['127.0.0.1', 'localhost'].includes(redis.hostname)) return null;
    mongo.pathname = `/ierri_salvos_test_${runId}`;
    return {
      mongo: mongo.toString(),
      sessionPrefix: `ierri:salvos:session:${runId}:`,
      ratePrefix: `ierri:salvos:rate:${runId}:`,
      cachePrefix: `ierri:salvos:cache:${runId}:`,
    };
  } catch { return null; }
})();

type Account = { id: string; token: string };

describe.runIf(config)('publicações salvas com MongoDB e Redis locais', () => {
  let app: INestApplication;
  let connection: Connection;
  let publications: Model<Publicacao>;
  let saves: Model<PublicacaoSalva>;
  let service: SalvosService;
  let cache: PublicacoesCacheService;
  let inspector: ReturnType<typeof createClient>;
  let author: Account;
  let follower: Account;
  let other: Account;
  let outsider: Account;
  let publicId: string;
  let secondPublicId: string;
  let privateId: string;
  let ownId: string;
  let outsiderId: string;
  const original = Object.fromEntries([
    'MONGODB_URI', 'REDIS_SESSION_PREFIX', 'REDIS_CHECK_EMAIL_RATE_PREFIX',
    'REDIS_CACHE_ENABLED', 'REDIS_CACHE_URL', 'REDIS_CACHE_PREFIX',
  ].map((key) => [key, process.env[key]]));
  const server = () => app.getHttpServer();
  const auth = (account: Account) => ({ Authorization: `Bearer ${account.token}` });
  const put = (id: string, account: Account) => request(server()).put(`/publicacoes/${id}/salvar`).set(auth(account));
  const remove = (id: string, account: Account) => request(server()).delete(`/publicacoes/${id}/salvar`).set(auth(account));
  const get = (id: string, account: Account) => request(server()).get(`/publicacoes/${id}/salvar`).set(auth(account));
  const list = (account: Account, query = '') => request(server()).get(`/usuarios/me/publicacoes-salvas${query}`).set(auth(account));
  const savedCount = async (id: string) => {
    const post = await connection.db!.collection('publicacoes').findOne({ _id: new Types.ObjectId(id) });
    return post?.contadores?.salvamentos as number;
  };
  const register = async (name: string): Promise<Account> => {
    const result = await request(server()).post('/auth/register').send({
      name, email: `${name.toLowerCase()}-${runId}@example.invalid`,
      password: `Local-${randomBytes(12).toString('hex')}`,
    }).expect(201);
    return { id: result.body.data.user.id as string, token: result.body.data.access_token as string };
  };
  const makePost = async (account: Account, visibilidade: 'publico' | 'seguidores') => {
    const reference = randomBytes(16).toString('base64url');
    const post = await publications.create({
      slug: `salvos-${runId}-${reference}`,
      autor_id: new Types.ObjectId(account.id),
      conteudo: `Publicação ${reference}`,
      status: 'publicada', visibilidade, publicada_em: new Date(),
      midias: [{ _id: new Types.ObjectId(), tipo: 'imagem',
        url: `http://127.0.0.1:3001/publicacoes/midias/${reference}`,
        chave_storage: `salvos-test/${runId}/${reference}`,
        mime_type: 'image/png', tamanho_bytes: 100, largura: 1, altura: 1,
        duracao_segundos: null, texto_alternativo: null, ordem: 0 }],
    });
    return post._id.toString();
  };
  const acceptFollower = async () => {
    await request(server()).put(`/usuarios/${author.id}/seguir`).set(auth(follower)).expect(200);
    const relation = await connection.db!.collection('seguidores').findOne({
      seguidor_id: new Types.ObjectId(follower.id), seguido_id: new Types.ObjectId(author.id),
    });
    expect(relation?.status).toBe('pendente');
    await request(server()).put(`/usuarios/me/solicitacoes/${relation!._id.toString()}/aceitar`)
      .set(auth(author)).expect(200);
  };

  beforeAll(async () => {
    process.env.MONGODB_URI = config!.mongo;
    process.env.REDIS_SESSION_PREFIX = config!.sessionPrefix;
    process.env.REDIS_CHECK_EMAIL_RATE_PREFIX = config!.ratePrefix;
    process.env.REDIS_CACHE_ENABLED = 'true';
    process.env.REDIS_CACHE_URL = redisBase;
    process.env.REDIS_CACHE_PREFIX = config!.cachePrefix;
    inspector = createClient({ url: redisBase });
    inspector.on('error', () => {});
    await inspector.connect();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureHttp(app);
    await app.init();
    connection = module.get<Connection>(getConnectionToken());
    publications = module.get<Model<Publicacao>>(getModelToken(Publicacao.name));
    saves = module.get<Model<PublicacaoSalva>>(getModelToken(PublicacaoSalva.name));
    service = module.get(SalvosService);
    cache = module.get(PublicacoesCacheService);
    await Promise.all([publications.init(), saves.init(), connection.model('Seguidor').init()]);
    const cacheClient = module.get(PublicacoesCacheClient);
    for (let attempt = 0; attempt < 30 && !cacheClient.ready; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cacheClient.ready).toBe(true);
    [author, follower, other, outsider] = await Promise.all([
      register('SavedAuthor'), register('SavedFollower'), register('SavedOther'), register('SavedOutsider'),
    ]);
    publicId = await makePost(author, 'publico');
    secondPublicId = await makePost(author, 'publico');
    privateId = await makePost(author, 'seguidores');
    ownId = await makePost(follower, 'publico');
    outsiderId = await makePost(outsider, 'publico');
  });

  beforeEach(async () => {
    await connection.db!.collection('publicacoes_salvas').deleteMany({});
    await connection.db!.collection('seguidores').deleteMany({});
    await connection.db!.collection('usuarios').updateMany({}, {
      $set: { status: 'ativo', excluido_em: null, 'contadores.seguidores': 0, 'contadores.seguindo': 0 },
    });
    await connection.db!.collection('usuarios').updateOne(
      { _id: new Types.ObjectId(author.id) }, { $set: { visibilidade_perfil: 'privado' } },
    );
    await publications.updateMany({}, { $set: {
      status: 'publicada', 'contadores.salvamentos': 0,
      salvamentos_revisao: 0, salvamentos_projecao_pendente: false,
      salvamentos_operacoes_pendentes: [], salvamentos_proxima_tentativa_em: new Date('9999-12-31T23:59:59.999Z'),
    } }).exec();
    for (const id of [publicId, secondPublicId, privateId, ownId, outsiderId])
      await cache.invalidate(id, id === ownId ? follower.id : id === outsiderId ? outsider.id : author.id);
  });

  afterAll(async () => {
    if (app) {
      await app.get(SeguidoresService).onModuleDestroy();
      app.get(VotosService).onModuleDestroy();
      service.onModuleDestroy();
    }
    if (connection?.db) await connection.db.dropDatabase();
    if (inspector?.isReady) {
      for (const prefix of [config!.sessionPrefix, config!.ratePrefix, config!.cachePrefix]) {
        const keys: string[] = [];
        for await (const batch of inspector.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) keys.push(...batch);
        if (keys.length) await inspector.del(keys);
      }
      await inspector.close();
    }
    if (app) await app.close();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('requires authentication and an active account on all saved routes', async () => {
    await request(server()).put(`/publicacoes/${publicId}/salvar`).expect(401);
    await request(server()).delete(`/publicacoes/${publicId}/salvar`).expect(401);
    await request(server()).get(`/publicacoes/${publicId}/salvar`).expect(401);
    await request(server()).get('/usuarios/me/publicacoes-salvas').expect(401);
    await connection.db!.collection('usuarios').updateOne(
      { _id: new Types.ObjectId(follower.id) }, { $set: { status: 'bloqueado' } },
    );
    await put(publicId, follower).expect(401);
    await list(follower).expect(401);
  });

  it('saves own and public posts once and removes them idempotently', async () => {
    await put(publicId, follower).expect(200);
    const firstSaved = await saves.findOne({ publicacao_id: new Types.ObjectId(publicId),
      usuario_id: new Types.ObjectId(follower.id) }).lean().exec();
    await put(publicId, follower).expect(200);
    const retriedSaved = await saves.findOne({ publicacao_id: new Types.ObjectId(publicId),
      usuario_id: new Types.ObjectId(follower.id) }).lean().exec();
    expect(retriedSaved?.criado_em).toEqual(firstSaved?.criado_em);
    await put(ownId, follower).expect(200);
    expect((await get(publicId, follower).expect(200)).body.data).toEqual({ salvo: true });
    expect(await saves.countDocuments({ publicacao_id: new Types.ObjectId(publicId), usuario_id: new Types.ObjectId(follower.id) })).toBe(1);
    expect(await savedCount(publicId)).toBe(1);
    await remove(publicId, follower).expect(200);
    await remove(publicId, follower).expect(200);
    expect((await get(publicId, follower).expect(200)).body.data).toEqual({ salvo: false });
    expect(await savedCount(publicId)).toBe(0);
    expect(await savedCount(ownId)).toBe(1);
  });

  it('enforces pending and accepted follower privacy and permits removal after unfollowing', async () => {
    await request(server()).put(`/usuarios/${author.id}/seguir`).set(auth(follower)).expect(200);
    await put(privateId, follower).expect(404);
    await get(privateId, follower).expect(404);
    const relation = await connection.db!.collection('seguidores').findOne({
      seguidor_id: new Types.ObjectId(follower.id), seguido_id: new Types.ObjectId(author.id),
    });
    await request(server()).put(`/usuarios/me/solicitacoes/${relation!._id.toString()}/aceitar`)
      .set(auth(author)).expect(200);
    await put(privateId, follower).expect(200);
    expect(await savedCount(privateId)).toBe(1);
    await request(server()).delete(`/usuarios/${author.id}/seguir`).set(auth(follower)).expect(200);
    await get(privateId, follower).expect(404);
    expect((await list(follower).expect(200)).body.data.items).toHaveLength(0);
    await remove(privateId, follower).expect(200);
    expect(await savedCount(privateId)).toBe(0);
  });

  it('filters inaccessible, deleted and inactive-author saves before pagination', async () => {
    await acceptFollower();
    for (const id of [publicId, privateId, secondPublicId, outsiderId, ownId])
      await put(id, follower).expect(200);
    const dates = [publicId, privateId, secondPublicId, outsiderId, ownId];
    for (const [index, id] of dates.entries()) {
      await connection.db!.collection('publicacoes_salvas').updateOne(
        { publicacao_id: new Types.ObjectId(id), usuario_id: new Types.ObjectId(follower.id) },
        { $set: { criado_em: new Date(Date.UTC(2026, 10, 24, 12, 0, index)) } },
      );
    }
    await request(server()).delete(`/usuarios/${author.id}/seguir`).set(auth(follower)).expect(200);
    await connection.db!.collection('usuarios').updateOne(
      { _id: new Types.ObjectId(outsider.id) }, { $set: { status: 'bloqueado' } },
    );
    const first = await list(follower, '?limite=2').expect(200);
    expect(first.body.data.items.map((item: { id: string }) => item.id)).toEqual([ownId, secondPublicId]);
    expect(first.body.data.hasMore).toBe(true);
    const second = await list(follower, `?limite=2&cursor=${first.body.data.nextCursor}`).expect(200);
    expect(second.body.data.items.map((item: { id: string }) => item.id)).toEqual([publicId]);
    expect(second.body.data.hasMore).toBe(false);
    await list(other, `?cursor=${first.body.data.nextCursor}`).expect(400);
    await publications.updateOne({ _id: new Types.ObjectId(publicId) }, { $set: { status: 'excluida' } }).exec();
    expect((await list(follower).expect(200)).body.data.items.map((item: { id: string }) => item.id))
      .toEqual([ownId, secondPublicId]);
  });

  it('updates public cache counters on save and removal', async () => {
    const detail = () => request(server()).get(`/publicacoes/${publicId}`).expect(200);
    expect((await detail()).body.data.contadores.salvamentos).toBe(0);
    await put(publicId, follower).expect(200);
    expect((await detail()).body.data.contadores.salvamentos).toBe(1);
    await remove(publicId, follower).expect(200);
    expect((await detail()).body.data.contadores.salvamentos).toBe(0);
  });

  it('prevents duplicate saves under concurrent requests', async () => {
    const responses = await Promise.all(Array.from({ length: 4 }, () => put(publicId, follower)));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(await saves.countDocuments({ publicacao_id: new Types.ObjectId(publicId) })).toBe(1);
    expect(await savedCount(publicId)).toBe(1);
  });

  it('keeps the counter correct for concurrent users and removals', async () => {
    const results = await Promise.all([put(publicId, follower), put(publicId, other)]);
    expect(results.every((response) => response.status === 200)).toBe(true);
    expect(await savedCount(publicId)).toBe(2);
    await remove(publicId, follower).expect(200);
    expect(await savedCount(publicId)).toBe(1);
  });

  it('recovers an ambiguous persisted save without compensating or duplicating it', async () => {
    const originalUpdate = saves.updateOne.bind(saves);
    const spy = vi.spyOn(saves, 'updateOne').mockImplementation((...args) => {
      const query = originalUpdate(...args);
      const originalExec = query.exec.bind(query);
      query.exec = (async () => { await originalExec(); throw new Error('response lost'); }) as typeof query.exec;
      return query;
    });
    try {
      await put(publicId, follower).expect(503);
    } finally {
      spy.mockRestore();
    }
    expect(await saves.countDocuments({ publicacao_id: new Types.ObjectId(publicId) })).toBe(1);
    await connection.db!.collection('publicacoes').updateOne({ _id: new Types.ObjectId(publicId) }, {
      $set: { 'salvamentos_operacoes_pendentes.$[].expira_em': new Date(0),
        salvamentos_proxima_tentativa_em: new Date(0) },
    });
    await service.recoverPendingBatch();
    expect(await savedCount(publicId)).toBe(1);
    await put(publicId, follower).expect(200);
    expect(await savedCount(publicId)).toBe(1);
  });

  it('repairs a counter update that persisted before its response failed', async () => {
    const originalUpdate = publications.updateOne.bind(publications);
    let intercepted = false;
    const spy = vi.spyOn(publications, 'updateOne').mockImplementation((...args) => {
      const query = originalUpdate(...args);
      const update = args[1] as { $inc?: Record<string, number> };
      if (!intercepted && update.$inc?.['contadores.salvamentos'] === 1) {
        intercepted = true;
        const originalExec = query.exec.bind(query);
        query.exec = (async () => { await originalExec(); throw new Error('response lost'); }) as typeof query.exec;
      }
      return query;
    });
    try {
      await put(publicId, follower).expect(503);
    } finally {
      spy.mockRestore();
    }
    expect(intercepted).toBe(true);
    expect(await savedCount(publicId)).toBe(1);
    await connection.db!.collection('publicacoes').updateOne({ _id: new Types.ObjectId(publicId) }, {
      $set: { 'salvamentos_operacoes_pendentes.$[].expira_em': new Date(0),
        salvamentos_proxima_tentativa_em: new Date(0) },
    });
    await service.recoverPendingBatch();
    expect(await savedCount(publicId)).toBe(1);
    expect((await get(publicId, follower).expect(200)).body.data.salvo).toBe(true);
  });

  it('recovers an ambiguous persisted removal without leaving a stale count', async () => {
    await put(publicId, follower).expect(200);
    const originalDelete = saves.deleteOne.bind(saves);
    const spy = vi.spyOn(saves, 'deleteOne').mockImplementation((...args) => {
      const query = originalDelete(...args);
      const originalExec = query.exec.bind(query);
      query.exec = (async () => { await originalExec(); throw new Error('response lost'); }) as typeof query.exec;
      return query;
    });
    try {
      await remove(publicId, follower).expect(503);
    } finally {
      spy.mockRestore();
    }
    expect(await saves.countDocuments({ publicacao_id: new Types.ObjectId(publicId) })).toBe(0);
    await connection.db!.collection('publicacoes').updateOne({ _id: new Types.ObjectId(publicId) }, {
      $set: { 'salvamentos_operacoes_pendentes.$[].expira_em': new Date(0),
        salvamentos_proxima_tentativa_em: new Date(0) },
    });
    await service.recoverPendingBatch();
    expect(await savedCount(publicId)).toBe(0);
    await remove(publicId, follower).expect(200);
    expect(await savedCount(publicId)).toBe(0);
  });
});
