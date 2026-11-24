import type { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { Publicacao } from '../publicacoes/schemas/publicacao.schema.js';
import { CreatorRankingCursor } from './creator-ranking.cursor.js';
import { CreatorStatsService } from './creator-stats.service.js';
import { Usuario } from './schemas/usuario.schema.js';

const userId = new Types.ObjectId();

function query(value: unknown) {
  const result = { exec: vi.fn().mockResolvedValue(value), select: vi.fn(), lean: vi.fn(), sort: vi.fn(), limit: vi.fn() };
  result.select.mockReturnValue(result);
  result.lean.mockReturnValue(result);
  result.sort.mockReturnValue(result);
  result.limit.mockReturnValue(result);
  return result;
}

function setup() {
  const user = { _id: userId, criador_revisao: 2, criador_projecao_pendente: true,
    contadores: { publicacoes: 0, score: 0 } };
  const users = {
    findById: vi.fn().mockReturnValue(query(user)),
    find: vi.fn().mockReturnValue(query([])),
    updateOne: vi.fn().mockReturnValue(query({ modifiedCount: 1 })),
  };
  const posts = {
    aggregate: vi.fn().mockReturnValue(query([{ _id: null, publicacoes: 3, score: -2 }])),
    countDocuments: vi.fn().mockReturnValue(query(2)),
  };
  const cursor = new CreatorRankingCursor({ getOrThrow: () => 'unit-test-ranking-secret' } as unknown as ConfigService);
  const service = new CreatorStatsService(users as unknown as Model<Usuario>,
    posts as unknown as Model<Publicacao>, cursor);
  return { service, users, posts, cursor, user };
}

describe('CreatorStatsService', () => {
  it('recalculates published posts and public score without touching follower counters', async () => {
    const { service, users, posts } = setup();
    await expect(service.reconcile(userId.toString())).resolves.toEqual({ publicacoes: 3, score: -2 });
    expect(posts.aggregate.mock.calls[0][0]).toEqual([
      { $match: { autor_id: userId, status: 'publicada' } },
      { $group: { _id: null, publicacoes: { $sum: 1 }, score: { $sum: { $cond: [
        { $eq: ['$visibilidade', 'publico'] }, { $ifNull: ['$contadores.score', 0] }, 0,
      ] } } } },
    ]);
    expect(users.updateOne.mock.calls[0][0]).toEqual({ _id: userId, criador_revisao: 2 });
    expect(users.updateOne.mock.calls[0][1].$set).toMatchObject({
      'contadores.publicacoes': 3, 'contadores.score': -2, criador_projecao_pendente: false,
    });
    expect(users.updateOne.mock.calls[0][1].$set).not.toHaveProperty('contadores.seguidores');
    expect(users.updateOne.mock.calls[0][1].$set).not.toHaveProperty('contadores.seguindo');
  });

  it('rejects a stale reconciliation when another mutation advances the revision', async () => {
    const { service, users } = setup();
    users.updateOne.mockReturnValueOnce(query({ modifiedCount: 0 }));
    await expect(service.reconcile(userId.toString())).rejects.toThrow('changed concurrently');
  });

  it('marks mutations before refreshing and counts only public published posts for visitors', async () => {
    const { service, users, posts } = setup();
    await service.refresh(userId.toString());
    expect(users.updateOne.mock.calls[0][1]).toMatchObject({
      $set: { criador_projecao_pendente: true }, $inc: { criador_revisao: 1 },
    });
    expect(await service.publicPublicationCount(userId.toString())).toBe(2);
    expect(posts.countDocuments).toHaveBeenCalledWith({
      autor_id: userId, status: 'publicada', visibilidade: 'publico',
    });
  });

  it('recovers dirty users and audits legacy users in bounded batches', async () => {
    const { service, users } = setup();
    users.find.mockReturnValueOnce(query([{ _id: userId }])).mockReturnValueOnce(query([{ _id: userId }]));
    const reconcile = vi.spyOn(service, 'reconcile').mockResolvedValue({ publicacoes: 3, score: -2 });
    expect(await service.recoverBatch()).toBe(2);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(users.find.mock.results[0].value.limit).toHaveBeenCalledWith(100);
    expect(users.find.mock.results[1].value.limit).toHaveBeenCalledWith(25);
    expect(users.updateOne.mock.calls[0][1].$set).toHaveProperty('criador_auditoria_em');
  });

  it('sorts active public creators by score and ID with a private-free response', async () => {
    const { service, users, cursor } = setup();
    const first = { _id: new Types.ObjectId(), nome: 'Ana', username: 'ana', avatar_url: null,
      contadores: { score: 2 } };
    const second = { _id: new Types.ObjectId(), nome: 'Bia', username: 'bia', avatar_url: '/avatar.png',
      contadores: { score: -1 } };
    users.find.mockReturnValue(query([first, second]));
    const page = await service.ranking({ limite: 1 });
    expect(page.items).toEqual([{ id: first._id.toString(), nome: 'Ana', username: 'ana',
      avatarUrl: null, score: 2 }]);
    expect(page.hasMore).toBe(true);
    expect(users.find.mock.calls[0][0]).toMatchObject({ status: 'ativo',
      visibilidade_perfil: { $ne: 'privado' } });
    expect(users.find.mock.results[0].value.sort).toHaveBeenCalledWith({ 'contadores.score': -1, _id: -1 });
    expect(cursor.decode(page.nextCursor!)).toEqual({ score: 2, id: first._id });
    await service.ranking({ limite: 1, cursor: page.nextCursor! });
    expect(users.find.mock.calls[1][0].$or).toEqual([
      { 'contadores.score': { $lt: 2 } },
      { 'contadores.score': 2, _id: { $lt: first._id } },
    ]);
  });

  it('rejects malformed or foreign ranking cursors', () => {
    const { cursor } = setup();
    expect(() => cursor.decode('invalid')).toThrow();
    const valid = cursor.encode({ score: -1, id: userId });
    expect(() => cursor.decode(`${valid.slice(0, -1)}!`)).toThrow();
  });
});
