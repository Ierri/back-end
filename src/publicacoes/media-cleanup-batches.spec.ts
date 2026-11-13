import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { MediaCleanupService } from './media-cleanup.service.js';
import { MediaStorageService } from './media-storage.service.js';
import { Publicacao } from './schemas/publicacao.schema.js';
import { UploadMedia } from './schemas/upload-media.schema.js';

type Row = {
  _id: Types.ObjectId;
  chave_storage: string;
  estado: 'pronta' | 'reservada' | 'vinculada' | 'excluindo';
  publicacao_id: Types.ObjectId | null;
  expira_em: Date | null;
  reservada_em: Date | null;
  criado_em: Date;
  atualizado_em: Date;
};

const now = new Date('2026-11-12T12:00:00.000Z');
const old = new Date('2026-11-10T12:00:00.000Z');

function row(
  index: number,
  state: Row['estado'],
  post: Types.ObjectId | null,
): Row {
  return {
    _id: new Types.ObjectId(),
    chave_storage: `uploads/${index}`,
    estado: state,
    publicacao_id: post,
    expira_em: new Date(old.getTime() + index),
    reservada_em: post ? old : null,
    criado_em: old,
    atualizado_em: old,
  };
}

function setup(rows: Row[], postStatus = 'publicada') {
  const posts = new Map<string, { status: string; criada_em: Date }>();
  for (const item of rows) {
    if (item.publicacao_id)
      posts.set(item.publicacao_id.toString(), {
        status: postStatus,
        criada_em: old,
      });
  }
  const matching = (item: Row, filter: Record<string, unknown>) => {
    if (filter._id && !item._id.equals(filter._id as Types.ObjectId))
      return false;
    if (filter.estado && item.estado !== filter.estado) return false;
    if (filter.publicacao_id === null && item.publicacao_id !== null)
      return false;
    if (
      filter.publicacao_id instanceof Types.ObjectId &&
      !item.publicacao_id?.equals(filter.publicacao_id)
    )
      return false;
    if (
      filter.expira_em instanceof Date &&
      item.expira_em?.getTime() !== filter.expira_em.getTime()
    )
      return false;
    const expiry = filter.expira_em as { $lt?: Date } | undefined;
    if (expiry?.$lt && !(item.expira_em && item.expira_em < expiry.$lt))
      return false;
    if (filter.reservada_em === null && item.reservada_em !== null)
      return false;
    if (
      filter.reservada_em instanceof Date &&
      item.reservada_em?.getTime() !== filter.reservada_em.getTime()
    )
      return false;
    return true;
  };
  const sort = vi.fn((_order: Record<string, number>) => ({
    limit: vi.fn((count: number) => ({
      exec: async () =>
        rows
          .filter((item) => item.expira_em && item.expira_em < now)
          .sort(
            (left, right) =>
              left.expira_em!.getTime() - right.expira_em!.getTime() ||
              left._id.toString().localeCompare(right._id.toString()),
          )
          .slice(0, count)
          .map((item) => ({ ...item })),
    })),
  }));
  const uploads = {
    find: vi.fn(() => ({ sort })),
    updateOne: vi.fn(
      (filter: Record<string, unknown>, update: { $set: Partial<Row> }) => ({
        exec: async () => {
          const found = rows.find((item) => matching(item, filter));
          if (!found) return { modifiedCount: 0 };
          Object.assign(found, update.$set);
          return { modifiedCount: 1 };
        },
      }),
    ),
    findOneAndUpdate: vi.fn(
      (filter: Record<string, unknown>, update: { $set: Partial<Row> }) => ({
        exec: async () => {
          const found = rows.find((item) => matching(item, filter));
          if (!found) return null;
          Object.assign(found, update.$set);
          return { ...found };
        },
      }),
    ),
    deleteOne: vi.fn((filter: Record<string, unknown>) => ({
      exec: async () => {
        const index = rows.findIndex((item) => matching(item, filter));
        if (index < 0) return { deletedCount: 0 };
        rows.splice(index, 1);
        return { deletedCount: 1 };
      },
    })),
  };
  const publications = {
    exists: vi.fn(
      (filter: { _id: Types.ObjectId; status?: { $ne: string } }) => ({
        exec: async () => {
          const found = posts.get(filter._id.toString());
          return found && (!filter.status || found.status !== filter.status.$ne)
            ? found
            : null;
        },
      }),
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
            !found ||
            found.status !== filter.status ||
            !(found.criada_em < filter.criada_em.$lt)
          )
            return { deletedCount: 0 };
          posts.delete(filter._id.toString());
          return { deletedCount: 1 };
        },
      }),
    ),
  };
  const storage = { remove: vi.fn().mockResolvedValue(undefined) };
  const cleanup = new MediaCleanupService(
    uploads as unknown as Model<UploadMedia>,
    publications as unknown as Model<Publicacao>,
    storage as unknown as MediaStorageService,
  );
  return { rows, posts, uploads, publications, storage, cleanup, sort };
}

describe('MediaCleanupService bounded batches', () => {
  it('advances past 205 old linked records and reaches later orphan uploads', async () => {
    const linked = Array.from({ length: 205 }, (_, index) =>
      row(index, 'vinculada', new Types.ObjectId()),
    );
    const orphan = row(206, 'pronta', null);
    const state = setup([...linked, orphan]);

    await expect(state.cleanup.cleanupExpired(now, 100)).resolves.toBe(0);
    expect(linked.filter((item) => item.expira_em === null)).toHaveLength(100);
    await expect(state.cleanup.cleanupExpired(now, 100)).resolves.toBe(0);
    expect(linked.filter((item) => item.expira_em === null)).toHaveLength(200);
    await expect(state.cleanup.cleanupExpired(now, 100)).resolves.toBe(1);
    expect(linked.every((item) => item.expira_em === null)).toBe(true);
    expect(state.rows).not.toContain(orphan);
    expect(state.storage.remove).toHaveBeenCalledExactlyOnceWith(
      orphan.chave_storage,
    );
    expect(state.sort).toHaveBeenCalledWith({ expira_em: 1, _id: 1 });
    expect(state.uploads.find).toHaveBeenCalledTimes(3);
  });

  it('retains valid published and logically deleted legacy media without deleting S3 objects', async () => {
    const published = row(1, 'vinculada', new Types.ObjectId());
    const state = setup([published]);
    await expect(state.cleanup.cleanupExpired(now)).resolves.toBe(0);
    expect(published.expira_em).toBeNull();
    expect(state.storage.remove).not.toHaveBeenCalled();

    const deletedPostMedia = row(2, 'vinculada', new Types.ObjectId());
    const deletedState = setup([deletedPostMedia], 'excluida');
    await expect(deletedState.cleanup.cleanupExpired(now)).resolves.toBe(0);
    expect(deletedPostMedia.expira_em).toBeNull();
    expect(deletedState.storage.remove).not.toHaveBeenCalled();
  });

  it('does not clear expiry if a linked row changes while the batch runs', async () => {
    const linked = row(1, 'vinculada', new Types.ObjectId());
    const state = setup([linked]);
    const original = state.uploads.updateOne.getMockImplementation()!;
    state.uploads.updateOne.mockImplementationOnce((filter, update) => {
      linked.estado = 'reservada';
      linked.reservada_em = now;
      return original(filter, update);
    });
    await expect(state.cleanup.cleanupExpired(now)).resolves.toBe(0);
    expect(linked.expira_em).not.toBeNull();
    expect(state.storage.remove).not.toHaveBeenCalled();
  });

  it('recovers an old linked orphan with no reservation timestamp', async () => {
    const legacy = row(1, 'vinculada', new Types.ObjectId());
    legacy.reservada_em = null;
    const state = setup([legacy]);
    state.posts.clear();
    await expect(state.cleanup.cleanupExpired(now)).resolves.toBe(1);
    expect(state.rows).toHaveLength(0);
    expect(state.storage.remove).toHaveBeenCalledOnce();
  });

  it('keeps a failed delete eligible for a later retry', async () => {
    const orphan = row(1, 'pronta', null);
    const state = setup([orphan]);
    state.storage.remove.mockRejectedValueOnce(
      new Error('S3 temporarily unavailable'),
    );
    await expect(state.cleanup.cleanupExpired(now)).resolves.toBe(0);
    expect(orphan.estado).toBe('excluindo');
    expect(state.rows).toContain(orphan);
    await expect(state.cleanup.cleanupExpired(now)).resolves.toBe(1);
    expect(state.rows).toHaveLength(0);
  });
});
