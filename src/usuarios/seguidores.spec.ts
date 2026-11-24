import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { Seguidor } from './schemas/seguidor.schema.js';
import { Usuario } from './schemas/usuario.schema.js';
import { SeguidoresCursor } from './seguidores.cursor.js';
import { SeguidoresService } from './seguidores.service.js';
import { seguidorUserIdSchema } from './dto/seguidores.dto.js';

const actorId = new Types.ObjectId().toString();
const targetId = new Types.ObjectId().toString();
const relationId = new Types.ObjectId().toString();

function query<T>(value: T) {
  const result = { exec: vi.fn().mockResolvedValue(value), select: vi.fn(), lean: vi.fn(), sort: vi.fn(), limit: vi.fn() };
  result.select.mockReturnValue(result);
  result.lean.mockReturnValue(result);
  result.sort.mockReturnValue(result);
  result.limit.mockReturnValue(result);
  return result;
}

function setup() {
  const users = {
    findOne: vi.fn().mockReturnValue(query({ _id: new Types.ObjectId(targetId), visibilidade_perfil: 'publico' })),
    findById: vi.fn(),
    find: vi.fn(),
    updateOne: vi.fn(),
    exists: vi.fn().mockResolvedValue({ _id: new Types.ObjectId(targetId) }),
  };
  const followers = {
    findOne: vi.fn().mockReturnValue(query(null)),
    findOneAndUpdate: vi.fn(),
    findById: vi.fn(),
    find: vi.fn(),
    create: vi.fn(),
    deleteOne: vi.fn(),
    exists: vi.fn(),
    countDocuments: vi.fn(),
  };
  const service = new SeguidoresService(
    followers as unknown as Model<Seguidor>,
    users as unknown as Model<Usuario>,
    {} as SeguidoresCursor,
  );
  const counts = vi.spyOn(service, 'counts').mockResolvedValue({ seguidores: 1, seguindo: 1 });
  return { service, users, followers, counts };
}

describe('SeguidoresService', () => {
  it('uses the unique pair and recovers a persisted follow after an ambiguous create error', async () => {
    const { service, followers } = setup();
    const persisted = { status: 'aceito', seguidor_id: new Types.ObjectId(actorId), seguido_id: new Types.ObjectId(targetId) };
    followers.findOne.mockReturnValueOnce(query(null)).mockReturnValueOnce(query(persisted));
    followers.create.mockRejectedValueOnce(new Error('response lost'));
    await expect(service.follow(actorId, targetId)).resolves.toMatchObject({ estado: 'aceita' });
    expect(followers.create).toHaveBeenCalledWith(expect.objectContaining({
      seguidor_id: new Types.ObjectId(actorId),
      seguido_id: new Types.ObjectId(targetId),
      status: 'aceito',
    }));
    expect(followers.create).toHaveBeenCalledTimes(1);
  });

  it('does not create a second relation for a repeated pending follow', async () => {
    const { service, users, followers } = setup();
    users.findOne.mockReturnValue(query({ _id: new Types.ObjectId(targetId), visibilidade_perfil: 'privado' }));
    followers.findOne.mockReturnValue(query({ status: 'pendente' }));
    await expect(service.follow(actorId, targetId)).resolves.toMatchObject({ estado: 'pendente' });
    expect(followers.create).not.toHaveBeenCalled();
  });

  it('omits the target follower total after a private follow and still reconciles both accounts', async () => {
    const { service, users, followers, counts } = setup();
    users.findOne.mockReturnValue(query({ _id: new Types.ObjectId(targetId), visibilidade_perfil: 'privado' }));
    users.exists.mockResolvedValue(null);
    followers.findOne.mockReturnValue(query({ status: 'pendente' }));
    counts.mockResolvedValueOnce({ seguidores: 2, seguindo: 3 })
      .mockResolvedValueOnce({ seguidores: 7, seguindo: 4 });
    await expect(service.follow(actorId, targetId)).resolves.toEqual({
      estado: 'pendente',
      contadores: { seguindo: 3 },
    });
    expect(counts).toHaveBeenCalledTimes(2);
    expect(users.exists).toHaveBeenCalledWith({
      _id: targetId,
      status: 'ativo',
      visibilidade_perfil: { $ne: 'privado' },
    });
  });

  it('hides a target that became private before a public follow response', async () => {
    const { service, users, followers } = setup();
    followers.findOne.mockReturnValue(query(null));
    followers.create.mockResolvedValue({ status: 'aceito' });
    users.exists.mockResolvedValue(null);
    await expect(service.follow(actorId, targetId)).resolves.toEqual({
      estado: 'aceita',
      contadores: { seguindo: 1 },
    });
  });

  it('preserves both public counters in a follow response', async () => {
    const { service, followers } = setup();
    followers.findOne.mockReturnValue(query({ status: 'aceito' }));
    await expect(service.follow(actorId, targetId)).resolves.toEqual({
      estado: 'aceita',
      contadores: { seguidores: 1, seguindo: 1 },
    });
  });

  it('omits the private target total when a request is cancelled', async () => {
    const { service, users, followers } = setup();
    followers.deleteOne.mockReturnValue(query({ deletedCount: 1 }));
    users.exists.mockResolvedValue(null);
    await expect(service.unfollow(actorId, targetId)).resolves.toEqual({
      estado: 'nenhuma',
      contadores: { seguindo: 1 },
    });
  });

  it('accepts only a pending request addressed to the actor', async () => {
    const { service, followers } = setup();
    const pending = { _id: new Types.ObjectId(relationId), seguidor_id: new Types.ObjectId(actorId), seguido_id: new Types.ObjectId(targetId), status: 'pendente' };
    followers.findOne.mockReturnValue(query(pending));
    followers.findOneAndUpdate.mockReturnValue(query({ ...pending, status: 'aceito' }));
    await expect(service.accept(targetId, relationId)).resolves.toMatchObject({ estado: 'aceita' });
    expect(followers.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: new Types.ObjectId(relationId), seguido_id: new Types.ObjectId(targetId), status: 'pendente' }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'aceito' }) }),
      expect.any(Object),
    );
  });

  it('returns the private recipient own counters after acceptance, without the sender following total', async () => {
    const { service, users, followers, counts } = setup();
    const pending = {
      _id: new Types.ObjectId(relationId),
      seguidor_id: new Types.ObjectId(actorId),
      seguido_id: new Types.ObjectId(targetId),
      status: 'pendente',
    };
    followers.findOne.mockReturnValue(query(pending));
    followers.findOneAndUpdate.mockReturnValue(query({ ...pending, status: 'aceito' }));
    counts.mockResolvedValueOnce({ seguidores: 2, seguindo: 9 })
      .mockResolvedValueOnce({ seguidores: 5, seguindo: 3 });
    users.exists.mockResolvedValue(null);
    await expect(service.accept(targetId, relationId)).resolves.toEqual({
      estado: 'aceita',
      contadores: { seguidores: 5, seguindo: 3 },
    });
    expect(counts).toHaveBeenCalledTimes(2);
    expect(users.exists).not.toHaveBeenCalled();
  });

  it('recovers acceptance after a response is lost without accepting twice', async () => {
    const { service, followers } = setup();
    const accepted = { _id: new Types.ObjectId(relationId), seguidor_id: new Types.ObjectId(actorId), seguido_id: new Types.ObjectId(targetId), status: 'aceito' };
    followers.findOne.mockReturnValueOnce(query(null)).mockReturnValueOnce(query(accepted));
    followers.findOneAndUpdate.mockReturnValue(query(null));
    await expect(service.accept(targetId, relationId)).resolves.toMatchObject({ estado: 'aceita' });
    expect(followers.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not claim a declined request was removed when acceptance won the race', async () => {
    const { service, followers } = setup();
    followers.findOne.mockReturnValue(query({ status: 'pendente' }));
    followers.deleteOne.mockReturnValue(query({ deletedCount: 0 }));
    followers.findById.mockReturnValue(query({ status: 'aceito' }));
    await expect(service.decline(targetId, relationId)).rejects.toMatchObject({ status: 404 });
  });

  it('recovers an ambiguous cancellation only when the pair is absent', async () => {
    const { service, followers } = setup();
    followers.deleteOne.mockReturnValue({ exec: vi.fn().mockRejectedValue(new Error('response lost')) });
    followers.exists.mockResolvedValue(null);
    await expect(service.unfollow(actorId, targetId)).resolves.toMatchObject({ estado: 'nenhuma' });
    followers.exists.mockResolvedValue(new Types.ObjectId());
    await expect(service.unfollow(actorId, targetId)).rejects.toBeInstanceOf(ApiException);
  });

  it('reuses a persisted relation after the second counter read fails', async () => {
    const { service, followers, counts } = setup();
    const persisted = {
      status: 'aceito' as const,
      seguidor_id: new Types.ObjectId(actorId),
      seguido_id: new Types.ObjectId(targetId),
    };
    followers.findOne.mockReturnValueOnce(query(null)).mockReturnValueOnce(query(persisted));
    followers.create.mockResolvedValue(persisted);
    counts.mockResolvedValueOnce({ seguidores: 0, seguindo: 1 })
      .mockRejectedValueOnce(new ApiException('SEGUIDOR_WRITE_UNAVAILABLE'))
      .mockResolvedValueOnce({ seguidores: 0, seguindo: 1 })
      .mockResolvedValueOnce({ seguidores: 1, seguindo: 0 });
    await expect(service.follow(actorId, targetId)).rejects.toBeInstanceOf(ApiException);
    await expect(service.follow(actorId, targetId)).resolves.toMatchObject({
      estado: 'aceita',
      contadores: { seguidores: 1, seguindo: 1 },
    });
    expect(followers.create).toHaveBeenCalledTimes(1);
  });

  it('rejects self-follow before querying either collection', async () => {
    const { service, users, followers } = setup();
    await expect(service.follow(actorId, actorId)).rejects.toMatchObject({ status: 422 });
    expect(users.findOne).not.toHaveBeenCalled();
    expect(followers.findOne).not.toHaveBeenCalled();
  });

  it('normalizes uppercase identifiers before the self-follow check', () => {
    expect(seguidorUserIdSchema.parse(actorId.toUpperCase())).toBe(actorId);
  });

  it('recounts after a concurrent projection update defeats the first compare-and-set', async () => {
    const { service, users, followers, counts } = setup();
    followers.countDocuments = vi.fn()
      .mockReturnValueOnce(query(1))
      .mockReturnValueOnce(query(1))
      .mockReturnValueOnce(query(2))
      .mockReturnValueOnce(query(2))
      .mockReturnValueOnce(query(2))
      .mockReturnValueOnce(query(2));
    users.findById = vi.fn()
      .mockReturnValueOnce(query({ contadores: { seguidores: 0, seguindo: 0 } }))
      .mockReturnValueOnce(query({ contadores: { seguidores: 1, seguindo: 1 } }));
    users.updateOne = vi.fn()
      .mockReturnValueOnce(query({ modifiedCount: 0 }))
      .mockReturnValueOnce(query({ modifiedCount: 1 }));
    counts.mockRestore();
    await expect(service.counts(actorId)).resolves.toEqual({ seguidores: 2, seguindo: 2 });
    expect(users.updateOne).toHaveBeenCalledTimes(2);
    expect(users.updateOne.mock.calls[1][1]).toEqual({ $set: {
      'contadores.seguidores': 2,
      'contadores.seguindo': 2,
    } });
    expect(users.updateOne.mock.calls[1][2]).toEqual({ runValidators: true, timestamps: false });
  });

  it('reads the projected revision before counting and leaves a newer matching projection intact', async () => {
    const { service, users, followers, counts } = setup();
    users.findById.mockReturnValue(query({ contadores: { seguidores: 2, seguindo: 2 } }));
    followers.countDocuments.mockReturnValue(query(2));
    counts.mockRestore();
    await expect(service.counts(actorId)).resolves.toEqual({ seguidores: 2, seguindo: 2 });
    expect(users.findById.mock.invocationCallOrder[0]).toBeLessThan(
      followers.countDocuments.mock.invocationCallOrder[0],
    );
    expect(users.updateOne).not.toHaveBeenCalled();
  });

  it('recounts after a relationship is deleted during reconciliation', async () => {
    const { service, users, followers, counts } = setup();
    users.findById.mockReturnValueOnce(query({ contadores: { seguidores: 0, seguindo: 0 } }))
      .mockReturnValueOnce(query({ contadores: { seguidores: 1, seguindo: 1 } }));
    followers.countDocuments.mockReturnValueOnce(query(1)).mockReturnValueOnce(query(1))
      .mockReturnValueOnce(query(0)).mockReturnValueOnce(query(0))
      .mockReturnValueOnce(query(0)).mockReturnValueOnce(query(0));
    users.updateOne.mockReturnValueOnce(query({ modifiedCount: 0 }))
      .mockReturnValueOnce(query({ modifiedCount: 1 }));
    counts.mockRestore();
    await expect(service.counts(actorId)).resolves.toEqual({ seguidores: 0, seguindo: 0 });
    expect(users.updateOne.mock.calls[1][1]).toEqual({ $set: {
      'contadores.seguidores': 0,
      'contadores.seguindo': 0,
    } });
  });

  it('keeps auditing later batches after one user fails reconciliation', async () => {
    const { service, users, followers } = setup();
    const ids = Array.from({ length: 51 }, () => new Types.ObjectId());
    users.find.mockReturnValueOnce(query(ids.slice(0, 50).map((_id) => ({ _id }))))
      .mockReturnValueOnce(query([{ _id: ids[50] }]));
    users.findById.mockReturnValue(query({ contadores: { seguidores: 0, seguindo: 0 } }));
    followers.countDocuments.mockImplementation((filter: { seguido_id?: Types.ObjectId; seguidor_id?: Types.ObjectId }) => {
      const id = filter.seguido_id ?? filter.seguidor_id;
      return id?.equals(ids[0])
        ? { exec: vi.fn().mockRejectedValue(new Error('temporary failure')) }
        : query(0);
    });
    expect(await service.reconcileBatch()).toBe(49);
    expect(await service.reconcileBatch()).toBe(1);
    expect(users.find).toHaveBeenCalledWith({ _id: { $gt: ids[49] } });
  });

  it('rechecks privacy before returning a relationship list', async () => {
    const { service, users, followers } = setup();
    users.findOne.mockReturnValueOnce(query({ _id: new Types.ObjectId(targetId), visibilidade_perfil: 'publico' }))
      .mockReturnValueOnce(query({ _id: new Types.ObjectId(targetId), visibilidade_perfil: 'privado' }));
    users.find.mockReturnValue(query([]));
    followers.find.mockReturnValue(query([]));
    await expect(service.list(targetId, actorId, 'seguidores', { limite: 20 })).rejects.toMatchObject({ status: 404 });
  });

  it('starts the bounded audit timer and stops it during application shutdown', async () => {
    const { service } = setup();
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const set = vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const audit = vi.spyOn(service, 'reconcileBatch').mockResolvedValue(1);
    try {
      service.onModuleInit();
      expect(set).toHaveBeenCalledWith(expect.any(Function), 30_000);
      const callback = set.mock.calls[0][0] as () => void;
      callback();
      expect(audit).toHaveBeenCalledOnce();
      await service.onModuleDestroy();
      expect(clear).toHaveBeenCalledWith(timer);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });
});
