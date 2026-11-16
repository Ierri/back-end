import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { MediaCleanupService } from './media-cleanup.service.js';
import { MediaStorageService } from './media-storage.service.js';
import { MongoMediaVerifierService } from './mongo-media-verifier.service.js';
import { Publicacao } from './schemas/publicacao.schema.js';
import { UploadMedia } from './schemas/upload-media.schema.js';

const owner = new Types.ObjectId();
const postId = new Types.ObjectId();
const head = {
  ContentLength: 100,
  ContentType: 'image/png',
  Metadata: { sha256: 'a'.repeat(64) },
};

function query<T>(value: T) {
  return { exec: async () => value };
}

function setup() {
  const row = {
    _id: new Types.ObjectId(),
    referencia: 'race-reference-123',
    usuario_id: owner,
    chave_storage: 'uploads/race-object',
    tipo: 'imagem',
    mime_type: 'image/png',
    tamanho_bytes: 100,
    largura: 2,
    altura: 2,
    duracao_segundos: null,
    sha256: 'a'.repeat(64),
    estado: 'pronta',
    publicacao_id: null as Types.ObjectId | null,
    reservada_em: null as Date | null,
    expira_em: new Date(Date.now() + 60_000) as Date | null,
    criado_em: new Date(0),
    atualizado_em: new Date(0),
  };
  const posts = new Map<
    string,
    { _id: Types.ObjectId; status: string; criada_em: Date }
  >();
  const match = (filter: Record<string, unknown>) => {
    if (filter._id && !row._id.equals(filter._id as Types.ObjectId))
      return false;
    if (filter.referencia && row.referencia !== filter.referencia) return false;
    if (
      filter.usuario_id &&
      !row.usuario_id.equals(filter.usuario_id as Types.ObjectId)
    )
      return false;
    if (filter.estado && filter.estado !== row.estado) return false;
    if (filter.publicacao_id === null && row.publicacao_id !== null)
      return false;
    if (
      filter.publicacao_id instanceof Types.ObjectId &&
      !row.publicacao_id?.equals(filter.publicacao_id)
    )
      return false;
    const expiry = filter.expira_em as { $gt?: Date; $lt?: Date } | undefined;
    if (expiry?.$gt && !(row.expira_em && row.expira_em > expiry.$gt))
      return false;
    if (expiry?.$lt && !(row.expira_em && row.expira_em < expiry.$lt))
      return false;
    const reservation = filter.reservada_em as
      { $gt?: Date; $lt?: Date } | undefined;
    if (
      reservation?.$gt &&
      !(row.reservada_em && row.reservada_em > reservation.$gt)
    )
      return false;
    if (
      reservation?.$lt &&
      !(row.reservada_em && row.reservada_em < reservation.$lt)
    )
      return false;
    return true;
  };
  let present = true;
  const uploads = {
    findOneAndUpdate: vi.fn(
      (
        filter: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => ({
        exec: async () => {
          if (!present || !match(filter)) return null;
          Object.assign(row, update.$set);
          return { ...row };
        },
      }),
    ),
    find: vi.fn(() => ({
      sort: () => ({
        limit: () => ({
          exec: async () =>
            present && row.expira_em && row.expira_em < new Date()
              ? [{ ...row }]
              : [],
        }),
      }),
    })),
    updateMany: vi.fn(
      (_filter: unknown, update: { $set: Record<string, unknown> }) => ({
        exec: async () => {
          if (present) Object.assign(row, update.$set);
        },
      }),
    ),
    updateOne: vi.fn(
      (
        filter: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => ({
        exec: async () => {
          if (present && match(filter)) Object.assign(row, update.$set);
        },
      }),
    ),
    deleteOne: vi.fn((filter: Record<string, unknown>) => ({
      exec: async () => {
        if (present && match(filter)) {
          present = false;
          return { deletedCount: 1 };
        }
        return { deletedCount: 0 };
      },
    })),
  };
  const publications = {
    exists: vi.fn(
      (filter: { _id: Types.ObjectId; status?: { $ne: string } }) => {
        const found = posts.get(filter._id.toString());
        return query(
          found && (!filter.status || found.status !== filter.status.$ne)
            ? found
            : null,
        );
      },
    ),
    deleteOne: vi.fn(
      (filter: {
        _id: Types.ObjectId;
        status: string;
        criada_em: { $lt: Date };
      }) => ({
        exec: async () => {
          const found = posts.get(filter._id.toString());
          if (
            found?.status === filter.status &&
            found.criada_em < filter.criada_em.$lt
          ) {
            posts.delete(filter._id.toString());
            return { deletedCount: 1 };
          }
          return { deletedCount: 0 };
        },
      }),
    ),
  };
  const storage = {
    head: vi.fn().mockResolvedValue(head),
    publicUrl: vi
      .fn()
      .mockReturnValue(
        'https://api.example.test/publicacoes/midias/race-reference-123',
      ),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const verifier = new MongoMediaVerifierService(
    uploads as unknown as Model<UploadMedia>,
    publications as unknown as Model<Publicacao>,
    storage as unknown as MediaStorageService,
  );
  const cleanup = new MediaCleanupService(
    uploads as unknown as Model<UploadMedia>,
    publications as unknown as Model<Publicacao>,
    storage as unknown as MediaStorageService,
  );
  return {
    row,
    posts,
    uploads,
    publications,
    storage,
    verifier,
    cleanup,
    isPresent: () => present,
  };
}

describe('reservation and cleanup races', () => {
  it('protects a fresh reservation after the upload itself expires', async () => {
    const { row, storage, verifier, cleanup } = setup();
    await verifier.resolveForPublication(
      owner.toString(),
      [row.referencia],
      postId.toString(),
    );
    row.expira_em = new Date(0);
    await expect(cleanup.cleanupExpired()).resolves.toBe(0);
    expect(storage.remove).not.toHaveBeenCalled();
    await expect(
      verifier.confirmForPublication(postId.toString(), [row.referencia]),
    ).resolves.toBeUndefined();
    expect(row.estado).toBe('vinculada');
  });

  it('does not confirm a reservation after its own lease expires', async () => {
    const { row, verifier } = setup();
    await verifier.resolveForPublication(
      owner.toString(),
      [row.referencia],
      postId.toString(),
    );
    row.reservada_em = new Date(0);
    await expect(
      verifier.confirmForPublication(postId.toString(), [row.referencia]),
    ).rejects.toMatchObject({ status: 422 });
    expect(row.estado).toBe('reservada');
  });

  it('keeps an active processing publication safe when upload expiry passes', async () => {
    const { row, posts, storage, verifier, cleanup } = setup();
    await verifier.resolveForPublication(
      owner.toString(),
      [row.referencia],
      postId.toString(),
    );
    posts.set(postId.toString(), {
      _id: postId,
      status: 'processando',
      criada_em: new Date(),
    });
    row.expira_em = new Date(0);
    await expect(cleanup.cleanupExpired()).resolves.toBe(0);
    expect(storage.remove).not.toHaveBeenCalled();
    await verifier.confirmForPublication(postId.toString(), [row.referencia]);
    posts.get(postId.toString())!.status = 'publicada';
    await expect(cleanup.cleanupExpired()).resolves.toBe(0);
    expect(row.estado).toBe('vinculada');
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('fences a creator when cleanup claims an expired reservation before its post exists', async () => {
    const { row, posts, storage, verifier, cleanup, isPresent } = setup();
    await verifier.resolveForPublication(
      owner.toString(),
      [row.referencia],
      postId.toString(),
    );
    row.expira_em = new Date(0);
    row.reservada_em = new Date(0);
    await expect(cleanup.cleanupExpired()).resolves.toBe(1);
    expect(isPresent()).toBe(false);
    expect(storage.remove).toHaveBeenCalledOnce();
    posts.set(postId.toString(), {
      _id: postId,
      status: 'processando',
      criada_em: new Date(),
    });
    await expect(
      verifier.confirmForPublication(postId.toString(), [row.referencia]),
    ).rejects.toMatchObject({ status: 422 });
    expect(posts.get(postId.toString())?.status).toBe('processando');
  });

  it('reclaims an abandoned reservation and old processing post', async () => {
    const { row, posts, storage, verifier, cleanup, isPresent } = setup();
    await verifier.resolveForPublication(
      owner.toString(),
      [row.referencia],
      postId.toString(),
    );
    posts.set(postId.toString(), {
      _id: postId,
      status: 'processando',
      criada_em: new Date(0),
    });
    row.expira_em = new Date(0);
    row.reservada_em = new Date(0);
    await expect(cleanup.cleanupExpired()).resolves.toBe(1);
    expect(posts.has(postId.toString())).toBe(false);
    expect(isPresent()).toBe(false);
    expect(storage.remove).toHaveBeenCalledOnce();
  });

  it('rechecks publication existence after claiming a stale reservation', async () => {
    const { row, posts, publications, storage, verifier, cleanup, isPresent } =
      setup();
    await verifier.resolveForPublication(
      owner.toString(),
      [row.referencia],
      postId.toString(),
    );
    row.expira_em = new Date(0);
    row.reservada_em = new Date(0);
    publications.exists
      .mockReturnValueOnce(query(null))
      .mockImplementationOnce(() => {
        const active = {
          _id: postId,
          status: 'processando',
          criada_em: new Date(),
        };
        posts.set(postId.toString(), active);
        return query(active);
      });
    await expect(cleanup.cleanupExpired()).resolves.toBe(0);
    expect(isPresent()).toBe(true);
    expect(row.estado).toBe('reservada');
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('never removes media attached to an existing published post', async () => {
    const { row, posts, storage, verifier, cleanup } = setup();
    await verifier.resolveForPublication(
      owner.toString(),
      [row.referencia],
      postId.toString(),
    );
    await verifier.confirmForPublication(postId.toString(), [row.referencia]);
    posts.set(postId.toString(), {
      _id: postId,
      status: 'publicada',
      criada_em: new Date(0),
    });
    row.expira_em = new Date(0);
    await expect(cleanup.cleanupExpired()).resolves.toBe(0);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('releases a failed reservation for retry and later cleans it after expiry', async () => {
    const { row, verifier, cleanup, storage } = setup();
    await verifier.resolveForPublication(
      owner.toString(),
      [row.referencia],
      postId.toString(),
    );
    await verifier.releaseForPublication(postId.toString(), [row.referencia]);
    expect(row.estado).toBe('pronta');
    expect(row.publicacao_id).toBeNull();
    row.expira_em = new Date(0);
    await expect(cleanup.cleanupExpired()).resolves.toBe(1);
    expect(storage.remove).toHaveBeenCalledOnce();
  });
});
