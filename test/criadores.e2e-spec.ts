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
import { MEDIA_VERIFIER } from '../src/publicacoes/media-verifier.js';
import { Publicacao } from '../src/publicacoes/schemas/publicacao.schema.js';
import { SalvosService } from '../src/publicacoes/salvos.service.js';
import { VotosService } from '../src/publicacoes/votos.service.js';
import { CreatorStatsService } from '../src/usuarios/creator-stats.service.js';
import { SeguidoresService } from '../src/usuarios/seguidores.service.js';

const runId = randomBytes(8).toString('hex');
const mongoBase = process.env.MONGODB_URI;
const redisBase = process.env.REDIS_URL;
const config = (() => {
  try {
    if (!mongoBase || !redisBase || !process.env.JWT_SECRET || Buffer.byteLength(process.env.JWT_SECRET) < 32)
      return null;
    const mongo = new URL(mongoBase);
    const redis = new URL(redisBase);
    if (mongo.protocol !== 'mongodb:' || redis.protocol !== 'redis:' ||
      !['127.0.0.1', 'localhost'].includes(mongo.hostname) ||
      !['127.0.0.1', 'localhost'].includes(redis.hostname)) return null;
    mongo.pathname = `/ierri_criadores_test_${runId}`;
    return { mongo: mongo.toString(), sessionPrefix: `ierri:criadores:session:${runId}:`,
      ratePrefix: `ierri:criadores:rate:${runId}:`, cachePrefix: `ierri:criadores:cache:${runId}:` };
  } catch { return null; }
})();

type Account = { id: string; username: string; token: string };

describe.runIf(config)('contadores e ranking de criadores com MongoDB e Redis locais', () => {
  let app: INestApplication;
  let connection: Connection;
  let posts: Model<Publicacao>;
  let stats: CreatorStatsService;
  let inspector: ReturnType<typeof createClient>;
  let author: Account;
  let voter: Account;
  let peer: Account;
  let outsider: Account;
  const original = Object.fromEntries([
    'MONGODB_URI', 'REDIS_SESSION_PREFIX', 'REDIS_CHECK_EMAIL_RATE_PREFIX',
    'REDIS_CACHE_ENABLED', 'REDIS_CACHE_URL', 'REDIS_CACHE_PREFIX',
  ].map((key) => [key, process.env[key]]));
  const server = () => app.getHttpServer();
  const auth = (account: Account) => ({ Authorization: `Bearer ${account.token}` });
  const register = async (name: string): Promise<Account> => {
    const result = await request(server()).post('/auth/register').send({ name,
      email: `${name.toLowerCase()}-${runId}@example.invalid`,
      password: `Local-${randomBytes(12).toString('hex')}` }).expect(201);
    return { id: result.body.data.user.id as string,
      username: result.body.data.user.username as string,
      token: result.body.data.access_token as string };
  };
  const create = async (account: Account, visibilidade: 'publico' | 'seguidores' = 'publico') => {
    const media = randomBytes(16).toString('base64url');
    const result = await request(server()).post('/publicacoes').set(auth(account))
      .send({ conteudo: `Publicação ${media}`, visibilidade, midias: [media] }).expect(201);
    return result.body.data.id as string;
  };
  const profile = (account: Account) => request(server()).get(`/usuarios/${account.username}`);
  const self = (account: Account) => request(server()).get('/usuarios/me').set(auth(account));
  const rank = (query = '') => request(server()).get(`/usuarios/ranking${query}`);
  const score = async (account: Account) => (await self(account).expect(200)).body.data.contadores.score as number;

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
    const mediaVerifier = {
      resolveForPublication: async (_author: string, references: string[]) => references.map((reference) => ({
        referencia: reference, tipo: 'imagem' as const,
        url: `http://127.0.0.1:3001/publicacoes/midias/${reference}`,
        chave_storage: `criadores-test/${runId}/${reference}`,
        mime_type: 'image/png', tamanho_bytes: 100, largura: 1, altura: 1, duracao_segundos: null,
      })),
      confirmForPublication: async () => undefined,
      finalizeForPublication: async () => undefined,
      releaseForPublication: async () => undefined,
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MEDIA_VERIFIER).useValue(mediaVerifier).compile();
    app = module.createNestApplication();
    configureHttp(app);
    await app.init();
    connection = module.get<Connection>(getConnectionToken());
    posts = module.get<Model<Publicacao>>(getModelToken(Publicacao.name));
    stats = module.get(CreatorStatsService);
    stats.onModuleDestroy();
    await Promise.all([posts.init(), connection.model('Usuario').init(), connection.model('Voto').init()]);
    [author, voter, peer, outsider] = await Promise.all([
      register('CreatorAuthor'), register('CreatorVoter'),
      register('CreatorPeer'), register('CreatorOutsider'),
    ]);
  });

  beforeEach(async () => {
    await connection.db!.collection('votos').deleteMany({});
    await connection.db!.collection('publicacoes').deleteMany({});
    await connection.db!.collection('publicacoes_salvas').deleteMany({});
    await connection.db!.collection('seguidores').deleteMany({});
    await connection.db!.collection('usuarios').updateMany({}, { $set: {
      status: 'ativo', visibilidade_perfil: 'publico', excluido_em: null,
      'contadores.publicacoes': 0, 'contadores.score': 0,
      'contadores.seguidores': 0, 'contadores.seguindo': 0,
      criador_revisao: 0, criador_projecao_pendente: false,
      criador_proxima_tentativa_em: new Date('9999-12-31T23:59:59.999Z'),
    } });
  });

  afterAll(async () => {
    if (app) {
      await app.get(SeguidoresService).onModuleDestroy();
      app.get(VotosService).onModuleDestroy();
      app.get(SalvosService).onModuleDestroy();
      stats.onModuleDestroy();
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

  it('counts created public and restricted posts without revealing restricted totals', async () => {
    await create(author);
    await create(author, 'seguidores');
    expect((await self(author).expect(200)).body.data.contadores.publicacoes).toBe(2);
    expect((await profile(author).expect(200)).body.data.contadores.publicacoes).toBe(1);
    expect((await profile(author).set(auth(author)).expect(200)).body.data.contadores.publicacoes).toBe(2);
  });

  it('reconciles concurrent creations without duplicating the creator count', async () => {
    await Promise.all([create(author), create(author), create(author)]);
    await stats.recoverBatch();
    expect((await self(author).expect(200)).body.data.contadores.publicacoes).toBe(3);
    expect(await posts.countDocuments({ autor_id: new Types.ObjectId(author.id), status: 'publicada' })).toBe(3);
  });

  it('updates the public score when visibility changes and a post is deleted', async () => {
    const id = await create(author);
    await posts.updateOne({ _id: new Types.ObjectId(id) }, { $set: { 'contadores.score': -3 } }).exec();
    await stats.refresh(author.id);
    expect(await score(author)).toBe(-3);
    await request(server()).patch(`/publicacoes/${id}`).set(auth(author))
      .send({ visibilidade: 'seguidores' }).expect(200);
    expect(await score(author)).toBe(0);
    expect((await profile(author).expect(200)).body.data.contadores.publicacoes).toBe(0);
    await request(server()).patch(`/publicacoes/${id}`).set(auth(author))
      .send({ visibilidade: 'publico' }).expect(200);
    expect(await score(author)).toBe(-3);
    await request(server()).delete(`/publicacoes/${id}`).set(auth(author)).expect(200);
    expect((await self(author).expect(200)).body.data.contadores.publicacoes).toBe(0);
    expect(await score(author)).toBe(0);
  });

  it('excludes archived and hidden posts from creator totals', async () => {
    const id = await create(author);
    await posts.updateOne({ _id: new Types.ObjectId(id) }, { $set: { 'contadores.score': 4 } }).exec();
    await stats.refresh(author.id);
    expect(await score(author)).toBe(4);
    for (const status of ['arquivada', 'oculta'] as const) {
      await posts.updateOne({ _id: new Types.ObjectId(id) }, { $set: { status } }).exec();
      await stats.refresh(author.id);
      expect((await self(author).expect(200)).body.data.contadores).toMatchObject({ publicacoes: 0, score: 0 });
    }
  });

  it('tracks upvote, downvote, vote change and removal without changing the post score formula', async () => {
    const id = await create(author);
    const put = (valor: number) => request(server()).put(`/publicacoes/${id}/voto`)
      .set(auth(voter)).send({ valor });
    await put(1).expect(200);
    expect(await score(author)).toBe(1);
    await put(-1).expect(200);
    expect(await score(author)).toBe(-1);
    await request(server()).delete(`/publicacoes/${id}/voto`).set(auth(voter)).expect(200);
    expect(await score(author)).toBe(0);
  });

  it('omits counters from private profiles for visitors but keeps the owner total', async () => {
    await create(author, 'seguidores');
    await request(server()).patch('/usuarios/me').set(auth(author))
      .send({ visibilidadePerfil: 'privado' }).expect(200);
    expect((await profile(author).expect(200)).body.data).not.toHaveProperty('contadores');
    expect((await self(author).expect(200)).body.data.contadores.publicacoes).toBe(1);
  });

  it('orders all-time ranking by score and ID, including negatives, with cursor pagination', async () => {
    for (const [account, value] of [[author, 2], [voter, 2], [peer, -1]] as const) {
      const id = await create(account);
      await posts.updateOne({ _id: new Types.ObjectId(id) }, { $set: { 'contadores.score': value } }).exec();
      await stats.refresh(account.id);
    }
    const first = await rank('?limite=2').expect(200);
    const expected = [author, voter].sort((a, b) => b.id.localeCompare(a.id)).map((account) => account.id);
    expect(first.body.data.items.map((item: { id: string }) => item.id)).toEqual(expected);
    expect(first.body.data.hasMore).toBe(true);
    const second = await rank(`?limite=2&cursor=${first.body.data.nextCursor}`).expect(200);
    expect(second.body.data.items).toMatchObject([{ id: outsider.id, score: 0 }, { id: peer.id, score: -1 }]);
    expect(second.body.data.hasMore).toBe(false);
    expect(first.body.data.items[0]).toEqual({ id: expected[0], nome: expect.any(String),
      username: expect.any(String), avatarUrl: null, score: 2 });
  });

  it('excludes private and inactive creators before pagination', async () => {
    for (const account of [author, voter, peer]) {
      const id = await create(account);
      await posts.updateOne({ _id: new Types.ObjectId(id) }, { $set: { 'contadores.score': 5 } }).exec();
      await stats.refresh(account.id);
    }
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(author.id) },
      { $set: { visibilidade_perfil: 'privado' } });
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(voter.id) },
      { $set: { status: 'bloqueado' } });
    const result = await rank('?limite=1').expect(200);
    expect(result.body.data.items).toMatchObject([{ id: peer.id, score: 5 }]);
    expect(result.body.data.hasMore).toBe(true);
    const next = await rank(`?limite=1&cursor=${result.body.data.nextCursor}`).expect(200);
    expect(next.body.data.items).toMatchObject([{ id: outsider.id, score: 0 }]);
  });

  it('repairs a corrupted legacy counter and an incomplete dirty projection automatically', async () => {
    const id = await create(author);
    await posts.updateOne({ _id: new Types.ObjectId(id) }, { $set: { 'contadores.score': 4 } }).exec();
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(author.id) },
      { $set: { 'contadores.publicacoes': 999, 'contadores.score': 999 } });
    await stats.markDirty(author.id);
    await stats.recoverBatch();
    expect((await self(author).expect(200)).body.data.contadores).toMatchObject({ publicacoes: 1, score: 4 });
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(author.id) },
      { $set: { 'contadores.score': 999, criador_auditoria_em: null } });
    await stats.recoverBatch();
    expect(await score(author)).toBe(4);
  });

  it('does not award creator score for saving or following a post', async () => {
    const id = await create(author);
    await request(server()).put(`/publicacoes/${id}/salvar`).set(auth(voter)).expect(200);
    await request(server()).put(`/usuarios/${author.id}/seguir`).set(auth(voter)).expect(200);
    await stats.reconcile(author.id);
    expect(await score(author)).toBe(0);
  });

  it('rejects malformed cursors and resolves ranking before the username route', async () => {
    await rank('?cursor=invalid').expect(400);
    await rank('?limite=51').expect(400);
    expect((await rank().expect(200)).body.data).toHaveProperty('items');
  });
});
