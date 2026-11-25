import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { createConnection as createNetConnection } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import { createClient } from 'redis';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureHttp } from '../src/common/http/configure-http.js';
import { Publicacao } from '../src/publicacoes/schemas/publicacao.schema.js';
import { Seguidor } from '../src/usuarios/schemas/seguidor.schema.js';
import { Tecnologia } from '../src/usuarios/schemas/tecnologia.schema.js';
import { Usuario } from '../src/usuarios/schemas/usuario.schema.js';

const runId = randomBytes(8).toString('hex');
const mongoBase = process.env.MONGODB_URI;
const redisBase = process.env.REDIS_URL;

const config = (() => {
  try {
    if (
      !mongoBase ||
      !redisBase ||
      !process.env.JWT_SECRET ||
      Buffer.byteLength(process.env.JWT_SECRET) < 32
    ) {
      return null;
    }
    const mongo = new URL(mongoBase);
    const redis = new URL(redisBase);
    if (
      mongo.protocol !== 'mongodb:' ||
      redis.protocol !== 'redis:' ||
      !['127.0.0.1', 'localhost'].includes(mongo.hostname) ||
      !['127.0.0.1', 'localhost'].includes(redis.hostname)
    ) {
      return null;
    }
    mongo.pathname = `/ierri_busca_test_${runId}`;
    return {
      mongo: mongo.toString(),
      mongoHost: mongo.hostname,
      mongoPort: Number(mongo.port || 27017),
      redisHost: redis.hostname,
      redisPort: Number(redis.port || 6379),
      sessionPrefix: `ierri:busca:session:${runId}:`,
      ratePrefix: `ierri:busca:rate:${runId}:`,
      cachePrefix: `ierri:busca:cache:${runId}:`,
    };
  } catch {
    return null;
  }
})();

function tcpReachable(host: string, port: number, timeoutMs = 400) {
  return new Promise<boolean>((resolve) => {
    const socket = createNetConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const servicesReady = config
  ? (await tcpReachable(config.mongoHost, config.mongoPort)) &&
    (await tcpReachable(config.redisHost, config.redisPort))
  : false;

type Account = { id: string; username: string; token: string };

describe.runIf(Boolean(config && servicesReady))(
  'busca de perfis, publicações e relacionados (e2e)',
  () => {
    let app: INestApplication;
    let connection: Connection;
    let usuarios: Model<Usuario>;
    let publicacoes: Model<Publicacao>;
    let tecnologias: Model<Tecnologia>;
    let seguidores: Model<Seguidor>;
    let inspector: ReturnType<typeof createClient>;

    let julio: Account;
    let relatedCreator: Account;
    let privateCreator: Account;
    let blockedCreator: Account;
    let follower: Account;
    let reactTechId: Types.ObjectId;

    const original = Object.fromEntries(
      [
        'MONGODB_URI',
        'REDIS_SESSION_PREFIX',
        'REDIS_CHECK_EMAIL_RATE_PREFIX',
        'REDIS_CACHE_ENABLED',
        'REDIS_CACHE_URL',
        'REDIS_CACHE_PREFIX',
      ].map((key) => [key, process.env[key]]),
    );

    const server = () => app.getHttpServer();
    const auth = (account: Account) => ({
      Authorization: `Bearer ${account.token}`,
    });

    const register = async (
      name: string,
      usernameHint: string,
    ): Promise<Account> => {
      const result = await request(server())
        .post('/auth/register')
        .send({
          name,
          email: `${usernameHint}-${runId}@example.invalid`,
          password: `Local-${randomBytes(12).toString('hex')}`,
        })
        .expect(201);
      const id = result.body.data.user.id as string;
      await usuarios
        .updateOne(
          { _id: new Types.ObjectId(id) },
          { $set: { username: usernameHint } },
        )
        .exec();
      return {
        id,
        username: usernameHint,
        token: result.body.data.access_token as string,
      };
    };

    const makePost = async (
      authorId: string,
      conteudo: string,
      options: {
        visibilidade?: 'publico' | 'seguidores';
        status?: 'publicada' | 'oculta' | 'excluida';
        score?: number;
        publishedAt?: Date;
      } = {},
    ) => {
      const reference = randomBytes(16).toString('base64url');
      const post = await publicacoes.create({
        slug: `busca-${runId}-${reference}`,
        autor_id: new Types.ObjectId(authorId),
        conteudo,
        status: options.status ?? 'publicada',
        visibilidade: options.visibilidade ?? 'publico',
        publicada_em: options.publishedAt ?? new Date(),
        contadores: {
          upvotes: Math.max(0, options.score ?? 0),
          downvotes: 0,
          score: options.score ?? 0,
          comentarios: 0,
          salvamentos: 0,
        },
        midias: [
          {
            _id: new Types.ObjectId(),
            tipo: 'imagem',
            url: `http://127.0.0.1:3001/publicacoes/midias/${reference}`,
            chave_storage: `busca-test/${runId}/${reference}`,
            mime_type: 'image/png',
            tamanho_bytes: 100,
            largura: 10,
            altura: 10,
            duracao_segundos: null,
            texto_alternativo: null,
            ordem: 0,
          },
        ],
      });
      return post._id.toString();
    };

    beforeAll(async () => {
      process.env.MONGODB_URI = config!.mongo;
      process.env.REDIS_SESSION_PREFIX = config!.sessionPrefix;
      process.env.REDIS_CHECK_EMAIL_RATE_PREFIX = config!.ratePrefix;
      process.env.REDIS_CACHE_ENABLED = 'false';
      process.env.REDIS_CACHE_URL = redisBase;
      process.env.REDIS_CACHE_PREFIX = config!.cachePrefix;

      inspector = createClient({ url: redisBase });
      inspector.on('error', () => {});
      await inspector.connect();

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication();
      configureHttp(app);
      await app.init();

      connection = moduleRef.get<Connection>(getConnectionToken());
      usuarios = moduleRef.get<Model<Usuario>>(getModelToken(Usuario.name));
      publicacoes = moduleRef.get<Model<Publicacao>>(
        getModelToken(Publicacao.name),
      );
      tecnologias = moduleRef.get<Model<Tecnologia>>(
        getModelToken(Tecnologia.name),
      );
      seguidores = moduleRef.get<Model<Seguidor>>(getModelToken(Seguidor.name));

      const react = await tecnologias.create({
        nome: 'React',
        slug: `react-${runId}`,
        categoria: 'Frontend',
        icone_url: '/brand/react.svg',
        ativo: true,
      });
      reactTechId = react._id;

      julio = await register('Júlio César', `julio_${runId}`);
      relatedCreator = await register('Marina Costa', `marina_${runId}`);
      privateCreator = await register('Júlio Reservado', `julio_priv_${runId}`);
      blockedCreator = await register('Júlio Bloqueado', `julio_ban_${runId}`);
      follower = await register('Seguidor Fiel', `seguidor_${runId}`);

      await usuarios
        .updateOne(
          { _id: new Types.ObjectId(julio.id) },
          {
            $set: {
              biografia: 'Arquiteto de interfaces acessíveis',
              stack_ids: [reactTechId],
              'contadores.score': 30,
            },
          },
        )
        .exec();

      await usuarios
        .updateOne(
          { _id: new Types.ObjectId(relatedCreator.id) },
          {
            $set: {
              biografia: 'Especialista em sistemas de design',
              stack_ids: [reactTechId],
              'contadores.score': 20,
            },
          },
        )
        .exec();

      await usuarios
        .updateOne(
          { _id: new Types.ObjectId(privateCreator.id) },
          {
            $set: {
              visibilidade_perfil: 'privado',
              biografia: 'PalavraSecretaPrivadaX99',
              stack_ids: [reactTechId],
              'contadores.score': 50,
            },
          },
        )
        .exec();

      await usuarios
        .updateOne(
          { _id: new Types.ObjectId(blockedCreator.id) },
          { $set: { status: 'bloqueado' } },
        )
        .exec();

      await seguidores.create({
        seguidor_id: new Types.ObjectId(follower.id),
        seguido_id: new Types.ObjectId(julio.id),
        status: 'aceito',
        aceito_em: new Date(),
      });

      await makePost(julio.id, 'Dashboard financeiro minimalista', {
        publishedAt: new Date('2026-11-24T12:00:00.000Z'),
        score: 15,
      });
      await makePost(julio.id, 'Protótipo exclusivo para seguidores', {
        visibilidade: 'seguidores',
        publishedAt: new Date('2026-11-24T13:00:00.000Z'),
        score: 5,
      });
      await makePost(julio.id, 'Post oculto pela moderação', {
        status: 'oculta',
        publishedAt: new Date('2026-11-24T14:00:00.000Z'),
      });
      await makePost(relatedCreator.id, 'Biblioteca de botões acessíveis', {
        publishedAt: new Date('2026-11-23T12:00:00.000Z'),
        score: 10,
      });
      await makePost(blockedCreator.id, 'Post de autor bloqueado com julio', {
        publishedAt: new Date('2026-11-25T00:00:00.000Z'),
      });
    });

    afterAll(async () => {
      if (connection) {
        await connection.dropDatabase().catch(() => undefined);
      }
      if (app) {
        await app.close().catch(() => undefined);
      }
      if (inspector?.isReady) {
        for (const prefix of [
          config!.sessionPrefix,
          config!.ratePrefix,
          config!.cachePrefix,
        ]) {
          const keys = await inspector.keys(`${prefix}*`);
          if (keys.length) await inspector.del(keys);
        }
        await inspector.close().catch(() => inspector.destroy());
      }
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('busca por nome sem acento trazendo perfis diretos, perfil privado mínimo, criador relacionado e publicações do autor e relacionados', async () => {
      const response = await request(server())
        .get('/busca')
        .query({ q: 'julio', limite: '10' })
        .expect(200);

      const { usuarios: usersPage, publicacoes: pubsPage } = response.body.data;
      const usernames = usersPage.items.map(
        (u: { username: string }) => u.username,
      );

      expect(usernames).toContain(julio.username);
      expect(usernames).toContain(privateCreator.username);
      expect(usernames).toContain(relatedCreator.username);
      expect(usernames).not.toContain(blockedCreator.username);

      const privateItem = usersPage.items.find(
        (u: { username: string }) => u.username === privateCreator.username,
      );
      expect(privateItem).toEqual({
        id: privateCreator.id,
        nome: 'Júlio Reservado',
        username: privateCreator.username,
        avatarUrl: null,
        biografia: null,
        visibilidadePerfil: 'privado',
        stacks: [],
        score: null,
        relacionado: false,
      });

      const relatedItem = usersPage.items.find(
        (u: { username: string }) => u.username === relatedCreator.username,
      );
      expect(relatedItem.relacionado).toBe(true);

      const postContents = pubsPage.items.map(
        (p: { conteudo: string }) => p.conteudo,
      );
      // Direto do Júlio vem antes do post da criadora relacionada; oculto, seguidores e bloqueado não vazam!
      expect(postContents).toEqual([
        'Dashboard financeiro minimalista',
        'Biblioteca de botões acessíveis',
      ]);
    });

    it('impede vazamento por canal lateral (search oracle) de biografia privada e respeita posts para seguidores quando autenticado', async () => {
      const oracleAttempt = await request(server())
        .get('/busca')
        .query({ q: 'PalavraSecretaPrivadaX99' })
        .expect(200);
      expect(oracleAttempt.body.data.usuarios.items).toEqual([]);

      const asFollower = await request(server())
        .get('/busca/publicacoes')
        .set(auth(follower))
        .query({ q: `@${julio.username}` })
        .expect(200);
      const followerContents = asFollower.body.data.items.map(
        (p: { conteudo: string }) => p.conteudo,
      );
      expect(followerContents).toContain('Protótipo exclusivo para seguidores');
      expect(followerContents).toContain('Dashboard financeiro minimalista');
      expect(followerContents).not.toContain('Post oculto pela moderação');
    });

    it('pagina por cursor criptografado sem duplicar e bloqueia reutilização entre queries ou usuários diferentes', async () => {
      const page1 = await request(server())
        .get('/busca/usuarios')
        .query({ q: 'julio', limite: '1' })
        .expect(200);
      expect(page1.body.data.items).toHaveLength(1);
      expect(page1.body.data.hasMore).toBe(true);
      const cursor1 = page1.body.data.nextCursor as string;

      const page2 = await request(server())
        .get('/busca/usuarios')
        .query({ q: 'julio', limite: '1', cursor: cursor1 })
        .expect(200);
      expect(page2.body.data.items).toHaveLength(1);
      expect(page2.body.data.items[0].id).not.toBe(page1.body.data.items[0].id);

      // Trocar query invalida o cursor
      await request(server())
        .get('/busca/usuarios')
        .query({ q: 'react', limite: '1', cursor: cursor1 })
        .expect(400);

      // Reutilizar cursor anônimo autenticado invalida o cursor
      await request(server())
        .get('/busca/usuarios')
        .set(auth(follower))
        .query({ q: 'julio', limite: '1', cursor: cursor1 })
        .expect(400);
    });
  },
);
