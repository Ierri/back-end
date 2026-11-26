import http from 'node:http';
import {
  Controller,
  Get,
  Inject,
  Optional,
  Req,
  Sse,
  Header,
  Query,
} from '@nestjs/common';
import type { INestApplication, MessageEvent } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiHttpModule } from '../common/http/api-http.module.js';
import { configureHttp } from '../common/http/configure-http.js';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import type { Seguidor } from '../usuarios/schemas/seguidor.schema.js';
import type { Usuario } from '../usuarios/schemas/usuario.schema.js';
import { streamVotosQuerySchema } from './dto/votos.dto.js';
import type { StreamVotosQueryDto } from './dto/votos.dto.js';
import type { PublicacaoAccessService } from './publicacao-access.service.js';
import type { PublicacoesCacheClient } from './publicacoes-cache.client.js';
import type { Publicacao } from './schemas/publicacao.schema.js';
import {
  MAX_STREAMS_PER_USER,
  VotosStreamService,
} from './votos-stream.service.js';

function chainFind<T>(result: T) {
  const query = {
    select: () => query,
    lean: () => query,
    exec: () => Promise.resolve(result),
  };
  return query;
}

describe('VotosStreamService (SSE + Pub/Sub em tempo real)', () => {
  const activeAuthorId = new Types.ObjectId();
  const blockedAuthorId = new Types.ObjectId();
  const followerViewerId = new Types.ObjectId();
  const strangerViewerId = new Types.ObjectId();
  const publicPostId = new Types.ObjectId();
  const followersPostId = new Types.ObjectId();
  const blockedPostId = new Types.ObjectId();

  function createBus() {
    const handlers = new Set<(message: string) => void>();
    return {
      makeCacheClient(enabled = true) {
        const publishSpy = vi.fn((_channel: string, payload: string) => {
          if (!enabled) return Promise.resolve(false);
          for (const handler of handlers) {
            handler(payload);
          }
          return Promise.resolve(true);
        });
        const subscriber = {
          isReady: true,
          on: vi.fn(),
          connect: vi.fn(() => Promise.resolve()),
          subscribe: vi.fn(
            (_channel: string, listener: (msg: string) => void) => {
              handlers.add(listener);
              return Promise.resolve();
            },
          ),
          close: vi.fn(() => {
            handlers.clear();
            return Promise.resolve();
          }),
          destroy: vi.fn(),
        };
        const client = {
          prefix: 'ierri:cache:test:',
          enabled,
          publish: publishSpy,
          createSubscriber: vi.fn(() => (enabled ? subscriber : null)),
        } as unknown as PublicacoesCacheClient;
        return { client, publishSpy, subscriber };
      },
      injectRaw(raw: string) {
        for (const handler of handlers) handler(raw);
      },
    };
  }

  function buildService(
    cacheClient: PublicacoesCacheClient,
    options?: { followerAccepted?: boolean },
  ) {
    const followerAccepted = options?.followerAccepted ?? true;

    const allDocs = [
      {
        _id: publicPostId,
        autor_id: activeAuthorId,
        visibilidade: 'publico' as const,
        status: 'publicada',
        contadores: { upvotes: 4, downvotes: 1, score: 3 },
        votos_revisao: 7,
      },
      {
        _id: followersPostId,
        autor_id: activeAuthorId,
        visibilidade: 'seguidores' as const,
        status: 'publicada',
        contadores: { upvotes: 2, downvotes: 0, score: 2 },
        votos_revisao: 2,
      },
      {
        _id: blockedPostId,
        autor_id: blockedAuthorId,
        visibilidade: 'publico' as const,
        status: 'publicada',
        contadores: { upvotes: 9, downvotes: 0, score: 9 },
        votos_revisao: 1,
      },
    ];

    const publicacoes = {
      find: vi.fn((filter: Record<string, unknown>) => {
        const andClauses = (filter.$and ?? []) as Array<
          Record<string, unknown>
        >;
        const visClause = andClauses[0] ?? {};
        const allowFollowers = '$or' in visClause;
        const filtered = allDocs.filter((doc) =>
          allowFollowers ? true : doc.visibilidade === 'publico',
        );
        return chainFind(filtered);
      }),
    } as unknown as Model<Publicacao>;

    const usuarios = {
      find: vi.fn((filter: { _id?: { $in?: Types.ObjectId[] } }) => {
        const requested = filter._id?.$in ?? [];
        const activeSet = new Set([
          activeAuthorId.toString(),
          followerViewerId.toString(),
          strangerViewerId.toString(),
        ]);
        const found = requested
          .filter((id) => activeSet.has(id.toString()))
          .map((id) => ({ _id: id }));
        return chainFind(found);
      }),
    } as unknown as Model<Usuario>;

    const seguidores = {
      find: vi.fn(() =>
        chainFind(followerAccepted ? [{ seguidor_id: followerViewerId }] : []),
      ),
    } as unknown as Model<Seguidor>;

    const access = {
      listVisibility: vi.fn((viewerId?: string) =>
        Promise.resolve(
          viewerId === followerViewerId.toString() ||
            viewerId === activeAuthorId.toString()
            ? {
                $or: [
                  { visibilidade: 'publico' },
                  { visibilidade: 'seguidores' },
                ],
              }
            : { visibilidade: 'publico' },
        ),
      ),
    } as unknown as PublicacaoAccessService;

    return new VotosStreamService(
      publicacoes,
      usuarios,
      seguidores,
      access,
      cacheClient,
    );
  }

  it('filtra snapshot inicial por visibilidade e autor ativo (anti-oracle) e nunca expõe identidade de votantes', async () => {
    const bus = createBus();
    const { client } = bus.makeCacheClient(false);
    const service = buildService(client);
    service.onModuleInit();

    const anonEvents: MessageEvent[] = [];
    const followerEvents: MessageEvent[] = [];

    const reqIds = [
      publicPostId.toString(),
      followersPostId.toString(),
      blockedPostId.toString(),
    ];

    const anonObs = await service.openStream(reqIds, undefined, '10.0.0.1');
    const followerObs = await service.openStream(
      reqIds,
      followerViewerId.toString(),
      '10.0.0.2',
    );

    const subAnon = anonObs.subscribe((ev) => anonEvents.push(ev));
    const subFollower = followerObs.subscribe((ev) => followerEvents.push(ev));

    expect(anonEvents).toEqual([
      {
        type: 'snapshot',
        retry: 3_000,
        data: {
          items: [
            {
              publicationId: publicPostId.toString(),
              upvotes: 4,
              downvotes: 1,
              score: 3,
              revisao: 7,
            },
          ],
        },
      },
    ]);

    expect(followerEvents).toEqual([
      {
        type: 'snapshot',
        retry: 3_000,
        data: {
          items: [
            {
              publicationId: publicPostId.toString(),
              upvotes: 4,
              downvotes: 1,
              score: 3,
              revisao: 7,
            },
            {
              publicationId: followersPostId.toString(),
              upvotes: 2,
              downvotes: 0,
              score: 2,
              revisao: 2,
            },
          ],
        },
      },
    ]);

    // Voto em post seguidores: apenas seguidor aceito recebe; visitante não recebe nada
    await service.publishVoteUpdate({
      publicationId: followersPostId.toString(),
      authorId: activeAuthorId.toString(),
      visibility: 'seguidores',
      upvotes: 3,
      downvotes: 0,
      score: 3,
      revisao: 3,
    });

    expect(anonEvents).toHaveLength(1);
    expect(followerEvents).toHaveLength(2);
    expect(followerEvents[1]).toEqual({
      type: 'vote',
      data: {
        publicationId: followersPostId.toString(),
        upvotes: 3,
        downvotes: 0,
        score: 3,
        revisao: 3,
      },
    });
    expect(JSON.stringify(followerEvents[1])).not.toContain(
      activeAuthorId.toString(),
    );

    subAnon.unsubscribe();
    subFollower.unsubscribe();
    await service.onModuleDestroy();
  });

  it('propaga eventos entre múltiplas réplicas via Pub/Sub sem duplicar na instância de origem e revoga acesso ao vivo', async () => {
    const bus = createBus();
    const cacheA = bus.makeCacheClient(true);
    const cacheB = bus.makeCacheClient(true);

    const replicaA = buildService(cacheA.client);
    const replicaB = buildService(cacheB.client);
    replicaA.onModuleInit();
    replicaB.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();

    const eventsOnA: MessageEvent[] = [];
    const eventsOnB: MessageEvent[] = [];

    const subA = (
      await replicaA.openStream(
        [publicPostId.toString()],
        undefined,
        '10.0.0.1',
      )
    ).subscribe((ev) => eventsOnA.push(ev));

    const subB = (
      await replicaB.openStream(
        [publicPostId.toString()],
        undefined,
        '10.0.0.2',
      )
    ).subscribe((ev) => eventsOnB.push(ev));

    // Ignora lixo/payload inválido no canal Redis sem cair
    bus.injectRaw('not-json');
    bus.injectRaw(JSON.stringify({ kind: 'vote', invalid: true }));

    // Publica voto na réplica A -> entrega 1x em A e 1x em B
    await replicaA.publishVoteUpdate({
      publicationId: publicPostId.toString(),
      authorId: activeAuthorId.toString(),
      visibility: 'publico',
      upvotes: 5,
      downvotes: 1,
      score: 4,
      revisao: 8,
    });
    await Promise.resolve();

    expect(eventsOnA).toHaveLength(2);
    expect(eventsOnB).toHaveLength(2);
    expect(eventsOnB[1]).toEqual({
      type: 'vote',
      data: {
        publicationId: publicPostId.toString(),
        upvotes: 5,
        downvotes: 1,
        score: 4,
        revisao: 8,
      },
    });

    // Autor muda visibilidade do post para 'seguidores' na réplica A -> visitante na réplica B perde acesso imediatamente!
    await replicaA.publishAccessChange({
      publicationId: publicPostId.toString(),
      authorId: activeAuthorId.toString(),
      visibility: 'seguidores',
    });
    await Promise.resolve();

    await replicaA.publishVoteUpdate({
      publicationId: publicPostId.toString(),
      authorId: activeAuthorId.toString(),
      visibility: 'seguidores',
      upvotes: 6,
      downvotes: 1,
      score: 5,
      revisao: 9,
    });
    await Promise.resolve();

    // Nenhum dos visitantes anônimos recebeu o voto após virar 'seguidores'
    expect(eventsOnA).toHaveLength(2);
    expect(eventsOnB).toHaveLength(2);

    subA.unsubscribe();
    subB.unsubscribe();
    await replicaA.onModuleDestroy();
    await replicaB.onModuleDestroy();
  });

  it('aplica limite anti-DoS por usuário (429) e libera contadores ao encerrar conexões', async () => {
    const bus = createBus();
    const { client } = bus.makeCacheClient(false);
    const service = buildService(client);
    service.onModuleInit();

    const subscriptions = [];
    for (let index = 0; index < MAX_STREAMS_PER_USER; index++) {
      const obs = await service.openStream(
        [publicPostId.toString()],
        strangerViewerId.toString(),
        '10.0.0.9',
      );
      subscriptions.push(obs.subscribe());
    }
    expect(service.activeStreamCount).toBe(MAX_STREAMS_PER_USER);

    await expect(
      service.openStream(
        [publicPostId.toString()],
        strangerViewerId.toString(),
        '10.0.0.9',
      ),
    ).rejects.toMatchObject({ status: 429 });

    subscriptions[0].unsubscribe();
    expect(service.activeStreamCount).toBe(MAX_STREAMS_PER_USER - 1);

    const reopened = await service.openStream(
      [publicPostId.toString()],
      strangerViewerId.toString(),
      '10.0.0.9',
    );
    const reopenedSub = reopened.subscribe();
    expect(service.activeStreamCount).toBe(MAX_STREAMS_PER_USER);

    reopenedSub.unsubscribe();
    for (const sub of subscriptions.slice(1)) sub.unsubscribe();
    expect(service.activeStreamCount).toBe(0);
    await service.onModuleDestroy();
  });

  it('integra @Sse com ApiResponseInterceptor (sem envelopar frames SSE) e ApiExceptionFilter (400 JSON em query inválida)', async () => {
    @Controller()
    class TestStreamController {
      constructor(
        @Inject(VotosStreamService)
        private readonly streamService: VotosStreamService,
      ) {}

      @Get('ping')
      ping() {
        return { ok: true };
      }

      @Sse('publicacoes/votos/stream')
      @Header('X-Accel-Buffering', 'no')
      stream(
        @Query({ schema: streamVotosQuerySchema }) query: StreamVotosQueryDto,
        @Req() req: AuthenticatedRequest,
      ) {
        return this.streamService.openStream(
          query.ids,
          req.authUserId,
          '127.0.0.1',
        );
      }

      @Optional()
      unused?: unknown;
    }

    const bus = createBus();
    const { client } = bus.makeCacheClient(false);
    const streamService = buildService(client);

    const moduleRef = await Test.createTestingModule({
      imports: [ApiHttpModule],
      controllers: [TestStreamController],
      providers: [{ provide: VotosStreamService, useValue: streamService }],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    configureHttp(app);
    await app.init();
    await app.listen(0, '127.0.0.1');

    try {
      const address = app.getHttpServer().address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // 1. Rota REST comum continua recebendo envelope padrão
      const pingRes = await fetch(`${baseUrl}/ping`);
      expect(pingRes.status).toBe(200);
      await expect(pingRes.json()).resolves.toMatchObject({
        success: true,
        data: { ok: true },
      });

      // 2. Query inválida no @Sse retorna 400 JSON padronizado antes de abrir stream
      const badRes = await fetch(`${baseUrl}/publicacoes/votos/stream?ids=abc`);
      expect(badRes.status).toBe(400);
      await expect(badRes.json()).resolves.toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
      });

      // 3. Stream SSE real emite snapshot e vote sem corromper event/retry/data
      const receivedChunks: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const req = http.get(
          `${baseUrl}/publicacoes/votos/stream?ids=${publicPostId.toString()}`,
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
            expect(res.headers['x-accel-buffering']).toBe('no');

            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              receivedChunks.push(chunk);
              const joined = receivedChunks.join('');
              if (
                joined.includes('event: snapshot') &&
                !joined.includes('event: vote')
              ) {
                void streamService.publishVoteUpdate({
                  publicationId: publicPostId.toString(),
                  authorId: activeAuthorId.toString(),
                  visibility: 'publico',
                  upvotes: 10,
                  downvotes: 2,
                  score: 8,
                  revisao: 12,
                });
              }
              if (joined.includes('event: vote')) {
                req.destroy();
                resolve();
              }
            });
            res.on('error', () => resolve());
          },
        );
        req.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
            resolve();
            return;
          }
          reject(err);
        });
      });

      const fullStream = receivedChunks.join('');
      expect(fullStream).toContain('event: snapshot');
      expect(fullStream).toContain('retry: 3000');
      expect(fullStream).toContain(
        `data: {"items":[{"publicationId":"${publicPostId.toString()}","upvotes":4,"downvotes":1,"score":3,"revisao":7}]}`,
      );
      expect(fullStream).toContain('event: vote');
      expect(fullStream).toContain(
        `data: {"publicationId":"${publicPostId.toString()}","upvotes":10,"downvotes":2,"score":8,"revisao":12}`,
      );
    } finally {
      await streamService.onModuleDestroy();
      await app.close();
    }
  });
});
