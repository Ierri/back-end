import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { Seguidor } from '../usuarios/schemas/seguidor.schema.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import { PublicacaoAccessService } from './publicacao-access.service.js';

const author = new Types.ObjectId();
const follower = new Types.ObjectId();
const stranger = new Types.ObjectId();

function query<T>(value: T) {
  const result = { exec: vi.fn().mockResolvedValue(value), select: vi.fn(), lean: vi.fn() };
  result.select.mockReturnValue(result);
  result.lean.mockReturnValue(result);
  return result;
}

function setup() {
  const active = new Set([author.toString(), follower.toString(), stranger.toString()]);
  const accepted = new Set([follower.toString()]);
  const users = {
    exists: vi.fn(async ({ _id, status }: { _id: Types.ObjectId; status: string }) =>
      status === 'ativo' && active.has(_id.toString()) ? { _id } : null),
    countDocuments: vi.fn(({ _id }: { _id: { $in: Types.ObjectId[] } }) =>
      query(_id.$in.filter((id) => active.has(id.toString())).length)),
    find: vi.fn(({ _id }: { _id: { $in: Types.ObjectId[] } }) =>
      query(_id.$in.filter((id) => active.has(id.toString())).map((_id) => ({ _id })))),
  };
  const followers = {
    exists: vi.fn(async ({ seguidor_id, seguido_id, status }: { seguidor_id: Types.ObjectId; seguido_id: Types.ObjectId; status: string }) =>
      status === 'aceito' && seguido_id.equals(author) && accepted.has(seguidor_id.toString()) ? { _id: new Types.ObjectId() } : null),
    distinct: vi.fn(() => query(accepted.has(follower.toString()) ? [author] : [])),
  };
  const service = new PublicacaoAccessService(
    followers as unknown as Model<Seguidor>,
    users as unknown as Model<Usuario>,
  );
  const restricted = { autor_id: author, status: 'publicada' as const, visibilidade: 'seguidores' as const };
  return { service, active, accepted, followers, users, restricted };
}

describe('PublicacaoAccessService', () => {
  it('keeps public posts available and rejects unpublished posts', async () => {
    const { service, restricted } = setup();
    await expect(service.canRead({ ...restricted, visibilidade: 'publico' })).resolves.toBe(true);
    await expect(service.canRead({ ...restricted, status: 'excluida' }, author.toString())).resolves.toBe(false);
  });

  it('allows the active author and accepted active follower, but not pending or unrelated users', async () => {
    const { service, accepted, restricted } = setup();
    await expect(service.canRead(restricted, author.toString())).resolves.toBe(true);
    await expect(service.canRead(restricted, follower.toString())).resolves.toBe(true);
    await expect(service.canRead(restricted, stranger.toString())).resolves.toBe(false);
    await expect(service.canRead(restricted)).resolves.toBe(false);
    accepted.clear();
    await expect(service.canRead(restricted, follower.toString())).resolves.toBe(false);
  });

  it('revokes restricted access when the viewer or author is inactive', async () => {
    const { service, active, restricted } = setup();
    active.delete(follower.toString());
    await expect(service.canRead(restricted, follower.toString())).resolves.toBe(false);
    active.add(follower.toString());
    active.delete(author.toString());
    await expect(service.canRead(restricted, follower.toString())).resolves.toBe(false);
    await expect(service.canRead(restricted, author.toString())).resolves.toBe(false);
  });

  it('builds authorization into the list query before pagination', async () => {
    const { service, active, accepted } = setup();
    expect(await service.listVisibility()).toEqual({ visibilidade: 'publico' });
    expect(await service.listVisibility(follower.toString(), author.toString())).toEqual({});
    expect(await service.listVisibility(stranger.toString(), author.toString())).toEqual({ visibilidade: 'publico' });
    expect(await service.listVisibility(author.toString(), author.toString())).toEqual({});
    expect(await service.listVisibility(follower.toString())).toEqual({
      $or: [
        { visibilidade: 'publico' },
        { autor_id: follower },
        { visibilidade: 'seguidores', autor_id: { $in: [author] } },
      ],
    });
    accepted.clear();
    expect(await service.listVisibility(follower.toString())).toEqual({
      $or: [{ visibilidade: 'publico' }, { autor_id: follower }],
    });
    active.delete(follower.toString());
    expect(await service.listVisibility(follower.toString())).toEqual({ visibilidade: 'publico' });
  });

  it('guards writes against a change in status or visibility', () => {
    const { service, restricted } = setup();
    expect(service.writeFilter(restricted)).toEqual(restricted);
  });
});
