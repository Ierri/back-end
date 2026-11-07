import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { configureHttp } from '../src/common/http/configure-http.js';
import { AppModule } from '../src/app.module.js';

const baseUri = process.env.MONGODB_URI;
const secret = process.env.JWT_SECRET;
const localUri = (() => {
  if (!baseUri || !secret || Buffer.byteLength(secret) < 32) return null;
  try {
    const url = new URL(baseUri);
    if (
      url.protocol !== 'mongodb:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname)
    )
      return null;
    url.pathname = `/ierri_auth_test_${randomBytes(8).toString('hex')}`;
    return url.toString();
  } catch {
    return null;
  }
})();

describe.runIf(localUri)('Auth HTTP with isolated MongoDB', () => {
  let app: INestApplication;
  let connection: Connection;
  const body = {
    name: 'Ana Integração',
    email: 'ana.integracao@example.com',
    password: 'SenhaTeste123!',
  };

  const sessionId = (token: string) => {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString(),
    ) as { sid: string };
    return createHash('sha256').update(payload.sid).digest('hex');
  };

  beforeAll(async () => {
    process.env.MONGODB_URI = localUri!;
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    configureHttp(app);
    await app.init();
    connection = module.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    if (connection?.db) await connection.db.dropDatabase();
    if (app) await app.close();
    if (baseUri) process.env.MONGODB_URI = baseUri;
  });

  it('persists registration and login sessions, then revokes a token on logout', async () => {
    const agent = request.agent(app.getHttpServer());
    const registered = await agent
      .post('/auth/register')
      .send(body)
      .expect(201);
    const firstToken = registered.body.data.access_token as string;
    const user = await connection
      .db!.collection('usuarios')
      .findOne({ email: body.email });
    const session = await connection
      .db!.collection('sessoes')
      .findOne({ id_hash: sessionId(firstToken) });
    expect(user).not.toBeNull();
    expect(session?.usuario_id.toString()).toBe(user?._id.toString());
    expect(session?.expira_em).toBeInstanceOf(Date);
    expect(session?.criada_em).toBeInstanceOf(Date);
    expect(JSON.stringify(session)).not.toContain(firstToken);
    await agent.get('/auth/me').expect(200);

    const login = await agent
      .post('/auth/login')
      .send({ email: body.email, password: body.password })
      .expect(200);
    const token = login.body.data.access_token as string;
    expect(
      await connection
        .db!.collection('sessoes')
        .findOne({ id_hash: sessionId(token) }),
    ).not.toBeNull();
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await agent.post('/auth/logout').send({}).expect(200);
    const revoked = await connection
      .db!.collection('sessoes')
      .findOne({ id_hash: sessionId(token) });
    expect(revoked?.revogada_em).toBeInstanceOf(Date);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
  });

  it('rejects missing, expired and foreign-user sessions', async () => {
    const login = async () =>
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: body.email, password: body.password })
          .expect(200)
      ).body.data.access_token as string;
    const me = (token: string) =>
      request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);

    const missing = await login();
    await connection
      .db!.collection('sessoes')
      .deleteOne({ id_hash: sessionId(missing) });
    await me(missing).expect(401);

    const expired = await login();
    await connection
      .db!.collection('sessoes')
      .updateOne(
        { id_hash: sessionId(expired) },
        { $set: { expira_em: new Date(0) } },
      );
    await me(expired).expect(401);

    const foreign = await login();
    await connection
      .db!.collection('sessoes')
      .updateOne(
        { id_hash: sessionId(foreign) },
        { $set: { usuario_id: new Types.ObjectId() } },
      );
    await me(foreign).expect(401);
  });

  it('keeps public validation and invalid-login behavior', async () => {
    await request(app.getHttpServer())
      .post('/auth/check-email')
      .send({ email: body.email })
      .expect(200);
    const count = await connection.db!.collection('sessoes').countDocuments();
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: body.email, password: 'wrong' })
      .expect(401);
    expect(await connection.db!.collection('sessoes').countDocuments()).toBe(
      count,
    );
    const invalid = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'invalid', password: '' })
      .expect(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    await request(app.getHttpServer()).get('/auth/me').expect(401);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({})
      .expect(200);
  });

  it('fails closed when MongoDB rejects session writes', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: body.email, password: body.password })
      .expect(200);
    const token = login.body.data.access_token as string;
    await connection.db!.command({
      collMod: 'sessoes',
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['integration_test_blocked'],
        },
      },
      validationLevel: 'strict',
    });
    try {
      const failedRegistration = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ ...body, email: 'falha.integracao@example.com' })
        .expect(500);
      expect(failedRegistration.headers['set-cookie']).toBeUndefined();
      expect(
        await connection
          .db!.collection('usuarios')
          .findOne({ email: 'falha.integracao@example.com' }),
      ).not.toBeNull();

      const failedLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: body.email, password: body.password })
        .expect(500);
      expect(failedLogin.headers['set-cookie']).toBeUndefined();
      const failedLogout = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(500);
      expect(failedLogout.headers['set-cookie']).toBeUndefined();
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    } finally {
      await connection.db!.command({ collMod: 'sessoes', validator: {} });
    }
  });
});
