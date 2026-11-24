import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { createClient } from 'redis';
import sharp from 'sharp';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { ApiException } from '../src/common/http/api.exception.js';
import { configureHttp } from '../src/common/http/configure-http.js';
import { MediaStorageService } from '../src/publicacoes/media-storage.service.js';
import { AvatarService } from '../src/usuarios/avatar.service.js';

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
    mongo.pathname = `/ierri_avatar_test_${runId}`;
    return { mongo: mongo.toString(), session: `ierri:avatar:session:${runId}:`,
      rate: `ierri:avatar:rate:${runId}:`, cache: `ierri:avatar:cache:${runId}:` };
  } catch { return null; }
})();

type Account = { id: string; token: string; username: string };

describe.runIf(config)('avatar personalizado com MongoDB, Redis e MinIO locais', () => {
  let app: INestApplication;
  let connection: Connection;
  let storage: MediaStorageService;
  let avatars: AvatarService;
  let inspector: ReturnType<typeof createClient>;
  let sequence = 0;
  const extraKeys: string[] = [];
  const originals = Object.fromEntries([
    'MONGODB_URI', 'REDIS_SESSION_PREFIX', 'REDIS_CHECK_EMAIL_RATE_PREFIX',
    'REDIS_CACHE_ENABLED', 'REDIS_CACHE_URL', 'REDIS_CACHE_PREFIX',
  ].map((key) => [key, process.env[key]]));
  const server = () => app.getHttpServer();
  const auth = (user: Account) => ({ Authorization: `Bearer ${user.token}` });
  const image = (format: 'png' | 'jpeg' | 'webp', width = 128, height = 128) =>
    sharp({ create: { width, height, channels: 4, background: '#bb3355' } })
      .toFormat(format).toBuffer();
  const account = async (): Promise<Account> => {
    const name = `Avatar ${++sequence}`;
    const response = await request(server()).post('/auth/register').send({ name,
      email: `avatar-${sequence}-${runId}@example.invalid`,
      password: `Local-${randomBytes(12).toString('hex')}` }).expect(201);
    return { id: response.body.data.user.id as string,
      token: response.body.data.access_token as string,
      username: response.body.data.user.username as string };
  };
  const upload = async (user: Account, format: 'png' | 'jpeg' | 'webp' = 'png') => {
    const bytes = await image(format);
    return request(server()).put('/usuarios/me/avatar').set(auth(user))
      .attach('file', bytes, { filename: `avatar.${format}`, contentType: `image/${format}` });
  };
  const reference = (url: string) => url.split('/').at(-1)!;
  const read = (user: Account, url: string) =>
    request(server()).get(`/usuarios/${user.id}/avatar/${reference(url)}`);

  beforeAll(async () => {
    process.env.MONGODB_URI = config!.mongo;
    process.env.REDIS_SESSION_PREFIX = config!.session;
    process.env.REDIS_CHECK_EMAIL_RATE_PREFIX = config!.rate;
    process.env.REDIS_CACHE_ENABLED = 'true';
    process.env.REDIS_CACHE_URL = redisBase;
    process.env.REDIS_CACHE_PREFIX = config!.cache;
    inspector = createClient({ url: redisBase });
    inspector.on('error', () => {});
    await inspector.connect();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureHttp(app);
    await app.init();
    connection = module.get<Connection>(getConnectionToken());
    storage = module.get(MediaStorageService);
    avatars = module.get(AvatarService);
    await connection.model('AvatarArquivo').init();
  });

  afterAll(async () => {
    if (app) app.get(AvatarService).onModuleDestroy();
    if (connection?.db) {
      const rows = await connection.db.collection('avatar_arquivos')
        .find({}, { projection: { chave_storage: 1 } }).toArray();
      for (const key of [...rows.map((row) => row.chave_storage as string), ...extraKeys])
        await storage.remove(key).catch(() => undefined);
      await connection.db.dropDatabase();
    }
    if (inspector?.isReady) {
      for (const prefix of [config!.session, config!.rate, config!.cache]) {
        const keys = await inspector.keys(`${prefix}*`);
        if (keys.length) await inspector.del(keys);
      }
      await inspector.close();
    }
    if (app) await app.close();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('requires a valid session for upload and removal', async () => {
    const bytes = await image('png');
    await request(server()).put('/usuarios/me/avatar')
      .attach('file', bytes, 'avatar.png').expect(401);
    await request(server()).delete('/usuarios/me/avatar').expect(401);
  });

  it.each(['png', 'jpeg', 'webp'] as const)('uploads and serves a valid %s avatar', async (format) => {
    const user = await account();
    const response = await upload(user, format).then((result) => { expect(result.status).toBe(200); return result; });
    const url = response.body.data.avatarUrl as string;
    expect(response.body.data).toMatchObject({ mimeType: `image/${format}`,
      largura: 128, altura: 128 });
    expect(url).toContain(`/usuarios/${user.id}/avatar/`);
    const opened = await read(user, url).expect(200);
    expect(opened.headers['content-type']).toMatch(`image/${format}`);
    expect(opened.headers['x-content-type-options']).toBe('nosniff');
    const profile = await request(server()).get(`/usuarios/${user.username}`).expect(200);
    expect(profile.body.data.avatarUrl).toBe(url);
    const me = await request(server()).get('/usuarios/me').set(auth(user)).expect(200);
    expect(me.body.data.avatarUrl).toBe(url);
  });

  it('rejects invalid MIME, corrupt data, small dimensions and files over 5 MB', async () => {
    const user = await account();
    const small = await image('png', 127, 128);
    const valid = await image('png');
    for (const [bytes, mime] of [[small, 'image/png'], [Buffer.from('broken'), 'image/png'],
      [valid, 'image/webp'], [Buffer.from('<svg/>'), 'image/svg+xml']] as const) {
      const response = await request(server()).put('/usuarios/me/avatar').set(auth(user))
        .attach('file', bytes, { filename: 'avatar.bin', contentType: mime });
      expect(response.status).toBe(422);
    }
    const tooLarge = await request(server()).put('/usuarios/me/avatar').set(auth(user))
      .attach('file', Buffer.alloc(5_000_001), { filename: 'big.png', contentType: 'image/png' });
    expect(tooLarge.status).toBeGreaterThanOrEqual(400);
    const me = await request(server()).get('/usuarios/me').set(auth(user)).expect(200);
    expect(me.body.data.avatarUrl).toBeNull();
  });

  it('replaces an avatar and makes the old reference inaccessible', async () => {
    const user = await account();
    const first = await upload(user).then((result) => result.body.data.avatarUrl as string);
    const second = await upload(user, 'webp').then((result) => result.body.data.avatarUrl as string);
    expect(second).not.toBe(first);
    await read(user, first).expect(404);
    await read(user, second).expect(200);
    const other = await account();
    await request(server()).delete('/usuarios/me/avatar').set(auth(other)).expect(200);
    await read(user, second).expect(200);
    await read(other, second).expect(404);
    await request(server()).get(`/usuarios/${new Types.ObjectId().toString()}/avatar/${reference(second)}`).expect(404);
  });

  it('cleans the custom avatar when a predefined avatar is selected or cleared', async () => {
    const user = await account();
    const first = await upload(user).then((result) => result.body.data.avatarUrl as string);
    const staticUrl = '/brand/ierri/social/github-avatar-512.png';
    const selected = await request(server()).patch('/usuarios/me').set(auth(user))
      .send({ avatarUrl: staticUrl }).expect(200);
    expect(selected.body.data.avatarUrl).toBe(staticUrl);
    await read(user, first).expect(404);
    const second = await upload(user).then((result) => result.body.data.avatarUrl as string);
    const cleared = await request(server()).patch('/usuarios/me').set(auth(user))
      .send({ avatarUrl: null }).expect(200);
    expect(cleared.body.data.avatarUrl).toBeNull();
    await read(user, second).expect(404);
    await request(server()).patch('/usuarios/me').set(auth(user))
      .send({ avatarUrl: second }).expect(400);
  });

  it('removes the avatar idempotently and does not serve it to an inactive account', async () => {
    const user = await account();
    const url = await upload(user).then((result) => result.body.data.avatarUrl as string);
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(user.id) },
      { $set: { status: 'bloqueado' } });
    await read(user, url).expect(404);
    await connection.db!.collection('usuarios').updateOne({ _id: new Types.ObjectId(user.id) },
      { $set: { status: 'ativo' } });
    await request(server()).delete('/usuarios/me/avatar').set(auth(user)).expect(200);
    const again = await request(server()).delete('/usuarios/me/avatar').set(auth(user)).expect(200);
    expect(again.body.data.avatarUrl).toBeNull();
    await read(user, url).expect(404);
  });

  it('preserves the old avatar and recovers an ambiguous persisted upload', async () => {
    const user = await account();
    const old = await upload(user).then((result) => result.body.data.avatarUrl as string);
    const actualPut = storage.put.bind(storage);
    const spy = vi.spyOn(storage, 'put').mockImplementationOnce(async (...args) => {
      await actualPut(...args);
      throw new ApiException('MEDIA_STORAGE_UNAVAILABLE');
    });
    try {
      await upload(user).then((response) => expect(response.status).toBe(503));
      await read(user, old).expect(200);
      const pending = await connection.db!.collection('avatar_arquivos').findOne({
        usuario_id: new Types.ObjectId(user.id), estado: 'preparando',
      });
      expect(pending).not.toBeNull();
      expect(await storage.head(pending!.chave_storage as string)).not.toBeNull();
      await connection.db!.collection('avatar_arquivos').updateOne({ _id: pending!._id },
        { $set: { criado_em: new Date(Date.now() - 31 * 60_000) } });
      await avatars.recoverBatch();
      expect(await storage.head(pending!.chave_storage as string)).toBeNull();
      await read(user, old).expect(200);
    } finally { spy.mockRestore(); }
  });

  it('keeps one active reference after concurrent replacements', async () => {
    const user = await account();
    const bytes = await image('png');
    const attempts = await Promise.all([1, 2].map(() => request(server())
      .put('/usuarios/me/avatar').set(auth(user))
      .attach('file', bytes, { filename: 'avatar.png', contentType: 'image/png' })));
    const me = await request(server()).get('/usuarios/me').set(auth(user)).expect(200);
    const active = me.body.data.avatarUrl as string;
    expect(attempts.some((result) => result.body.data?.avatarUrl === active)).toBe(true);
    await read(user, active).expect(200);
    for (const result of attempts) {
      const url = result.body.data?.avatarUrl as string | undefined;
      if (url && url !== active) await read(user, url).expect(404);
    }
  });

  it('recovers an orphaned stored file without removing the active avatar', async () => {
    const user = await account();
    const active = await upload(user).then((result) => result.body.data.avatarUrl as string);
    const key = `avatars/${user.id}/orphan-${runId}`;
    extraKeys.push(key);
    const bytes = await image('png');
    await storage.put(key, bytes, 'image/png', 'orphan-test');
    await connection.db!.collection('avatar_arquivos').insertOne({
      usuario_id: new Types.ObjectId(user.id), referencia: randomBytes(24).toString('base64url'),
      chave_storage: key, estado: 'preparando',
      criado_em: new Date(Date.now() - 31 * 60_000), atualizado_em: new Date(),
    });
    await avatars.recoverBatch();
    expect(await storage.head(key)).toBeNull();
    await read(user, active).expect(200);
  });
});
