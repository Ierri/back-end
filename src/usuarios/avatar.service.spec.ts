import { Readable } from 'node:stream';
import sharp from 'sharp';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { MediaInspectionService } from '../publicacoes/media-inspection.service.js';
import { MediaStorageService } from '../publicacoes/media-storage.service.js';
import { PublicacoesCacheService } from '../publicacoes/publicacoes-cache.service.js';
import { VideoProbeService } from '../publicacoes/video-probe.service.js';
import { AvatarService } from './avatar.service.js';
import { AvatarArquivo } from './schemas/avatar-arquivo.schema.js';
import { Usuario } from './schemas/usuario.schema.js';

const userId = new Types.ObjectId();

function query(value: () => unknown) {
  const result = { exec: vi.fn(async () => value()), select: vi.fn(), lean: vi.fn(),
    sort: vi.fn(), limit: vi.fn() };
  for (const name of ['select', 'lean', 'sort', 'limit'] as const) result[name].mockReturnValue(result);
  return result;
}

async function image(format: 'png' | 'jpeg' | 'webp', width = 128, height = 128) {
  return sharp({ create: { width, height, channels: 4, background: '#d03855' } })
    .toFormat(format).toBuffer();
}

function setup() {
  const current = { _id: userId, status: 'ativo', avatar_url: null as string | null,
    avatar_atual: null as Usuario['avatar_atual'], avatar_revisao: 0 };
  const records: (AvatarArquivo & { _id: Types.ObjectId })[] = [];
  const objects = new Map<string, { body: Buffer; mime: string; hash: string }>();
  let failCas = false;
  const users = {
    findOne: vi.fn(() => query(() => current.status === 'ativo' ? { ...current } : null)),
    findById: vi.fn(() => query(() => current)),
    findOneAndUpdate: vi.fn((_filter: unknown, update: { $set: Record<string, unknown> }) =>
      query(() => {
        if (failCas) return null;
        current.avatar_atual = update.$set.avatar_atual as Usuario['avatar_atual'];
        current.avatar_url = update.$set.avatar_url as string | null;
        current.avatar_revisao++;
        return current;
      })),
  };
  const files = {
    create: vi.fn(async (data: Pick<AvatarArquivo, 'usuario_id' | 'referencia' |
      'chave_storage' | 'estado'>) => {
      const record = { ...data, _id: new Types.ObjectId(), criado_em: new Date(),
        atualizado_em: new Date() };
      records.push(record);
      return record;
    }),
    updateOne: vi.fn((filter: { _id: Types.ObjectId; estado?: AvatarArquivo['estado'] },
      update: { $set: { estado: AvatarArquivo['estado'] } }) =>
      query(() => { const record = records.find((item) => item._id.equals(filter._id) &&
        (!filter.estado || item.estado === filter.estado));
        if (record) record.estado = update.$set.estado;
        return { modifiedCount: record ? 1 : 0 }; })),
    findOneAndUpdate: vi.fn((filter: { _id?: Types.ObjectId; referencia?: string },
      update: { $set: { estado: AvatarArquivo['estado'] } }) => query(() => {
      const record = records.find((item) => filter._id?.equals(item._id) ||
        filter.referencia === item.referencia);
      if (record) record.estado = update.$set.estado;
      return record ?? null;
    })),
    find: vi.fn((filter: { estado: string | { $in: string[] }; _id?: { $gt: Types.ObjectId } }) =>
      query(() => records.filter((item) => (typeof filter.estado === 'string'
        ? item.estado === filter.estado : filter.estado.$in.includes(item.estado)) &&
        (!filter._id || item._id.toString() > filter._id.$gt.toString())))),
    deleteOne: vi.fn((filter: { _id: Types.ObjectId }) => query(() => {
      const index = records.findIndex((item) => item._id.equals(filter._id));
      if (index >= 0) records.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    })),
  };
  const storage = {
    avatarUrl: vi.fn((id: string, reference: string) =>
      `http://127.0.0.1:3001/usuarios/${id}/avatar/${reference}`),
    put: vi.fn(async (key: string, body: Buffer, mime: string, hash: string) => {
      objects.set(key, { body, mime, hash });
    }),
    head: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object ? { ContentLength: object.body.length, ContentType: object.mime,
        Metadata: { sha256: object.hash } } : null;
    }),
    get: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object ? { Body: Readable.from(object.body), ContentLength: object.body.length,
        ContentType: object.mime, Metadata: { sha256: object.hash } } : null;
    }),
    remove: vi.fn(async (key: string) => { objects.delete(key); }),
  };
  const cache = { invalidateAuthor: vi.fn().mockResolvedValue(true) };
  const inspection = new MediaInspectionService({} as VideoProbeService);
  const service = new AvatarService(users as unknown as Model<Usuario>,
    files as unknown as Model<AvatarArquivo>, inspection,
    storage as unknown as MediaStorageService, cache as unknown as PublicacoesCacheService);
  return { service, users, files, storage, cache, current, records, objects,
    setFailCas: (value: boolean) => { failCas = value; } };
}

describe('AvatarService', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('uploads a real %s image and verifies storage', async (format) => {
    const { service, storage, current, records } = setup();
    const buffer = await image(format);
    const mime = `image/${format}`;
    const result = await service.upload(userId.toString(), { buffer, mimetype: mime, size: buffer.length });
    expect(result).toMatchObject({ mimeType: mime, largura: 128, altura: 128,
      tamanhoBytes: buffer.length });
    expect(result.avatarUrl).toContain(`/usuarios/${userId.toString()}/avatar/`);
    expect(current.avatar_atual?.referencia).toBe(records[0].referencia);
    expect(records[0].chave_storage).toMatch(new RegExp(`^avatars/${userId.toString()}/`));
    expect(storage.head).toHaveBeenCalledOnce();
  });

  it('rejects corrupt, unsupported, small and oversized images before storage', async () => {
    const { service, storage, records } = setup();
    const small = await image('png', 127, 128);
    const large = await image('png', 4097, 128);
    const valid = await image('png');
    const animated = Buffer.from('UklGRigBAABXRUJQVlA4WAoAAAACAAAAfwAAfwAAQU5JTQYAAAD/////AABBTk1GhAAAAAAAAAAAAH8AAH8AAGQAAAJWUDggbAAAANAGAJ0BKoAAgAA+kUihTKWkIyIgiACwEglpbuF0oP2cAABPhBptsReIKjntiLxBUc9sReIKjntiLxBUc9sQ8AD+/mBr//wG6+LaZf/+5wP+5wP+5wP422tSUoxQ/Hq6NJopbS6klaKiQgAAAEFOTUZwAAAAAAAAAAAAfwAAfwAAZAAAAFZQOCBYAAAA9AUAnQEqgACAAD6RQplMgggAASCWlu4XSQAFBYc44ux4NitsjnYF8Vtkc7AvitsjnYF8Vtkc6MAA/v7/h///ucD//ZwP/9nA/jr/9eqWuTqgeCYigAAAAA==', 'base64');
    for (const file of [
      { buffer: small, mimetype: 'image/png', size: small.length },
      { buffer: large, mimetype: 'image/png', size: large.length },
      { buffer: valid, mimetype: 'image/jpeg', size: valid.length },
      { buffer: animated, mimetype: 'image/webp', size: animated.length },
      { buffer: Buffer.from('<svg/>'), mimetype: 'image/svg+xml', size: 6 },
      { buffer: Buffer.from('broken'), mimetype: 'image/png', size: 6 },
      { buffer: Buffer.alloc(5_000_001), mimetype: 'image/png', size: 5_000_001 },
    ]) await expect(service.upload(userId.toString(), file)).rejects.toMatchObject({ status: 422 });
    expect(storage.put).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
  });

  it('preserves the prior avatar when storage fails', async () => {
    const { service, storage, current } = setup();
    const buffer = await image('png');
    await service.upload(userId.toString(), { buffer, mimetype: 'image/png', size: buffer.length });
    const old = current.avatar_atual?.referencia;
    storage.put.mockRejectedValueOnce(new Error('S3 unavailable'));
    await expect(service.upload(userId.toString(), { buffer, mimetype: 'image/png', size: buffer.length }))
      .rejects.toThrow('S3 unavailable');
    expect(current.avatar_atual?.referencia).toBe(old);
  });

  it('preserves the prior avatar when the optimistic update loses a race', async () => {
    const { service, current, records, objects, setFailCas } = setup();
    const buffer = await image('png');
    await service.upload(userId.toString(), { buffer, mimetype: 'image/png', size: buffer.length });
    const old = current.avatar_atual?.referencia;
    setFailCas(true);
    await expect(service.upload(userId.toString(), { buffer, mimetype: 'image/png', size: buffer.length }))
      .rejects.toMatchObject({ status: 409 });
    expect(current.avatar_atual?.referencia).toBe(old);
    expect(records[1].estado).toBe('preparando');
    records[1].criado_em = new Date(Date.now() - 31 * 60_000);
    await service.recoverBatch();
    expect(objects.size).toBe(1);
  });

  it('replaces the active reference and rejects access through the previous one', async () => {
    const { service, current, objects } = setup();
    const buffer = await image('png');
    const first = await service.upload(userId.toString(), { buffer, mimetype: 'image/png', size: buffer.length });
    const old = current.avatar_atual?.referencia;
    const second = await service.upload(userId.toString(), { buffer, mimetype: 'image/png', size: buffer.length });
    expect(second.avatarUrl).not.toBe(first.avatarUrl);
    await expect(service.open(userId.toString(), old!)).rejects.toMatchObject({ status: 404 });
    expect(objects.size).toBe(1);
  });

  it('releases the custom file when a static avatar is selected or cleared', async () => {
    const { service, current, objects, records, storage, cache } = setup();
    const buffer = await image('png');
    await service.upload(userId.toString(), { buffer, mimetype: 'image/png', size: buffer.length });
    const first = current.avatar_atual!.referencia;
    const staticUrl = '/brand/ierri/social/github-avatar-512.png';
    await service.updateProfile(userId.toString(), {}, staticUrl);
    expect(current.avatar_url).toBe(staticUrl);
    expect(current.avatar_atual).toBeNull();
    expect(records).toHaveLength(0);
    expect(storage.remove).toHaveBeenCalled();
    expect(objects.size).toBe(0);
    await expect(service.open(userId.toString(), first)).rejects.toMatchObject({ status: 404 });
    await service.upload(userId.toString(), { buffer, mimetype: 'image/png', size: buffer.length });
    await service.updateProfile(userId.toString(), {}, null);
    expect(current.avatar_url).toBeNull();
    expect(objects.size).toBe(0);
    expect(cache.invalidateAuthor).toHaveBeenCalledTimes(4);
  });

  it('serves only an active account and removes the avatar idempotently', async () => {
    const { service, current } = setup();
    const buffer = await image('png');
    await service.upload(userId.toString(), { buffer, mimetype: 'image/png', size: buffer.length });
    const reference = current.avatar_atual!.referencia;
    expect((await service.open(userId.toString(), reference)).mimeType).toBe('image/png');
    current.status = 'bloqueado';
    await expect(service.open(userId.toString(), reference)).rejects.toMatchObject({ status: 404 });
    current.status = 'ativo';
    await expect(service.remove(userId.toString())).resolves.toEqual({ avatarUrl: null });
    await expect(service.remove(userId.toString())).resolves.toEqual({ avatarUrl: null });
    await expect(service.open(userId.toString(), reference)).rejects.toMatchObject({ status: 404 });
  });

  it('keeps the prior avatar when the account becomes inactive before the update', async () => {
    const { service, current, records, objects } = setup();
    const buffer = await image('png');
    await service.upload(userId.toString(), { buffer, mimetype: 'image/png', size: buffer.length });
    const previous = current.avatar_atual?.referencia;
    current.status = 'bloqueado';
    await expect(service.upload(userId.toString(), { buffer, mimetype: 'image/png', size: buffer.length }))
      .rejects.toMatchObject({ status: 404 });
    expect(current.avatar_atual?.referencia).toBe(previous);
    expect(records[1].estado).toBe('preparando');
    records[1].criado_em = new Date(Date.now() - 31 * 60_000);
    await service.recoverBatch();
    expect(objects.size).toBe(1);
  });

  it('retries deletion after a storage failure without removing the active avatar', async () => {
    const { service, storage, records, objects, cache } = setup();
    const buffer = await image('png');
    await service.upload(userId.toString(), { buffer, mimetype: 'image/png', size: buffer.length });
    const previousKey = records[0].chave_storage;
    storage.remove.mockRejectedValueOnce(new Error('storage unavailable'));
    await service.upload(userId.toString(), { buffer, mimetype: 'image/png', size: buffer.length });
    expect(objects.has(previousKey)).toBe(true);
    expect(records.find((record) => record.chave_storage === previousKey)?.estado).toBe('excluindo');
    await service.recoverBatch();
    expect(objects.has(previousKey)).toBe(false);
    expect(objects.size).toBe(1);
    expect(cache.invalidateAuthor).toHaveBeenCalledTimes(2);
  });

  it('cleans an orphaned prepared object after the lease and leaves the active file', async () => {
    const { service, files, records, storage, objects } = setup();
    const buffer = await image('png');
    await service.upload(userId.toString(), { buffer, mimetype: 'image/png', size: buffer.length });
    const orphan = { _id: new Types.ObjectId(), usuario_id: userId, referencia: 'o'.repeat(32),
      chave_storage: `avatars/${userId.toString()}/orphan`, estado: 'preparando' as const,
      criado_em: new Date(Date.now() - 31 * 60_000), atualizado_em: new Date() };
    records.push(orphan);
    objects.set(orphan.chave_storage, { body: buffer, mime: 'image/png', hash: 'hash' });
    await service.recoverBatch();
    expect(storage.remove).toHaveBeenCalledWith(orphan.chave_storage);
    expect(files.deleteOne).toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(objects.size).toBe(1);
  });
});
