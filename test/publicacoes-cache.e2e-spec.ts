import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import { createClient } from 'redis';
import request from 'supertest';
import sharp from 'sharp';
import { AppModule } from '../src/app.module.js';
import { configureHttp } from '../src/common/http/configure-http.js';
import { PublicacoesCacheClient } from '../src/publicacoes/publicacoes-cache.client.js';
import { PublicacoesCacheService } from '../src/publicacoes/publicacoes-cache.service.js';
import { MediaStorageService } from '../src/publicacoes/media-storage.service.js';
import { Publicacao } from '../src/publicacoes/schemas/publicacao.schema.js';

const baseMongoUri = process.env.MONGODB_URI;
const baseRedisUrl = process.env.REDIS_URL;
const secret = process.env.JWT_SECRET;
const runId = randomBytes(8).toString('hex');
const localS3 = (() => {
  try {
    const endpoint = new URL(process.env.S3_ENDPOINT ?? '');
    return (
      ['127.0.0.1', 'localhost'].includes(endpoint.hostname) &&
      Boolean(
        process.env.S3_ACCESS_KEY_ID &&
        process.env.S3_SECRET_ACCESS_KEY &&
        process.env.S3_BUCKET &&
        process.env.MEDIA_PUBLIC_BASE_URL,
      )
    );
  } catch {
    return false;
  }
})();
const config = (() => {
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
      redis.protocol !== 'redis:' ||
      !['127.0.0.1', 'localhost'].includes(mongo.hostname) ||
      !['127.0.0.1', 'localhost'].includes(redis.hostname)
    )
      return null;
    mongo.pathname = `/ierri_cache_test_${runId}`;
    return {
      mongoUri: mongo.toString(),
      cachePrefix: `ierri:cache:e2e:${runId}:`,
      sessionPrefix: `ierri:e2e:session:${runId}:`,
      ratePrefix: `ierri:e2e:rate:${runId}:`,
    };
  } catch {
    return null;
  }
})();

describe.runIf(config)(
  'Publicacoes Redis cache with local MongoDB and Redis',
  () => {
    let app: INestApplication;
    let connection: Connection;
    let publications: Model<Publicacao>;
    let cache: PublicacoesCacheService;
    let cacheClient: PublicacoesCacheClient;
    let storage: MediaStorageService;
    let inspector: ReturnType<typeof createClient>;
    let tokenA: string;
    let tokenB: string;
    let authorA: string;
    let authorB: string;
    let posts: {
      first: string;
      second: string;
      other: string;
      third: string;
      private: string;
    };
    const original = Object.fromEntries(
      [
        'MONGODB_URI',
        'REDIS_SESSION_PREFIX',
        'REDIS_CHECK_EMAIL_RATE_PREFIX',
        'REDIS_CACHE_ENABLED',
        'REDIS_CACHE_URL',
        'REDIS_CACHE_PREFIX',
      ].map((key) => [key, process.env[key]]),
    );

    const media = (reference: string) => ({
      _id: new Types.ObjectId(),
      tipo: 'imagem' as const,
      url: `http://127.0.0.1:33001/publicacoes/midias/${reference}`,
      chave_storage: `cache-e2e/${runId}/${reference}`,
      mime_type: 'image/png',
      tamanho_bytes: 100,
      largura: 10,
      altura: 10,
      duracao_segundos: null,
      texto_alternativo: null,
      ordem: 0,
    });

    async function insertPost(
      authorId: string,
      content: string,
      publishedAt: Date,
      visibility: 'publico' | 'seguidores' = 'publico',
    ) {
      const created = await publications.create({
        slug: `cache-${runId}-${randomBytes(5).toString('hex')}`,
        autor_id: new Types.ObjectId(authorId),
        conteudo: content,
        midias: [media(randomBytes(12).toString('base64url'))],
        visibilidade: visibility,
        status: 'publicada',
        publicada_em: publishedAt,
      });
      return created._id.toString();
    }

    async function list(query = '') {
      return request(app.getHttpServer())
        .get(`/publicacoes${query}`)
        .expect(200);
    }

    async function cacheKeys(pattern: string) {
      const keys: string[] = [];
      for await (const batch of inspector.scanIterator({
        MATCH: pattern,
        COUNT: 100,
      }))
        keys.push(...batch);
      return keys;
    }

    beforeAll(async () => {
      process.env.MONGODB_URI = config!.mongoUri;
      process.env.REDIS_SESSION_PREFIX = config!.sessionPrefix;
      process.env.REDIS_CHECK_EMAIL_RATE_PREFIX = config!.ratePrefix;
      process.env.REDIS_CACHE_ENABLED = 'true';
      process.env.REDIS_CACHE_URL = baseRedisUrl;
      process.env.REDIS_CACHE_PREFIX = config!.cachePrefix;
      inspector = createClient({ url: baseRedisUrl });
      inspector.on('error', () => {});
      await inspector.connect();
      const module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = module.createNestApplication();
      configureHttp(app);
      await app.init();
      connection = module.get<Connection>(getConnectionToken());
      publications = module.get<Model<Publicacao>>(
        getModelToken(Publicacao.name),
      );
      cache = module.get(PublicacoesCacheService);
      cacheClient = module.get(PublicacoesCacheClient);
      storage = module.get(MediaStorageService);
      for (let attempt = 0; attempt < 30 && !cacheClient.ready; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      expect(cacheClient.ready).toBe(true);
      const password = `Local-${randomBytes(12).toString('hex')}`;
      const first = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Autora Cache',
          email: `cache-a-${runId}@example.invalid`,
          password,
        })
        .expect(201);
      tokenA = first.body.data.access_token;
      authorA = first.body.data.user.id;
      const second = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Outro Usuário',
          email: `cache-b-${runId}@example.invalid`,
          password,
        })
        .expect(201);
      tokenB = second.body.data.access_token;
      authorB = second.body.data.user.id;
      const now = Date.now();
      posts = {
        first: await insertPost(authorA, 'Primeira', new Date(now - 1000)),
        second: await insertPost(authorA, 'Segunda', new Date(now - 2000)),
        other: await insertPost(authorB, 'Outra pessoa', new Date(now - 3000)),
        third: await insertPost(authorB, 'Terceira', new Date(now - 3500)),
        private: await insertPost(
          authorA,
          'Restrita',
          new Date(now - 4000),
          'seguidores',
        ),
      };
    });

    afterAll(async () => {
      if (connection?.db) {
        const uploads = await connection.db
          .collection('uploads_midias')
          .find({}, { projection: { chave_storage: 1 } })
          .toArray();
        for (const upload of uploads)
          await storage.remove(upload.chave_storage).catch(() => undefined);
        await connection.db.dropDatabase();
      }
      if (inspector?.isReady) {
        for (const prefix of [
          config!.cachePrefix,
          config!.sessionPrefix,
          config!.ratePrefix,
        ]) {
          const keys = await cacheKeys(`${prefix}*`);
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

    it('misses once, then serves the identical public feed from Redis', async () => {
      const before = cache.metrics();
      const first = await list('?limite=2');
      const afterFirst = cache.metrics();
      expect(afterFirst.mongoAfterMiss).toBe(before.mongoAfterMiss + 1);
      const second = await list('?limite=2');
      expect(second.body).toEqual(first.body);
      expect(cache.metrics().hit).toBeGreaterThan(afterFirst.hit);
      expect(cache.metrics().mongoAfterMiss).toBe(afterFirst.mongoAfterMiss);
      expect(first.body.data.items).toHaveLength(2);
      expect(first.body.data.hasMore).toBe(true);
      expect(first.body.data.nextCursor).toBeTypeOf('string');
      expect(
        (await cacheKeys(`${config!.cachePrefix}feed:*`)).length,
      ).toBeGreaterThan(0);
    });

    it('isolates limit, cursor, author and owner scope', async () => {
      const first = await list('?limite=1');
      const cursor = first.body.data.nextCursor as string;
      const next = await list(`?limite=1&cursor=${cursor}`);
      expect(next.body.data.items[0].id).not.toBe(first.body.data.items[0].id);
      const publicAuthor = await list(`?autorId=${authorA}`);
      expect(
        publicAuthor.body.data.items.map((item: { id: string }) => item.id),
      ).not.toContain(posts.private);
      const owner = await request(app.getHttpServer())
        .get(`/publicacoes?autorId=${authorA}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(
        owner.body.data.items.map((item: { id: string }) => item.id),
      ).toContain(posts.private);
      const other = await request(app.getHttpServer())
        .get(`/publicacoes?autorId=${authorA}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      expect(other.body.data).toEqual(publicAuthor.body.data);
      expect(
        (await cacheKeys(`${config!.cachePrefix}feed:*`)).length,
      ).toBeGreaterThanOrEqual(3);
      expect(
        (await cacheKeys(`${config!.cachePrefix}author:*`)).length,
      ).toBeGreaterThanOrEqual(1);
    });

    it('expires entries and treats corrupted JSON as a miss', async () => {
      await list('?limite=19');
      const address = (await cache.pageAddress(19, null, null, false))!;
      expect(await inspector.get(address.key)).not.toBeNull();
      await inspector.set(address.key, '{broken', { EX: 20 });
      const beforeCorrupt = cache.metrics();
      await list('?limite=19');
      expect(cache.metrics().error).toBeGreaterThan(beforeCorrupt.error);
      expect(cache.metrics().mongoAfterMiss).toBe(
        beforeCorrupt.mongoAfterMiss + 1,
      );
      await inspector.expire(address.key, 1);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const beforeExpiry = cache.metrics().mongoAfterMiss;
      await list('?limite=19');
      expect(cache.metrics().mongoAfterMiss).toBe(beforeExpiry + 1);
    });

    it('validates author metadata even when its cache generation did not change', async () => {
      await list(`?autorId=${authorA}&limite=18`);
      const before = cache.metrics().mongoAfterMiss;
      await connection
        .db!.collection('usuarios')
        .updateOne(
          { _id: new Types.ObjectId(authorA) },
          { $set: { nome: 'Autora Atualizada' } },
        );
      const response = await list(`?autorId=${authorA}&limite=18`);
      expect(response.body.data.items[0].autor.nome).toBe('Autora Atualizada');
      expect(cache.metrics().mongoAfterMiss).toBe(before + 1);
    });

    it('shares one validated public ID entry across visitors and different authenticated users', async () => {
      const server = app.getHttpServer();
      const address = (await cache.postAddress(posts.other))!;
      await inspector.del(address.key);
      const before = cache.metrics();
      const visitor = await request(server)
        .get(`/publicacoes/${posts.other}`)
        .expect(200);
      const afterMiss = cache.metrics();
      expect(afterMiss.mongoAfterMiss).toBe(before.mongoAfterMiss + 1);
      const firstUser = await request(server)
        .get(`/publicacoes/${posts.other}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      const secondUser = await request(server)
        .get(`/publicacoes/${posts.other}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      expect(firstUser.body).toEqual(visitor.body);
      expect(secondUser.body).toEqual(visitor.body);
      expect(cache.metrics().hit).toBe(afterMiss.hit + 2);
      expect(cache.metrics().mongoAfterMiss).toBe(afterMiss.mongoAfterMiss);
      expect(await inspector.get(address.key)).not.toBeNull();
      await inspector.del(address.key);
      const beforeAuthenticatedMiss = cache.metrics();
      const seededByUser = await request(server)
        .get(`/publicacoes/${posts.other}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(seededByUser.body).toEqual(visitor.body);
      expect(cache.metrics().mongoAfterMiss).toBe(
        beforeAuthenticatedMiss.mongoAfterMiss + 1,
      );
      const beforeVisitorHit = cache.metrics().hit;
      await request(server).get(`/publicacoes/${posts.other}`).expect(200);
      expect(cache.metrics().hit).toBe(beforeVisitorHit + 1);
    });

    it('never coalesces a private owner response into another viewer or the public cache', async () => {
      const server = app.getHttpServer();
      const address = (await cache.postAddress(posts.private))!;
      await inspector.del(address.key);
      const [owner, other, visitor] = await Promise.all([
        request(server)
          .get(`/publicacoes/${posts.private}`)
          .set('Authorization', `Bearer ${tokenA}`),
        request(server)
          .get(`/publicacoes/${posts.private}`)
          .set('Authorization', `Bearer ${tokenB}`),
        request(server).get(`/publicacoes/${posts.private}`),
      ]);
      expect(owner.status).toBe(200);
      expect(owner.body.data.visibilidade).toBe('seguidores');
      expect(other.status).toBe(404);
      expect(visitor.status).toBe(404);
      expect(await inspector.get(address.key)).toBeNull();
    });

    it('invalidates public ID and feed on edit, visibility and deletion', async () => {
      const server = app.getHttpServer();
      const first = await request(server)
        .get(`/publicacoes/${posts.first}`)
        .expect(200);
      const beforeHit = cache.metrics();
      const second = await request(server)
        .get(`/publicacoes/${posts.first}`)
        .expect(200);
      expect(second.body).toEqual(first.body);
      expect(cache.metrics().hit).toBeGreaterThan(beforeHit.hit);
      const beforeAuthenticatedHit = cache.metrics();
      const authenticated = await request(server)
        .get(`/publicacoes/${posts.first}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      expect(authenticated.body).toEqual(first.body);
      expect(cache.metrics().hit).toBe(beforeAuthenticatedHit.hit + 1);
      await list('?limite=20');
      await request(server)
        .patch(`/publicacoes/${posts.first}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ conteudo: 'Conteúdo editado' })
        .expect(200);
      expect(
        (await request(server).get(`/publicacoes/${posts.first}`).expect(200))
          .body.data.conteudo,
      ).toBe('Conteúdo editado');
      expect(
        (await list('?limite=20')).body.data.items.find(
          (item: { id: string }) => item.id === posts.first,
        ).conteudo,
      ).toBe('Conteúdo editado');
      await request(server)
        .patch(`/publicacoes/${posts.first}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ visibilidade: 'seguidores' })
        .expect(200);
      await request(server).get(`/publicacoes/${posts.first}`).expect(404);
      await request(server)
        .get(`/publicacoes/${posts.first}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      await request(server)
        .get(`/publicacoes/${posts.first}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
      expect(
        (await list('?limite=20')).body.data.items.map(
          (item: { id: string }) => item.id,
        ),
      ).not.toContain(posts.first);
      await request(server)
        .patch(`/publicacoes/${posts.first}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ visibilidade: 'publico' })
        .expect(200);
      await request(server).get(`/publicacoes/${posts.first}`).expect(200);
      await request(server)
        .delete(`/publicacoes/${posts.first}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      await request(server).get(`/publicacoes/${posts.first}`).expect(404);
      await request(server)
        .get(`/publicacoes/${posts.first}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
      await request(server)
        .get(`/publicacoes/${posts.first}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
      expect(
        (await list('?limite=20')).body.data.items.map(
          (item: { id: string }) => item.id,
        ),
      ).not.toContain(posts.first);
    });

    it('keeps sessions active while cache is down and rejects stale public content on recovery', async () => {
      const server = app.getHttpServer();
      await request(server).get(`/publicacoes/${posts.second}`).expect(200);
      const redisCache = cacheClient as unknown as {
        client: ReturnType<typeof createClient>;
      };
      await redisCache.client.close();
      expect(cacheClient.ready).toBe(false);
      await list('?limite=20');
      await request(server)
        .get(`/publicacoes/${posts.second}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      await request(server)
        .get('/auth/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      await request(server)
        .patch(`/publicacoes/${posts.second}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ visibilidade: 'seguidores' })
        .expect(200);
      await redisCache.client.connect();
      expect(cacheClient.ready).toBe(true);
      await request(server).get(`/publicacoes/${posts.second}`).expect(404);
      await request(server)
        .get(`/publicacoes/${posts.second}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(
        (await list('?limite=20')).body.data.items.map(
          (item: { id: string }) => item.id,
        ),
      ).not.toContain(posts.second);
    });

    it('starts another API instance when only its cache Redis address is unavailable', async () => {
      const previous = process.env.REDIS_CACHE_URL;
      process.env.REDIS_CACHE_URL = 'redis://127.0.0.1:1';
      let other: INestApplication | undefined;
      try {
        const module = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();
        other = module.createNestApplication();
        configureHttp(other);
        await other.init();
        expect(module.get(PublicacoesCacheClient).ready).toBe(false);
        await request(other.getHttpServer()).get('/publicacoes').expect(200);
        await request(other.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${tokenA}`)
          .expect(200);
      } finally {
        if (other) await other.close();
        if (previous === undefined) delete process.env.REDIS_CACHE_URL;
        else process.env.REDIS_CACHE_URL = previous;
      }
    });

    it('coalesces simultaneous feed misses in one application instance', async () => {
      await cache.invalidate(posts.other, authorB);
      const before = cache.metrics().mongoAfterMiss;
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => list('?limite=16')),
      );
      expect(
        responses.every((response) => response.body.data.items.length > 0),
      ).toBe(true);
      expect(cache.metrics().mongoAfterMiss).toBe(before + 1);
    });

    it.runIf(localS3)(
      'invalidates a cached feed after a real upload and publication',
      async () => {
        const firstPage = await list('?limite=1');
        const cursor = firstPage.body.data.nextCursor as string;
        const image = await sharp({
          create: { width: 16, height: 16, channels: 3, background: '#4488cc' },
        })
          .png()
          .toBuffer();
        const uploaded = await request(app.getHttpServer())
          .post('/publicacoes/midias')
          .set('Authorization', `Bearer ${tokenA}`)
          .attach('arquivo', image, {
            filename: 'cache.png',
            contentType: 'image/png',
          })
          .expect(201);
        const created = await request(app.getHttpServer())
          .post('/publicacoes')
          .set('Authorization', `Bearer ${tokenA}`)
          .send({
            conteudo: 'Nova publicação em cache',
            midias: [uploaded.body.data.referencia],
          })
          .expect(201);
        const refreshed = await list('?limite=1');
        expect(refreshed.body.data.items[0].id).toBe(created.body.data.id);
        const nextPage = await list(`?limite=1&cursor=${cursor}`);
        expect(nextPage.body.data.items[0].id).not.toBe(created.body.data.id);
        expect(nextPage.body.data.items[0].id).not.toBe(
          firstPage.body.data.items[0].id,
        );
      },
    );

    it('preserves invalid credentials and check-email rate limiting behavior', async () => {
      await request(app.getHttpServer())
        .get('/publicacoes')
        .set('Authorization', 'Bearer invalid')
        .expect(401);
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      await request(app.getHttpServer())
        .post('/auth/check-email')
        .send({ email: `cache-a-${runId}@example.invalid` })
        .expect(200);
    });
  },
);
