import { Types, model } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import {
  createPublicacaoSchema,
  publicacaoIdSchema,
  updatePublicacaoSchema,
} from './dto/publicacoes.dto.js';
import {
  MAX_MEDIA_SIZE_BYTES,
  UnavailableMediaVerifier,
} from './media-verifier.js';
import type { MediaVerifier, VerifiedMedia } from './media-verifier.js';
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
  const result = { exec: vi.fn().mockResolvedValue(value), select: vi.fn() };
  result.select.mockReturnValue(result);
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
    findOne: vi.fn().mockReturnValue(query(saved)),
    findOneAndUpdate: vi.fn().mockReturnValue(query(saved)),
  };
  const users = { findById: vi.fn().mockReturnValue(query(author)) };
  const service = new PublicacoesService(
    publications as unknown as Model<Publicacao>,
    users as unknown as Model<Usuario>,
    verifier,
  );
  return { service, publications, users, saved, author };
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
    const verifier: MediaVerifier = {
      resolveForPublication: resolve,
    };
    const { service, publications } = setup(verifier);
    const result = await service.create(authorId.toString(), body());
    const stored = publications.create.mock.calls[0][0];

    expect(resolve).toHaveBeenCalledWith(authorId.toString(), [
      'referencia-verificada',
    ]);
    expect(stored.autor_id.toString()).toBe(authorId.toString());
    expect(stored.status).toBe('publicada');
    expect(stored.publicada_em).toBeInstanceOf(Date);
    expect(stored.midias).toHaveLength(1);
    expect(result.autor).not.toHaveProperty('email');
    expect(result.midias[0]).not.toHaveProperty('chave_storage');
  });

  it('rejects mismatched or invalid verified media before persistence', async () => {
    const verifier: MediaVerifier = {
      resolveForPublication: vi
        .fn()
        .mockResolvedValue([{ referencia: 'other', ...media() }]),
    };
    const { service, publications } = setup(verifier);
    await expect(
      service.create(authorId.toString(), body()),
    ).rejects.toMatchObject({ status: 422 });
    expect(publications.create).not.toHaveBeenCalled();
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
