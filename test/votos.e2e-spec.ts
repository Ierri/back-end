import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import { createClient } from 'redis';
import request from 'supertest';
import sharp from 'sharp';
import { AppModule } from '../src/app.module.js';
import { configureHttp } from '../src/common/http/configure-http.js';
import { MediaStorageService } from '../src/publicacoes/media-storage.service.js';
import { PublicacoesCacheClient } from '../src/publicacoes/publicacoes-cache.client.js';
import { PublicacoesCacheService } from '../src/publicacoes/publicacoes-cache.service.js';
import { VotosService } from '../src/publicacoes/votos.service.js';
import type { Voto } from '../src/publicacoes/schemas/voto.schema.js';

const runId = randomBytes(8).toString('hex');
const mongoBase = process.env.MONGODB_URI;
const redisBase = process.env.REDIS_URL;
const secret = process.env.JWT_SECRET;
const config = (() => {
  try {
    if (!mongoBase || !redisBase || !secret || Buffer.byteLength(secret) < 32 ||
      !process.env.S3_ENDPOINT || !process.env.S3_ACCESS_KEY_ID ||
      !process.env.S3_SECRET_ACCESS_KEY || !process.env.S3_BUCKET) return null;
    const mongo = new URL(mongoBase);
    const redis = new URL(redisBase);
    const s3 = new URL(process.env.S3_ENDPOINT);
    if (mongo.protocol !== 'mongodb:' || redis.protocol !== 'redis:' ||
      !['127.0.0.1', 'localhost'].includes(mongo.hostname) ||
      !['127.0.0.1', 'localhost'].includes(redis.hostname) ||
      !['127.0.0.1', 'localhost'].includes(s3.hostname)) return null;
    mongo.pathname = '/ierri_votes_test_' + runId;
    return {
      mongo: mongo.toString(),
      cachePrefix: 'ierri:votes:cache:' + runId + ':',
      sessionPrefix: 'ierri:votes:session:' + runId + ':',
      ratePrefix: 'ierri:votes:rate:' + runId + ':',
    };
  } catch { return null; }
})();

describe.runIf(config)('votos com MongoDB, Redis e MinIO locais', () => {
  let app: INestApplication;
  let connection: Connection;
  let storage: MediaStorageService;
  let cacheClient: PublicacoesCacheClient;
  let votosService: VotosService;
  let tokenA: string;
  let tokenB: string;
  let authorId: string;
  let readerId: string;
  let sourcePostId: string;
  let postId: string;
  const original = Object.fromEntries([
    'MONGODB_URI', 'REDIS_SESSION_PREFIX', 'REDIS_CHECK_EMAIL_RATE_PREFIX',
    'REDIS_CACHE_ENABLED', 'REDIS_CACHE_URL', 'REDIS_CACHE_PREFIX',
  ].map((key) => [key, process.env[key]]));
  const server = () => app.getHttpServer();
  const path = () => `/publicacoes/${postId}/voto`;
  const put = (token: string, value: unknown) => request(server()).put(path())
    .set('Authorization', `Bearer ${token}`).send({ valor: value });
  const remove = (token: string) => request(server()).delete(path())
    .set('Authorization', `Bearer ${token}`);
  const get = (token: string) => request(server()).get(path())
    .set('Authorization', `Bearer ${token}`);
  const counters = async () => {
    const post = await connection.db!.collection('publicacoes').findOne({ _id: new Types.ObjectId(postId) });
    return {
      upvotes: post!.contadores.upvotes as number,
      downvotes: post!.contadores.downvotes as number,
      score: post!.contadores.score as number,
    };
  };
  const votes = () => connection.db!.collection('votos').find({
    publicacao_id: new Types.ObjectId(postId),
    valor: { $in: [1, -1] },
  }).toArray();
  const allVotes = () => connection.db!.collection('votos').find({ publicacao_id: new Types.ObjectId(postId) }).toArray();
  const postDocument = () => connection.db!.collection('publicacoes').findOne({ _id: new Types.ObjectId(postId) });
  const makeProjectionPending = async () => {
    await connection.db!.collection('publicacoes').updateOne(
      { _id: new Types.ObjectId(postId) },
      { $set: {
        votos_projecao_pendente: true,
        votos_proxima_tentativa_em: new Date(0),
      } },
    );
  };
  const insertVote = async (voterId: string, valor: 1 | -1) => {
    await connection.db!.collection('votos').insertOne({
      publicacao_id: new Types.ObjectId(postId),
      usuario_id: new Types.ObjectId(voterId),
      valor,
      revisao: 0,
      criado_em: new Date(),
      atualizado_em: new Date(),
    });
  };
  const expectState = async (upvotes: number, downvotes: number) => {
    const stored = await votes();
    expect(stored.filter((vote) => vote.valor === 1)).toHaveLength(upvotes);
    expect(stored.filter((vote) => vote.valor === -1)).toHaveLength(downvotes);
    expect(await counters()).toEqual({ upvotes, downvotes, score: upvotes - downvotes });
  };

  const failReservationRelease = (token: string) => {
    const model = (votosService as unknown as { publicacoes: Model<unknown> }).publicacoes;
    const originalUpdate = model.updateOne.bind(model);
    let intercepted = false;
    const spy = vi.spyOn(model, 'updateOne').mockImplementation(
      ((filter: unknown, update: unknown, options: unknown) => {
        const query = originalUpdate(
          filter as Parameters<typeof model.updateOne>[0],
          update as Parameters<typeof model.updateOne>[1],
          options as Parameters<typeof model.updateOne>[2],
        );
        const pulled = (update as { $pull?: { votos_operacoes_pendentes?: { token?: string } } })
          .$pull?.votos_operacoes_pendentes?.token;
        if (pulled === token) {
          query.exec = (async () => {
            intercepted = true;
            throw new Error('Controlled later release failure');
          }) as typeof query.exec;
        }
        return query;
      }) as typeof model.updateOne,
    );
    return { spy, wasIntercepted: () => intercepted };
  };

  const startApp = async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureHttp(app);
    await app.init();
    connection = module.get<Connection>(getConnectionToken());
    storage = module.get(MediaStorageService);
    cacheClient = module.get(PublicacoesCacheClient);
    votosService = module.get(VotosService);
    await connection.model('Voto').init();
    for (let attempt = 0; attempt < 30 && !cacheClient.ready; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cacheClient.ready).toBe(true);
  };

  beforeAll(async () => {
    process.env.MONGODB_URI = config!.mongo;
    process.env.REDIS_SESSION_PREFIX = config!.sessionPrefix;
    process.env.REDIS_CHECK_EMAIL_RATE_PREFIX = config!.ratePrefix;
    process.env.REDIS_CACHE_ENABLED = 'true';
    process.env.REDIS_CACHE_URL = redisBase;
    process.env.REDIS_CACHE_PREFIX = config!.cachePrefix;
    await startApp();
    const password = 'Local-' + randomBytes(12).toString('hex');
    const first = await request(server()).post('/auth/register').send({
      name: 'Autora', email: `votes-a-${runId}@example.invalid`, password,
    }).expect(201);
    const second = await request(server()).post('/auth/register').send({
      name: 'Leitor', email: `votes-b-${runId}@example.invalid`, password,
    }).expect(201);
    tokenA = first.body.data.access_token;
    tokenB = second.body.data.access_token;
    authorId = first.body.data.user.id;
    readerId = second.body.data.user.id;
    const image = await sharp({ create: {
      width: 16, height: 16, channels: 3, background: '#4488cc',
    } }).png().toBuffer();
    const uploaded = await request(server()).post('/publicacoes/midias')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('arquivo', image, { filename: 'votes.png', contentType: 'image/png' })
      .expect(201);
    const publication = await request(server()).post('/publicacoes')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ conteudo: 'Publicação de referência para votos', midias: [uploaded.body.data.referencia] })
      .expect(201);
    sourcePostId = publication.body.data.id;
  });

  beforeEach(async () => {
    const source = await connection.db!.collection('publicacoes').findOne({ _id: new Types.ObjectId(sourcePostId) });
    const { _id: _sourceId, slug: _sourceSlug, ...template } = source!;
    const id = new Types.ObjectId();
    await connection.db!.collection('publicacoes').insertOne({
      ...template,
      _id: id,
      slug: `votes-${randomBytes(12).toString('hex')}`,
      status: 'publicada',
      visibilidade: 'publico',
      publicada_em: new Date(),
      criada_em: new Date(),
      atualizada_em: new Date(),
      contadores: { ...template.contadores, upvotes: 0, downvotes: 0, score: 0 },
    });
    postId = id.toString();
  });

  afterAll(async () => {
    if (connection?.db) {
      const uploads = await connection.db.collection('uploads_midias').find({}, { projection: { chave_storage: 1 } }).toArray();
      for (const upload of uploads) await storage.remove(upload.chave_storage).catch(() => undefined);
      await connection.db.dropDatabase();
    }
    if (app) await app.close();
    if (redisBase && config) {
      const inspector = createClient({ url: redisBase });
      inspector.on('error', () => {});
      await inspector.connect();
      for (const prefix of [config.cachePrefix, config.sessionPrefix, config.ratePrefix]) {
        const keys: string[] = [];
        for await (const batch of inspector.scanIterator({ MATCH: prefix + '*', COUNT: 100 })) keys.push(...batch);
        if (keys.length) await inspector.del(keys);
      }
      await inspector.close();
    }
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('returns null when the authenticated user has no vote', async () => {
    expect((await get(tokenB).expect(200)).body.data).toEqual({ valor: null });
    await expectState(0, 0);
  });

  it('creates an upvote and returns persisted counters', async () => {
    const response = await put(tokenB, 1).expect(200);
    expect(response.body.data).toMatchObject({ valor: 1, contadores: { upvotes: 1, downvotes: 0, score: 1 } });
    await expectState(1, 0);
  });

  it('creates a downvote and returns persisted counters', async () => {
    const response = await put(tokenB, -1).expect(200);
    expect(response.body.data).toMatchObject({ valor: -1, contadores: { upvotes: 0, downvotes: 1, score: -1 } });
    await expectState(0, 1);
  });

  it('repeats an upvote without incrementing twice', async () => {
    await put(tokenB, 1).expect(200);
    await put(tokenB, 1).expect(200);
    expect((await votes())).toHaveLength(1);
    await expectState(1, 0);
  });

  it('repeats a downvote without incrementing twice', async () => {
    await put(tokenB, -1).expect(200);
    await put(tokenB, -1).expect(200);
    expect((await votes())).toHaveLength(1);
    await expectState(0, 1);
  });

  it('changes upvote to downvote without leaving the old count', async () => {
    await put(tokenB, 1).expect(200);
    expect((await put(tokenB, -1).expect(200)).body.data.contadores).toEqual({ upvotes: 0, downvotes: 1, score: -1 });
    await expectState(0, 1);
  });

  it('changes downvote to upvote without leaving the old count', async () => {
    await put(tokenB, -1).expect(200);
    expect((await put(tokenB, 1).expect(200)).body.data.contadores).toEqual({ upvotes: 1, downvotes: 0, score: 1 });
    await expectState(1, 0);
  });

  it('removes an upvote and keeps other users untouched', async () => {
    await put(tokenA, 1).expect(200);
    await put(tokenB, 1).expect(200);
    expect((await remove(tokenB).expect(200)).body.data.valor).toBeNull();
    expect((await votes()).map((vote) => vote.usuario_id.toString())).toEqual([authorId]);
    await expectState(1, 0);
  });

  it('removes a downvote and restores zero score', async () => {
    await put(tokenB, -1).expect(200);
    const response = await remove(tokenB).expect(200);
    expect(response.body.data).toMatchObject({ valor: null, contadores: { upvotes: 0, downvotes: 0, score: 0 } });
    await expectState(0, 0);
    expect((await allVotes())[0].valor).toBeNull();
  });

  it('repeats removal of an absent vote without making counters negative', async () => {
    await remove(tokenB).expect(200);
    await remove(tokenB).expect(200);
    await expectState(0, 0);
  });

  it('reports each authenticated user’s own vote without exposing voter identities', async () => {
    await put(tokenA, 1).expect(200);
    await put(tokenB, -1).expect(200);
    expect((await get(tokenA).expect(200)).body.data).toEqual({ valor: 1 });
    expect((await get(tokenB).expect(200)).body.data).toEqual({ valor: -1 });
    expect((await request(server()).get(`/publicacoes/${postId}`).expect(200)).body.data)
      .not.toHaveProperty('votos');
    await expectState(1, 1);
  });

  it('rejects invalid IDs, values and additional body fields', async () => {
    await request(server()).put('/publicacoes/not-an-id/voto')
      .set('Authorization', `Bearer ${tokenB}`).send({ valor: 1 }).expect(400);
    for (const payload of [{ valor: 0 }, { valor: 2 }, { valor: '1' }, { valor: 1, usuarioId: readerId }, {}]) {
      await request(server()).put(path()).set('Authorization', `Bearer ${tokenB}`)
        .send(payload).expect(400);
    }
    await expectState(0, 0);
  });

  it('requires a valid JWT and active Redis session for all vote routes', async () => {
    await request(server()).put(path()).send({ valor: 1 }).expect(401);
    await request(server()).delete(path()).expect(401);
    await request(server()).get(path()).expect(401);
    await request(server()).put(path()).set('Authorization', 'Bearer invalid')
      .send({ valor: 1 }).expect(401);
    await expectState(0, 0);
  });

  it('restricts follower-only posts to their author', async () => {
    await connection.db!.collection('publicacoes').updateOne(
      { _id: new Types.ObjectId(postId) }, { $set: { visibilidade: 'seguidores' } },
    );
    await put(tokenB, 1).expect(404);
    await get(tokenB).expect(404);
    await remove(tokenB).expect(404);
    await put(tokenA, 1).expect(200);
    await expectState(1, 0);
  });

  it('blocks new votes on unpublished, hidden, archived and deleted posts', async () => {
    for (const status of ['processando', 'oculta', 'arquivada', 'excluida']) {
      await connection.db!.collection('publicacoes').updateOne(
        { _id: new Types.ObjectId(postId) }, { $set: { status } },
      );
      await put(tokenB, 1).expect(404);
      await get(tokenB).expect(404);
    }
    await expectState(0, 0);
  });

  it('rejects blocked and deleted voters without changing the stored vote', async () => {
    await put(tokenB, 1).expect(200);
    for (const status of ['bloqueado', 'excluido']) {
      await connection.db!.collection('usuarios').updateOne(
        { _id: new Types.ObjectId(readerId) }, { $set: { status } },
      );
      expect((await put(tokenB, -1).expect(401)).body.error.code).toBe('INVALID_TOKEN');
      expect((await remove(tokenB).expect(401)).body.error.code).toBe('INVALID_TOKEN');
      expect((await get(tokenB).expect(401)).body.error.code).toBe('INVALID_TOKEN');
    }
    await connection.db!.collection('usuarios').updateOne(
      { _id: new Types.ObjectId(readerId) }, { $set: { status: 'ativo' } },
    );
    await expectState(1, 0);
  });

  it('serializes concurrent requests from the same user without duplicate votes', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => put(tokenB, index % 2 ? -1 : 1)));
    expect(results.some((response) => response.status === 200)).toBe(true);
    expect(results.every((response) => [200, 503].includes(response.status))).toBe(true);
    const stored = await votes();
    expect(stored).toHaveLength(1);
    await votosService.reconcileCounter(postId);
    await expectState(stored[0].valor === 1 ? 1 : 0, stored[0].valor === -1 ? 1 : 0);
  });

  it('preserves votes from different users under concurrent requests', async () => {
    const results = await Promise.all([put(tokenA, 1), put(tokenB, -1)]);
    expect(results.every((response) => [200, 503].includes(response.status))).toBe(true);
    for (const [token, value] of [[tokenA, 1], [tokenB, -1]] as const) {
      if ((await get(token).expect(200)).body.data.valor !== value)
        await put(token, value).expect(200);
    }
    const sortIds = (ids: string[]) => ids.toSorted((left, right) => left.localeCompare(right));
    expect(sortIds((await votes()).map((vote) => vote.usuario_id.toString())))
      .toEqual(sortIds([authorId, readerId]));
    await votosService.reconcileCounter(postId);
    await expectState(1, 1);
    expect((await postDocument())!.votos_projecao_pendente).toBe(false);
  });

  it('keeps an ambiguous persisted write pending, blocks a concurrent request and recovers it', async () => {
    const model = (votosService as unknown as { votos: Model<Voto> }).votos;
    const originalUpdate = model.updateOne.bind(model);
    let intercepted = false;
    const spy = vi.spyOn(model, 'updateOne').mockImplementation(
      ((filter: unknown, update: unknown, options: unknown) => {
        const fields = (update as { $set?: Record<string, unknown> }).$set;
        const query = originalUpdate(
          filter as Parameters<typeof model.updateOne>[0],
          update as Parameters<typeof model.updateOne>[1],
          options as Parameters<typeof model.updateOne>[2],
        );
        if (!intercepted && fields?.valor === 1 && fields['operacao.estado'] === 'aplicada') {
          intercepted = true;
          const execute = query.exec.bind(query);
          query.exec = (async () => {
            await execute();
            throw new Error('Resposta MongoDB perdida após persistência');
          }) as typeof query.exec;
        }
        return query;
      }) as typeof model.updateOne,
    );
    try {
      await put(tokenB, 1).expect(503);
    } finally {
      spy.mockRestore();
    }
    expect(intercepted).toBe(true);
    expect((await votes())).toHaveLength(1);
    expect((await votes())[0].valor).toBe(1);
    expect((await postDocument())!.votos_projecao_pendente).toBe(true);
    const firstVote = (await votes())[0];
    const firstToken = firstVote.operacao.token as string;
    const firstExpiry = firstVote.operacao.expira_em as Date;
    expect(firstVote.operacao.estado).toBe('aplicada');
    expect((await postDocument())!.votos_operacoes_pendentes[0].token).toBe(firstToken);
    await put(tokenB, -1).expect(503);
    const blockedVote = (await votes())[0];
    expect(blockedVote.valor).toBe(1);
    expect(blockedVote.operacao).toMatchObject({
      token: firstToken, expira_em: firstExpiry, estado: 'aplicada',
    });
    expect((await postDocument())!.votos_operacoes_pendentes[0].token).toBe(firstToken);
    await connection.db!.collection('votos').updateOne(
      { publicacao_id: new Types.ObjectId(postId), usuario_id: new Types.ObjectId(readerId) },
      { $set: { 'operacao.expira_em': new Date(0) } },
    );
    await connection.db!.collection('publicacoes').updateOne(
      { _id: new Types.ObjectId(postId) },
      { $set: {
        'votos_operacoes_pendentes.$[].expira_em': new Date(0),
        votos_proxima_tentativa_em: new Date(0),
      } },
    );
    await votosService.recoverPendingBatch();
    await expectState(1, 0);
    expect((await postDocument())!.votos_projecao_pendente).toBe(false);
    expect((await postDocument())!.votos_operacoes_pendentes).toHaveLength(0);
    expect((await votes())[0].operacao).toBeNull();
    await put(tokenB, 1).expect(200);
    await expectState(1, 0);
  });

  it('refreshes publication details and feed counters after a vote', async () => {
    await request(server()).get(`/publicacoes/${postId}`).expect(200);
    await request(server()).get('/publicacoes').query({ limite: '50' }).expect(200);
    await put(tokenB, 1).expect(200);
    const detail = await request(server()).get(`/publicacoes/${postId}`).expect(200);
    const feed = await request(server()).get('/publicacoes').query({ limite: '50' }).expect(200);
    expect(detail.body.data.contadores).toMatchObject({ upvotes: 1, downvotes: 0, score: 1 });
    expect(feed.body.data.items.find((item: { id: string }) => item.id === postId).contadores)
      .toMatchObject({ upvotes: 1, downvotes: 0, score: 1 });
  });

  it('keeps voting available when only the public Redis cache is unavailable', async () => {
    const client = cacheClient as unknown as { client: ReturnType<typeof createClient> };
    await client.client.close();
    try {
      await request(server()).get('/auth/me').set('Authorization', `Bearer ${tokenB}`).expect(200);
      await put(tokenB, 1).expect(200);
      await get(tokenB).expect(200);
      await expectState(1, 0);
    } finally {
      await client.client.connect();
    }
  });

  it('keeps the projection pending and public cache bypassed after reconciliation fails', async () => {
    const model = (votosService as unknown as { publicacoes: Model<unknown> }).publicacoes;
    const originalUpdate = model.updateOne.bind(model);
    let intercepted = false;
    const spy = vi.spyOn(model, 'updateOne').mockImplementation(
      ((filter: unknown, update: unknown, options: unknown) => {
        const fields = (update as { $set?: Record<string, unknown> }).$set;
        const query = originalUpdate(
          filter as Parameters<typeof model.updateOne>[0],
          update as Parameters<typeof model.updateOne>[1],
          options as Parameters<typeof model.updateOne>[2],
        );
        if (!intercepted && fields && 'contadores.upvotes' in fields) {
          intercepted = true;
          query.exec = (async () => { throw new Error('Reconciliation unavailable'); }) as typeof query.exec;
        }
        return query;
      }) as typeof model.updateOne,
    );
    try {
      await put(tokenB, 1).expect(503);
    } finally {
      spy.mockRestore();
    }
    expect(intercepted).toBe(true);
    expect((await votes())).toHaveLength(1);
    expect((await postDocument())!.votos_projecao_pendente).toBe(true);
    const cache = app.get(PublicacoesCacheService);
    const hits = cache.metrics().hit;
    await request(server()).get(`/publicacoes/${postId}`).expect(200);
    await request(server()).get(`/publicacoes/${postId}`).expect(200);
    expect(cache.metrics().hit).toBe(hits);
    await votosService.recoverPendingBatch();
    await expectState(1, 0);
    expect((await postDocument())!.votos_projecao_pendente).toBe(false);
  });

  it('fences an expired old upvote after a newer downvote has completed', async () => {
    const model = (votosService as unknown as { votos: Model<Voto> }).votos;
    const originalUpdate = model.updateOne.bind(model);
    let intercepted = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(model, 'updateOne').mockImplementation(
      ((filter: unknown, update: unknown, options: unknown) => {
        const fields = (update as { $set?: Record<string, unknown> }).$set;
        const query = originalUpdate(
          filter as Parameters<typeof model.updateOne>[0],
          update as Parameters<typeof model.updateOne>[1],
          options as Parameters<typeof model.updateOne>[2],
        );
        if (!intercepted && fields?.valor === 1 && fields['operacao.estado'] === 'aplicada') {
          intercepted = true;
          const execute = query.exec.bind(query);
          query.exec = (async () => { await pending; return execute(); }) as typeof query.exec;
        }
        return query;
      }) as typeof model.updateOne,
    );
    const first = put(tokenB, 1).then((response) => response);
    try {
      await vi.waitFor(() => expect(intercepted).toBe(true));
      await connection.db!.collection('votos').updateOne(
        { publicacao_id: new Types.ObjectId(postId), usuario_id: new Types.ObjectId(readerId) },
        { $set: { 'operacao.expira_em': new Date(0) } },
      );
      await connection.db!.collection('publicacoes').updateOne(
        { _id: new Types.ObjectId(postId) },
        { $set: {
          'votos_operacoes_pendentes.$[].expira_em': new Date(0),
          votos_proxima_tentativa_em: new Date(0),
        } },
      );
      await votosService.recoverPendingBatch();
      const second = await put(tokenB, -1).expect(200);
      expect(second.body.data.valor).toBe(-1);
    } finally {
      release();
      spy.mockRestore();
    }
    expect((await first).status).toBe(503);
    expect((await votes())[0].valor).toBe(-1);
    await expectState(0, 1);
    expect((await postDocument())!.votos_projecao_pendente).toBe(false);
  }, 15_000);

  it('repairs a persisted pending projection through the scheduled worker', async () => {
    await insertVote(readerId, 1);
    await makeProjectionPending();
    await vi.waitFor(async () => {
      await expectState(1, 0);
      expect((await postDocument())!.votos_projecao_pendente).toBe(false);
    }, { timeout: 65_000, interval: 1_000 });
  }, 70_000);

  it('recovers pending votes after restarting the application on the same isolated database', async () => {
    await insertVote(readerId, -1);
    await makeProjectionPending();
    await app.close();
    await startApp();
    await vi.waitFor(async () => {
      expect((await postDocument())!.votos_projecao_pendente).toBe(false);
    }, { timeout: 15_000, interval: 250 });
    await expectState(0, 1);
  }, 30_000);

  it('reschedules with the persisted revision after a partial release and later recovers the vote', async () => {
    votosService.onModuleDestroy();
    try {
      await vi.waitFor(() => {
        expect((votosService as unknown as { recovering: boolean }).recovering).toBe(false);
      }, { timeout: 10_000 });
      const publicationId = new Types.ObjectId(postId);
      const firstToken = randomBytes(12).toString('hex');
      const laterToken = randomBytes(12).toString('hex');
      const validToken = randomBytes(12).toString('hex');
      const firstUserId = new Types.ObjectId();
      const laterUserId = new Types.ObjectId();
      const validUserId = new Types.ObjectId();
      const validUntil = new Date(Date.now() + 300_000);
      await insertVote(readerId, 1);
      await connection.db!.collection('votos').insertOne({
        publicacao_id: publicationId, usuario_id: validUserId, valor: null, revisao: 0,
        operacao: { token: validToken, expira_em: validUntil, estado: 'reservada' },
        criado_em: new Date(), atualizado_em: new Date(),
      });
      await connection.db!.collection('publicacoes').updateOne(
        { _id: publicationId },
        { $set: {
          votos_revisao: 0,
          votos_operacoes_pendentes: [
            { usuario_id: firstUserId, token: firstToken, expira_em: new Date(0) },
            { usuario_id: laterUserId, token: laterToken, expira_em: new Date(0) },
            { usuario_id: validUserId, token: validToken, expira_em: validUntil },
          ],
          votos_projecao_pendente: true,
          votos_proxima_tentativa_em: new Date(0),
        } },
      );
      const { spy, wasIntercepted } = failReservationRelease(laterToken);
      try {
        await votosService.recoverPendingBatch();
      } finally {
        spy.mockRestore();
      }
      expect(wasIntercepted()).toBe(true);
      const pending = (await postDocument())!;
      expect(pending.votos_revisao).toBe(1);
      expect(pending.votos_operacoes_pendentes.map((item: { token: string }) => item.token))
        .toEqual([laterToken, validToken]);
      expect(pending.votos_proxima_tentativa_em.getTime()).toBeGreaterThan(Date.now());
      expect(pending.votos_projecao_pendente).toBe(true);
      const validVote = await connection.db!.collection('votos').findOne({
        publicacao_id: publicationId, usuario_id: validUserId,
      });
      expect(validVote!.operacao).toMatchObject({ token: validToken, expira_em: validUntil });
      expect((await votes()).map((vote) => vote.valor)).toEqual([1]);
      await connection.db!.collection('votos').updateOne(
        { publicacao_id: publicationId, usuario_id: validUserId },
        { $set: { 'operacao.expira_em': new Date(0) } },
      );
      await connection.db!.collection('publicacoes').updateOne(
        { _id: publicationId },
        { $set: {
          'votos_operacoes_pendentes.$[pending].expira_em': new Date(0),
          votos_proxima_tentativa_em: new Date(0),
        } },
        { arrayFilters: [{ 'pending.token': validToken }] },
      );
      await votosService.recoverPendingBatch();
      const recovered = (await postDocument())!;
      expect(recovered.votos_operacoes_pendentes).toHaveLength(0);
      expect(recovered.votos_projecao_pendente).toBe(false);
      expect((await connection.db!.collection('votos').findOne({
        publicacao_id: publicationId, usuario_id: validUserId,
      }))!.operacao).toBeNull();
      await expectState(1, 0);
    } finally {
      votosService.onModuleInit();
    }
  }, 30_000);

  it('progresses beyond the first 100 pending publications', async () => {
    votosService.onModuleDestroy();
    try {
      await vi.waitFor(() => {
        expect((votosService as unknown as { recovering: boolean }).recovering).toBe(false);
      }, { timeout: 10_000 });
      const source = await connection.db!.collection('publicacoes').findOne({ _id: new Types.ObjectId(sourcePostId) });
      const { _id: _sourceId, slug: _sourceSlug, ...template } = source!;
      const documents = Array.from({ length: 101 }, (_, index) => ({
        ...template,
        _id: new Types.ObjectId(),
        slug: `vote-recovery-${runId}-${index}`,
        contadores: { ...template.contadores, upvotes: 0, downvotes: 0, score: 0 },
        votos_projecao_pendente: true,
        votos_proxima_tentativa_em: new Date(Date.now() - 200_000 + index),
      }));
      await connection.db!.collection('publicacoes').insertMany(documents);
      postId = documents.at(-1)!._id.toString();
      await insertVote(readerId, 1);
      const firstToken = randomBytes(12).toString('hex');
      const laterToken = randomBytes(12).toString('hex');
      await connection.db!.collection('publicacoes').updateOne(
        { _id: documents[0]._id },
        { $set: {
          votos_revisao: 0,
          votos_operacoes_pendentes: [
            { usuario_id: new Types.ObjectId(), token: firstToken, expira_em: new Date(0) },
            { usuario_id: new Types.ObjectId(), token: laterToken, expira_em: new Date(0) },
          ],
          votos_proxima_tentativa_em: new Date(0),
        } },
      );
      const { spy, wasIntercepted } = failReservationRelease(laterToken);
      try {
        await votosService.recoverPendingBatch();
      } finally {
        spy.mockRestore();
      }
      expect(wasIntercepted()).toBe(true);
      const failed = await connection.db!.collection('publicacoes').findOne({ _id: documents[0]._id });
      expect(failed!.votos_revisao).toBe(1);
      expect(failed!.votos_operacoes_pendentes.map((item: { token: string }) => item.token))
        .toEqual([laterToken]);
      expect(failed!.votos_proxima_tentativa_em.getTime()).toBeGreaterThan(Date.now());
      const ids = documents.map((item) => item._id);
      const remaining = () => connection.db!.collection('publicacoes').countDocuments({
        _id: { $in: ids }, votos_projecao_pendente: true,
      });
      expect(await remaining()).toBeGreaterThan(0);
      await votosService.recoverPendingBatch();
      expect(await remaining()).toBe(1);
      await expectState(1, 0);
      await connection.db!.collection('publicacoes').updateOne(
        { _id: documents[0]._id },
        { $set: { votos_proxima_tentativa_em: new Date(0) } },
      );
      await votosService.recoverPendingBatch();
      expect(await remaining()).toBe(0);
      const recovered = await connection.db!.collection('publicacoes').findOne({ _id: documents[0]._id });
      expect(recovered!.votos_operacoes_pendentes).toHaveLength(0);
      expect(recovered!.contadores).toMatchObject({ upvotes: 0, downvotes: 0, score: 0 });
      await expectState(1, 0);
    } finally {
      votosService.onModuleInit();
    }
  }, 60_000);
});
