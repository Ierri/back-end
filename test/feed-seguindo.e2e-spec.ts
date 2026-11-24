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
import { Publicacao } from '../src/publicacoes/schemas/publicacao.schema.js';
import { SeguidoresService } from '../src/usuarios/seguidores.service.js';

const runId = randomBytes(8).toString('hex');
const mongoBase = process.env.MONGODB_URI;
const redisBase = process.env.REDIS_URL;
const config = (() => {
  try {
    if (!mongoBase || !redisBase || !process.env.JWT_SECRET ||
      Buffer.byteLength(process.env.JWT_SECRET) < 32) return null;
    const mongo = new URL(mongoBase);
    const redis = new URL(redisBase);
    if (mongo.protocol !== 'mongodb:' || redis.protocol !== 'redis:' ||
      !['127.0.0.1', 'localhost'].includes(mongo.hostname) ||
      !['127.0.0.1', 'localhost'].includes(redis.hostname)) return null;
    mongo.pathname = `/ierri_feed_seguindo_test_${runId}`;
    return {
      mongo: mongo.toString(),
      sessionPrefix: `ierri:feed-following:session:${runId}:`,
      ratePrefix: `ierri:feed-following:rate:${runId}:`,
      cachePrefix: `ierri:feed-following:cache:${runId}:`,
    };
  } catch { return null; }
})();

type Account = { id: string; token: string };

describe.runIf(config)('feed de Seguindo com MongoDB e Redis locais', () => {
  let app: INestApplication;
  let connection: Connection;
  let publications: Model<Publicacao>;
  let cache: PublicacoesCacheService;
  let inspector: ReturnType<typeof createClient>;
  let viewer: Account;
  let otherViewer: Account;
  let followed: Account;
  let pendingAuthor: Account;
  let outsider: Account;
  let expected: string[];
  let publicPost: string;
  let outsiderPost: string;
  let pendingPublicPost: string;
  const original = Object.fromEntries([
    'MONGODB_URI', 'REDIS_SESSION_PREFIX', 'REDIS_CHECK_EMAIL_RATE_PREFIX',
    'REDIS_CACHE_ENABLED', 'REDIS_CACHE_URL', 'REDIS_CACHE_PREFIX',
  ].map((key) => [key, process.env[key]]));
  const server = () => app.getHttpServer();
  const auth = (account: Account) => ({ Authorization: `Bearer ${account.token}` });
  const feed = (account?: Account, query = '') => {
    const call = request(server()).get(`/publicacoes?escopo=seguindo${query}`);
    return account ? call.set(auth(account)) : call;
  };
  const register = async (name: string): Promise<Account> => {
    const result = await request(server()).post('/auth/register').send({
      name,
      email: `${name.toLowerCase()}-${runId}@example.invalid`,
      password: `Local-${randomBytes(12).toString('hex')}`,
    }).expect(201);
    return { id: result.body.data.user.id as string, token: result.body.data.access_token as string };
  };
  const makePost = async (author: Account, visibility: 'publico' | 'seguidores', publishedAt: Date) => {
    const reference = randomBytes(16).toString('base64url');
    const created = await publications.create({
      slug: `feed-${runId}-${reference}`,
      autor_id: new Types.ObjectId(author.id),
      conteudo: `Publicação ${reference}`,
      status: 'publicada',
      visibilidade: visibility,
      publicada_em: publishedAt,
      midias: [{
        _id: new Types.ObjectId(), tipo: 'imagem',
        url: `http://127.0.0.1:3001/publicacoes/midias/${reference}`,
        chave_storage: `feed-test/${runId}/${reference}`,
        mime_type: 'image/png', tamanho_bytes: 100,
        largura: 1, altura: 1, duracao_segundos: null,
        texto_alternativo: null, ordem: 0,
      }],
    });
    return created._id.toString();
  };
  const follow = (account: Account, target: Account) => request(server())
    .put(`/usuarios/${target.id}/seguir`).set(auth(account));
  const items = (response: { body: { data: { items: { id: string }[] } } }) =>
    response.body.data.items.map((item) => item.id);
  const setScore = (id: string, score: number) => publications.updateOne(
    { _id: new Types.ObjectId(id) }, { $set: { 'contadores.score': score } },
  ).exec();

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
    await Promise.all([
      connection.model('Publicacao').init(),
      connection.model('Voto').init(),
      connection.model('Seguidor').init(),
    ]);
    cache = module.get(PublicacoesCacheService);
    const cacheClient = module.get(PublicacoesCacheClient);
    for (let attempt = 0; attempt < 30 && !cacheClient.ready; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cacheClient.ready).toBe(true);
    [viewer, otherViewer, followed, pendingAuthor, outsider] = await Promise.all([
      register('Viewer'), register('OtherViewer'), register('Followed'),
      register('PendingAuthor'), register('Outsider'),
    ]);
    const now = Date.now();
    const first = await makePost(followed, 'seguidores', new Date(now - 1000));
    const second = await makePost(followed, 'publico', new Date(now - 1000));
    const third = await makePost(followed, 'seguidores', new Date(now - 3000));
    expected = [first, second].sort((left, right) => right.localeCompare(left)).concat(third);
    publicPost = second;
    pendingPublicPost = await makePost(pendingAuthor, 'publico', new Date(now + 2000));
    await makePost(pendingAuthor, 'seguidores', new Date(now + 1000));
    outsiderPost = await makePost(outsider, 'publico', new Date(now + 3000));
    await makePost(viewer, 'publico', new Date(now + 4000));
  });

  beforeEach(async () => {
    await connection.db!.collection('seguidores').deleteMany({});
    await connection.db!.collection('votos').deleteMany({});
    await publications.updateMany({}, { $set: {
      'contadores.upvotes': 0, 'contadores.downvotes': 0, 'contadores.score': 0,
      votos_projecao_pendente: false, votos_operacoes_pendentes: [],
    } }).exec();
    await connection.db!.collection('usuarios').updateMany({}, {
      $set: { status: 'ativo', excluido_em: null, 'contadores.seguidores': 0, 'contadores.seguindo': 0 },
    });
    await connection.db!.collection('usuarios').updateOne(
      { _id: new Types.ObjectId(pendingAuthor.id) }, { $set: { visibilidade_perfil: 'privado' } },
    );
  });

  afterAll(async () => {
    if (app) await app.get(SeguidoresService).onModuleDestroy();
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

  it('requires a valid active session and rejects autorId with the Following scope', async () => {
    await feed().expect(401);
    await request(server()).get('/publicacoes?escopo=seguindo')
      .set('Authorization', 'Bearer invalid').expect(401);
    await feed(viewer, `&autorId=${followed.id}`).expect(400);
  });

  it('returns a valid empty page when no accepted relationship exists', async () => {
    const result = await feed(viewer).expect(200);
    expect(result.body.data).toEqual({ items: [], nextCursor: null, hasMore: false });
    expect(items(result)).not.toContain(publicPost);
  });

  it('includes public and restricted posts from accepted authors but excludes pending, outsiders and own posts', async () => {
    await follow(viewer, followed).expect(200);
    await follow(viewer, pendingAuthor).expect(200);
    const result = await feed(viewer).expect(200);
    expect(items(result)).toEqual(expected);
    expect(result.body.data.items.some((item: { visibilidade: string }) => item.visibilidade === 'seguidores')).toBe(true);
  });

  it('includes a private-profile author only after the follow request is accepted', async () => {
    await follow(viewer, pendingAuthor).expect(200);
    expect(items(await feed(viewer).expect(200))).toEqual([]);
    const relation = await connection.db!.collection('seguidores').findOne({
      seguidor_id: new Types.ObjectId(viewer.id),
      seguido_id: new Types.ObjectId(pendingAuthor.id),
    });
    expect(relation?.status).toBe('pendente');
    await request(server()).put(`/usuarios/me/solicitacoes/${relation!._id.toString()}/aceitar`)
      .set(auth(pendingAuthor)).expect(200);
    const result = await feed(viewer).expect(200);
    expect(result.body.data.items).toHaveLength(2);
    expect(result.body.data.items.map((item: { autor: { id: string } }) => item.autor.id))
      .toEqual([pendingAuthor.id, pendingAuthor.id]);
  });

  it('revokes access on the next request after unfollowing', async () => {
    await follow(viewer, followed).expect(200);
    expect(items(await feed(viewer).expect(200))).toEqual(expected);
    await request(server()).delete(`/usuarios/${followed.id}/seguir`).set(auth(viewer)).expect(200);
    expect(items(await feed(viewer).expect(200))).toEqual([]);
  });

  it('excludes inactive authors and rejects blocked or excluded viewers', async () => {
    await follow(viewer, followed).expect(200);
    for (const status of ['bloqueado', 'excluido'] as const) {
      await connection.db!.collection('usuarios').updateOne(
        { _id: new Types.ObjectId(followed.id) },
        { $set: { status, excluido_em: status === 'excluido' ? new Date() : null } },
      );
      expect(items(await feed(viewer).expect(200))).toEqual([]);
      await connection.db!.collection('usuarios').updateOne(
        { _id: new Types.ObjectId(followed.id) }, { $set: { status: 'ativo', excluido_em: null } },
      );
      await connection.db!.collection('usuarios').updateOne(
        { _id: new Types.ObjectId(viewer.id) },
        { $set: { status, excluido_em: status === 'excluido' ? new Date() : null } },
      );
      await feed(viewer).expect(401);
      await connection.db!.collection('usuarios').updateOne(
        { _id: new Types.ObjectId(viewer.id) }, { $set: { status: 'ativo', excluido_em: null } },
      );
    }
  });

  it('orders by publication date and ID and paginates without loss or duplication', async () => {
    await follow(viewer, followed).expect(200);
    const first = await feed(viewer, '&limite=2').expect(200);
    expect(items(first)).toEqual(expected.slice(0, 2));
    expect(first.body.data.hasMore).toBe(true);
    const second = await feed(viewer, `&limite=2&cursor=${first.body.data.nextCursor}`).expect(200);
    expect(items(second)).toEqual(expected.slice(2));
    expect(second.body.data).toMatchObject({ nextCursor: null, hasMore: false });
    expect(new Set([...items(first), ...items(second)]).size).toBe(expected.length);
  });

  it('rejects cursors from the general feed, other viewers and the reverse direction', async () => {
    await follow(viewer, followed).expect(200);
    const following = await feed(viewer, '&limite=1').expect(200);
    const cursor = following.body.data.nextCursor as string;
    await feed(otherViewer, `&limite=1&cursor=${cursor}`).expect(400);
    await request(server()).get(`/publicacoes?limite=1&cursor=${cursor}`)
      .set(auth(viewer)).expect(400);
    const general = await request(server()).get('/publicacoes?limite=1').expect(200);
    await feed(viewer, `&limite=1&cursor=${general.body.data.nextCursor}`).expect(400);
  });

  it('keeps Following pages out of the shared Redis cache while the general feed remains available', async () => {
    await follow(viewer, followed).expect(200);
    const pageAddress = vi.spyOn(cache, 'pageAddress');
    try {
      expect(items(await feed(viewer).expect(200))).toEqual(expected);
      expect(items(await feed(viewer).expect(200))).toEqual(expected);
      expect(pageAddress).not.toHaveBeenCalled();
      await request(server()).get('/publicacoes?limite=1').expect(200);
      expect(pageAddress).toHaveBeenCalled();
    } finally {
      pageAddress.mockRestore();
    }
  });

  it('ranks positive, zero and negative scores ahead of publication age', async () => {
    await follow(viewer, followed).expect(200);
    await setScore(expected[2], 5);
    await setScore(expected[1], -2);
    const result = await feed(viewer, '&ordem=score').expect(200);
    expect(items(result)).toEqual([expected[2], expected[0], expected[1]]);
    expect(result.body.data.items.map((item: { contadores: { score: number } }) => item.contadores.score))
      .toEqual([5, 0, -2]);
  });

  it('filters inactive authors before ranking pagination', async () => {
    await setScore(outsiderPost, 100);
    await setScore(pendingPublicPost, 1);
    await connection.db!.collection('usuarios').updateOne(
      { _id: new Types.ObjectId(outsider.id) }, { $set: { status: 'bloqueado' } },
    );
    const result = await request(server()).get('/publicacoes?ordem=score&limite=1').expect(200);
    expect(items(result)).toEqual([pendingPublicPost]);
    expect(result.body.data.hasMore).toBe(true);
  });

  it('applies accepted-follow and privacy filters before ranking pagination', async () => {
    await follow(viewer, followed).expect(200);
    await follow(viewer, pendingAuthor).expect(200);
    await setScore(pendingPublicPost, 100);
    await setScore(expected[2], 2);
    const result = await feed(viewer, '&ordem=score&limite=1').expect(200);
    expect(items(result)).toEqual([expected[2]]);
    expect(result.body.data.hasMore).toBe(true);
  });

  it('updates the ranking after effective votes without changing the score formula', async () => {
    await follow(viewer, followed).expect(200);
    await request(server()).put(`/publicacoes/${publicPost}/voto`).set(auth(viewer))
      .send({ valor: 1 }).expect(200);
    expect(items(await feed(viewer, '&ordem=score').expect(200))[0]).toBe(publicPost);
    await request(server()).put(`/publicacoes/${publicPost}/voto`).set(auth(otherViewer))
      .send({ valor: -1 }).expect(200);
    expect((await request(server()).get(`/publicacoes/${publicPost}`).expect(200)).body.data.contadores.score).toBe(0);
    await request(server()).delete(`/publicacoes/${publicPost}/voto`).set(auth(viewer)).expect(200);
    const result = await feed(viewer, '&ordem=score').expect(200);
    expect(items(result).at(-1)).toBe(publicPost);
    expect(result.body.data.items.at(-1).contadores.score).toBe(-1);
  });

  it('paginates score, publication-date and ID ties without losing or duplicating records', async () => {
    await follow(viewer, followed).expect(200);
    for (const id of expected) await setScore(id, 2);
    const ordered = expected;
    const pages = [];
    let cursor: string | null = null;
    for (let index = 0; index < ordered.length; index++) {
      const result = await feed(viewer, `&ordem=score&limite=1${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
      pages.push(...items(result));
      cursor = result.body.data.nextCursor as string | null;
    }
    expect(pages).toEqual(ordered);
    expect(new Set(pages).size).toBe(ordered.length);
    expect(cursor).toBeNull();
  });

  it('isolates ranking cursors by order, viewer and feed scope', async () => {
    await follow(viewer, followed).expect(200);
    const following = await feed(viewer, '&ordem=score&limite=1').expect(200);
    const cursor = following.body.data.nextCursor as string;
    await feed(otherViewer, `&ordem=score&limite=1&cursor=${cursor}`).expect(400);
    await feed(viewer, `&limite=1&cursor=${cursor}`).expect(400);
    await request(server()).get(`/publicacoes?ordem=score&limite=1&cursor=${cursor}`)
      .set(auth(viewer)).expect(400);
    const chronological = await feed(viewer, '&limite=1').expect(200);
    await feed(viewer, `&ordem=score&limite=1&cursor=${chronological.body.data.nextCursor}`).expect(400);
  });

  it('bypasses shared cache for anonymous and Following rankings while preserving chronological cache', async () => {
    await follow(viewer, followed).expect(200);
    const pageAddress = vi.spyOn(cache, 'pageAddress');
    try {
      await request(server()).get('/publicacoes?ordem=score').expect(200);
      await feed(viewer, '&ordem=score').expect(200);
      expect(pageAddress).not.toHaveBeenCalled();
      await request(server()).get('/publicacoes?limite=1').expect(200);
      expect(pageAddress).toHaveBeenCalled();
    } finally {
      pageAddress.mockRestore();
    }
  });
});
