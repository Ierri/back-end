import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { Mongoose } from 'mongoose';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RedisSessionClient } from '../auth/redis-session.client.js';
import { OptionalAuthGuard } from '../publicacoes/optional-auth.guard.js';
import { RequiredAuthGuard } from '../publicacoes/required-auth.guard.js';
import { Tecnologia } from '../usuarios/schemas/tecnologia.schema.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import { PerfisModule } from './perfis.module.js';

describe('PerfisModule wiring', () => {
  let module: TestingModule;
  let app: INestApplication;

  beforeAll(async () => {
    const emptyQuery = {
      select: vi.fn(),
      sort: vi.fn(),
      limit: vi.fn(),
      lean: vi.fn(),
      exec: vi.fn().mockResolvedValue([]),
    };
    emptyQuery.select.mockReturnValue(emptyQuery);
    emptyQuery.sort.mockReturnValue(emptyQuery);
    emptyQuery.limit.mockReturnValue(emptyQuery);
    emptyQuery.lean.mockReturnValue(emptyQuery);
    const config = {
      getOrThrow: (key: string) => {
        if (key === 'JWT_SECRET') return 'unit-test-secret-with-at-least-32-bytes';
        if (key === 'MONGODB_URI') return 'mongodb://127.0.0.1:1/ierri_test';
        if (key === 'REDIS_URL') return 'redis://127.0.0.1:1';
        throw new Error(`Unexpected setting: ${key}`);
      },
      get: () => undefined,
    };
    module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(getConnectionToken())
      .useValue(new Mongoose().connection)
      .overrideProvider(getModelToken(Usuario.name))
      .useValue({})
      .overrideProvider(getModelToken(Tecnologia.name))
      .useValue({ find: vi.fn().mockReturnValue(emptyQuery) })
      .overrideProvider(RedisSessionClient)
      .useValue({ client: { isReady: false }, prefix: 'ierri:test:session:' })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('reuses the exported JWT guard without additional session clients', () => {
    const auth = module.select(AuthModule).get(JwtAuthGuard, { strict: true });
    const profiles = module.select(PerfisModule);
    expect((profiles.get(RequiredAuthGuard, { strict: true }) as unknown as { auth: JwtAuthGuard }).auth).toBe(auth);
    expect((profiles.get(OptionalAuthGuard, { strict: true }) as unknown as { auth: JwtAuthGuard }).auth).toBe(auth);
  });

  it('keeps the catalogue public and reserves /usuarios/me for authenticated users', async () => {
    const server = app.getHttpServer();
    await request(server).get('/tecnologias').expect(200);
    await request(server).get('/usuarios/me').expect(401);
    await request(server).patch('/usuarios/me').send({ nome: 'Pessoa' }).expect(401);
    await request(server).put('/usuarios/me/stacks').send({ stackIds: [] }).expect(401);
  });
});
