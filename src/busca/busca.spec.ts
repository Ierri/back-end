import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Types, model } from 'mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { ApiHttpModule } from '../common/http/api-http.module.js';
import { ApiException } from '../common/http/api.exception.js';
import { OptionalAuthGuard } from '../publicacoes/optional-auth.guard.js';
import { PublicacaoAccessService } from '../publicacoes/publicacao-access.service.js';
import { PublicacoesService } from '../publicacoes/publicacoes.service.js';
import type { Publicacao } from '../publicacoes/schemas/publicacao.schema.js';
import { PublicacaoSchema } from '../publicacoes/schemas/publicacao.schema.js';
import type { Seguidor } from '../usuarios/schemas/seguidor.schema.js';
import type { Tecnologia } from '../usuarios/schemas/tecnologia.schema.js';
import type { Usuario } from '../usuarios/schemas/usuario.schema.js';
import { UsuarioSchema } from '../usuarios/schemas/usuario.schema.js';
import {
  MAX_SEARCH_TOKENS,
  buildDiacriticPattern,
  normalizeSearchInput,
} from './busca-pattern.js';
import { BuscaController } from './busca.controller.js';
import { BuscaCursor } from './busca.cursor.js';
import { BuscaService } from './busca.service.js';
import {
  buscaGeralSchema,
  buscaPublicacoesSchema,
  buscaUsuariosSchema,
} from './dto/busca.dto.js';

const TestUsuarioModel = model('BuscaSpecUsuario', UsuarioSchema);
const TestPublicacaoModel = model('BuscaSpecPublicacao', PublicacaoSchema);

function makeConfig(secret = 'segredo-de-teste-com-pelo-menos-32-bytes!') {
  return {
    getOrThrow: vi.fn((key: string) => {
      if (key === 'JWT_SECRET') return secret;
      throw new Error(`Unexpected key: ${key}`);
    }),
  } as unknown as ConfigService;
}

describe('DTOs e normalização segura de busca', () => {
  it('rejeita campos extras, strings vazias, @ isolado e caracteres de controle', () => {
    expect(buscaGeralSchema.parse({ q: '  @julio  ' })).toEqual({
      q: '@julio',
      limite: 10,
      ordem: 'recentes',
    });
    expect(
      buscaPublicacoesSchema.parse({
        q: 'react',
        limite: '15',
        ordem: 'score',
      }),
    ).toEqual({
      q: 'react',
      limite: 15,
      ordem: 'score',
    });
    for (const invalid of [
      {},
      { q: '   ' },
      { q: '@@@' },
      { q: 'abc\u0000def' },
      { q: 'a'.repeat(81) },
      { q: 'react', limite: '21' },
      { q: 'react', limite: '0' },
      { q: 'react', extra: '1' },
      { q: 'react', cursor: 'curto' },
    ]) {
      expect(buscaUsuariosSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('normaliza acentos PT-BR, escapa regex malicioso sem backtracking e limita tokens', () => {
    const parsed = normalizeSearchInput(
      '  @Júlio   César  ação  c++  (a+)+$  extra1 extra2 ',
    );
    expect(parsed.tokenSources).toHaveLength(MAX_SEARCH_TOKENS);

    const julioRegex = new RegExp(buildDiacriticPattern('julio'), 'i');
    expect(julioRegex.test('Júlio César')).toBe(true);
    expect(julioRegex.test('JULIO')).toBe(true);

    const acaoRegex = new RegExp(buildDiacriticPattern('acao'), 'i');
    expect(acaoRegex.test('Interação e Ação')).toBe(true);

    const hostile = buildDiacriticPattern('(a+)+$ [.*]');
    expect(hostile).not.toContain('(a+)+');
    const hostileRegex = new RegExp(hostile, 'i');
    expect(hostileRegex.test('texto literal com (a+)+$ [.*] aqui')).toBe(true);
    expect(hostileRegex.test('aaaaaaaaaaaaaaaaaaaaaaaaaaaa!')).toBe(false);
  });
});

describe('BuscaCursor (AES-256-GCM)', () => {
  const cursor = new BuscaCursor(makeConfig());
  const id = new Types.ObjectId();

  it('codifica e valida escopo de usuários (queryHash e viewerId)', () => {
    const encoded = cursor.encodeUsers(
      { relevancia: 1, score: 42, id },
      { queryHash: 'hash-a', viewerId: null },
    );
    expect(
      cursor.decodeUsers(encoded, { queryHash: 'hash-a', viewerId: null }),
    ).toEqual({ relevancia: 1, score: 42, id });

    expect(() =>
      cursor.decodeUsers(encoded, { queryHash: 'hash-b', viewerId: null }),
    ).toThrow(ApiException);
    expect(() =>
      cursor.decodeUsers(encoded, {
        queryHash: 'hash-a',
        viewerId: new Types.ObjectId().toString(),
      }),
    ).toThrow(ApiException);
    expect(() =>
      cursor.decodePublications(encoded, {
        queryHash: 'hash-a',
        viewerId: null,
        order: 'recentes',
      }),
    ).toThrow(ApiException);
  });

  it('codifica e valida escopo de publicações (queryHash, viewerId, ordem e adulteração)', () => {
    const publishedAt = new Date('2026-11-20T12:00:00.000Z');
    const encoded = cursor.encodePublications(
      { tier: 0, publishedAt, score: 19, id },
      { queryHash: 'hash-pub', viewerId: id.toString(), order: 'score' },
    );
    expect(
      cursor.decodePublications(encoded, {
        queryHash: 'hash-pub',
        viewerId: id.toString().toUpperCase(),
        order: 'score',
      }),
    ).toEqual({ tier: 0, publishedAt, score: 19, id });

    expect(() =>
      cursor.decodePublications(encoded, {
        queryHash: 'hash-pub',
        viewerId: id.toString(),
        order: 'recentes',
      }),
    ).toThrow(ApiException);

    const tampered = `${encoded.slice(0, -2)}AA`;
    expect(() =>
      cursor.decodePublications(tampered, {
        queryHash: 'hash-pub',
        viewerId: id.toString(),
        order: 'score',
      }),
    ).toThrow(ApiException);
  });
});

describe('BuscaService — privacidade, relacionados e paginação', () => {
  function chainQuery<T>(result: T) {
    const q = {
      select: vi.fn(),
      sort: vi.fn(),
      limit: vi.fn(),
      maxTimeMS: vi.fn(),
      lean: vi.fn(),
      exec: vi.fn().mockResolvedValue(result),
    };
    q.select.mockReturnValue(q);
    q.sort.mockReturnValue(q);
    q.limit.mockReturnValue(q);
    q.maxTimeMS.mockReturnValue(q);
    q.lean.mockReturnValue(q);
    return q;
  }

  function chainAgg<T>(result: T) {
    const agg = {
      option: vi.fn(),
      exec: vi.fn().mockResolvedValue(result),
    };
    agg.option.mockReturnValue(agg);
    return agg;
  }

  it('retorna perfis privados apenas com dados mínimos, marca relacionados e respeita visibilidade de publicações', async () => {
    const techId = new Types.ObjectId();
    const publicUserId = new Types.ObjectId();
    const privateUserId = new Types.ObjectId();
    const relatedUserId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const mediaId = new Types.ObjectId();
    const publishedAt = new Date('2026-11-24T15:00:00.000Z');

    const techDoc = {
      _id: techId,
      nome: 'React',
      slug: 'react',
      categoria: 'Frontend',
      icone_url: '/brand/react.svg',
    };

    const userAggregateCalls: unknown[] = [];
    const pubAggregateCalls: unknown[] = [];

    const usuarios = {
      exists: vi.fn().mockReturnValue({
        maxTimeMS: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue({ _id: publicUserId }),
        }),
      }),
      aggregate: vi
        .fn()
        .mockImplementationOnce((pipeline: unknown) => {
          userAggregateCalls.push(pipeline);
          return chainAgg([
            {
              _id: publicUserId,
              visibilidade_perfil: 'publico',
              stack_ids: [techId],
            },
            {
              _id: privateUserId,
              visibilidade_perfil: 'privado',
              stack_ids: [techId],
            },
          ]);
        })
        .mockImplementationOnce((pipeline: unknown) => {
          userAggregateCalls.push(pipeline);
          return chainAgg([
            {
              _id: publicUserId,
              nome: 'Júlio Público',
              username: 'julio',
              biografia: 'Criador de interfaces',
              avatar_url: 'https://cdn.example.test/julio.png',
              visibilidade_perfil: 'publico',
              stack_ids: [techId],
              contadores: { score: 25 },
              relevancia: 0,
              scoreOrdenacao: 25,
            },
            {
              _id: privateUserId,
              nome: 'Júlio Privado',
              username: 'julio_priv',
              biografia: 'Segredo confidencial',
              avatar_url: 'https://cdn.example.test/priv.png',
              visibilidade_perfil: 'privado',
              stack_ids: [techId],
              contadores: { score: 99 },
              relevancia: 1,
              scoreOrdenacao: 99,
            },
            {
              _id: relatedUserId,
              nome: 'Marina Stack',
              username: 'marina_ui',
              biografia: 'Design systems',
              avatar_url: null,
              visibilidade_perfil: 'publico',
              stack_ids: [techId],
              contadores: { score: 12 },
              relevancia: 5,
              scoreOrdenacao: 12,
            },
          ]);
        }),
      find: vi.fn().mockReturnValue(chainQuery([{ _id: relatedUserId }])),
      hydrate: (doc: Record<string, unknown>) => TestUsuarioModel.hydrate(doc),
    };

    const tecnologias = {
      find: vi
        .fn()
        .mockReturnValueOnce(chainQuery([techDoc]))
        .mockReturnValueOnce(chainQuery([techDoc])),
    };

    const seguidores = {
      find: vi.fn().mockReturnValue(chainQuery([])),
    };

    const publicacoes = {
      aggregate: vi.fn().mockImplementation((pipeline: unknown) => {
        pubAggregateCalls.push(pipeline);
        return chainAgg([
          {
            _id: postId,
            slug: 'post-julio-1',
            autor_id: publicUserId,
            conteudo: 'Explorando componentes acessíveis',
            midias: [
              {
                _id: mediaId,
                tipo: 'imagem',
                url: 'https://cdn.example.test/p1.png',
                chave_storage: 'midias/p1',
                mime_type: 'image/png',
                tamanho_bytes: 1024,
                largura: 800,
                altura: 600,
                duracao_segundos: null,
                texto_alternativo: 'Preview',
                ordem: 0,
              },
            ],
            visibilidade: 'publico',
            status: 'publicada',
            contadores: {
              upvotes: 10,
              downvotes: 1,
              score: 9,
              comentarios: 2,
              salvamentos: 3,
            },
            publicada_em: publishedAt,
            editada_em: null,
            criada_em: publishedAt,
            tier: 0,
            scoreOrdenacao: 9,
            author: {
              _id: publicUserId,
              nome: 'Júlio Público',
              username: 'julio',
              biografia: 'Criador de interfaces',
              avatar_url: 'https://cdn.example.test/julio.png',
              visibilidade_perfil: 'publico',
            },
          },
        ]);
      }),
      hydrate: (doc: Record<string, unknown>) =>
        TestPublicacaoModel.hydrate(doc),
    };

    const access = {
      listVisibility: vi.fn().mockResolvedValue({ visibilidade: 'publico' }),
    };

    const publicationResponses = {
      toResponse: (...args: Parameters<PublicacoesService['toResponse']>) =>
        PublicacoesService.prototype.toResponse.call(null, ...args),
    };

    const service = new BuscaService(
      usuarios as unknown as Model<Usuario>,
      publicacoes as unknown as Model<Publicacao>,
      tecnologias as unknown as Model<Tecnologia>,
      seguidores as unknown as Model<Seguidor>,
      access as unknown as PublicacaoAccessService,
      publicationResponses as unknown as PublicacoesService,
      new BuscaCursor(makeConfig()),
    );

    const result = await service.searchAll({
      q: 'julio',
      limite: 2,
      ordem: 'recentes',
    });

    expect(access.listVisibility).toHaveBeenCalledWith(undefined);
    expect(result.usuarios.hasMore).toBe(true);
    expect(result.usuarios.nextCursor).toBeTypeOf('string');
    expect(result.usuarios.items).toEqual([
      {
        id: publicUserId.toString(),
        nome: 'Júlio Público',
        username: 'julio',
        avatarUrl: 'https://cdn.example.test/julio.png',
        biografia: 'Criador de interfaces',
        visibilidadePerfil: 'publico',
        stacks: [
          {
            id: techId.toString(),
            nome: 'React',
            slug: 'react',
            categoria: 'Frontend',
            iconeUrl: '/brand/react.svg',
          },
        ],
        score: 25,
        relacionado: false,
      },
      {
        id: privateUserId.toString(),
        nome: 'Júlio Privado',
        username: 'julio_priv',
        avatarUrl: 'https://cdn.example.test/priv.png',
        biografia: null,
        visibilidadePerfil: 'privado',
        stacks: [],
        score: null,
        relacionado: false,
      },
    ]);

    expect(result.publicacoes.items).toHaveLength(1);
    expect(result.publicacoes.items[0]).toMatchObject({
      id: postId.toString(),
      conteudo: 'Explorando componentes acessíveis',
      autor: {
        id: publicUserId.toString(),
        username: 'julio',
      },
    });
    expect(result.tecnologias).toEqual({
      items: [
        {
          id: techId.toString(),
          nome: 'React',
          slug: 'react',
          categoria: 'Frontend',
          iconeUrl: '/brand/react.svg',
        },
      ],
      hasMore: false,
    });

    // Verifica que apenas o perfil público serviu de semente para relacionados (nunca o privado)
    expect(usuarios.find).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ativo',
        visibilidade_perfil: { $ne: 'privado' },
        _id: { $nin: [publicUserId, privateUserId] },
      }),
    );
  });
});

describe('BuscaController — pipeline HTTP NestJS (pipes, guards e envelope)', () => {
  it('valida query params com StandardSchemaValidationPipe e retorna envelope oficial nas 3 rotas', async () => {
    const buscaServiceMock = {
      searchAll: vi.fn().mockResolvedValue({
        usuarios: { items: [], nextCursor: null, hasMore: false },
        publicacoes: { items: [], nextCursor: null, hasMore: false },
        tecnologias: { items: [], hasMore: false },
      }),
      searchUsers: vi.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
        hasMore: false,
      }),
      searchPublications: vi.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
        hasMore: false,
      }),
    };

    const jwtGuardMock = {
      authenticate: vi
        .fn()
        .mockImplementation((req: { authUserId?: string }) => {
          req.authUserId = '507f1f77bcf86cd799439011';
          return Promise.resolve(true);
        }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [ApiHttpModule],
      controllers: [BuscaController],
      providers: [
        OptionalAuthGuard,
        { provide: JwtAuthGuard, useValue: jwtGuardMock },
        { provide: BuscaService, useValue: buscaServiceMock },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const okAll = await request(app.getHttpServer())
        .get('/busca')
        .query({ q: '  React  ', limite: '5', ordem: 'score' })
        .expect(200);
      expect(okAll.body).toEqual({
        success: true,
        message: 'Resultados da pesquisa encontrados.',
        data: {
          usuarios: { items: [], nextCursor: null, hasMore: false },
          publicacoes: { items: [], nextCursor: null, hasMore: false },
          tecnologias: { items: [], hasMore: false },
        },
      });
      expect(buscaServiceMock.searchAll).toHaveBeenCalledWith(
        { q: 'React', limite: 5, ordem: 'score' },
        undefined,
      );

      await request(app.getHttpServer())
        .get('/busca/usuarios')
        .set('Authorization', 'Bearer token-valido')
        .query({ q: '@julio' })
        .expect(200);
      expect(buscaServiceMock.searchUsers).toHaveBeenCalledWith(
        { q: '@julio', limite: 20 },
        '507f1f77bcf86cd799439011',
      );

      await request(app.getHttpServer())
        .get('/busca/publicacoes')
        .query({ q: 'dashboard' })
        .expect(200);
      expect(buscaServiceMock.searchPublications).toHaveBeenCalledWith(
        { q: 'dashboard', limite: 20, ordem: 'recentes' },
        undefined,
      );

      const badQuery = await request(app.getHttpServer())
        .get('/busca')
        .query({ q: '@@@', intruso: '1' })
        .expect(400);
      expect(badQuery.body).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
      });
    } finally {
      await app.close();
    }
  });
});
