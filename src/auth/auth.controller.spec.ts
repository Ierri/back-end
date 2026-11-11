import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { ApiHttpModule } from '../common/http/api-http.module.js';
import { ApiException } from '../common/http/api.exception.js';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import { compare } from 'bcryptjs';
import request from 'supertest';
import { configureHttp } from '../common/http/configure-http.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { SessionPersistenceError, SessoesService } from './sessoes.service.js';
import { CheckEmailRateLimitService } from './check-email-rate-limit.service.js';
import { UsuariosService } from '../usuarios/usuarios.service.js';
import { UsuarioSchema } from '../usuarios/schemas/usuario.schema.js';
import type { UsuarioDocument } from '../usuarios/schemas/usuario.schema.js';

const UsuarioModel = mongoose.model('AuthTestUsuario', UsuarioSchema);
const secret = 'test-secret-only-for-auth-tests-at-least-32-bytes';

describe('Auth HTTP (isolated persistence)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const records = new Map<string, UsuarioDocument>();
  const sessions = new Map<
    string,
    { userId: string; expiresAt: Date; revoked: boolean }
  >();
  const sessoes = {
    create: vi.fn(async (id: string, userId: string, expiresAt: Date) => {
      sessions.set(id, { userId, expiresAt, revoked: false });
    }),
    assertActive: vi.fn(async (id: string, userId: string) => {
      const session = sessions.get(id);
      if (
        !session ||
        session.userId !== userId ||
        session.revoked ||
        session.expiresAt <= new Date()
      ) {
        throw new ApiException('INVALID_TOKEN');
      }
    }),
    revoke: vi.fn(async (id: string, userId: string) => {
      const session = sessions.get(id);
      if (!session || session.userId !== userId) return 'missing';
      if (session.revoked) return 'already_revoked';
      if (session.expiresAt <= new Date()) return 'expired';
      session.revoked = true;
      return 'revoked';
    }),
  };
  const checkEmailRateLimit = {
    consume: vi.fn().mockResolvedValue(null),
  };
  const usuarios = {
    findByEmail: vi.fn((email: string) => records.get(email) ?? null),
    findCredentials: vi.fn((email: string) => records.get(email) ?? null),
    findById: vi.fn(
      (id: string) =>
        [...records.values()].find((user) => user._id.toString() === id) ??
        null,
    ),
    create: vi.fn(
      (
        data: Pick<
          import('../usuarios/schemas/usuario.schema.js').Usuario,
          'nome' | 'email' | 'senha_hash'
        >,
      ) => persistence.create(data),
    ),
  };
  const persistence = new UsuariosService({
    create: async (data: Record<string, unknown>) => {
      const user = new UsuarioModel(data);
      await user.validate();
      if (records.has(user.email))
        throw { code: 11000, keyPattern: { email: 1 } };
      if (
        [...records.values()].some(
          (existing) => existing.username === user.username,
        )
      )
        throw { code: 11000, keyPattern: { username: 1 } };
      user.criado_em = new Date();
      records.set(user.email, user);
      return user;
    },
  } as unknown as mongoose.Model<
    import('../usuarios/schemas/usuario.schema.js').Usuario
  >);
  const body = {
    name: 'Ana Teste',
    email: 'ana@example.com',
    password: 'SenhaTeste123!',
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ApiHttpModule,
        JwtModule.register({
          secret,
          signOptions: {
            algorithm: 'HS256',
            expiresIn: '15m',
            issuer: 'ierri-api',
            audience: 'ierri-api',
          },
        }),
      ],
      controllers: [AuthController],
      providers: [
        AuthService,
        JwtAuthGuard,
        { provide: SessoesService, useValue: sessoes },
        { provide: CheckEmailRateLimitService, useValue: checkEmailRateLimit },
        { provide: UsuariosService, useValue: usuarios },
      ],
    }).compile();
    app = module.createNestApplication();
    configureHttp(app);
    await app.init();
    jwt = module.get(JwtService);
  });
  beforeEach(() => {
    records.clear();
    sessions.clear();
    vi.clearAllMocks();
    checkEmailRateLimit.consume.mockResolvedValue(null);
  });
  afterAll(async () => {
    await app.close();
  });

  it('registers, hashes the password, normalizes input and returns a usable token without credentials', async () => {
    const result = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        ...body,
        name: ' Ana Teste ',
        email: ' ANA@EXAMPLE.COM ',
        senha_hash: 'injected',
      })
      .expect(201);
    expect(result.body.success).toBe(true);
    expect(result.body.message).toBe('Conta criada com sucesso.');
    const stored = records.get(body.email)!;
    expect(await compare(body.password, stored.senha_hash)).toBe(true);
    expect(result.body.data.user.name).toBe('Ana Teste');
    expect(result.body.data.user.email).toBe(body.email);
    expect(result.body.data.user.username).toBe('ana_teste');
    expect(JSON.stringify(result.body)).not.toContain(stored.senha_hash);
    expect(JSON.stringify(result.body)).not.toContain(body.password);
    const payload = await jwt.verifyAsync(result.body.data.access_token);
    expect(Object.keys(payload).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'sid',
      'sub',
    ]);
    expect(payload.iss).toBe('ierri-api');
    expect(payload.aud).toBe('ierri-api');
    expect(payload.sub).toBe(stored._id.toString());
    expect(sessions.get(payload.sid)).toMatchObject({
      userId: payload.sub,
      revoked: false,
    });
    expect(payload.exp - payload.iat).toBe(900);
    stored.nome = 'Ana Atualizada';
    stored.avatar_url = '/avatar-atualizado.png';
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${result.body.data.access_token}`)
      .expect(200);
    expect(me.body.data.id).toBe(stored._id.toString());
    expect(me.body.data.name).toBe('Ana Atualizada');
    expect(me.body.data.avatarUrl).toBe('/avatar-atualizado.png');
  });

  it('persists browser authentication with an HttpOnly cookie and clears it on logout', async () => {
    const agent = request.agent(app.getHttpServer());
    const registration = await agent
      .post('/auth/register')
      .send(body)
      .expect(201);
    const cookie = registration.headers['set-cookie'][0];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=900');
    const me = await agent.get('/auth/me').expect(200);
    expect(me.body.data.email).toBe(body.email);
    const logout = await agent.post('/auth/logout').send({}).expect(200);
    expect(sessoes.revoke).toHaveBeenCalledOnce();
    expect(logout.headers['set-cookie'][0]).toContain(
      'Expires=Thu, 01 Jan 1970',
    );
    await agent.get('/auth/me').expect(401);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${registration.body.data.access_token}`)
      .expect(401);
    const login = await agent
      .post('/auth/login')
      .send({ email: body.email, password: body.password })
      .expect(200);
    expect(login.headers['set-cookie'][0]).toContain('HttpOnly');
    await agent.get('/auth/me').expect(200);
  });

  it('allows the configured frontend with credentials and rejects foreign mutations', async () => {
    const origin = (process.env.FRONTEND_URL ?? 'http://localhost:3000')
      .split(',')[0]
      .trim();
    const preflight = await request(app.getHttpServer())
      .options('/auth/login')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Origin', 'https://foreign.example')
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Origin', origin)
      .send({})
      .expect(200);
  });

  it('normalizes names and appends numbers to existing usernames', async () => {
    for (const [email, name, expected] of [
      ['first@example.com', ' Ána  Teste! ', 'ana_teste'],
      ['second@example.com', 'Ana Teste', 'ana_teste1'],
      ['third@example.com', 'ANA TESTE', 'ana_teste2'],
      ['fallback@example.com', '🎨', 'usuario'],
    ]) {
      const result = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ ...body, email, name })
        .expect(201);
      expect(result.body.data.user.username).toBe(expected);
    }
  });

  it('handles simultaneous registrations with the same name', async () => {
    const results = await Promise.all(
      ['one@example.com', 'two@example.com'].map((email) =>
        request(app.getHttpServer())
          .post('/auth/register')
          .send({ ...body, email })
          .expect(201),
      ),
    );
    expect(
      results
        .map((result) => result.body.data.user.username)
        .sort((a: string, b: string) => a.localeCompare(b)),
    ).toEqual(['ana_teste', 'ana_teste1']);
  });

  it('rejects invalid input before persisting and blocks bcrypt truncation', async () => {
    for (const data of [
      { ...body, email: 'invalid' },
      { ...body, name: ' ' },
      { ...body, password: 'short' },
      { ...body, password: 'é'.repeat(37) },
      { email: { $ne: null }, password: body.password },
    ]) {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send(data)
        .expect(400);
    }
    expect(usuarios.create).not.toHaveBeenCalled();
  });

  it('rejects a repeated email', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(409);
    expect(records.size).toBe(1);
  });

  it('returns 404 for unknown users and a limited profile preview for known users', async () => {
    const absent = await request(app.getHttpServer())
      .post('/auth/check-email')
      .send({ email: body.email })
      .expect(404);
    expect(absent.body).toEqual({
      success: false,
      error: {
        code: 'USER_NOT_FOUND',
        message: 'Usuário não encontrado.',
        details: [],
      },
    });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(201);
    const found = await request(app.getHttpServer())
      .post('/auth/check-email')
      .send({ email: ' ANA@EXAMPLE.COM ' })
      .expect(200);
    expect(found.body).toEqual({
      success: true,
      message: 'Usuário encontrado.',
      data: { user: { name: body.name, initials: 'AT' } },
    });
    expect(checkEmailRateLimit.consume).toHaveBeenLastCalledWith(
      expect.any(String),
      body.email,
    );
  });

  it('rejects invalid check-email input before consuming a rate limit', async () => {
    const result = await request(app.getHttpServer())
      .post('/auth/check-email')
      .send({ email: 'invalid' })
      .expect(400);
    expect(result.body.error.code).toBe('VALIDATION_ERROR');
    expect(checkEmailRateLimit.consume).not.toHaveBeenCalled();
  });

  it('does not use an untrusted forwarded IP header for rate limiting', async () => {
    await request(app.getHttpServer())
      .post('/auth/check-email')
      .set('X-Forwarded-For', '203.0.113.42')
      .send({ email: body.email })
      .expect(404);
    expect(checkEmailRateLimit.consume.mock.calls[0][0]).not.toBe(
      '203.0.113.42',
    );
  });

  it('returns the standard 429 envelope and Retry-After without querying users', async () => {
    checkEmailRateLimit.consume.mockResolvedValueOnce(47);
    const result = await request(app.getHttpServer())
      .post('/auth/check-email')
      .send({ email: body.email })
      .expect(429);
    expect(result.headers['retry-after']).toBe('47');
    expect(result.body).toEqual({
      success: false,
      error: {
        code: 'CHECK_EMAIL_RATE_LIMITED',
        message: 'Muitas consultas. Tente novamente mais tarde.',
        details: [],
      },
    });
    expect(usuarios.findByEmail).not.toHaveBeenCalled();
  });

  it('does not bypass the limit when Redis fails', async () => {
    checkEmailRateLimit.consume.mockRejectedValueOnce(
      new ApiException('CHECK_EMAIL_RATE_LIMIT_UNAVAILABLE'),
    );
    const result = await request(app.getHttpServer())
      .post('/auth/check-email')
      .send({ email: body.email })
      .expect(503);
    expect(result.body.error.code).toBe('CHECK_EMAIL_RATE_LIMIT_UNAVAILABLE');
    expect(usuarios.findByEmail).not.toHaveBeenCalled();
  });

  it('logs in with bcrypt credentials and returns 401 for wrong or unknown credentials', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: body.email, password: body.password })
      .expect(200);
    expect(login.body.data.access_token).toBeTypeOf('string');
    const wrong = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: body.email, password: 'wrong' })
      .expect(401);
    const unknown = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'unknown@example.com', password: 'wrong' })
      .expect(401);
    expect(wrong.body).toEqual({
      success: false,
      error: {
        code: 'INVALID_CREDENTIALS',
        message: 'E-mail ou senha inválidos.',
        details: [],
      },
    });
    expect(unknown.body).toEqual(wrong.body);
    expect(sessoes.create).toHaveBeenCalledTimes(2);
  });

  it('rejects missing, expired and revoked sessions despite a valid JWT', async () => {
    const result = await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(201);
    const token = result.body.data.access_token;
    const sid = (await jwt.verifyAsync<{ sid: string }>(token)).sid;
    const callMe = () =>
      request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);

    sessions.delete(sid);
    await callMe().expect(401);
    sessions.set(sid, {
      userId: records.get(body.email)!._id.toString(),
      expiresAt: new Date(0),
      revoked: false,
    });
    await callMe().expect(401);
    sessions.get(sid)!.expiresAt = new Date(Date.now() + 60_000);
    sessions.get(sid)!.revoked = true;
    await callMe().expect(401);
    sessions.get(sid)!.revoked = false;
    sessions.get(sid)!.userId = new mongoose.Types.ObjectId().toString();
    await callMe().expect(401);
  });

  it('clears missing, expired and already revoked sessions on logout', async () => {
    const result = await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(201);
    const token = result.body.data.access_token;
    const sid = (await jwt.verifyAsync<{ sid: string }>(token)).sid;
    const logout = () =>
      request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .send({});

    await logout().expect(200);
    const repeated = await logout().expect(200);
    expect(repeated.body.data).toBeNull();
    expect(repeated.headers['set-cookie'][0]).toContain(
      'Expires=Thu, 01 Jan 1970',
    );
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    sessions.delete(sid);
    await logout().expect(200);
    sessions.set(sid, {
      userId: records.get(body.email)!._id.toString(),
      expiresAt: new Date(0),
      revoked: false,
    });
    await logout().expect(200);
    const absent = await request(app.getHttpServer())
      .post('/auth/logout')
      .send({})
      .expect(200);
    expect(absent.headers['set-cookie'][0]).toContain(
      'Expires=Thu, 01 Jan 1970',
    );
  });

  it('clears an expired JWT and rejects a forged token without hiding it', async () => {
    const expired = await jwt.signAsync(
      { sub: new mongoose.Types.ObjectId().toString(), sid: 'a'.repeat(43) },
      { expiresIn: -1 },
    );
    const result = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', `ierri_session=${expired}`)
      .send({})
      .expect(200);
    expect(result.headers['set-cookie'][0]).toContain(
      'Expires=Thu, 01 Jan 1970',
    );
    expect(sessoes.revoke).not.toHaveBeenCalled();
    const invalid = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', 'ierri_session=forged')
      .send({})
      .expect(401);
    expect(invalid.body.error.code).toBe('INVALID_TOKEN');
    expect(invalid.headers['set-cookie'][0]).toContain(
      'Expires=Thu, 01 Jan 1970',
    );
  });

  it('reports a completed registration when session persistence fails', async () => {
    sessoes.create.mockRejectedValueOnce(new SessionPersistenceError());
    const result = await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(503);
    expect(result.body).toEqual({
      success: false,
      error: {
        code: 'REGISTRATION_COMPLETED_SESSION_UNAVAILABLE',
        message:
          'Sua conta foi criada, mas não foi possível iniciar a sessão. Tente entrar novamente quando o serviço estiver disponível.',
        details: [],
      },
    });
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(records.has(body.email)).toBe(true);
    expect(sessions.size).toBe(0);
    expect(usuarios.create).toHaveBeenCalledOnce();
    await request(app.getHttpServer()).get('/auth/me').expect(401);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(409);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: body.email, password: body.password })
      .expect(200);
    expect(login.body.data.user.email).toBe(body.email);
    expect(login.headers['set-cookie'][0]).toContain('ierri_session=');
  });

  it('does not report a completed registration when user persistence fails', async () => {
    usuarios.create.mockRejectedValueOnce(new Error('MongoDB unavailable'));
    const result = await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(500);
    expect(result.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(result.body)).not.toContain('access_token');
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(records.has(body.email)).toBe(false);
    expect(sessoes.create).not.toHaveBeenCalled();
  });

  it('keeps unrelated failures out of the session-unavailable response', async () => {
    const sign = vi
      .spyOn(jwt, 'signAsync')
      .mockRejectedValueOnce(new Error('signing failed'));
    const result = await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(500);
    sign.mockRestore();
    expect(result.body.error.code).toBe('INTERNAL_ERROR');
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(records.has(body.email)).toBe(true);
    expect(sessoes.create).not.toHaveBeenCalled();
  });

  it('fails closed when session creation, lookup or revocation fails', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(201);
    sessoes.create.mockRejectedValueOnce(new Error('database unavailable'));
    const failedLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: body.email, password: body.password })
      .expect(500);
    expect(failedLogin.headers['set-cookie']).toBeUndefined();
    expect(sessions.size).toBe(1);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: body.email, password: body.password })
      .expect(200);
    const token = login.body.data.access_token;
    sessoes.assertActive.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(500);
    sessoes.revoke.mockRejectedValueOnce(new Error('database unavailable'));
    const failedLogout = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(500);
    expect(failedLogout.headers['set-cookie']).toBeUndefined();
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('rejects absent, forged, expired and malformed-subject tokens', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
    const expired = await jwt.signAsync(
      { sub: new mongoose.Types.ObjectId().toString() },
      { expiresIn: -1 },
    );
    const malformed = await jwt.signAsync({ sub: { $ne: null } });
    const sub = new mongoose.Types.ObjectId().toString();
    const wrongAudience = await jwt.signAsync(
      { sub },
      { audience: 'outra-api' },
    );
    const wrongIssuer = await jwt.signAsync(
      { sub },
      { issuer: 'outra-origem' },
    );
    for (const token of [
      'forged',
      expired,
      malformed,
      wrongAudience,
      wrongIssuer,
    ]) {
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    }
  });

  it('returns field details for validation errors', async () => {
    const result = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...body, email: 'invalid', password: 'short' })
      .expect(400);
    expect(result.body.success).toBe(false);
    expect(result.body.error.code).toBe('VALIDATION_ERROR');
    expect(result.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'email',
          message: expect.any(String),
        }),
        expect.objectContaining({
          field: 'password',
          message: expect.any(String),
        }),
      ]),
    );
    expect(usuarios.create).not.toHaveBeenCalled();
  });

  it('standardizes unknown routes and malformed JSON', async () => {
    const absent = await request(app.getHttpServer())
      .get('/does-not-exist')
      .expect(404);
    expect(absent.body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Recurso não encontrado.',
        details: [],
      },
    });
    const invalid = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send('{invalid')
      .expect(400);
    expect(invalid.body.error.code).toBe('BAD_REQUEST');
    expect(invalid.body.success).toBe(false);
  });

  it('does not expose internal errors or credentials', async () => {
    usuarios.findByEmail.mockImplementationOnce(() => {
      throw new Error('mongodb://sensitive:password@host');
    });
    const result = await request(app.getHttpServer())
      .post('/auth/check-email')
      .send({ email: body.email })
      .expect(500);
    expect(result.body).toEqual({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Ocorreu um erro interno. Tente novamente mais tarde.',
        details: [],
      },
    });
    expect(JSON.stringify(result.body)).not.toContain('password');
  });

  it('rejects a token when the user no longer exists', async () => {
    const result = await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(201);
    records.clear();
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${result.body.data.access_token}`)
      .expect(401);
  });
});

it('translates a MongoDB duplicate-key race into HTTP 409', async () => {
  const service = new UsuariosService({
    create: vi.fn().mockRejectedValue({ code: 11000 }),
  } as unknown as mongoose.Model<
    import('../usuarios/schemas/usuario.schema.js').Usuario
  >);
  await expect(
    service.create({
      nome: 'Ana',
      email: 'ana@example.com',
      senha_hash: 'hash',
    }),
  ).rejects.toMatchObject({
    response: { code: 'USER_ALREADY_EXISTS' },
    status: 409,
  });
});

it('does not retry username generation on email conflicts or database failures', async () => {
  const create = vi
    .fn()
    .mockRejectedValueOnce({ code: 11000, keyPattern: { email: 1 } })
    .mockRejectedValueOnce(new Error('unavailable'));
  const service = new UsuariosService({ create } as unknown as mongoose.Model<
    import('../usuarios/schemas/usuario.schema.js').Usuario
  >);
  const data = { nome: 'Ana', email: 'ana@example.com', senha_hash: 'hash' };
  await expect(service.create(data)).rejects.toMatchObject({
    response: { code: 'EMAIL_ALREADY_EXISTS' },
  });
  await expect(service.create(data)).rejects.toThrow('unavailable');
  expect(create).toHaveBeenCalledTimes(2);
});
