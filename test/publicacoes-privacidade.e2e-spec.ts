import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import { createClient } from 'redis';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureHttp } from '../src/common/http/configure-http.js';
import { MediaStorageService } from '../src/publicacoes/media-storage.service.js';
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
      Buffer.byteLength(process.env.JWT_SECRET) < 32 ||
      !process.env.S3_ENDPOINT || !process.env.S3_ACCESS_KEY_ID ||
      !process.env.S3_SECRET_ACCESS_KEY || !process.env.S3_BUCKET ||
      !process.env.MEDIA_PUBLIC_BASE_URL) return null;
    const mongo = new URL(mongoBase);
    const redis = new URL(redisBase);
    const s3 = new URL(process.env.S3_ENDPOINT);
    if (mongo.protocol !== 'mongodb:' || redis.protocol !== 'redis:' ||
      !['localhost', '127.0.0.1'].includes(mongo.hostname) ||
      !['localhost', '127.0.0.1'].includes(redis.hostname) ||
      !['localhost', '127.0.0.1'].includes(s3.hostname)) return null;
    mongo.pathname = `/ierri_privacidade_test_${runId}`;
    return {
      mongo: mongo.toString(),
      cachePrefix: `ierri:privacy:cache:${runId}:`,
      sessionPrefix: `ierri:privacy:session:${runId}:`,
      ratePrefix: `ierri:privacy:rate:${runId}:`,
    };
  } catch { return null; }
})();

type Account = { id: string; token: string };

describe.runIf(config)('privacidade de publicações com MongoDB, Redis e MinIO locais', () => {
  let app: INestApplication;
  let connection: Connection;
  let publications: Model<Publicacao>;
  let storage: MediaStorageService;
  let cache: PublicacoesCacheService;
  let inspector: ReturnType<typeof createClient>;
  let author: Account;
  let follower: Account;
  let pending: Account;
  let outsider: Account;
  let restrictedId: string;
  let publicId: string;
  let olderId: string;
  let reference: string;
  const storageKeys: string[] = [];
  const original = Object.fromEntries([
    'MONGODB_URI', 'REDIS_SESSION_PREFIX', 'REDIS_CHECK_EMAIL_RATE_PREFIX',
    'REDIS_CACHE_ENABLED', 'REDIS_CACHE_URL', 'REDIS_CACHE_PREFIX',
  ].map((key) => [key, process.env[key]]));
  const server = () => app.getHttpServer();
  const auth = (account: Account) => ({ Authorization: `Bearer ${account.token}` });
  const detail = (id: string, account?: Account) => {
    const call = request(server()).get(`/publicacoes/${id}`);
    return account ? call.set(auth(account)) : call;
  };
  const list = (query: string, account?: Account) => {
    const call = request(server()).get(`/publicacoes${query}`);
    return account ? call.set(auth(account)) : call;
  };
  const media = (account?: Account) => {
    const call = request(server()).get(`/publicacoes/midias/${reference}`);
    return account ? call.set(auth(account)) : call;
  };
  const comments = (account?: Account) => {
    const call = request(server()).get(`/publicacoes/${restrictedId}/comentarios`);
    return account ? call.set(auth(account)) : call;
  };
  const vote = (account: Account) => request(server()).get(`/publicacoes/${restrictedId}/voto`).set(auth(account));
  const relation = (account: Account) => ({
    seguidor_id: new Types.ObjectId(account.id),
    seguido_id: new Types.ObjectId(author.id),
  });
  const accept = async (account: Account) => {
    await request(server()).put(`/usuarios/${author.id}/seguir`).set(auth(account)).expect(200);
    const pendingRelation = await connection.db!.collection('seguidores').findOne(relation(account));
    expect(pendingRelation?.status).toBe('pendente');
    await request(server()).put(`/usuarios/me/solicitacoes/${pendingRelation!._id.toString()}/aceitar`)
      .set(auth(author)).expect(200);
  };
  const account = async (name: string): Promise<Account> => {
    const created = await request(server()).post('/auth/register').send({
      name,
      email: `${name.toLowerCase()}-${runId}@example.invalid`,
      password: `Local-${randomBytes(12).toString('hex')}`,
    }).expect(201);
    return { id: created.body.data.user.id as string, token: created.body.data.access_token as string };
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
    storage = module.get(MediaStorageService);
    cache = module.get(PublicacoesCacheService);
    const cacheClient = module.get(PublicacoesCacheClient);
    for (let attempt = 0; attempt < 30 && !cacheClient.ready; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cacheClient.ready).toBe(true);
    [author, follower, pending, outsider] = await Promise.all([
      account('Author'), account('Follower'), account('Pending'), account('Outsider'),
    ]);
    const now = Date.now();
    const createPost = async (visibility: 'publico' | 'seguidores', offset: number) => {
      const id = new Types.ObjectId();
      const ref = randomBytes(16).toString('base64url');
      const key = `privacy-e2e/${runId}/${ref}`;
      const bytes = Buffer.from(`test-media-${runId}-${offset}`);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const post = await publications.create({
        _id: id,
        slug: `privacy-${runId}-${offset}`,
        autor_id: new Types.ObjectId(author.id),
        conteudo: `Publicação ${offset}`,
        visibilidade: visibility,
        status: 'publicada',
        publicada_em: new Date(now - offset * 1000),
        midias: [{
          _id: new Types.ObjectId(), tipo: 'imagem', url: storage.publicUrl(ref),
          chave_storage: key, mime_type: 'image/png', tamanho_bytes: bytes.length,
          largura: 1, altura: 1, duracao_segundos: null, texto_alternativo: null, ordem: 0,
        }],
      });
      await storage.put(key, bytes, 'image/png', hash);
      storageKeys.push(key);
      await connection.db!.collection('uploads_midias').insertOne({
        referencia: ref, usuario_id: new Types.ObjectId(author.id),
        chave_storage: key, tipo: 'imagem', mime_type: 'image/png',
        tamanho_bytes: bytes.length, largura: 1, altura: 1, duracao_segundos: null,
        sha256: hash, estado: 'vinculada', publicacao_id: post._id,
        reservada_em: null, expira_em: null, criado_em: new Date(), atualizado_em: new Date(),
      });
      if (offset === 0) reference = ref;
      return post._id.toString();
    };
    restrictedId = await createPost('seguidores', 0);
    publicId = await createPost('publico', 1);
    olderId = await createPost('seguidores', 2);
  });

  beforeEach(async () => {
    await connection.db!.collection('seguidores').deleteMany({});
    await connection.db!.collection('comentarios').deleteMany({});
    await connection.db!.collection('votos').deleteMany({});
    await connection.db!.collection('usuarios').updateMany({}, {
      $set: { status: 'ativo', excluido_em: null, 'contadores.seguidores': 0, 'contadores.seguindo': 0 },
    });
    await request(server()).patch('/usuarios/me').set(auth(author))
      .send({ visibilidadePerfil: 'privado' }).expect(200);
    await publications.updateOne({ _id: new Types.ObjectId(publicId) }, { $set: { visibilidade: 'publico' } }).exec();
    await cache.invalidate(publicId, author.id);
  });

  afterAll(async () => {
    if (app) await app.get(SeguidoresService).onModuleDestroy();
    if (storage) for (const key of storageKeys) await storage.remove(key).catch(() => undefined);
    if (connection?.db) await connection.db.dropDatabase();
    if (inspector?.isReady) {
      for (const prefix of [config!.cachePrefix, config!.sessionPrefix, config!.ratePrefix]) {
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

  it('keeps public content visible to visitors despite a private author profile', async () => {
    await detail(publicId).expect(200);
    await list(`?autorId=${author.id}`).expect(200).then((response) => {
      expect(response.body.data.items.map((item: { id: string }) => item.id)).toEqual([publicId]);
    });
  });

  it('allows the author to read restricted details, list and media', async () => {
    await detail(restrictedId, author).expect(200);
    const result = await list(`?autorId=${author.id}`, author).expect(200);
    expect(result.body.data.items.map((item: { id: string }) => item.id)).toEqual([restrictedId, publicId, olderId]);
    await media(author).expect(200);
  });

  it('denies pending followers and strangers across posts, media, comments and votes', async () => {
    await request(server()).put(`/usuarios/${author.id}/seguir`).set(auth(pending)).expect(200);
    for (const viewer of [pending, outsider]) {
      await detail(restrictedId, viewer).expect(404);
      await media(viewer).expect(404);
      await comments(viewer).expect(404);
      await vote(viewer).expect(404);
      await request(server()).put(`/publicacoes/${restrictedId}/voto`).set(auth(viewer)).send({ valor: 1 }).expect(404);
      await request(server()).post(`/publicacoes/${restrictedId}/comentarios`).set(auth(viewer))
        .send({ conteudo: 'Sem acesso' }).expect(404);
      const result = await list(`?autorId=${author.id}`, viewer).expect(200);
      expect(result.body.data.items.map((item: { id: string }) => item.id)).toEqual([publicId]);
    }
    await detail(restrictedId).expect(404);
    await media().expect(404);
    await comments().expect(404);
  });

  it('allows an accepted follower to read, comment and vote on restricted content', async () => {
    await accept(follower);
    await detail(restrictedId, follower).expect(200);
    await media(follower).expect(200);
    await comments(follower).expect(200);
    const comment = await request(server()).post(`/publicacoes/${restrictedId}/comentarios`)
      .set(auth(follower)).send({ conteudo: 'Comentário autorizado' }).expect(201);
    await request(server()).get(`/comentarios/${comment.body.data.id}/respostas`).set(auth(follower)).expect(200);
    await request(server()).get(`/comentarios/${comment.body.data.id}/respostas`).set(auth(outsider)).expect(404);
    await request(server()).put(`/publicacoes/${restrictedId}/voto`).set(auth(follower))
      .send({ valor: 1 }).expect(200);
    expect((await vote(follower).expect(200)).body.data.valor).toBe(1);
  });

  it('revokes access on the next request after unfollowing', async () => {
    await accept(follower);
    await detail(restrictedId, follower).expect(200);
    await request(server()).delete(`/usuarios/${author.id}/seguir`).set(auth(follower)).expect(200);
    await detail(restrictedId, follower).expect(404);
    await media(follower).expect(404);
    await comments(follower).expect(404);
    await vote(follower).expect(404);
    expect((await list(`?autorId=${author.id}`, follower).expect(200)).body.data.items)
      .toHaveLength(1);
  });

  it('denies inactive followers and inactive authors through old relationships', async () => {
    await accept(follower);
    for (const status of ['bloqueado', 'excluido'] as const) {
      await connection.db!.collection('usuarios').updateOne(
        { _id: new Types.ObjectId(follower.id) },
        { $set: { status, excluido_em: status === 'excluido' ? new Date() : null } },
      );
      await detail(restrictedId, follower).expect(401);
      await connection.db!.collection('usuarios').updateOne(
        { _id: new Types.ObjectId(follower.id) }, { $set: { status: 'ativo', excluido_em: null } },
      );
      await connection.db!.collection('usuarios').updateOne(
        { _id: new Types.ObjectId(author.id) },
        { $set: { status, excluido_em: status === 'excluido' ? new Date() : null } },
      );
      await detail(restrictedId, follower).expect(404);
      expect((await list(`?autorId=${author.id}`, follower).expect(200)).body.data.items)
        .toHaveLength(0);
      await connection.db!.collection('usuarios').updateOne(
        { _id: new Types.ObjectId(author.id) }, { $set: { status: 'ativo', excluido_em: null } },
      );
    }
  });

  it('filters restricted posts before pagination without losing or duplicating records', async () => {
    await accept(follower);
    const first = await list('?limite=2', follower).expect(200);
    const second = await list(`?limite=2&cursor=${first.body.data.nextCursor}`, follower).expect(200);
    expect([...first.body.data.items, ...second.body.data.items].map((item: { id: string }) => item.id))
      .toEqual([restrictedId, publicId, olderId]);
    await list(`?limite=2&cursor=${first.body.data.nextCursor}`, outsider).expect(400);
    const visitor = await list('?limite=1').expect(200);
    expect(visitor.body.data.items.map((item: { id: string }) => item.id)).toEqual([publicId]);
    expect(visitor.body.data.hasMore).toBe(false);
  });

  it('does not reuse public cache entries after a post becomes restricted', async () => {
    await detail(publicId).expect(200);
    const address = (await cache.postAddress(publicId))!;
    expect(await inspector.get(address.key)).not.toBeNull();
    await request(server()).patch(`/publicacoes/${publicId}`).set(auth(author))
      .send({ visibilidade: 'seguidores' }).expect(200);
    await detail(publicId).expect(404);
    await detail(publicId, outsider).expect(404);
    await accept(follower);
    await detail(publicId, follower).expect(200);
    expect(await inspector.get((await cache.postAddress(publicId))!.key)).toBeNull();
  });
});
