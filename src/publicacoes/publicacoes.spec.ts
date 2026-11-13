import { Types, model } from 'mongoose';
import type { Model } from 'mongoose';
import type { ConfigService } from '@nestjs/config';
import { ApiException } from '../common/http/api.exception.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import {
  createPublicacaoSchema,
  listPublicacoesSchema,
  publicacaoIdSchema,
  updatePublicacaoSchema,
} from './dto/publicacoes.dto.js';
import {
  MAX_MEDIA_SIZE_BYTES,
  UnavailableMediaVerifier,
} from './media-verifier.js';
import type { MediaVerifier, VerifiedMedia } from './media-verifier.js';
import { PublicacoesCursor } from './publicacoes.cursor.js';
import { PublicacoesService } from './publicacoes.service.js';
import { Publicacao, PublicacaoSchema } from './schemas/publicacao.schema.js';

const PublicationModel = model(Publicacao.name, PublicacaoSchema);
const authorId = new Types.ObjectId();
const postId = new Types.ObjectId();

function media(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    tipo: 'imagem',
    url: 'https://cdn.example.test/publicacoes/imagem.webp',
    chave_storage: 'publicacoes/imagem.webp',
    mime_type: 'image/webp',
    tamanho_bytes: 1000,
    largura: 800,
    altura: 600,
    duracao_segundos: null,
    texto_alternativo: null,
    ordem: 0,
    ...overrides,
  };
}

function publication(overrides: Record<string, unknown> = {}) {
  return new PublicationModel({
    slug: 'post-exemplo',
    autor_id: authorId,
    conteudo: 'Conteúdo da publicação',
    midias: [media()],
    visibilidade: 'publico',
    status: 'publicada',
    publicada_em: new Date(),
    ...overrides,
  });
}

function query(value: unknown) {
  const result = {
    exec: vi.fn().mockResolvedValue(value),
    select: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
  };
  result.select.mockReturnValue(result);
  result.sort.mockReturnValue(result);
  result.limit.mockReturnValue(result);
  return result;
}

function setup(verifier: MediaVerifier = new UnavailableMediaVerifier()) {
  const author = {
    _id: authorId,
    nome: 'Pessoa',
    username: 'pessoa',
    biografia: 'Bio pública',
    avatar_url: '/avatar.png',
    email: 'private@example.test',
  };
  const saved = publication();
  const publications = {
    create: vi.fn().mockResolvedValue(saved),
    find: vi.fn().mockReturnValue(query([])),
    findOne: vi.fn().mockReturnValue(query(saved)),
    findOneAndUpdate: vi.fn().mockReturnValue(query(saved)),
    deleteOne: vi.fn().mockReturnValue(query({ deletedCount: 1 })),
  };
  const users = {
    findById: vi.fn().mockReturnValue(query(author)),
    find: vi.fn().mockReturnValue(query([author])),
  };
  const cursor = new PublicacoesCursor({
    getOrThrow: () => 'unit-test-secret-for-publication-cursors',
  } as unknown as ConfigService);
  const service = new PublicacoesService(
    publications as unknown as Model<Publicacao>,
    users as unknown as Model<Usuario>,
    verifier,
    cursor,
  );
  return { service, publications, users, saved, author, cursor };
}

function body() {
  return createPublicacaoSchema.parse({
    conteudo: 'Nova publicação',
    midias: ['referencia-verificada'],
  });
}

describe('publicações: validação', () => {
  it('accepts the documented publication shape without a database connection', async () => {
    await expect(publication().validate()).resolves.toBeUndefined();
    await expect(
      publication({
        midias: Array.from({ length: 10 }, (_, ordem) =>
          media({ ordem, chave_storage: `arquivo-${ordem}` }),
        ),
      }).validate(),
    ).resolves.toBeUndefined();
  });

  it.each(['imagem', 'video'] as const)(
    'accepts %s below and exactly at 25 MB, but rejects one byte above',
    async (tipo) => {
      const attributes =
        tipo === 'video'
          ? { tipo, mime_type: 'video/mp4', duracao_segundos: 120 }
          : { tipo, mime_type: 'image/webp' };
      for (const size of [MAX_MEDIA_SIZE_BYTES - 1, MAX_MEDIA_SIZE_BYTES]) {
        await expect(
          publication({
            midias: [media({ ...attributes, tamanho_bytes: size })],
          }).validate(),
        ).resolves.toBeUndefined();
      }
      await expect(
        publication({
          midias: [
            media({ ...attributes, tamanho_bytes: MAX_MEDIA_SIZE_BYTES + 1 }),
          ],
        }).validate(),
      ).rejects.toThrow();
    },
  );

  it.each([
    { midias: [] },
    {
      midias: Array.from({ length: 11 }, (_, ordem) =>
        media({ ordem, chave_storage: `arquivo-${ordem}` }),
      ),
    },
    { midias: [media({ ordem: 1 })] },
    { midias: [media({ largura: null })] },
    { midias: [media({ mime_type: 'image/gif' })] },
    { midias: [media({ url: 'https://cdn.example.test/file?token=secret' })] },
    {
      midias: Array.from({ length: 9 }, (_, ordem) =>
        media({
          ordem,
          chave_storage: `video-${ordem}`,
          tipo: 'video',
          mime_type: 'video/mp4',
          tamanho_bytes: MAX_MEDIA_SIZE_BYTES,
          duracao_segundos: 30,
        }),
      ),
    },
    { midias: [media(), media({ ordem: 1 })] },
    { conteudo: '   ' },
    { publicada_em: null },
    { contadores: { upvotes: -1 } },
  ])('rejects an invalid publication %#', async (changes) => {
    await expect(publication(changes).validate()).rejects.toThrow();
  });

  it('requires unique opaque media references and forbids client-owned fields', () => {
    expect(
      createPublicacaoSchema.safeParse({ conteudo: 'x', midias: [] }).success,
    ).toBe(false);
    expect(
      createPublicacaoSchema.safeParse({
        conteudo: 'x',
        midias: ['referencia-verificada', 'referencia-verificada'],
      }).success,
    ).toBe(false);
    expect(
      createPublicacaoSchema.safeParse({
        conteudo: 'x',
        midias: ['https://example.test/file'],
      }).success,
    ).toBe(false);
    expect(
      createPublicacaoSchema.safeParse({
        ...body(),
        tamanho_bytes: MAX_MEDIA_SIZE_BYTES,
      }).success,
    ).toBe(false);
    expect(
      createPublicacaoSchema.safeParse({
        ...body(),
        autor_id: authorId.toString(),
      }).success,
    ).toBe(false);
    expect(
      createPublicacaoSchema.safeParse({
        ...body(),
        url: 'https://example.test/a',
      }).success,
    ).toBe(false);
    expect(updatePublicacaoSchema.safeParse({}).success).toBe(false);
    expect(
      updatePublicacaoSchema.safeParse({ contadores: { score: 100 } }).success,
    ).toBe(false);
    expect(
      updatePublicacaoSchema.safeParse({ midias: ['unverified'] }).success,
    ).toBe(false);
    expect(publicacaoIdSchema.safeParse('invalid').success).toBe(false);
  });

  it('validates list filters and page size', () => {
    expect(listPublicacoesSchema.parse({})).toEqual({ limite: 20 });
    expect(
      listPublicacoesSchema.parse({
        limite: '50',
        autorId: authorId.toString(),
      }),
    ).toEqual({
      limite: 50,
      autorId: authorId.toString(),
    });
    for (const limite of ['0', '51', '-1', '1.5', 'abc', '']) {
      expect(listPublicacoesSchema.safeParse({ limite }).success).toBe(false);
    }
    expect(
      listPublicacoesSchema.safeParse({ autorId: 'invalid' }).success,
    ).toBe(false);
    expect(
      listPublicacoesSchema.safeParse({ cursor: 'malformed' }).success,
    ).toBe(false);
    expect(listPublicacoesSchema.safeParse({ unknown: 'value' }).success).toBe(
      false,
    );
  });

  it('has indexes for public and author cursor queries', () => {
    const indexes = PublicacaoSchema.indexes().map(([fields]) => fields);
    expect(indexes).toContainEqual({
      status: 1,
      visibilidade: 1,
      publicada_em: -1,
      _id: -1,
    });
    expect(indexes).toContainEqual({
      autor_id: 1,
      status: 1,
      publicada_em: -1,
      _id: -1,
    });
    expect(indexes).toContainEqual({
      autor_id: 1,
      status: 1,
      visibilidade: 1,
      publicada_em: -1,
      _id: -1,
    });
  });
});

describe('PublicacoesService', () => {
  it('fails closed without a real media verifier and creates no document', async () => {
    const { service, publications } = setup();
    await expect(
      service.create(authorId.toString(), body()),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(publications.create).not.toHaveBeenCalled();
  });

  it('creates only after verified media and uses the authenticated author', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValue([
        { referencia: 'referencia-verificada', ...media() } as VerifiedMedia,
      ]);
    const confirm = vi.fn().mockResolvedValue(undefined);
    const finalize = vi.fn().mockResolvedValue(undefined);
    const verifier: MediaVerifier = {
      resolveForPublication: resolve,
      confirmForPublication: confirm,
      finalizeForPublication: finalize,
      releaseForPublication: vi.fn().mockResolvedValue(undefined),
    };
    const { service, publications, saved } = setup(verifier);
    const result = await service.create(authorId.toString(), body());
    const stored = publications.create.mock.calls[0][0];

    expect(resolve).toHaveBeenCalledWith(
      authorId.toString(),
      ['referencia-verificada'],
      expect.any(String),
    );
    expect(stored.autor_id.toString()).toBe(authorId.toString());
    expect(stored.status).toBe('processando');
    expect(stored.publicada_em).toBeNull();
    expect(confirm).toHaveBeenCalledWith(stored._id.toString(), [
      'referencia-verificada',
    ]);
    expect(finalize).toHaveBeenCalledWith(stored._id.toString(), [
      'referencia-verificada',
    ]);
    expect(publications.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: saved._id, status: 'processando' },
      { $set: { status: 'publicada', publicada_em: expect.any(Date) } },
      { new: true, runValidators: true },
    );
    expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(
      publications.findOneAndUpdate.mock.invocationCallOrder[0],
    );
    expect(
      publications.findOneAndUpdate.mock.invocationCallOrder[0],
    ).toBeLessThan(finalize.mock.invocationCallOrder[0]);
    expect(stored.midias).toHaveLength(1);
    expect(result.autor).not.toHaveProperty('email');
    expect(result.midias[0]).not.toHaveProperty('chave_storage');
  });

  it('keeps a successfully published post when expiry normalization fails temporarily', async () => {
    const finalize = vi
      .fn()
      .mockRejectedValue(new Error('MongoDB unavailable'));
    const verifier: MediaVerifier = {
      resolveForPublication: vi
        .fn()
        .mockResolvedValue([
          { referencia: 'referencia-verificada', ...media() },
        ]),
      confirmForPublication: vi.fn().mockResolvedValue(undefined),
      finalizeForPublication: finalize,
      releaseForPublication: vi.fn().mockResolvedValue(undefined),
    };
    const { service, publications } = setup(verifier);
    await expect(
      service.create(authorId.toString(), body()),
    ).resolves.toMatchObject({ status: 'publicada' });
    expect(finalize).toHaveBeenCalledOnce();
    expect(publications.deleteOne).not.toHaveBeenCalled();
  });

  it('rejects mismatched or invalid verified media before persistence', async () => {
    const verifier: MediaVerifier = {
      resolveForPublication: vi
        .fn()
        .mockResolvedValue([{ referencia: 'other', ...media() }]),
      confirmForPublication: vi.fn().mockResolvedValue(undefined),
      finalizeForPublication: vi.fn().mockResolvedValue(undefined),
      releaseForPublication: vi.fn().mockResolvedValue(undefined),
    };
    const { service, publications } = setup(verifier);
    await expect(
      service.create(authorId.toString(), body()),
    ).rejects.toMatchObject({ status: 422 });
    expect(publications.create).not.toHaveBeenCalled();
  });

  it('does not publish when media confirmation loses a cleanup race', async () => {
    const confirm = vi
      .fn()
      .mockRejectedValue(new ApiException('MEDIA_INVALID'));
    const release = vi.fn().mockResolvedValue(undefined);
    const verifier: MediaVerifier = {
      resolveForPublication: vi
        .fn()
        .mockResolvedValue([
          { referencia: 'referencia-verificada', ...media() },
        ]),
      confirmForPublication: confirm,
      finalizeForPublication: vi.fn().mockResolvedValue(undefined),
      releaseForPublication: release,
    };
    const { service, publications } = setup(verifier);
    await expect(
      service.create(authorId.toString(), body()),
    ).rejects.toMatchObject({ status: 422 });
    expect(publications.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'processando' }),
    );
    expect(publications.findOneAndUpdate).not.toHaveBeenCalled();
    expect(publications.deleteOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'processando' }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('retains the reservation when MongoDB reports an ambiguous create failure', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const verifier: MediaVerifier = {
      resolveForPublication: vi
        .fn()
        .mockResolvedValue([
          { referencia: 'referencia-verificada', ...media() },
        ]),
      confirmForPublication: vi.fn().mockResolvedValue(undefined),
      finalizeForPublication: vi.fn().mockResolvedValue(undefined),
      releaseForPublication: release,
    };
    const { service, publications } = setup(verifier);
    publications.create.mockRejectedValueOnce(
      new Error('MongoDB connection lost'),
    );
    await expect(service.create(authorId.toString(), body())).rejects.toThrow(
      'MongoDB connection lost',
    );
    expect(publications.findOneAndUpdate).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('does not release media if publication may already be published', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const verifier: MediaVerifier = {
      resolveForPublication: vi
        .fn()
        .mockResolvedValue([
          { referencia: 'referencia-verificada', ...media() },
        ]),
      confirmForPublication: vi.fn().mockResolvedValue(undefined),
      finalizeForPublication: vi.fn().mockResolvedValue(undefined),
      releaseForPublication: release,
    };
    const { service, publications } = setup(verifier);
    publications.findOneAndUpdate.mockReturnValueOnce(query(null));
    publications.deleteOne.mockReturnValueOnce(query({ deletedCount: 0 }));
    await expect(
      service.create(authorId.toString(), body()),
    ).rejects.toMatchObject({ status: 422 });
    expect(release).not.toHaveBeenCalled();
  });

  it.each([MAX_MEDIA_SIZE_BYTES, MAX_MEDIA_SIZE_BYTES + 1])(
    'enforces the 25 MB limit on verified metadata of %s bytes',
    async (size) => {
      const verifier: MediaVerifier = {
        resolveForPublication: vi.fn().mockResolvedValue([
          {
            referencia: 'referencia-verificada',
            ...media({ tamanho_bytes: size }),
          },
        ]),
        confirmForPublication: vi.fn().mockResolvedValue(undefined),
        finalizeForPublication: vi.fn().mockResolvedValue(undefined),
        releaseForPublication: vi.fn().mockResolvedValue(undefined),
      };
      const { service, publications } = setup(verifier);
      if (size <= MAX_MEDIA_SIZE_BYTES) {
        await service.create(authorId.toString(), body());
        expect(
          publications.create.mock.calls[0][0].midias[0].tamanho_bytes,
        ).toBe(size);
      } else {
        await expect(
          service.create(authorId.toString(), body()),
        ).rejects.toMatchObject({ status: 422 });
        expect(publications.create).not.toHaveBeenCalled();
      }
    },
  );

  it('queries only published and accessible posts and hides missing content', async () => {
    const { service, publications } = setup();
    await service.findById(postId.toString());
    expect(publications.findOne).toHaveBeenCalledWith({
      _id: postId.toString(),
      status: 'publicada',
      $or: [{ visibilidade: 'publico' }],
    });
    await service.findById(postId.toString(), authorId.toString());
    expect(publications.findOne.mock.calls[1][0].$or).toContainEqual({
      autor_id: authorId,
    });
    publications.findOne.mockReturnValueOnce(query(null));
    await expect(service.findById(postId.toString())).rejects.toMatchObject({
      status: 404,
    });
  });

  it("atomically edits only the author's published post", async () => {
    const { service, publications } = setup();
    await service.update(postId.toString(), authorId.toString(), {
      conteudo: 'Editado',
    });
    const [filter, update] = publications.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      _id: postId.toString(),
      autor_id: authorId,
      status: 'publicada',
    });
    expect(update.$set).toMatchObject({
      conteudo: 'Editado',
      editada_em: expect.any(Date),
    });
    expect(update.$set).not.toHaveProperty('autor_id');
    publications.findOneAndUpdate.mockReturnValueOnce(query(null));
    await expect(
      service.update(postId.toString(), new Types.ObjectId().toString(), {
        conteudo: 'x',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("atomically soft-deletes only the author's published post", async () => {
    const { service, publications } = setup();
    await expect(
      service.remove(postId.toString(), authorId.toString()),
    ).resolves.toBeNull();
    const [filter, update] = publications.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      _id: postId.toString(),
      autor_id: authorId,
      status: 'publicada',
    });
    expect(update).toEqual({ $set: { status: 'excluida' } });
    publications.findOneAndUpdate.mockReturnValueOnce(query(null));
    await expect(
      service.remove(postId.toString(), new Types.ObjectId().toString()),
    ).rejects.toBeInstanceOf(ApiException);
  });
});

describe('PublicacoesService list', () => {
  const publishedAt = new Date('2026-11-09T12:00:00.000Z');
  const ids = [
    '00000000000000000000000a',
    '00000000000000000000000b',
    '00000000000000000000000c',
  ];
  const posts = ids.map((id) =>
    publication({ _id: new Types.ObjectId(id), publicada_em: publishedAt }),
  );

  it('places a later publication first even when it was created earlier', async () => {
    const { service, publications } = setup();
    const publishedLater = publication({
      _id: new Types.ObjectId(ids[0]),
      criada_em: new Date('2026-11-09T09:00:00.000Z'),
      publicada_em: new Date('2026-11-09T13:00:00.000Z'),
    });
    const createdLater = publication({
      _id: new Types.ObjectId(ids[1]),
      criada_em: new Date('2026-11-09T10:00:00.000Z'),
      publicada_em: new Date('2026-11-09T12:00:00.000Z'),
    });
    const findQuery = query([]);
    findQuery.exec.mockImplementation(async () => {
      const sort = findQuery.sort.mock.calls[0][0] as Record<string, number>;
      const field = Object.keys(sort)[0] as 'criada_em' | 'publicada_em';
      return [publishedLater, createdLater].toSorted(
        (left, right) =>
          right[field]!.getTime() - left[field]!.getTime() ||
          right._id.toString().localeCompare(left._id.toString()),
      );
    });
    publications.find.mockReturnValueOnce(findQuery);

    const result = await service.list({ limite: 20 });
    expect(result.items.map((item) => item.id)).toEqual([ids[0], ids[1]]);
    expect(findQuery.sort).toHaveBeenCalledWith({ publicada_em: -1, _id: -1 });
  });

  it('reads one extra document, sorts by publication date and id, and batches authors', async () => {
    const { service, publications, users, cursor } = setup();
    const firstQuery = query([posts[2], posts[1], posts[0]]);
    const secondQuery = query([posts[0]]);
    publications.find
      .mockReturnValueOnce(firstQuery)
      .mockReturnValueOnce(secondQuery);

    const first = await service.list({ limite: 2 });
    expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(firstQuery.sort).toHaveBeenCalledWith({ publicada_em: -1, _id: -1 });
    expect(firstQuery.limit).toHaveBeenCalledWith(3);
    expect(publications.find.mock.calls[0][0]).toEqual({
      status: 'publicada',
      visibilidade: 'publico',
    });
    expect(users.find).toHaveBeenCalledTimes(1);
    expect(users.find.mock.calls[0][0]).toEqual({
      _id: { $in: [authorId.toString()] },
    });
    expect(first.items[0].autor).not.toHaveProperty('email');
    expect(first.items[0].midias[0]).not.toHaveProperty('chave_storage');

    const position = cursor.decode(first.nextCursor!, {
      authorId: null,
      owner: false,
    });
    expect(position.id.toString()).toBe(ids[1]);
    expect(position.publishedAt).toEqual(publishedAt);
    const second = await service.list({ limite: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(publications.find.mock.calls[1][0]).toEqual({
      status: 'publicada',
      visibilidade: 'publico',
      $or: [
        { publicada_em: { $lt: publishedAt } },
        { publicada_em: publishedAt, _id: { $lt: new Types.ObjectId(ids[1]) } },
      ],
    });
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(3);
  });

  it('returns an empty page without loading authors', async () => {
    const { service, users } = setup();
    await expect(
      service.list({ limite: 20, autorId: authorId.toString() }),
    ).resolves.toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(users.find).not.toHaveBeenCalled();
  });

  it('pages through first, intermediate and last pages without duplicate ids', async () => {
    const { service, publications } = setup();
    const pageIds = ['a', 'b', 'c', 'd', 'e'].map(
      (digit) => `00000000000000000000000${digit}`,
    );
    const pagePosts = pageIds.map((id) =>
      publication({ _id: new Types.ObjectId(id), publicada_em: publishedAt }),
    );
    publications.find
      .mockReturnValueOnce(query([pagePosts[4], pagePosts[3], pagePosts[2]]))
      .mockReturnValueOnce(query([pagePosts[2], pagePosts[1], pagePosts[0]]))
      .mockReturnValueOnce(query([pagePosts[0]]));

    const first = await service.list({ limite: 2 });
    const middle = await service.list({ limite: 2, cursor: first.nextCursor! });
    const last = await service.list({ limite: 2, cursor: middle.nextCursor! });
    expect([first.hasMore, middle.hasMore, last.hasMore]).toEqual([
      true,
      true,
      false,
    ]);
    expect(last.nextCursor).toBeNull();
    const allIds = [...first.items, ...middle.items, ...last.items].map(
      (item) => item.id,
    );
    expect(allIds).toEqual(pageIds.toReversed());
    expect(new Set(allIds).size).toBe(5);
    for (const [index, lastId] of [pageIds[3], pageIds[1]].entries()) {
      expect(publications.find.mock.calls[index + 1][0].$or).toEqual([
        { publicada_em: { $lt: publishedAt } },
        {
          publicada_em: publishedAt,
          _id: { $lt: new Types.ObjectId(lastId) },
        },
      ]);
    }
  });

  it('filters by author and allows restricted posts only to that authenticated author', async () => {
    const { service, publications } = setup();
    const query = { limite: 20, autorId: authorId.toString() };
    await service.list(query);
    expect(publications.find.mock.calls[0][0]).toEqual({
      status: 'publicada',
      autor_id: authorId,
      visibilidade: 'publico',
    });
    await service.list(query, new Types.ObjectId().toString());
    expect(publications.find.mock.calls[1][0]).toHaveProperty(
      'visibilidade',
      'publico',
    );
    await service.list(query, authorId.toString());
    expect(publications.find.mock.calls[2][0]).toEqual({
      status: 'publicada',
      autor_id: authorId,
    });
  });

  it('rejects an owner cursor for an anonymous or different author query', async () => {
    const { service, cursor, publications } = setup();
    const ownerCursor = cursor.encode(
      { publishedAt, id: new Types.ObjectId(ids[0]) },
      { authorId: authorId.toString(), owner: true },
    );
    await expect(
      service.list({
        limite: 20,
        autorId: authorId.toString(),
        cursor: ownerCursor,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.list({ limite: 20, cursor: ownerCursor }, authorId.toString()),
    ).rejects.toMatchObject({ status: 400 });
    expect(publications.find).not.toHaveBeenCalled();
  });
});
