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
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import { OptionalAuthGuard } from './optional-auth.guard.js';
import { Publicacao } from './schemas/publicacao.schema.js';
import { RequiredAuthGuard } from './required-auth.guard.js';

describe('PublicacoesModule wiring', () => {
  let app: INestApplication;
  let module: TestingModule;

  beforeAll(async () => {
    const emptyQuery = {
      sort: vi.fn(),
      limit: vi.fn(),
      exec: vi.fn().mockResolvedValue([]),
    };
    emptyQuery.sort.mockReturnValue(emptyQuery);
    emptyQuery.limit.mockReturnValue(emptyQuery);
    const config = {
      getOrThrow: (key: string) => {
        if (key === 'JWT_SECRET')
          return 'unit-test-secret-with-at-least-32-bytes';
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
      .overrideProvider(getModelToken(Publicacao.name))
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

  it('reuses the AuthModule guard instance for required and optional routes', () => {
    const auth = module.select(AuthModule).get(JwtAuthGuard, { strict: true });
    const required = app.get(RequiredAuthGuard) as unknown as {
      auth: JwtAuthGuard;
    };
    const optional = app.get(OptionalAuthGuard) as unknown as {
      auth: JwtAuthGuard;
    };
    expect(required.auth).toBe(auth);
    expect(optional.auth).toBe(auth);
  });

  it('serves public routes and rejects requests without valid credentials', async () => {
    const server = app.getHttpServer();
    await request(server).get('/publicacoes').expect(200);
    await request(server)
      .get('/publicacoes')
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    await request(server).post('/publicacoes').send({}).expect(401);
    await request(server)
      .patch('/publicacoes/000000000000000000000001')
      .send({})
      .expect(401);
    await request(server)
      .delete('/publicacoes/000000000000000000000001')
      .expect(401);
  });
});
