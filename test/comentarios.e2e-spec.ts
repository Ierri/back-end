import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import type { Connection, Model, UpdateQuery } from 'mongoose';
import { createClient } from 'redis';
import request from 'supertest';
import sharp from 'sharp';
import { AppModule } from '../src/app.module.js';
import { ComentariosService } from '../src/comentarios/comentarios.service.js';
import { configureHttp } from '../src/common/http/configure-http.js';
import { MediaStorageService } from '../src/publicacoes/media-storage.service.js';
import { PublicacoesCacheClient } from '../src/publicacoes/publicacoes-cache.client.js';
import type { Publicacao } from '../src/publicacoes/schemas/publicacao.schema.js';
import { SeguidoresService } from '../src/usuarios/seguidores.service.js';

const runId = randomBytes(8).toString('hex');
const mongoBase = process.env.MONGODB_URI;
const redisBase = process.env.REDIS_URL;
const secret = process.env.JWT_SECRET;
const config = (() => {
  try {
    if (!mongoBase || !redisBase || !secret || Buffer.byteLength(secret) < 32 || !process.env.S3_ENDPOINT || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY || !process.env.S3_BUCKET) return null;
    const mongo = new URL(mongoBase);
    const redis = new URL(redisBase);
    const s3 = new URL(process.env.S3_ENDPOINT);
    if (mongo.protocol !== 'mongodb:' || redis.protocol !== 'redis:' || !['127.0.0.1', 'localhost'].includes(mongo.hostname) || !['127.0.0.1', 'localhost'].includes(redis.hostname) || !['127.0.0.1', 'localhost'].includes(s3.hostname)) return null;
    mongo.pathname = '/ierri_comments_test_' + runId;
    return { mongo: mongo.toString(), cachePrefix: 'ierri:comments:cache:' + runId + ':', sessionPrefix: 'ierri:comments:session:' + runId + ':', ratePrefix: 'ierri:comments:rate:' + runId + ':' };
  } catch { return null; }
})();

describe.runIf(config)('comentários com MongoDB, Redis e MinIO locais', () => {
  let app: INestApplication;
  let connection: Connection;
  let storage: MediaStorageService;
  let cacheClient: PublicacoesCacheClient;
  let comentarios: ComentariosService;
  let tokenA: string;
  let tokenB: string;
  let authorB: string;
  let postId: string;
  let rootId: string;
  let replyId: string;
  let leafId: string;
  const original = Object.fromEntries(['MONGODB_URI', 'REDIS_SESSION_PREFIX', 'REDIS_CHECK_EMAIL_RATE_PREFIX', 'REDIS_CACHE_ENABLED', 'REDIS_CACHE_URL', 'REDIS_CACHE_PREFIX'].map((key) => [key, process.env[key]]));

  const createComment = (token: string, body: { conteudo: string; comentarioPaiId?: string | null }) =>
    request(app.getHttpServer()).post('/publicacoes/' + postId + '/comentarios')
      .set('Authorization', 'Bearer ' + token).send(body);

  const detail = () => request(app.getHttpServer()).get('/publicacoes/' + postId).expect(200);

  beforeAll(async () => {
    process.env.MONGODB_URI = config!.mongo;
    process.env.REDIS_SESSION_PREFIX = config!.sessionPrefix;
    process.env.REDIS_CHECK_EMAIL_RATE_PREFIX = config!.ratePrefix;
    process.env.REDIS_CACHE_ENABLED = 'true';
    process.env.REDIS_CACHE_URL = redisBase;
    process.env.REDIS_CACHE_PREFIX = config!.cachePrefix;
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureHttp(app);
    await app.init();
    connection = module.get<Connection>(getConnectionToken());
    storage = module.get(MediaStorageService);
    cacheClient = module.get(PublicacoesCacheClient);
    comentarios = module.get(ComentariosService);
    for (let attempt = 0; attempt < 30 && !cacheClient.ready; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cacheClient.ready).toBe(true);
    const password = 'Local-' + randomBytes(12).toString('hex');
    const first = await request(app.getHttpServer()).post('/auth/register').send({ name: 'Autora', email: 'comments-a-' + runId + '@example.invalid', password }).expect(201);
    const second = await request(app.getHttpServer()).post('/auth/register').send({ name: 'Leitor', email: 'comments-b-' + runId + '@example.invalid', password }).expect(201);
    tokenA = first.body.data.access_token;
    tokenB = second.body.data.access_token;
    authorB = second.body.data.user.id;
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#4488cc' } }).png().toBuffer();
    const uploaded = await request(app.getHttpServer()).post('/publicacoes/midias')
      .set('Authorization', 'Bearer ' + tokenA)
      .attach('arquivo', image, { filename: 'comments.png', contentType: 'image/png' }).expect(201);
    const publication = await request(app.getHttpServer()).post('/publicacoes')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ conteudo: 'Publicação para comentários', midias: [uploaded.body.data.referencia] }).expect(201);
    postId = publication.body.data.id;
  });

  afterAll(async () => {
    if (app) await app.get(SeguidoresService).onModuleDestroy();
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

  it('creates three levels, rejects a fourth, and keeps author permissions', async () => {
    const root = await createComment(tokenB, { conteudo: '  Comentário principal  ' }).expect(201);
    rootId = root.body.data.id;
    expect(root.body.data.conteudo).toBe('Comentário principal');
    expect(root.body.data.profundidade).toBe(0);
    const reply = await createComment(tokenA, { conteudo: 'Resposta', comentarioPaiId: rootId }).expect(201);
    replyId = reply.body.data.id;
    expect(reply.body.data.profundidade).toBe(1);
    expect(reply.body.data.comentarioRaizId).toBe(rootId);
    const leaf = await createComment(tokenB, { conteudo: 'Terceiro nível', comentarioPaiId: replyId }).expect(201);
    leafId = leaf.body.data.id;
    expect(leaf.body.data.profundidade).toBe(2);
    await createComment(tokenA, { conteudo: 'Quarto nível', comentarioPaiId: leafId }).expect(422);
    await request(app.getHttpServer()).patch('/comentarios/' + rootId).set('Authorization', 'Bearer ' + tokenA).send({ conteudo: 'Inválido' }).expect(404);
    await request(app.getHttpServer()).patch('/comentarios/' + rootId).set('Authorization', 'Bearer ' + tokenB).send({ conteudo: 'Editado' }).expect(200);
    expect((await detail()).body.data.contadores.comentarios).toBe(3);
    const roots = await request(app.getHttpServer()).get('/publicacoes/' + postId + '/comentarios').expect(200);
    expect(roots.body.data.items[0].conteudo).toBe('Editado');
    const replies = await request(app.getHttpServer()).get('/comentarios/' + rootId + '/respostas').expect(200);
    expect(replies.body.data.items[0].id).toBe(replyId);
    const leaves = await request(app.getHttpServer()).get('/comentarios/' + replyId + '/respostas').expect(200);
    expect(leaves.body.data.items[0].id).toBe(leafId);
  });

  it('validates content, IDs, parent publication and session', async () => {
    await createComment(tokenB, { conteudo: '   ' }).expect(400);
    await createComment(tokenB, { conteudo: 'x'.repeat(2001) }).expect(400);
    await createComment(tokenB, { conteudo: 'x', comentarioPaiId: 'not-an-id' }).expect(400);
    await createComment(tokenB, { conteudo: 'x', comentarioPaiId: '0'.repeat(24) }).expect(404);
    await request(app.getHttpServer()).post('/publicacoes/' + postId + '/comentarios').send({ conteudo: 'Sem sessão' }).expect(401);
    await request(app.getHttpServer()).get('/publicacoes/not-an-id/comentarios').expect(400);
    await request(app.getHttpServer()).get('/publicacoes/' + '0'.repeat(24) + '/comentarios').expect(404);
  });

  it('paginates roots and replies without loss or duplication', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 22; index++) {
      const created = await createComment(tokenB, { conteudo: 'Página ' + index }).expect(201);
      ids.push(created.body.data.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response: { body: { data: { items: { id: string }[]; nextCursor: string | null } } } = await request(app.getHttpServer())
        .get('/publicacoes/' + postId + '/comentarios')
        .query({ limite: '7', ...(cursor ? { cursor } : {}) }).expect(200);
      seen.push(...response.body.data.items.map((item: { id: string }) => item.id));
      cursor = response.body.data.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    expect(ids.every((id) => seen.includes(id))).toBe(true);
    const firstPage = await request(app.getHttpServer()).get('/publicacoes/' + postId + '/comentarios?limite=7').expect(200);
    await request(app.getHttpServer()).get('/comentarios/' + rootId + '/respostas').query({ cursor: firstPage.body.data.nextCursor }).expect(400);
    expect((await detail()).body.data.contadores.comentarios).toBe(25);
    const plan = await connection.db!.collection('comentarios')
      .find({ publicacao_id: new Types.ObjectId(postId), comentario_pai_id: null })
      .sort({ criado_em: 1, _id: 1 }).limit(8).explain('queryPlanner');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('IXSCAN');
  });

  it('deduplicates retries with an idempotency key and rejects conflicting reuse', async () => {
    const before = (await detail()).body.data.contadores.comentarios;
    const key = randomBytes(18).toString('base64url');
    const send = (content: string, value: string) =>
      request(app.getHttpServer()).post('/publicacoes/' + postId + '/comentarios')
        .set('Authorization', 'Bearer ' + tokenB)
        .set('Idempotency-Key', value).send({ conteudo: content });
    const first = await send('Comentário repetível', key).expect(201);
    const repeated = await send('Comentário repetível', key).expect(201);
    expect(repeated.body.data.id).toBe(first.body.data.id);
    await send('Outro texto', key).expect(409);
    await send('Texto', 'short').expect(400);
    const parallelKey = randomBytes(18).toString('base64url');
    const parallel = await Promise.all([
      send('Comentário simultâneo', parallelKey),
      send('Comentário simultâneo', parallelKey),
    ]);
    expect(parallel.some((item) => item.status === 201)).toBe(true);
    expect(parallel.every((item) => [201, 503].includes(item.status))).toBe(true);
    const completed = await send('Comentário simultâneo', parallelKey).expect(201);
    expect(completed.body.data.id).toBe(parallel.find((item) => item.status === 201)!.body.data.id);
    expect((await detail()).body.data.contadores.comentarios).toBe(before + 2);
  });

  it('returns 503 while a keyed creation is pending and succeeds only after confirmation', async () => {
    const before = (await detail()).body.data.contadores.comentarios;
    const key = randomBytes(18).toString('base64url');
    const id = new Types.ObjectId(createHash('sha256')
      .update(authorB + ':' + postId + ':' + key).digest('hex').slice(0, 24));
    const operation = 'c:' + id.toString();
    await connection.db!.collection('publicacoes').updateOne(
      { _id: new Types.ObjectId(postId) },
      { $addToSet: { comentarios_operacoes_pendentes: operation }, $inc: { comentarios_revisao: 1 } },
    );
    const now = new Date();
    await connection.db!.collection('comentarios').insertOne({
      _id: id, publicacao_id: new Types.ObjectId(postId), autor_id: new Types.ObjectId(authorB),
      comentario_pai_id: null, comentario_raiz_id: null, profundidade: 0,
      conteudo: 'Operação pendente', status: 'publicado', criacao_estado: 'pendente',
      editado_em: null, criado_em: now, atualizado_em: now,
    });
    const send = (conteudo: string) => request(app.getHttpServer())
      .post('/publicacoes/' + postId + '/comentarios')
      .set('Authorization', 'Bearer ' + tokenB)
      .set('Idempotency-Key', key).send({ conteudo });
    await send('Operação pendente').expect(503);
    await send('Texto diferente').expect(409);
    await expect(comentarios.reconcileCounter(postId)).rejects.toMatchObject({ response: { code: 'COMENTARIO_OPERATION_PENDING' } });
    expect((await detail()).body.data.contadores.comentarios).toBe(before);
    await connection.db!.collection('publicacoes').updateOne(
      { _id: new Types.ObjectId(postId), comentarios_operacoes_pendentes: operation },
      { $inc: { 'contadores.comentarios': 1, comentarios_revisao: 1 } },
    );
    await connection.db!.collection('comentarios').updateOne(
      { _id: id }, { $set: { criacao_estado: 'confirmado' } },
    );
    const completed = await send('Operação pendente').expect(201);
    expect(completed.body.data.id).toBe(id.toString());
    expect((await detail()).body.data.contadores.comentarios).toBe(before + 1);
    expect(await connection.db!.collection('comentarios').countDocuments({ _id: id })).toBe(1);
  });

  it('preserves a persisted comment when the counter write succeeds but its response is lost', async () => {
    const before = (await detail()).body.data.contadores.comentarios;
    const key = randomBytes(18).toString('base64url');
    const id = new Types.ObjectId(createHash('sha256')
      .update(authorB + ':' + postId + ':' + key).digest('hex').slice(0, 24));
    const publications = (comentarios as unknown as { publicacoes: Model<Publicacao> }).publicacoes;
    const originalUpdate = publications.updateOne.bind(publications);
    let intercepted = false;
    const spy = vi.spyOn(publications, 'updateOne').mockImplementation(
      ((filter: unknown, update: UpdateQuery<Publicacao>) => {
        const query = originalUpdate(filter as Parameters<typeof publications.updateOne>[0], update);
        if (!intercepted && update.$inc?.['contadores.comentarios'] === 1) {
          intercepted = true;
          const execute = query.exec.bind(query);
          query.exec = (async () => {
            await execute();
            throw new Error('Resposta MongoDB perdida após persistência');
          }) as typeof query.exec;
        }
        return query;
      }) as typeof publications.updateOne,
    );
    try {
      await request(app.getHttpServer()).post('/publicacoes/' + postId + '/comentarios')
        .set('Authorization', 'Bearer ' + tokenB)
        .set('Idempotency-Key', key)
        .send({ conteudo: 'Falha ambígua real' }).expect(503);
    } finally {
      spy.mockRestore();
    }
    expect(intercepted).toBe(true);
    const stored = await connection.db!.collection('comentarios').findOne({ _id: id });
    expect(stored?.criacao_estado).toBe('pendente');
    expect((await detail()).body.data.contadores.comentarios).toBe(before + 1);
    await expect(comentarios.reconcileCounter(postId)).rejects.toMatchObject({ response: { code: 'COMENTARIO_OPERATION_PENDING' } });
    await request(app.getHttpServer()).post('/publicacoes/' + postId + '/comentarios')
      .set('Authorization', 'Bearer ' + tokenB)
      .set('Idempotency-Key', key)
      .send({ conteudo: 'Falha ambígua real' }).expect(503);
    expect(await connection.db!.collection('comentarios').countDocuments({ _id: id })).toBe(1);
    await connection.db!.collection('comentarios').updateOne(
      { _id: id }, { $set: { criacao_estado: 'confirmado' } },
    );
    await request(app.getHttpServer()).post('/publicacoes/' + postId + '/comentarios')
      .set('Authorization', 'Bearer ' + tokenB)
      .set('Idempotency-Key', key)
      .send({ conteudo: 'Falha ambígua real' }).expect(201);
    expect((await detail()).body.data.contadores.comentarios).toBe(before + 1);
  });

  it('does not overwrite concurrent creations, deletions or another reconciliation', async () => {
    const count = () => connection.db!.collection('comentarios').countDocuments({
      publicacao_id: new Types.ObjectId(postId), status: 'publicado',
      criacao_estado: { $nin: ['pendente', 'falhou'] },
    });
    for (let index = 0; index < 6; index++) {
      const [created] = await Promise.all([
        createComment(tokenB, { conteudo: 'Concorrência ' + index }).expect(201),
        comentarios.reconcileCounter(postId).catch(() => undefined),
      ]);
      expect((await detail()).body.data.contadores.comentarios).toBe(await count());
      await Promise.all([
        request(app.getHttpServer()).delete('/comentarios/' + created.body.data.id)
          .set('Authorization', 'Bearer ' + tokenB).expect(200),
        comentarios.reconcileCounter(postId).catch(() => undefined),
      ]);
      expect((await detail()).body.data.contadores.comentarios).toBe(await count());
    }
    await Promise.allSettled([
      comentarios.reconcileCounter(postId),
      comentarios.reconcileCounter(postId),
    ]);
    expect((await detail()).body.data.contadores.comentarios).toBe(await count());
  });

  it('counts concurrent creations and repairs a drifted projection from stored comments', async () => {
    const before = (await detail()).body.data.contadores.comentarios;
    const created = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      createComment(tokenB, { conteudo: 'Simultâneo ' + index }).expect(201)));
    expect(new Set(created.map((item) => item.body.data.id)).size).toBe(8);
    expect((await detail()).body.data.contadores.comentarios).toBe(before + 8);
    await connection.db!.collection('publicacoes').updateOne(
      { _id: new Types.ObjectId(postId) },
      { $set: { 'contadores.comentarios': 99 } },
    );
    await comentarios.reconcileCounter(postId);
    expect((await detail()).body.data.contadores.comentarios).toBe(before + 8);
  });

  it('deletes a parent once, preserves replies, and updates detail and feed counters', async () => {
    const before = (await detail()).body.data.contadores.comentarios;
    const results = await Promise.all([
      request(app.getHttpServer()).delete('/comentarios/' + rootId).set('Authorization', 'Bearer ' + tokenB),
      request(app.getHttpServer()).delete('/comentarios/' + rootId).set('Authorization', 'Bearer ' + tokenB),
    ]);
    expect(results.some((item) => item.status === 200)).toBe(true);
    expect(results.every((item) => [200, 404, 503].includes(item.status))).toBe(true);
    await request(app.getHttpServer()).delete('/comentarios/' + rootId)
      .set('Authorization', 'Bearer ' + tokenB).expect(404);
    const roots = await request(app.getHttpServer()).get('/publicacoes/' + postId + '/comentarios').expect(200);
    expect(roots.body.data.items[0].conteudo).toBe('Comentário removido');
    expect(roots.body.data.items[0].status).toBe('excluido');
    const replies = await request(app.getHttpServer()).get('/comentarios/' + rootId + '/respostas').expect(200);
    expect(replies.body.data.items[0].id).toBe(replyId);
    await createComment(tokenA, { conteudo: 'Não permitido', comentarioPaiId: rootId }).expect(404);
    expect((await detail()).body.data.contadores.comentarios).toBe(before - 1);
    const feed = await request(app.getHttpServer()).get('/publicacoes').expect(200);
    expect(feed.body.data.items.find((item: { id: string }) => item.id === postId).contadores.comentarios).toBe(before - 1);
  });

  it('replays a confirmed reply after its parent is logically deleted', async () => {
    const parent = await createComment(tokenB, { conteudo: 'Pai de resposta repetível' }).expect(201);
    const key = randomBytes(18).toString('base64url');
    const send = () => request(app.getHttpServer()).post('/publicacoes/' + postId + '/comentarios')
      .set('Authorization', 'Bearer ' + tokenA)
      .set('Idempotency-Key', key)
      .send({ conteudo: 'Resposta repetível', comentarioPaiId: parent.body.data.id });
    const first = await send().expect(201);
    await request(app.getHttpServer()).delete('/comentarios/' + parent.body.data.id)
      .set('Authorization', 'Bearer ' + tokenB).expect(200);
    const before = (await detail()).body.data.contadores.comentarios;
    const replay = await send().expect(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect((await detail()).body.data.contadores.comentarios).toBe(before);
  });

  it('keeps private comments private and sessions usable when cache Redis is unavailable', async () => {
    await request(app.getHttpServer()).patch('/publicacoes/' + postId).set('Authorization', 'Bearer ' + tokenA).send({ visibilidade: 'seguidores' }).expect(200);
    await request(app.getHttpServer()).get('/publicacoes/' + postId + '/comentarios').expect(404);
    await request(app.getHttpServer()).get('/publicacoes/' + postId + '/comentarios').set('Authorization', 'Bearer ' + tokenB).expect(404);
    await request(app.getHttpServer()).get('/comentarios/' + rootId + '/respostas').expect(404);
    await createComment(tokenB, { conteudo: 'Não autorizado' }).expect(404);
    await request(app.getHttpServer()).get('/publicacoes/' + postId + '/comentarios').set('Authorization', 'Bearer ' + tokenA).expect(200);
    const client = cacheClient as unknown as { client: ReturnType<typeof createClient> };
    await client.client.close();
    try {
      await request(app.getHttpServer()).get('/auth/me').set('Authorization', 'Bearer ' + tokenA).expect(200);
      await createComment(tokenA, { conteudo: 'Com cache indisponível' }).expect(201);
      await request(app.getHttpServer()).get('/publicacoes/' + postId + '/comentarios').set('Authorization', 'Bearer ' + tokenA).expect(200);
    } finally {
      await client.client.connect();
    }
  });

  it('blocks comment reads and writes after the publication is deleted', async () => {
    await request(app.getHttpServer()).delete('/publicacoes/' + postId)
      .set('Authorization', 'Bearer ' + tokenA).expect(200);
    await request(app.getHttpServer()).get('/publicacoes/' + postId + '/comentarios')
      .set('Authorization', 'Bearer ' + tokenA).expect(404);
    await request(app.getHttpServer()).get('/comentarios/' + rootId + '/respostas')
      .set('Authorization', 'Bearer ' + tokenA).expect(404);
    await createComment(tokenA, { conteudo: 'Após exclusão' }).expect(404);
  });
});
