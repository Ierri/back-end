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
import { Tecnologia } from '../src/usuarios/schemas/tecnologia.schema.js';
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
    mongo.pathname = `/ierri_admin_tecnologias_test_${runId}`;
    return { mongo: mongo.toString(), sessionPrefix: `ierri:admin-tech:session:${runId}:`,
      ratePrefix: `ierri:admin-tech:rate:${runId}:` };
  } catch { return null; }
})();

type Account = { id: string; token: string };

describe.runIf(config)('administração de tecnologias com MongoDB e Redis locais', () => {
  let app: INestApplication;
  let connection: Connection;
  let technologies: Model<Tecnologia>;
  let inspector: ReturnType<typeof createClient>;
  let admin: Account;
  let moderator: Account;
  let regular: Account;
  let another: Account;
  const original = Object.fromEntries([
    'MONGODB_URI', 'REDIS_SESSION_PREFIX', 'REDIS_CHECK_EMAIL_RATE_PREFIX',
  ].map((key) => [key, process.env[key]]));
  const server = () => app.getHttpServer();
  const auth = (account: Account) => ({ Authorization: `Bearer ${account.token}` });
  const create = (account: Account, body: Record<string, unknown>) =>
    request(server()).post('/admin/tecnologias').set(auth(account)).send(body);
  const edit = (account: Account, id: string, body: Record<string, unknown>) =>
    request(server()).patch(`/admin/tecnologias/${id}`).set(auth(account)).send(body);
  const list = (account: Account, query = '') =>
    request(server()).get(`/admin/tecnologias${query}`).set(auth(account));
  const register = async (name: string): Promise<Account> => {
    const result = await request(server()).post('/auth/register').send({ name,
      email: `${name.toLowerCase()}-${runId}@example.invalid`,
      password: `Local-${randomBytes(12).toString('hex')}` }).expect(201);
    return { id: result.body.data.user.id as string,
      token: result.body.data.access_token as string };
  };

  beforeAll(async () => {
    process.env.MONGODB_URI = config!.mongo;
    process.env.REDIS_SESSION_PREFIX = config!.sessionPrefix;
    process.env.REDIS_CHECK_EMAIL_RATE_PREFIX = config!.ratePrefix;
    inspector = createClient({ url: redisBase });
    inspector.on('error', () => {});
    await inspector.connect();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureHttp(app);
    await app.init();
    connection = module.get<Connection>(getConnectionToken());
    technologies = module.get<Model<Tecnologia>>(getModelToken(Tecnologia.name));
    await technologies.init();
    [admin, moderator, regular, another] = await Promise.all([
      register('TechAdmin'), register('TechModerator'), register('TechRegular'), register('TechAnother'),
    ]);
  });

  beforeEach(async () => {
    await technologies.deleteMany({}).exec();
    await connection.db!.collection('usuarios').updateMany({}, { $set: { stack_ids: [], papeis: ['usuario'],
      status: 'ativo', excluido_em: null } });
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(admin.id) },
      { $set: { papeis: ['usuario', 'administrador'] } });
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(moderator.id) },
      { $set: { papeis: ['usuario', 'moderador'] } });
  });

  afterAll(async () => {
    if (app) await app.get(SeguidoresService).onModuleDestroy();
    if (connection?.db) await connection.db.dropDatabase();
    if (inspector?.isReady) {
      for (const prefix of [config!.sessionPrefix, config!.ratePrefix]) {
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

  it('requires an active session for every administrative route', async () => {
    await request(server()).get('/admin/tecnologias').expect(401);
    await request(server()).post('/admin/tecnologias').send({ nome: 'Rust', slug: 'rust' }).expect(401);
    await request(server()).patch(`/admin/tecnologias/${new Types.ObjectId().toString()}`)
      .send({ ativo: false }).expect(401);
    await request(server()).get('/admin/tecnologias').set('Authorization', 'Bearer invalid').expect(401);
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(admin.id) },
      { $set: { status: 'bloqueado' } });
    await list(admin).expect(401);
  });

  it('denies users and moderators while allowing an administrator', async () => {
    for (const account of [regular, moderator]) {
      await list(account).expect(403);
      await create(account, { nome: 'Rust', slug: 'rust' }).expect(403);
      await edit(account, new Types.ObjectId().toString(), { ativo: false }).expect(403);
    }
    await list(admin).expect(200);
  });

  it('revokes administrator access during an otherwise active session', async () => {
    await list(admin).expect(200);
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(admin.id) },
      { $set: { papeis: ['usuario'] } });
    await list(admin).expect(403);
    await create(admin, { nome: 'Rust', slug: 'rust' }).expect(403);
    expect(await technologies.countDocuments()).toBe(0);
  });

  it('creates, edits and toggles a technology without removing its record', async () => {
    const result = await create(admin, { nome: ' Rust ', slug: 'Rust', categoria: 'Backend',
      iconeUrl: 'https://cdn.example.invalid/rust.svg', ativo: false }).expect(201);
    const id = result.body.data.id as string;
    expect(result.body.data).toEqual({ id, nome: 'Rust', slug: 'rust', categoria: 'Backend',
      iconeUrl: 'https://cdn.example.invalid/rust.svg', ativo: false });
    expect((await request(server()).get('/tecnologias').expect(200)).body.data.items).toHaveLength(0);
    await edit(admin, id, { nome: 'Rust Lang', ativo: true }).expect(200);
    expect((await request(server()).get('/tecnologias').expect(200)).body.data.items)
      .toMatchObject([{ id, nome: 'Rust Lang' }]);
    await edit(admin, id, { ativo: false }).expect(200);
    expect(await technologies.countDocuments({ _id: new Types.ObjectId(id) })).toBe(1);
    expect((await request(server()).get('/tecnologias').expect(200)).body.data.items).toHaveLength(0);
  });

  it('preserves the unique slug under concurrent creation and editing', async () => {
    const [first, second] = await Promise.all([
      create(admin, { nome: 'Go', slug: 'go' }),
      create(admin, { nome: 'Golang', slug: 'go' }),
    ]);
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([201, 409]);
    expect(await technologies.countDocuments({ slug: 'go' })).toBe(1);
    const other = await create(admin, { nome: 'Rust', slug: 'rust' }).expect(201);
    await edit(admin, other.body.data.id as string, { slug: 'go' }).expect(409);
    expect(await technologies.countDocuments({ slug: 'rust' })).toBe(1);
  });

  it('filters and paginates the admin list without exposing it through the public catalogue', async () => {
    for (const [nome, slug, ativo] of [
      ['Angular', 'angular', false], ['React', 'react', false],
      ['Rust', 'rust', false], ['Vue', 'vue', true],
    ] as const) await create(admin, { nome, slug, ativo }).expect(201);
    const first = await list(admin, '?status=inativo&limite=2').expect(200);
    expect(first.body.data.items.map((item: { nome: string }) => item.nome)).toEqual(['Angular', 'React']);
    expect(first.body.data.hasMore).toBe(true);
    const next = await list(admin, `?status=inativo&limite=2&cursor=${first.body.data.nextCursor}`).expect(200);
    expect(next.body.data.items.map((item: { nome: string }) => item.nome)).toEqual(['Rust']);
    await list(admin, `?status=ativo&cursor=${first.body.data.nextCursor}`).expect(400);
    expect((await list(admin, '?busca=rea').expect(200)).body.data.items)
      .toMatchObject([{ nome: 'React' }]);
    expect((await request(server()).get('/tecnologias').expect(200)).body.data.items)
      .toMatchObject([{ nome: 'Vue' }]);
  });

  it('retains old inactive stack selections while rejecting new ones', async () => {
    const inactive = await create(admin, { nome: 'Legacy', slug: 'legacy' }).expect(201);
    const older = await create(admin, { nome: 'Older', slug: 'older' }).expect(201);
    const active = await create(admin, { nome: 'Current', slug: 'current' }).expect(201);
    const oldId = inactive.body.data.id as string;
    const olderId = older.body.data.id as string;
    const activeId = active.body.data.id as string;
    await request(server()).put('/usuarios/me/stacks').set(auth(regular))
      .send({ stackIds: [oldId, olderId, activeId] }).expect(200);
    await edit(admin, oldId, { ativo: false }).expect(200);
    await edit(admin, olderId, { ativo: false }).expect(200);
    await request(server()).put('/usuarios/me/stacks').set(auth(regular))
      .send({ stackIds: [oldId, olderId, activeId] }).expect(200);
    await request(server()).put('/usuarios/me/stacks').set(auth(another))
      .send({ stackIds: [oldId] }).expect(422);
    await request(server()).put('/usuarios/me/stacks').set(auth(regular))
      .send({ stackIds: [olderId, activeId] }).expect(200);
    const saved = await connection.db!.collection('usuarios').findOne({ _id: new Types.ObjectId(regular.id) });
    expect(saved?.stack_ids.map((id: Types.ObjectId) => id.toString())).toEqual([olderId, activeId]);
  });

  it('rejects invalid icons and payloads without fetching remote resources', async () => {
    for (const body of [
      { nome: 'Bad', slug: 'bad', iconeUrl: 'http://example.invalid/icon.svg' },
      { nome: 'Bad', slug: 'bad', iconeUrl: '/brand/../secret.svg' },
      { nome: 'Bad', slug: 'bad', ativo: 'false' },
      { nome: '', slug: 'bad' },
    ]) await create(admin, body).expect(400);
    await edit(admin, new Types.ObjectId().toString(), {}).expect(400);
    await edit(admin, new Types.ObjectId().toString(), { ativo: false }).expect(404);
    expect(await technologies.countDocuments()).toBe(0);
  });
});
