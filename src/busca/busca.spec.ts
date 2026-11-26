import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Types, model } from 'mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { ApiHttpModule } from '../common/http/api-http.module.js';
import { ApiException } from '../common/http/api.exception.js';
import { OptionalAuthGuard } from '../publicacoes/optional-auth.guard.js';
import type { PublicacoesCacheClient } from '../publicacoes/publicacoes-cache.client.js';
import { PublicacaoAccessService } from '../publicacoes/publicacao-access.service.js';
import { PublicacoesService } from '../publicacoes/publicacoes.service.js';
import type { Publicacao } from '../publicacoes/schemas/publicacao.schema.js';
import { PublicacaoSchema } from '../publicacoes/schemas/publicacao.schema.js';
import type { Seguidor } from '../usuarios/schemas/seguidor.schema.js';
import type { Tecnologia } from '../usuarios/schemas/tecnologia.schema.js';
import type { Usuario } from '../usuarios/schemas/usuario.schema.js';
import { UsuarioSchema } from '../usuarios/schemas/usuario.schema.js';
import { BuscaCacheService } from './busca-cache.service.js';
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
  it('rejeita campos extras, strings vazias, @ isolado, diacríticos soltos e caracteres de controle', () => {
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
      { q: '@ @' },
      { q: '\u0301\u0300' },
      { q: '@\u0301' },
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

  it('normaliza NFC/NFD contra cache poisoning, unifica handleCandidate com/sem acento e estabiliza queryHash acima de 5 tokens', () => {
    const parsed = normalizeSearchInput(
      '  @Júlio   César  ação  c++  (a+)+$  extra1 ',
    );
    expect(parsed.tokenSources).toHaveLength(MAX_SEARCH_TOKENS);

    // Anti-Cache Poisoning: marcas combinantes soltas ou NFD produzem exatamente o mesmo hash e regex
    const cleanReact = normalizeSearchInput('react');
    const poisonedReact = normalizeSearchInput('react\u0300');
    const nfdReact = normalizeSearchInput('rea\u0301ct');
    expect(poisonedReact.queryHash).toBe(cleanReact.queryHash);
    expect(poisonedReact.tokenSources).toEqual(cleanReact.tokenSources);
    expect(nfdReact.queryHash).toBe(cleanReact.queryHash);
    expect(nfdReact.tokenSources).toEqual(cleanReact.tokenSources);

    // Unificação de handleCandidate entre joão, joao e @joão
    const joaoAscii = normalizeSearchInput('joao');
    const joaoAccent = normalizeSearchInput('joão');
    const joaoHandle = normalizeSearchInput('@joão');
    expect(joaoAscii.handleCandidate).toBe('joao');
    expect(joaoAccent.handleCandidate).toBe('joao');
    expect(joaoHandle.handleCandidate).toBe('joao');
    expect(joaoAccent.queryHash).toBe(joaoAscii.queryHash);
    expect(joaoHandle.queryHash).toBe(joaoAscii.queryHash);

    // Acima de 5 tokens, tokens descartados não fragmentam queryHash
    const fiveA = normalizeSearchInput('um dois tres quatro cinco caudaA');
    const fiveB = normalizeSearchInput('um dois tres quatro cinco caudaB');
    expect(fiveA.queryHash).toBe(fiveB.queryHash);

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

describe('BuscaService — privacidade, paginação, Score Oracle e cache Redis', () => {
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

  it('retorna perfis privados apenas com dados mínimos (scoreOrdenacao=0 contra Score Oracle), marca relacionados e respeita visibilidade', async () => {
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

    const userAggregateCalls: Array<Array<Record<string, unknown>>> = [];

    const usuarios = {
      findOne: vi.fn().mockReturnValue(chainQuery(null)),
      aggregate: vi
        .fn()
        .mockImplementationOnce((pipeline: Array<Record<string, unknown>>) => {
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
        .mockImplementationOnce((pipeline: Array<Record<string, unknown>>) => {
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
              scoreOrdenacao: 0,
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
      find: vi.fn().mockReturnValue(chainQuery([techDoc])),
    };

    const seguidores = {
      find: vi.fn().mockReturnValue(chainQuery([])),
    };

    const publicacoes = {
      aggregate: vi.fn().mockImplementation(() =>
        chainAgg([
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
            atualizada_em: publishedAt,
            dataOrdenacao: publishedAt,
            tier: 0,
            scoreOrdenacao: 9,
            author: [
              {
                _id: publicUserId,
                nome: 'Júlio Público',
                username: 'julio',
                biografia: 'Criador de interfaces',
                avatar_url: 'https://cdn.example.test/julio.png',
                visibilidade_perfil: 'publico',
              },
            ],
          },
        ]),
      ),
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

    // Verifica proteção contra Score Oracle na expressão de scoreOrdenacao
    const addFieldsStage = userAggregateCalls[1]?.[1] as {
      $addFields: { scoreOrdenacao: { $cond: unknown[] } };
    };
    expect(addFieldsStage.$addFields.scoreOrdenacao.$cond[1]).toBe(0);

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
    expect(result.tecnologias).toEqual({
      items: [],
      hasMore: false,
    });
    expect(tecnologias.find).toHaveBeenCalledTimes(1);
  });

  it('valida cursor autenticado antes de consultar catálogo/agregações e pagina searchPublications (score e publicada_em nula)', async () => {
    const viewerId = new Types.ObjectId();
    const authorId = new Types.ObjectId();
    const post1Id = new Types.ObjectId();
    const post2Id = new Types.ObjectId();
    const mediaId = new Types.ObjectId();
    const fallbackCreated = new Date('2026-11-22T10:00:00.000Z');
    const pubPipelines: Array<Array<Record<string, unknown>>> = [];

    const usuarios = {
      findOne: vi.fn().mockReturnValue(
        chainQuery({
          _id: viewerId,
          nome: 'Viewer',
          username: 'viewer',
          visibilidade_perfil: 'publico',
          stack_ids: [],
        }),
      ),
      aggregate: vi.fn().mockReturnValue(chainAgg([])),
      find: vi.fn().mockReturnValue(chainQuery([])),
      hydrate: (doc: Record<string, unknown>) => TestUsuarioModel.hydrate(doc),
    };

    const tecnologias = {
      find: vi.fn().mockReturnValue(chainQuery([])),
    };

    const seguidores = {
      find: vi.fn().mockReturnValue(chainQuery([])),
    };

    const makeRow = (id: Types.ObjectId, score: number) => ({
      _id: id,
      slug: `post-${id.toString()}`,
      autor_id: authorId,
      conteudo: 'Dashboard em React',
      midias: [
        {
          _id: mediaId,
          tipo: 'imagem',
          url: 'https://cdn.example.test/p.png',
          chave_storage: 'midias/p',
          mime_type: 'image/png',
          tamanho_bytes: 200,
          largura: 100,
          altura: 100,
          duracao_segundos: null,
          texto_alternativo: null,
          ordem: 0,
        },
      ],
      visibilidade: 'publico',
      status: 'publicada',
      contadores: {
        upvotes: score,
        downvotes: 0,
        score,
        comentarios: 0,
        salvamentos: 0,
      },
      publicada_em: null,
      editada_em: null,
      criada_em: fallbackCreated,
      atualizada_em: fallbackCreated,
      dataOrdenacao: fallbackCreated,
      tier: 0,
      scoreOrdenacao: score,
      author: [
        {
          _id: authorId,
          nome: 'Autor',
          username: 'autor',
          biografia: null,
          avatar_url: null,
          visibilidade_perfil: 'publico',
        },
      ],
    });

    const publicacoes = {
      aggregate: vi
        .fn()
        .mockImplementationOnce((pipeline: Array<Record<string, unknown>>) => {
          pubPipelines.push(pipeline);
          return chainAgg([makeRow(post1Id, 10), makeRow(post2Id, 5)]);
        })
        .mockImplementationOnce((pipeline: Array<Record<string, unknown>>) => {
          pubPipelines.push(pipeline);
          return chainAgg([makeRow(post2Id, 5)]);
        }),
      hydrate: (doc: Record<string, unknown>) =>
        TestPublicacaoModel.hydrate(doc),
    };

    const service = new BuscaService(
      usuarios as unknown as Model<Usuario>,
      publicacoes as unknown as Model<Publicacao>,
      tecnologias as unknown as Model<Tecnologia>,
      seguidores as unknown as Model<Seguidor>,
      {
        listVisibility: vi.fn().mockResolvedValue({ visibilidade: 'publico' }),
      } as unknown as PublicacaoAccessService,
      {
        toResponse: (...args: Parameters<PublicacoesService['toResponse']>) =>
          PublicacoesService.prototype.toResponse.call(null, ...args),
      } as unknown as PublicacoesService,
      new BuscaCursor(makeConfig()),
    );

    // 1) Cursor inválido autenticado falha ANTES de carregar catálogo ou rodar agregações
    await expect(
      service.searchPublications(
        {
          q: 'dashboard',
          limite: 1,
          ordem: 'score',
          cursor: 'cursor_invalido_com_comprimento_suficiente_123',
        },
        viewerId.toString(),
      ),
    ).rejects.toBeInstanceOf(ApiException);
    expect(tecnologias.find).not.toHaveBeenCalled();
    expect(usuarios.aggregate).not.toHaveBeenCalled();
    expect(publicacoes.aggregate).not.toHaveBeenCalled();

    // 2) Página 1 + Página 2 com ordem='score' e dataOrdenacao derivada de criada_em
    const page1 = await service.searchPublications(
      { q: 'dashboard', limite: 1, ordem: 'score' },
      viewerId.toString(),
    );
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTypeOf('string');

    const page2 = await service.searchPublications(
      {
        q: 'dashboard',
        limite: 1,
        ordem: 'score',
        cursor: page1.nextCursor!,
      },
      viewerId.toString(),
    );
    expect(page2.hasMore).toBe(false);
    expect(page2.items[0].id).toBe(post2Id.toString());

    const cursorMatchStage = pubPipelines[1]?.[2] as {
      $match: { $or: Array<Record<string, unknown>> };
    };
    expect(cursorMatchStage.$match.$or).toHaveLength(4);
    expect(cursorMatchStage.$match.$or[2]).toMatchObject({
      tier: 0,
      scoreOrdenacao: 10,
      dataOrdenacao: { $lt: fallbackCreated },
    });
  });

  it('serve páginas anônimas do Redis validando stacks/score/visibilidade, expurga chave stale quando !cacheable e permite auto-busca privada em memória', async () => {
    const store = new Map<string, string>();
    const delSpy = vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    });
    const fakeClient = {
      enabled: true,
      prefix: 'ierri:cache:test:',
      searchTtl: 15,
      techTtl: 300,
      get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      set: vi.fn((key: string, val: string) => {
        store.set(key, val);
        return Promise.resolve(true);
      }),
      del: delSpy,
      invalidate: vi.fn(),
    } as unknown as PublicacoesCacheClient;

    const buscaCache = new BuscaCacheService(fakeClient);
    const reactId = new Types.ObjectId();
    const authorId = new Types.ObjectId();
    const privateViewerId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const mediaId = new Types.ObjectId();
    const publishedAt = new Date('2026-11-24T18:00:00.000Z');

    let liveAuthorScore = 10;
    let liveAuthorStacks: Types.ObjectId[] = [reactId];
    let pendingVoteProjection = false;

    const usuarios = {
      findOne: vi.fn().mockImplementation(() =>
        chainQuery({
          _id: privateViewerId,
          nome: 'Conta Privada',
          username: 'conta_priv',
          biografia: 'Especialista em React confidencial',
          visibilidade_perfil: 'privado',
          stack_ids: [reactId],
        }),
      ),
      aggregate: vi
        .fn()
        .mockImplementation((pipeline: Array<Record<string, unknown>>) => {
          const matchStr = JSON.stringify(pipeline[0]);
          if (matchStr.includes(privateViewerId.toString())) {
            return chainAgg([
              {
                _id: privateViewerId,
                nome: 'Conta Privada',
                username: 'conta_priv',
                biografia: 'Especialista em React confidencial',
                avatar_url: null,
                visibilidade_perfil: 'privado',
                stack_ids: [reactId],
                contadores: { score: 77 },
                relevancia: 4,
                scoreOrdenacao: 77,
              },
            ]);
          }
          return chainAgg([
            {
              _id: authorId,
              nome: 'Autor Cache',
              username: 'autor_cache',
              biografia: 'Bio pública',
              avatar_url: null,
              visibilidade_perfil: 'publico',
              stack_ids: liveAuthorStacks,
              contadores: { score: liveAuthorScore },
              relevancia: 1,
              scoreOrdenacao: liveAuthorScore,
            },
          ]);
        }),
      find: vi.fn().mockImplementation((filter: Record<string, unknown>) => {
        if ('visibilidade_perfil' in filter) {
          return chainQuery([]);
        }
        return chainQuery([
          {
            _id: authorId,
            nome: 'Autor Cache',
            username: 'autor_cache',
            biografia: 'Bio pública',
            avatar_url: null,
            visibilidade_perfil: 'publico',
            stack_ids: liveAuthorStacks,
            contadores: { score: liveAuthorScore },
          },
        ]);
      }),
      hydrate: (doc: Record<string, unknown>) => TestUsuarioModel.hydrate(doc),
    };

    const tecnologias = {
      find: vi.fn().mockReturnValue(
        chainQuery([
          {
            _id: reactId,
            nome: 'React',
            slug: 'react',
            categoria: 'Frontend',
            icone_url: null,
          },
        ]),
      ),
    };

    const seguidores = {
      find: vi.fn().mockReturnValue(chainQuery([])),
    };

    const publicacoes = {
      aggregate: vi.fn().mockImplementation(() =>
        chainAgg([
          {
            _id: postId,
            slug: 'post-cache-1',
            autor_id: authorId,
            conteudo: 'Interface em React',
            votos_projecao_pendente: pendingVoteProjection,
            midias: [
              {
                _id: mediaId,
                tipo: 'imagem',
                url: 'https://cdn.example.test/cache1.png',
                chave_storage: 'midias/c1',
                mime_type: 'image/png',
                tamanho_bytes: 500,
                largura: 400,
                altura: 300,
                duracao_segundos: null,
                texto_alternativo: null,
                ordem: 0,
              },
            ],
            visibilidade: 'publico',
            status: 'publicada',
            contadores: {
              upvotes: 3,
              downvotes: 0,
              score: 3,
              comentarios: 0,
              salvamentos: 0,
            },
            publicada_em: publishedAt,
            editada_em: null,
            criada_em: publishedAt,
            atualizada_em: publishedAt,
            dataOrdenacao: publishedAt,
            tier: 0,
            scoreOrdenacao: 3,
            author: [
              {
                _id: authorId,
                nome: 'Autor Cache',
                username: 'autor_cache',
                biografia: 'Bio pública',
                avatar_url: null,
                visibilidade_perfil: 'publico',
              },
            ],
          },
        ]),
      ),
      hydrate: (doc: Record<string, unknown>) =>
        TestPublicacaoModel.hydrate(doc),
    };

    const service = new BuscaService(
      usuarios as unknown as Model<Usuario>,
      publicacoes as unknown as Model<Publicacao>,
      tecnologias as unknown as Model<Tecnologia>,
      seguidores as unknown as Model<Seguidor>,
      {
        listVisibility: vi.fn().mockResolvedValue({ visibilidade: 'publico' }),
      } as unknown as PublicacaoAccessService,
      {
        toResponse: (...args: Parameters<PublicacoesService['toResponse']>) =>
          PublicacoesService.prototype.toResponse.call(null, ...args),
      } as unknown as PublicacoesService,
      new BuscaCursor(makeConfig()),
      buscaCache,
    );

    // 1ª chamada anônima: miss -> popula Camadas 1, 2 e 3
    const first = await service.searchAll({
      q: 'react',
      limite: 10,
      ordem: 'recentes',
    });
    expect(first.usuarios.items[0].stacks).toHaveLength(1);
    expect(publicacoes.aggregate).toHaveBeenCalledTimes(1);

    // 2ª chamada anônima: hit na Camada 3
    await service.searchAll({
      q: 'react',
      limite: 10,
      ordem: 'recentes',
    });
    expect(publicacoes.aggregate).toHaveBeenCalledTimes(1);
    expect(buscaCache.metrics().pageHit).toBe(1);

    // Mudança de stacks + post com projeção pendente (!cacheable): verifyUsersCurrent detecta e evict apaga a chave stale!
    liveAuthorStacks = [];
    liveAuthorScore = 11;
    pendingVoteProjection = true;
    const third = await service.searchAll({
      q: 'react',
      limite: 10,
      ordem: 'recentes',
    });
    expect(buscaCache.metrics().staleMiss).toBe(1);
    expect(third.usuarios.items[0].stacks).toEqual([]);
    expect(third.usuarios.items[0].score).toBe(11);
    expect(delSpy).toHaveBeenCalled();

    // Auto-busca autenticada do próprio dono privado: vê própria bio/stacks/score em memória sem nunca gravar seu ID no Redis
    const selfUsers = await service.searchUsers(
      { q: 'react', limite: 10 },
      privateViewerId.toString(),
    );
    expect(selfUsers.items[0]).toMatchObject({
      id: privateViewerId.toString(),
      visibilidadePerfil: 'privado',
      biografia: 'Especialista em React confidencial',
      score: 77,
    });
    expect(selfUsers.items[0].stacks).toHaveLength(1);
    for (const value of store.values()) {
      expect(value).not.toContain(privateViewerId.toString());
    }
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
