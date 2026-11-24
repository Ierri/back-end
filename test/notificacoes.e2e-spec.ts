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
import { NotificationProducerService } from '../src/notificacoes/notification-producer.service.js';
import { Notificacao } from '../src/notificacoes/schemas/notificacao.schema.js';
import { Publicacao } from '../src/publicacoes/schemas/publicacao.schema.js';
import { VotosService } from '../src/publicacoes/votos.service.js';
import { SalvosService } from '../src/publicacoes/salvos.service.js';
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
    mongo.pathname = `/ierri_notificacoes_test_${runId}`;
    return { mongo: mongo.toString(), sessionPrefix: `ierri:notif:session:${runId}:`,
      ratePrefix: `ierri:notif:rate:${runId}:`, cachePrefix: `ierri:notif:cache:${runId}:` };
  } catch { return null; }
})();

type Account = { id: string; token: string };

describe.runIf(config)('notificações com MongoDB e Redis locais', () => {
  let app: INestApplication;
  let connection: Connection;
  let posts: Model<Publicacao>;
  let notifications: Model<Notificacao>;
  let producer: NotificationProducerService;
  let inspector: ReturnType<typeof createClient>;
  let author: Account;
  let actor: Account;
  let third: Account;
  let publicId: string;
  let restrictedId: string;
  const original = Object.fromEntries([
    'MONGODB_URI', 'REDIS_SESSION_PREFIX', 'REDIS_CHECK_EMAIL_RATE_PREFIX',
    'REDIS_CACHE_ENABLED', 'REDIS_CACHE_URL', 'REDIS_CACHE_PREFIX',
  ].map((key) => [key, process.env[key]]));
  const server = () => app.getHttpServer();
  const auth = (account: Account) => ({ Authorization: `Bearer ${account.token}` });
  const list = (account: Account, query = '') => request(server()).get(`/notificacoes${query}`).set(auth(account));
  const unread = (account: Account) => request(server()).get('/notificacoes/nao-lidas').set(auth(account));
  const comment = (id: string, account: Account, body: { conteudo: string; comentarioPaiId?: string }) =>
    request(server()).post(`/publicacoes/${id}/comentarios`).set(auth(account)).send(body);
  const follow = (account: Account) => request(server()).put(`/usuarios/${author.id}/seguir`).set(auth(account));
  const register = async (name: string): Promise<Account> => {
    const result = await request(server()).post('/auth/register').send({ name,
      email: `${name.toLowerCase()}-${runId}@example.invalid`,
      password: `Local-${randomBytes(12).toString('hex')}` }).expect(201);
    return { id: result.body.data.user.id as string, token: result.body.data.access_token as string };
  };
  const makePost = async (visibility: 'publico' | 'seguidores') => {
    const reference = randomBytes(16).toString('base64url');
    const post = await posts.create({ slug: `notif-${runId}-${reference}`,
      autor_id: new Types.ObjectId(author.id), conteudo: `Post ${reference}`,
      status: 'publicada', visibilidade: visibility, publicada_em: new Date(),
      midias: [{ _id: new Types.ObjectId(), tipo: 'imagem',
        url: `http://127.0.0.1:3001/publicacoes/midias/${reference}`,
        chave_storage: `notif-test/${runId}/${reference}`, mime_type: 'image/png',
        tamanho_bytes: 100, largura: 1, altura: 1, duracao_segundos: null,
        texto_alternativo: null, ordem: 0 }],
    });
    return post._id.toString();
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
    notifications = module.get<Model<Notificacao>>(getModelToken(Notificacao.name));
    producer = module.get(NotificationProducerService);
    producer.onModuleDestroy();
    await Promise.all([posts.init(), notifications.init(), connection.model('Seguidor').init(),
      connection.model('Voto').init()]);
    [author, actor, third] = await Promise.all([
      register('NotifyAuthor'), register('NotifyActor'), register('NotifyThird'),
    ]);
  });

  beforeEach(async () => {
    for (const collection of ['notificacoes', 'comentarios', 'votos', 'seguidores', 'publicacoes'])
      await connection.db!.collection(collection).deleteMany({});
    await connection.db!.collection('usuarios').updateMany({}, { $set: {
      status: 'ativo', excluido_em: null, visibilidade_perfil: 'publico',
      'contadores.seguidores': 0, 'contadores.seguindo': 0,
    } });
    publicId = await makePost('publico');
    restrictedId = await makePost('seguidores');
  });

  afterAll(async () => {
    if (app) {
      await app.get(SeguidoresService).onModuleDestroy();
      app.get(VotosService).onModuleDestroy();
      app.get(SalvosService).onModuleDestroy();
      app.get(CreatorStatsService).onModuleDestroy();
      producer.onModuleDestroy();
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

  it('requires an active session and isolates all notification routes', async () => {
    await request(server()).get('/notificacoes').expect(401);
    await request(server()).get('/notificacoes/nao-lidas').expect(401);
    await request(server()).patch('/notificacoes/ler-todas').expect(401);
    await request(server()).patch(`/notificacoes/${new Types.ObjectId().toString()}/lida`).expect(401);
    await follow(actor).expect(200);
    const item = (await list(author).expect(200)).body.data.items[0];
    expect((await list(third).expect(200)).body.data.items).toHaveLength(0);
    await request(server()).patch(`/notificacoes/${item.id}/lida`).set(auth(third)).expect(404);
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(author.id) },
      { $set: { status: 'bloqueado' } });
    await list(author).expect(401);
  });

  it('creates one follow notification and no self-notification', async () => {
    await follow(actor).expect(200);
    expect((await list(author).expect(200)).body.data.items).toMatchObject([{ tipo: 'user_followed',
      ator: { id: actor.id }, relacionamentoId: expect.any(String) }]);
    expect((await unread(author).expect(200)).body.data).toEqual({ total: 1 });
    await request(server()).put(`/usuarios/${author.id}/seguir`).set(auth(author)).expect(422);
    expect(await notifications.countDocuments()).toBe(1);
  });

  it('creates a new event when a user follows again after unfollowing', async () => {
    await follow(actor).expect(200);
    await request(server()).delete(`/usuarios/${author.id}/seguir`).set(auth(actor)).expect(200);
    await follow(actor).expect(200);
    expect(await notifications.countDocuments({ tipo: 'user_followed' })).toBe(2);
    expect((await list(author).expect(200)).body.data.items).toHaveLength(1);
  });

  it('notifies a pending private request and its acceptance without leaving an actionable request', async () => {
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(author.id) },
      { $set: { visibilidade_perfil: 'privado' } });
    await follow(actor).expect(200);
    expect((await list(author).expect(200)).body.data.items)
      .toMatchObject([{ tipo: 'follow_requested' }]);
    const relation = await connection.db!.collection('seguidores').findOne({
      seguidor_id: new Types.ObjectId(actor.id), seguido_id: new Types.ObjectId(author.id),
    });
    await request(server()).put(`/usuarios/me/solicitacoes/${relation!._id.toString()}/aceitar`)
      .set(auth(author)).expect(200);
    expect((await list(actor).expect(200)).body.data.items)
      .toMatchObject([{ tipo: 'follow_accepted', ator: { id: author.id } }]);
    expect((await unread(author).expect(200)).body.data).toEqual({ total: 0 });
  });

  it('hides canceled requests and other obsolete relationships from list and count', async () => {
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(author.id) },
      { $set: { visibilidade_perfil: 'privado' } });
    await follow(actor).expect(200);
    expect((await unread(author).expect(200)).body.data.total).toBe(1);
    await request(server()).delete(`/usuarios/${author.id}/seguir`).set(auth(actor)).expect(200);
    expect((await list(author).expect(200)).body.data.items).toHaveLength(0);
    expect((await unread(author).expect(200)).body.data.total).toBe(0);
  });

  it('notifies post comments and replies, but not the recipient’s own comment', async () => {
    const root = await comment(publicId, actor, { conteudo: 'Comentário' }).expect(201);
    expect((await list(author).expect(200)).body.data.items)
      .toMatchObject([{ tipo: 'post_commented', comentarioId: root.body.data.id }]);
    await comment(publicId, author, { conteudo: 'Resposta', comentarioPaiId: root.body.data.id }).expect(201);
    expect((await list(actor).expect(200)).body.data.items)
      .toMatchObject([{ tipo: 'comment_replied', ator: { id: author.id } }]);
    await comment(publicId, author, { conteudo: 'Comentário próprio' }).expect(201);
    expect(await notifications.countDocuments({ destinatario_id: new Types.ObjectId(author.id) })).toBe(1);
  });

  it('does not duplicate a notification on an idempotent comment retry', async () => {
    const key = randomBytes(18).toString('base64url');
    const send = (conteudo: string) => request(server()).post(`/publicacoes/${publicId}/comentarios`)
      .set(auth(actor)).set('Idempotency-Key', key).send({ conteudo });
    const first = await send('Comentário repetível').expect(201);
    const repeated = await send('Comentário repetível').expect(201);
    expect(repeated.body.data.id).toBe(first.body.data.id);
    await send('Outro conteúdo').expect(409);
    expect(await notifications.countDocuments({ tipo: 'post_commented' })).toBe(1);
  });

  it('notifies the first upvote once and ignores downvotes, removal and renewed upvotes', async () => {
    const put = (valor: number) => request(server()).put(`/publicacoes/${publicId}/voto`)
      .set(auth(actor)).send({ valor });
    await put(-1).expect(200);
    expect(await notifications.countDocuments()).toBe(0);
    await put(1).expect(200);
    expect((await list(author).expect(200)).body.data.items)
      .toMatchObject([{ tipo: 'post_upvoted', ator: { id: actor.id } }]);
    await put(1).expect(200);
    await request(server()).delete(`/publicacoes/${publicId}/voto`).set(auth(actor)).expect(200);
    await put(1).expect(200);
    expect(await notifications.countDocuments({ tipo: 'post_upvoted' })).toBe(1);
  });

  it('filters inaccessible replies, deleted posts and inactive actors before counting', async () => {
    await follow(actor).expect(200);
    const root = await comment(restrictedId, actor, { conteudo: 'Raiz' }).expect(201);
    await comment(restrictedId, author, { conteudo: 'Resposta', comentarioPaiId: root.body.data.id }).expect(201);
    expect((await unread(actor).expect(200)).body.data.total).toBe(1);
    await request(server()).delete(`/usuarios/${author.id}/seguir`).set(auth(actor)).expect(200);
    expect((await list(actor).expect(200)).body.data.items).toHaveLength(0);
    expect((await unread(actor).expect(200)).body.data.total).toBe(0);
    await follow(actor).expect(200);
    await posts.updateOne({ _id: new Types.ObjectId(restrictedId) }, { $set: { status: 'excluida' } }).exec();
    expect((await unread(actor).expect(200)).body.data.total).toBe(0);
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(author.id) },
      { $set: { status: 'bloqueado' } });
    expect((await unread(actor).expect(200)).body.data.total).toBe(0);
  });

  it('paginates by date and ID and binds cursors to recipient and unread filter', async () => {
    await comment(publicId, actor, { conteudo: 'Um' }).expect(201);
    await comment(publicId, third, { conteudo: 'Dois' }).expect(201);
    await comment(publicId, actor, { conteudo: 'Três' }).expect(201);
    const first = await list(author, '?limite=2&naoLidas=true').expect(200);
    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.hasMore).toBe(true);
    const next = await list(author, `?limite=2&naoLidas=true&cursor=${first.body.data.nextCursor}`).expect(200);
    expect(next.body.data.items).toHaveLength(1);
    expect(new Set([...first.body.data.items, ...next.body.data.items].map((item: { id: string }) => item.id)).size)
      .toBe(3);
    await list(actor, `?cursor=${first.body.data.nextCursor}&naoLidas=true`).expect(400);
    await list(author, `?cursor=${first.body.data.nextCursor}`).expect(400);
  });

  it('marks individual and all notifications as read idempotently', async () => {
    await comment(publicId, actor, { conteudo: 'Um' }).expect(201);
    await comment(publicId, third, { conteudo: 'Dois' }).expect(201);
    const id = (await list(author).expect(200)).body.data.items[0].id as string;
    await request(server()).patch(`/notificacoes/${id}/lida`).set(auth(author)).expect(200);
    await request(server()).patch(`/notificacoes/${id}/lida`).set(auth(author)).expect(200);
    expect((await unread(author).expect(200)).body.data.total).toBe(1);
    await request(server()).patch('/notificacoes/ler-todas').set(auth(author)).expect(200);
    await request(server()).patch('/notificacoes/ler-todas').set(auth(author)).expect(200);
    expect((await unread(author).expect(200)).body.data.total).toBe(0);
  });

  it('recovers a failed notification write without failing the confirmed comment', async () => {
    const originalUpdate = notifications.updateOne.bind(notifications);
    const spy = vi.spyOn(notifications, 'updateOne').mockImplementationOnce(() => {
      const failed = originalUpdate({ _id: new Types.ObjectId() }, { $set: { lida_em: null } });
      failed.exec = (async () => { throw new Error('notification storage unavailable'); }) as typeof failed.exec;
      return failed;
    });
    try {
      await comment(publicId, actor, { conteudo: 'Persistido apesar da falha' }).expect(201);
    } finally {
      spy.mockRestore();
    }
    expect(await notifications.countDocuments()).toBe(0);
    expect(await connection.db!.collection('comentarios').countDocuments({ notificacao_pendente: true })).toBe(1);
    await producer.recoverBatch();
    expect((await unread(author).expect(200)).body.data.total).toBe(1);
    await producer.recoverBatch();
    expect(await notifications.countDocuments()).toBe(1);
  });

  it('deduplicates concurrent follow requests and keeps one notification', async () => {
    const results = await Promise.all([follow(actor), follow(actor)]);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(await connection.db!.collection('seguidores').countDocuments()).toBe(1);
    expect(await notifications.countDocuments({ tipo: 'user_followed' })).toBe(1);
  });
});
