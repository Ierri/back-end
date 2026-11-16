import { Readable } from 'node:stream';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import {
  MediaAccessService,
  parseMediaRange,
  UnsatisfiableMediaRange,
} from './media-access.service.js';
import { MediaCleanupService } from './media-cleanup.service.js';
import { MediaInspectionService } from './media-inspection.service.js';
import { MediaStorageService } from './media-storage.service.js';
import { MediaUploadService } from './media-upload.service.js';
import { MongoMediaVerifierService } from './mongo-media-verifier.service.js';
import { Publicacao } from './schemas/publicacao.schema.js';
import { UploadMedia } from './schemas/upload-media.schema.js';

const owner = new Types.ObjectId();
const other = new Types.ObjectId();
const post = new Types.ObjectId();
const expectedHead = {
  ContentLength: 100,
  ContentType: 'image/png',
  Metadata: { sha256: 'a'.repeat(64) },
};

function query<T>(value: T) {
  return { exec: vi.fn().mockResolvedValue(value) };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    referencia: 'valid-reference-123',
    usuario_id: owner,
    chave_storage: 'uploads/key',
    tipo: 'imagem',
    mime_type: 'image/png',
    tamanho_bytes: 100,
    largura: 2,
    altura: 2,
    duracao_segundos: null,
    sha256: 'a'.repeat(64),
    estado: 'pronta',
    publicacao_id: null as Types.ObjectId | null,
    expira_em: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function verifierSetup(initial = [record()]) {
  const rows = initial;
  const uploads = {
    findOneAndUpdate: vi.fn(
      (
        filter: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => ({
        exec: async () => {
          const row = rows.find(
            (item) =>
              item.referencia === filter.referencia &&
              (filter.usuario_id === undefined ||
                item.usuario_id.equals(filter.usuario_id as Types.ObjectId)) &&
              item.estado === filter.estado &&
              (filter.publicacao_id === null
                ? item.publicacao_id === null
                : filter.publicacao_id === undefined ||
                  item.publicacao_id?.equals(
                    filter.publicacao_id as Types.ObjectId,
                  )) &&
              (filter.expira_em === undefined || item.expira_em > new Date()),
          );
          if (!row) return null;
          Object.assign(row, update.$set);
          return row;
        },
      }),
    ),
    updateMany: vi.fn(
      (
        filter: {
          referencia: { $in: string[] };
          publicacao_id: Types.ObjectId;
        },
        update: { $set: Record<string, unknown> },
      ) => ({
        exec: async () => {
          for (const row of rows) {
            if (
              filter.referencia.$in.includes(row.referencia) &&
              row.publicacao_id?.equals(filter.publicacao_id)
            ) {
              Object.assign(row, update.$set);
            }
          }
        },
      }),
    ),
  };
  const publications = { exists: vi.fn().mockReturnValue(query(null)) };
  const storage = {
    head: vi.fn().mockResolvedValue(expectedHead),
    publicUrl: vi.fn(
      (reference: string) =>
        `https://api.example.test/publicacoes/midias/${reference}`,
    ),
  };
  const verifier = new MongoMediaVerifierService(
    uploads as unknown as Model<UploadMedia>,
    publications as unknown as Model<Publicacao>,
    storage as unknown as MediaStorageService,
  );
  return { verifier, uploads, publications, storage, rows };
}

describe('MongoMediaVerifierService', () => {
  it('atomically reserves owned, complete media and rejects simultaneous reuse', async () => {
    const { verifier, rows, storage } = verifierSetup();
    const first = verifier.resolveForPublication(
      owner.toString(),
      [rows[0].referencia],
      post.toString(),
    );
    const second = verifier.resolveForPublication(
      owner.toString(),
      [rows[0].referencia],
      new Types.ObjectId().toString(),
    );
    const results = await Promise.allSettled([first, second]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(rows[0].estado).toBe('reservada');
    expect(storage.head).toHaveBeenCalledOnce();
    await expect(
      verifier.resolveForPublication(
        owner.toString(),
        [rows[0].referencia],
        new Types.ObjectId().toString(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects absent, foreign, incomplete, expired and duplicate references', async () => {
    const { verifier, rows } = verifierSetup();
    const id = post.toString();
    for (const refs of [
      ['absent-reference'],
      [rows[0].referencia, rows[0].referencia],
      Array(11).fill('x'),
    ]) {
      await expect(
        verifier.resolveForPublication(owner.toString(), refs, id),
      ).rejects.toMatchObject({ status: 422 });
    }
    await expect(
      verifier.resolveForPublication(
        other.toString(),
        [rows[0].referencia],
        id,
      ),
    ).rejects.toMatchObject({ status: 422 });
    rows[0].estado = 'recebendo';
    await expect(
      verifier.resolveForPublication(
        owner.toString(),
        [rows[0].referencia],
        id,
      ),
    ).rejects.toMatchObject({ status: 422 });
    rows[0].estado = 'pronta';
    rows[0].expira_em = new Date(0);
    await expect(
      verifier.resolveForPublication(
        owner.toString(),
        [rows[0].referencia],
        id,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('releases earlier reservations after a missing or inconsistent S3 object', async () => {
    const { verifier, rows, storage } = verifierSetup();
    storage.head.mockResolvedValueOnce(null);
    await expect(
      verifier.resolveForPublication(
        owner.toString(),
        [rows[0].referencia],
        post.toString(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(rows[0].estado).toBe('pronta');
    storage.head.mockResolvedValueOnce({ ...expectedHead, ContentLength: 99 });
    await expect(
      verifier.resolveForPublication(
        owner.toString(),
        [rows[0].referencia],
        post.toString(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(rows[0].estado).toBe('pronta');
  });

  it('releases a verified first reference when a later reference is unavailable', async () => {
    const first = record();
    const second = record({
      referencia: 'second-reference-123',
      estado: 'recebendo',
    });
    const { verifier, rows } = verifierSetup([first, second]);
    await expect(
      verifier.resolveForPublication(
        owner.toString(),
        [first.referencia, second.referencia],
        post.toString(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(rows[0].estado).toBe('pronta');
    expect(rows[0].publicacao_id).toBeNull();
  });

  it('preserves linked media when a publication already exists', async () => {
    const { verifier, rows, publications } = verifierSetup();
    await verifier.resolveForPublication(
      owner.toString(),
      [rows[0].referencia],
      post.toString(),
    );
    await verifier.confirmForPublication(post.toString(), [rows[0].referencia]);
    publications.exists.mockReturnValue(query({ _id: post }));
    await verifier.releaseForPublication(post.toString(), [rows[0].referencia]);
    expect(rows[0].estado).toBe('vinculada');
  });

  it('removes temporary expiry only after a reference is linked to its publication', async () => {
    const { verifier, rows, uploads } = verifierSetup();
    await verifier.resolveForPublication(
      owner.toString(),
      [rows[0].referencia],
      post.toString(),
    );
    await verifier.confirmForPublication(post.toString(), [rows[0].referencia]);
    await verifier.finalizeForPublication(post.toString(), [
      rows[0].referencia,
    ]);
    expect(rows[0].expira_em).toBeNull();
    expect(uploads.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ estado: 'vinculada', publicacao_id: post }),
      { $set: { expira_em: null } },
    );
  });

  it('returns 503 when S3 is unavailable and releases the reservation', async () => {
    const { verifier, rows, storage } = verifierSetup();
    storage.head.mockRejectedValueOnce({ status: 503 });
    await expect(
      verifier.resolveForPublication(
        owner.toString(),
        [rows[0].referencia],
        post.toString(),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(rows[0].estado).toBe('pronta');
  });
});

describe('MediaUploadService', () => {
  const file = { buffer: Buffer.alloc(100), size: 100, mimetype: 'image/png' };
  function setup() {
    const saved = record({ estado: 'recebendo' });
    const uploads = {
      create: vi.fn().mockResolvedValue(saved),
      findOneAndUpdate: vi
        .fn()
        .mockImplementation((_filter, update) =>
          query({ ...saved, ...update.$set }),
        ),
      deleteOne: vi.fn().mockReturnValue(query({ deletedCount: 1 })),
    };
    const inspection = {
      inspect: vi.fn().mockResolvedValue({
        tipo: 'imagem',
        mime_type: 'image/png',
        tamanho_bytes: 100,
        largura: 2,
        altura: 2,
        duracao_segundos: null,
      }),
    };
    const storage = {
      publicUrl: vi.fn().mockReturnValue('https://api.example.test/media'),
      put: vi.fn().mockResolvedValue(undefined),
      head: vi.fn().mockImplementation(() =>
        Promise.resolve({
          ...expectedHead,
          Metadata: { sha256: storage.put.mock.calls[0][3] },
        }),
      ),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const service = new MediaUploadService(
      uploads as unknown as Model<UploadMedia>,
      inspection as unknown as MediaInspectionService,
      storage as unknown as MediaStorageService,
    );
    return { service, uploads, inspection, storage };
  }

  it('stores verified bytes under a server generated key before returning an opaque reference', async () => {
    const { service, uploads, storage } = setup();
    const result = await service.upload(owner.toString(), file);
    expect(result.referencia).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(result).not.toHaveProperty('chave_storage');
    expect(uploads.create.mock.calls[0][0]).toMatchObject({
      estado: 'recebendo',
      usuario_id: owner,
      tamanho_bytes: 100,
    });
    expect(storage.put.mock.calls[0][0]).toMatch(
      /^uploads\/[a-f0-9]{24}\/[a-f0-9-]{36}$/,
    );
    expect(storage.head).toHaveBeenCalledOnce();
    expect(uploads.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ estado: 'recebendo' }),
      { $set: { estado: 'pronta' } },
      { new: true },
    );
  });

  it('does not approve an upload when S3 fails', async () => {
    const { service, storage, uploads } = setup();
    storage.put.mockRejectedValueOnce({ status: 503 });
    await expect(service.upload(owner.toString(), file)).rejects.toMatchObject({
      status: 503,
    });
    expect(uploads.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ estado: 'recebendo' }),
      { $set: { estado: 'excluindo' } },
      { new: true },
    );
    expect(storage.remove).toHaveBeenCalledOnce();
  });

  it('rejects missing, mismatched or invalid file data before creating a record', async () => {
    const { service, uploads, inspection } = setup();
    await expect(service.upload(owner.toString())).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      service.upload(owner.toString(), { ...file, size: 99 }),
    ).rejects.toMatchObject({ status: 422 });
    inspection.inspect.mockRejectedValueOnce({ status: 422 });
    await expect(service.upload(owner.toString(), file)).rejects.toMatchObject({
      status: 422,
    });
    expect(uploads.create).not.toHaveBeenCalled();
  });
});

describe('MediaAccessService', () => {
  function setup(visibility: 'publico' | 'seguidores') {
    const media = record({ estado: 'vinculada', publicacao_id: post });
    const uploads = { findOne: vi.fn().mockReturnValue(query(media)) };
    const publications = {
      findOne: vi.fn((filter: { $or: Array<Record<string, unknown>> }) =>
        query(
          visibility === 'publico' ||
            filter.$or.some(
              (clause) =>
                'autor_id' in clause &&
                (clause.autor_id as Types.ObjectId).equals(owner),
            )
            ? { _id: post, visibilidade: visibility }
            : null,
        ),
      ),
    };
    const storage = {
      get: vi.fn().mockResolvedValue({
        ...expectedHead,
        Body: Readable.from(Buffer.alloc(100)),
      }),
    };
    const service = new MediaAccessService(
      uploads as unknown as Model<UploadMedia>,
      publications as unknown as Model<Publicacao>,
      storage as unknown as MediaStorageService,
    );
    return { service, storage, uploads, publications };
  }

  it('streams public media without credentials', async () => {
    const { service } = setup('publico');
    await expect(service.open('valid-reference-123')).resolves.toMatchObject({
      mimeType: 'image/png',
      size: 100,
    });
  });

  it('allows only the author to read restricted media', async () => {
    const { service, storage } = setup('seguidores');
    await expect(service.open('valid-reference-123')).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.open('valid-reference-123', other.toString()),
    ).rejects.toMatchObject({ status: 404 });
    expect(storage.get).not.toHaveBeenCalled();
    await expect(
      service.open('valid-reference-123', owner.toString()),
    ).resolves.toMatchObject({ mimeType: 'image/png' });
  });

  it('does not expose incomplete or absent objects', async () => {
    const { service, uploads, storage } = setup('publico');
    uploads.findOne.mockReturnValueOnce(query(null));
    await expect(service.open('valid-reference-123')).rejects.toMatchObject({
      status: 404,
    });
    storage.get.mockResolvedValueOnce(null);
    await expect(service.open('valid-reference-123')).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe('video byte ranges', () => {
  it.each([
    ['bytes=0-9', { start: 0, end: 9 }],
    ['bytes=10-19', { start: 10, end: 19 }],
    ['bytes=90-', { start: 90, end: 99 }],
    ['bytes=-10', { start: 90, end: 99 }],
    ['bytes=-200', { start: 0, end: 99 }],
    ['bytes=0-999', { start: 0, end: 99 }],
  ] as const)('parses %s', (header, expected) => {
    expect(parseMediaRange(header, 100)).toEqual(expected);
  });

  it.each([
    'bytes=100-',
    'bytes=20-10',
    'bytes=-0',
    'bytes=abc',
    'bytes=-',
    'items=0-10',
  ])('rejects unsatisfiable %s with the resource size', (header) => {
    expect(() => parseMediaRange(header, 100)).toThrow(UnsatisfiableMediaRange);
  });

  it('ignores multi-range requests and serves the complete representation', async () => {
    expect(parseMediaRange('bytes=0-1,4-5', 100)).toBeNull();
  });

  it('authorizes before requesting only the specified bytes from S3', async () => {
    const media = record({
      estado: 'vinculada',
      publicacao_id: post,
      tipo: 'video',
      mime_type: 'video/mp4',
    });
    const uploads = { findOne: vi.fn().mockReturnValue(query(media)) };
    const publications = {
      findOne: vi
        .fn()
        .mockReturnValue(query({ _id: post, status: 'publicada' })),
    };
    const storage = {
      get: vi.fn((_key: string, range?: { start: number; end: number }) =>
        Promise.resolve({
          ContentType: 'video/mp4',
          ContentLength: range ? range.end - range.start + 1 : 100,
          ContentRange: range
            ? `bytes ${range.start}-${range.end}/100`
            : undefined,
          Metadata: expectedHead.Metadata,
          Body: Readable.from(
            Buffer.alloc(range ? range.end - range.start + 1 : 100),
          ),
        }),
      ),
    };
    const service = new MediaAccessService(
      uploads as unknown as Model<UploadMedia>,
      publications as unknown as Model<Publicacao>,
      storage as unknown as MediaStorageService,
    );
    for (const header of [
      'bytes=0-9',
      'bytes=10-19',
      'bytes=90-',
      'bytes=-10',
    ]) {
      const result = await service.open(media.referencia, undefined, header);
      expect(result.length).toBe(10);
      expect(result.range).toEqual(parseMediaRange(header, 100));
      expect(storage.get).toHaveBeenLastCalledWith(
        media.chave_storage,
        result.range,
      );
    }
    await expect(
      service.open(media.referencia, undefined, 'bytes=100-'),
    ).rejects.toBeInstanceOf(UnsatisfiableMediaRange);
    expect(storage.get).toHaveBeenCalledTimes(4);
    await expect(
      service.open(media.referencia, undefined),
    ).resolves.toMatchObject({ length: 100, range: null });
    await service.open(media.referencia, undefined, 'bytes=0-1,4-5');
    expect(storage.get).toHaveBeenLastCalledWith(
      media.chave_storage,
      undefined,
    );
    storage.get.mockResolvedValueOnce(null as never);
    await expect(
      service.open(media.referencia, undefined, 'bytes=0-9'),
    ).rejects.toMatchObject({ status: 503 });
    publications.findOne.mockReturnValueOnce(query(null));
    await expect(
      service.open(media.referencia, undefined, 'bytes=0-9'),
    ).rejects.toMatchObject({ status: 404 });
    expect(storage.get).toHaveBeenCalledTimes(7);
  });
});

describe('MediaCleanupService', () => {
  it('removes expired unlinked objects but preserves media referenced by a publication', async () => {
    const orphan = record({ estado: 'excluindo', expira_em: new Date(0) });
    const linked = record({
      chave_storage: 'uploads/linked',
      estado: 'vinculada',
      publicacao_id: post,
      expira_em: new Date(0),
    });
    const uploads = {
      find: vi.fn().mockReturnValue({
        sort: vi
          .fn()
          .mockReturnValue({
            limit: vi.fn().mockReturnValue(query([orphan, linked])),
          }),
      }),
      findOneAndUpdate: vi.fn().mockReturnValue(query(orphan)),
      updateOne: vi.fn().mockReturnValue(query({ modifiedCount: 1 })),
      deleteOne: vi.fn().mockReturnValue(query({ deletedCount: 1 })),
    };
    const publications = {
      exists: vi.fn().mockReturnValue(query({ _id: post })),
      deleteOne: vi.fn().mockReturnValue(query({ deletedCount: 0 })),
    };
    const storage = { remove: vi.fn().mockResolvedValue(undefined) };
    const service = new MediaCleanupService(
      uploads as unknown as Model<UploadMedia>,
      publications as unknown as Model<Publicacao>,
      storage as unknown as MediaStorageService,
    );
    await expect(service.cleanupExpired()).resolves.toBe(1);
    expect(storage.remove).toHaveBeenCalledOnce();
    expect(storage.remove).toHaveBeenCalledWith(orphan.chave_storage);
    expect(uploads.deleteOne).toHaveBeenCalledOnce();
  });

  it('retains cleanup state for retry when storage is unavailable', async () => {
    const orphan = record({ estado: 'excluindo', expira_em: new Date(0) });
    const uploads = {
      find: vi
        .fn()
        .mockReturnValue({
          sort: vi
            .fn()
            .mockReturnValue({
              limit: vi.fn().mockReturnValue(query([orphan])),
            }),
        }),
      findOneAndUpdate: vi.fn().mockReturnValue(query(orphan)),
      deleteOne: vi.fn(),
    };
    const publications = { exists: vi.fn() };
    const storage = { remove: vi.fn().mockRejectedValue({ status: 503 }) };
    const service = new MediaCleanupService(
      uploads as unknown as Model<UploadMedia>,
      publications as unknown as Model<Publicacao>,
      storage as unknown as MediaStorageService,
    );
    await expect(service.cleanupExpired()).resolves.toBe(0);
    expect(uploads.deleteOne).not.toHaveBeenCalled();
  });
});
