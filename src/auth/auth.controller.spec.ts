import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { ApiHttpModule } from '../common/http/api-http.module.js';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import { compare } from 'bcryptjs';
import request from 'supertest';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { UsuariosService } from '../usuarios/usuarios.service.js';
import { UsuarioSchema } from '../usuarios/schemas/usuario.schema.js';
import type { UsuarioDocument } from '../usuarios/schemas/usuario.schema.js';

const UsuarioModel = mongoose.model('AuthTestUsuario', UsuarioSchema);
const secret = 'test-secret-only-for-auth-tests-at-least-32-bytes';

describe('Auth HTTP (isolated persistence)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const records = new Map<string, UsuarioDocument>();
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
        { provide: UsuariosService, useValue: usuarios },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    jwt = module.get(JwtService);
  });
  beforeEach(() => {
    records.clear();
    vi.clearAllMocks();
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
      'sub',
    ]);
    expect(payload.iss).toBe('ierri-api');
    expect(payload.aud).toBe('ierri-api');
    expect(payload.sub).toBe(stored._id.toString());
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
