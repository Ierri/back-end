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
import { ModeracaoService } from '../src/moderacao/moderacao.service.js';
import { ModeracaoHistorico } from '../src/moderacao/schemas/moderacao-historico.schema.js';
import { Denuncia } from '../src/moderacao/schemas/denuncia.schema.js';
import { Publicacao } from '../src/publicacoes/schemas/publicacao.schema.js';
import { SeguidoresService } from '../src/usuarios/seguidores.service.js';
import { CreatorStatsService } from '../src/usuarios/creator-stats.service.js';

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
    mongo.pathname = `/ierri_moderacao_test_${runId}`;
    return { mongo: mongo.toString(), sessionPrefix: `ierri:mod:session:${runId}:`,
      ratePrefix: `ierri:mod:rate:${runId}:`, cachePrefix: `ierri:mod:cache:${runId}:` };
  } catch { return null; }
})();

type Account = { id: string; token: string; email: string; password: string };

describe.runIf(config)('denúncias e moderação com serviços locais isolados', () => {
  let app: INestApplication;
  let connection: Connection;
  let posts: Model<Publicacao>;
  let reports: Model<Denuncia>;
  let history: Model<ModeracaoHistorico>;
  let moderation: ModeracaoService;
  let inspector: ReturnType<typeof createClient>;
  let admin: Account;
  let moderator: Account;
  let author: Account;
  let reporter: Account;
  let other: Account;
  let postId: string;
  const original = Object.fromEntries([
    'MONGODB_URI', 'REDIS_SESSION_PREFIX', 'REDIS_CHECK_EMAIL_RATE_PREFIX',
    'REDIS_CACHE_ENABLED', 'REDIS_CACHE_URL', 'REDIS_CACHE_PREFIX',
  ].map((key) => [key, process.env[key]]));
  const server = () => app.getHttpServer();
  const auth = (user: Account) => ({ Authorization: `Bearer ${user.token}` });
  const report = (user: Account, alvoTipo: string, alvoId: string) => request(server())
    .post('/denuncias').set(auth(user)).send({ alvoTipo, alvoId, motivo: 'spam' });
  const action = (user: Account, type: string, id: string, status: string) => request(server())
    .patch(`/admin/${type}/${id}/status`).set(auth(user))
    .send({ status, justificativa: 'Justificativa suficiente.' });
  const register = async (name: string): Promise<Account> => {
    const email = `${name.toLowerCase()}-${runId}@example.invalid`;
    const password = `Local-${randomBytes(12).toString('hex')}`;
    const response = await request(server()).post('/auth/register').send({ name, email, password }).expect(201);
    return { id: response.body.data.user.id as string,
      token: response.body.data.access_token as string, email, password };
  };
  const makePost = async () => {
    const reference = randomBytes(16).toString('base64url');
    const post = await posts.create({ slug: `mod-${runId}-${reference}`,
      autor_id: new Types.ObjectId(author.id), conteudo: 'Conteúdo moderável',
      status: 'publicada', visibilidade: 'publico', publicada_em: new Date(),
      midias: [{ _id: new Types.ObjectId(), tipo: 'imagem',
        url: `http://127.0.0.1:3001/publicacoes/midias/${reference}`,
        chave_storage: `mod-test/${runId}/${reference}`, mime_type: 'image/png',
        tamanho_bytes: 100, largura: 1, altura: 1, duracao_segundos: null,
        texto_alternativo: null, ordem: 0 }],
    });
    return { id: post._id.toString(), reference };
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
    posts = module.get<Model<Publicacao>>(getModelToken(Publicacao.name));
    reports = module.get<Model<Denuncia>>(getModelToken(Denuncia.name));
    history = module.get<Model<ModeracaoHistorico>>(getModelToken(ModeracaoHistorico.name));
    moderation = module.get(ModeracaoService);
    moderation.onModuleDestroy();
    await Promise.all([posts.init(), reports.init(), history.init()]);
    [admin, moderator, author, reporter, other] = await Promise.all([
      register('ModAdmin'), register('ModModerator'), register('ModAuthor'),
      register('ModReporter'), register('ModOther'),
    ]);
  });

  beforeEach(async () => {
    for (const collection of ['denuncias', 'moderacao_historico', 'comentarios', 'votos',
      'publicacoes', 'uploads_midias', 'notificacoes'])
      await connection.db!.collection(collection).deleteMany({});
    await connection.db!.collection('usuarios').updateMany({}, { $set: {
      status: 'ativo', excluido_em: null, auth_versao: 0, moderacao_pendente: null,
      papeis: ['usuario'], visibilidade_perfil: 'publico',
    } });
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(admin.id) },
      { $set: { papeis: ['usuario', 'administrador'] } });
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(moderator.id) },
      { $set: { papeis: ['usuario', 'moderador'] } });
    postId = (await makePost()).id;
  });

  afterAll(async () => {
    if (app) await app.get(SeguidoresService).onModuleDestroy();
    if (app) moderation.onModuleDestroy();
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

  it('requires authentication and current moderator or administrator roles', async () => {
    await request(server()).post('/denuncias').send({}).expect(401);
    await request(server()).get('/denuncias/minhas').expect(401);
    await request(server()).get('/admin/denuncias').expect(401);
    await request(server()).get('/admin/denuncias').set(auth(reporter)).expect(403);
    await report(reporter, 'publicacao', postId).expect(201);
    await request(server()).get('/admin/denuncias').set(auth(moderator)).expect(200);
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(moderator.id) },
      { $set: { papeis: ['usuario'] } });
    await request(server()).get('/admin/denuncias').set(auth(moderator)).expect(403);
  });

  it('validates accessible targets, reasons and prevents self-reports', async () => {
    await report(author, 'publicacao', postId).expect(422);
    await report(reporter, 'publicacao', new Types.ObjectId().toString()).expect(404);
    await request(server()).post('/denuncias').set(auth(reporter)).send({
      alvoTipo: 'publicacao', alvoId: postId, motivo: 'outro',
    }).expect(400);
    await action(admin, 'publicacoes', postId, 'oculta').expect(200);
    await report(reporter, 'publicacao', postId).expect(404);
  });

  it('deduplicates concurrent reports and isolates personal lists', async () => {
    const results = await Promise.all([report(reporter, 'publicacao', postId),
      report(reporter, 'publicacao', postId)]);
    expect(results.map((item) => item.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(await reports.countDocuments()).toBe(1);
    expect((await request(server()).get('/denuncias/minhas').set(auth(other)).expect(200))
      .body.data.items).toHaveLength(0);
    const mine = await request(server()).get('/denuncias/minhas').set(auth(reporter)).expect(200);
    expect(mine.body.data.items).toHaveLength(1);
    expect(mine.body.data.items[0]).not.toHaveProperty('denuncianteId');
    expect(mine.body.data.items[0]).not.toHaveProperty('justificativa');
  });

  it('accepts user and comment reports and binds admin cursors to filters', async () => {
    const created = await request(server()).post(`/publicacoes/${postId}/comentarios`)
      .set(auth(author)).send({ conteudo: 'Comentário denunciável' }).expect(201);
    const commentId = created.body.data.id as string;
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(author.id) },
      { $set: { visibilidade_perfil: 'privado' } });
    await report(reporter, 'usuario', author.id).expect(201);
    await report(reporter, 'comentario', commentId).expect(201);
    await report(reporter, 'publicacao', postId).expect(201);
    const first = await request(server()).get('/admin/denuncias?limite=2')
      .set(auth(admin)).expect(200);
    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.hasMore).toBe(true);
    const next = await request(server())
      .get(`/admin/denuncias?limite=2&cursor=${first.body.data.nextCursor}`)
      .set(auth(admin)).expect(200);
    expect(next.body.data.items).toHaveLength(1);
    await request(server()).get(`/admin/denuncias?alvoTipo=usuario&cursor=${first.body.data.nextCursor}`)
      .set(auth(admin)).expect(400);
  });

  it('accepts a report once and keeps punishment as a separate action', async () => {
    const created = await report(reporter, 'publicacao', postId).expect(201);
    const id = created.body.data.id as string;
    const body = { status: 'aceita', justificativa: 'Conteúdo realmente impróprio.' };
    const results = await Promise.all([request(server()).patch(`/admin/denuncias/${id}`)
      .set(auth(moderator)).send(body), request(server()).patch(`/admin/denuncias/${id}`)
      .set(auth(admin)).send({ ...body, status: 'rejeitada' })]);
    expect(results.map((item) => item.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect((await posts.findById(postId).lean().exec())?.status).toBe('publicada');
    await moderation.recoverBatch();
    expect(await history.countDocuments({ alvo_tipo: 'denuncia', alvo_id: new Types.ObjectId(id) })).toBe(1);
  });

  it('rejects a report with a reason and preserves the original target', async () => {
    const created = await report(reporter, 'publicacao', postId).expect(201);
    const id = created.body.data.id as string;
    await request(server()).patch(`/admin/denuncias/${id}`).set(auth(moderator))
      .send({ status: 'rejeitada', justificativa: 'Não houve infração comprovada.' }).expect(200);
    const detail = await request(server()).get(`/admin/denuncias/${id}`).set(auth(admin)).expect(200);
    expect(detail.body.data).toMatchObject({ status: 'rejeitada', moderadorId: moderator.id });
    expect((await posts.findById(postId).lean().exec())?.status).toBe('publicada');
    expect(await history.countDocuments({ alvo_tipo: 'denuncia' })).toBe(1);
  });

  it('hides and restores posts, feeds and direct media without losing original state', async () => {
    await posts.updateOne({ _id: new Types.ObjectId(postId) },
      { $set: { 'contadores.score': 5 } }).exec();
    await app.get(CreatorStatsService).refresh(author.id);
    const post = await posts.findById(postId).lean().exec();
    const reference = post!.midias[0].url.split('/').at(-1)!;
    await connection.db!.collection('uploads_midias').insertOne({ referencia: reference,
      estado: 'vinculada', publicacao_id: new Types.ObjectId(postId) });
    await request(server()).get(`/publicacoes/${postId}`).expect(200);
    await action(moderator, 'publicacoes', postId, 'oculta').expect(200);
    const hiddenStats = await connection.db!.collection('usuarios')
      .findOne({ _id: new Types.ObjectId(author.id) });
    expect(hiddenStats?.contadores).toMatchObject({ publicacoes: 0, score: 0 });
    await request(server()).get(`/publicacoes/${postId}`).expect(404);
    await request(server()).get(`/publicacoes/midias/${reference}`).expect(404);
    const feed = await request(server()).get('/publicacoes').expect(200);
    expect(feed.body.data.items).toHaveLength(0);
    await action(admin, 'publicacoes', postId, 'publicada').expect(200);
    const restoredStats = await connection.db!.collection('usuarios')
      .findOne({ _id: new Types.ObjectId(author.id) });
    expect(restoredStats?.contadores).toMatchObject({ publicacoes: 1, score: 5 });
    await request(server()).get(`/publicacoes/${postId}`).expect(200);
    expect(await history.countDocuments({ alvo_tipo: 'publicacao', alvo_id: new Types.ObjectId(postId) })).toBe(2);
    const firstHistory = await request(server()).get('/admin/moderacao/historico?limite=1')
      .set(auth(admin)).expect(200);
    expect(firstHistory.body.data.hasMore).toBe(true);
    const nextHistory = await request(server())
      .get(`/admin/moderacao/historico?limite=1&cursor=${firstHistory.body.data.nextCursor}`)
      .set(auth(admin)).expect(200);
    expect(nextHistory.body.data.items).toHaveLength(1);
    await request(server()).get('/admin/moderacao/historico').set(auth(reporter)).expect(403);
  });

  it('masks a hidden comment and restores its original text and counter', async () => {
    const created = await request(server()).post(`/publicacoes/${postId}/comentarios`)
      .set(auth(reporter)).send({ conteudo: 'Texto original do comentário' }).expect(201);
    const id = created.body.data.id as string;
    await action(moderator, 'comentarios', id, 'oculto').expect(200);
    const hidden = await request(server()).get(`/publicacoes/${postId}/comentarios`).expect(200);
    expect(hidden.body.data.items[0].conteudo).toBe('Comentário indisponível');
    expect((await posts.findById(postId).lean().exec())?.contadores.comentarios).toBe(0);
    await action(admin, 'comentarios', id, 'publicado').expect(200);
    const restored = await request(server()).get(`/publicacoes/${postId}/comentarios`).expect(200);
    expect(restored.body.data.items[0].conteudo).toBe('Texto original do comentário');
    expect((await posts.findById(postId).lean().exec())?.contadores.comentarios).toBe(1);
  });

  it('removes hidden content from saved lists and notification counts', async () => {
    await request(server()).put(`/publicacoes/${postId}/salvar`).set(auth(reporter)).expect(200);
    await request(server()).post(`/publicacoes/${postId}/comentarios`)
      .set(auth(reporter)).send({ conteudo: 'Comentário notificável' }).expect(201);
    expect((await request(server()).get('/notificacoes/nao-lidas').set(auth(author)).expect(200))
      .body.data.total).toBe(1);
    await action(admin, 'publicacoes', postId, 'oculta').expect(200);
    expect((await request(server()).get('/usuarios/me/publicacoes-salvas')
      .set(auth(reporter)).expect(200)).body.data.items).toHaveLength(0);
    expect((await request(server()).get('/notificacoes/nao-lidas').set(auth(author)).expect(200))
      .body.data.total).toBe(0);
  });

  it('enforces account hierarchy and permanently invalidates pre-block sessions', async () => {
    await action(moderator, 'usuarios', admin.id, 'bloqueado').expect(403);
    await action(moderator, 'usuarios', moderator.id, 'bloqueado').expect(403);
    await action(moderator, 'usuarios', author.id, 'bloqueado').expect(200);
    await request(server()).get('/auth/me').set(auth(author)).expect(401);
    await request(server()).post('/auth/login').send({ email: author.email,
      password: author.password }).expect(401);
    await request(server()).get(`/publicacoes/${postId}`).expect(404);
    await action(admin, 'usuarios', author.id, 'ativo').expect(200);
    await request(server()).get('/auth/me').set(auth(author)).expect(401);
    const login = await request(server()).post('/auth/login').send({ email: author.email,
      password: author.password }).expect(200);
    expect(login.body.data.access_token).toBeTruthy();
  });

  it('lets administrators block moderators and removes blocked creators from ranking', async () => {
    await action(moderator, 'usuarios', admin.id, 'bloqueado').expect(403);
    await action(admin, 'usuarios', moderator.id, 'bloqueado').expect(200);
    await request(server()).get('/admin/denuncias').set(auth(moderator)).expect(401);
    await action(admin, 'usuarios', moderator.id, 'ativo').expect(200);
    await request(server()).get('/admin/denuncias').set(auth(moderator)).expect(401);
    await action(admin, 'usuarios', author.id, 'bloqueado').expect(200);
    const ranking = await request(server()).get('/usuarios/ranking').expect(200);
    expect(ranking.body.data.items.some((item: { id: string }) => item.id === author.id)).toBe(false);
  });

  it('recovers a failed history write from the source marker', async () => {
    const originalUpdate = history.updateOne.bind(history);
    const spy = vi.spyOn(history, 'updateOne').mockImplementationOnce(() => {
      const failed = originalUpdate({ _id: new Types.ObjectId() }, { $set: { acao: 'falha' } });
      failed.exec = (async () => { throw new Error('history unavailable'); }) as typeof failed.exec;
      return failed;
    });
    try {
      await action(admin, 'publicacoes', postId, 'oculta').expect(200);
    } finally {
      spy.mockRestore();
    }
    expect(await history.countDocuments({ alvo_tipo: 'publicacao' })).toBe(0);
    expect((await posts.findById(postId).lean().exec())?.moderacao_pendente).toBeTruthy();
    await moderation.recoverBatch();
    expect(await history.countDocuments({ alvo_tipo: 'publicacao' })).toBe(1);
    expect((await posts.findById(postId).lean().exec())?.moderacao_pendente).toBeNull();
  });

  it('serializes concurrent status transitions and rejects restoration of deleted posts', async () => {
    const results = await Promise.all([action(admin, 'publicacoes', postId, 'oculta'),
      action(moderator, 'publicacoes', postId, 'oculta')]);
    expect(results.map((item) => item.status).sort((a, b) => a - b)).toEqual([200, 409]);
    await posts.updateOne({ _id: new Types.ObjectId(postId) }, { $set: { status: 'excluida' } }).exec();
    await action(admin, 'publicacoes', postId, 'publicada').expect(409);
  });
});
