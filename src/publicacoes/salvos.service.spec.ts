import type { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import { PublicacaoAccessService } from './publicacao-access.service.js';
import { PublicacoesCacheService } from './publicacoes-cache.service.js';
import { PublicacoesService } from './publicacoes.service.js';
import { PublicacaoSalva } from './schemas/publicacao-salva.schema.js';
import { Publicacao } from './schemas/publicacao.schema.js';
import { SalvosCursor } from './salvos.cursor.js';
import { SalvosService } from './salvos.service.js';

const publicationId = new Types.ObjectId();
const authorId = new Types.ObjectId();
const userId = new Types.ObjectId();

function query(value: unknown) {
  const result = { exec: vi.fn().mockResolvedValue(value), select: vi.fn(), sort: vi.fn(), limit: vi.fn(), lean: vi.fn() };
  result.select.mockReturnValue(result);
  result.sort.mockReturnValue(result);
  result.limit.mockReturnValue(result);
  result.lean.mockReturnValue(result);
  return result;
}

function setup() {
  const post = {
    _id: publicationId, autor_id: authorId, status: 'publicada', visibilidade: 'publico',
    contadores: { salvamentos: 0 }, salvamentos_revisao: 0,
    salvamentos_projecao_pendente: false,
    salvamentos_operacoes_pendentes: [] as { token: string; expira_em: Date }[],
  };
  const salvos = {
    exists: vi.fn().mockResolvedValue(null),
    updateOne: vi.fn().mockReturnValue(query({ upsertedCount: 1 })),
    deleteOne: vi.fn().mockReturnValue(query({ deletedCount: 1 })),
    countDocuments: vi.fn().mockReturnValue(query(1)),
    aggregate: vi.fn().mockReturnValue(query([])),
  };
  const publicacoes = {
    findOne: vi.fn().mockReturnValue(query(post)),
    findById: vi.fn().mockReturnValue(query(post)),
    find: vi.fn().mockReturnValue(query([])),
    updateOne: vi.fn().mockReturnValue(query({ modifiedCount: 1 })),
    hydrate: vi.fn((value: unknown) => value),
  };
  const usuarios = {
    exists: vi.fn().mockResolvedValue({ _id: userId }),
    hydrate: vi.fn((value: unknown) => value),
  };
  const access = {
    canRead: vi.fn().mockResolvedValue(true),
    writeFilter: vi.fn().mockReturnValue({ autor_id: authorId, status: 'publicada', visibilidade: 'publico' }),
    listVisibility: vi.fn().mockResolvedValue({ visibilidade: 'publico' }),
  };
  const cache = { invalidate: vi.fn().mockResolvedValue(undefined) };
  const responses = { toResponse: vi.fn().mockReturnValue({ id: publicationId.toString() }) };
  const cursor = new SalvosCursor({ getOrThrow: () => 'unit-test-secret-for-saved-cursors' } as unknown as ConfigService);
  const service = new SalvosService(
    salvos as unknown as Model<PublicacaoSalva>,
    publicacoes as unknown as Model<Publicacao>,
    usuarios as unknown as Model<Usuario>,
    access as unknown as PublicacaoAccessService,
    cache as unknown as PublicacoesCacheService,
    responses as unknown as PublicacoesService,
    cursor,
  );
  return { service, post, salvos, publicacoes, usuarios, access, cache, responses, cursor };
}

describe('SalvosService', () => {
  it('requires an active account and access to save or inspect a post', async () => {
    const { service, usuarios, access, salvos } = setup();
    usuarios.exists.mockResolvedValueOnce(null);
    await expect(service.put(publicationId.toString(), userId.toString())).rejects.toMatchObject({ status: 401 });
    access.canRead.mockResolvedValueOnce(false);
    await expect(service.get(publicationId.toString(), userId.toString())).rejects.toMatchObject({ status: 404 });
    expect(salvos.updateOne).not.toHaveBeenCalled();
  });

  it('saves once and does not increment the counter for an idempotent retry', async () => {
    const { service, salvos, publicacoes, cache } = setup();
    vi.spyOn(service, 'reconcileCounter').mockResolvedValue(1);
    salvos.updateOne.mockReturnValueOnce(query({ upsertedCount: 1 }))
      .mockReturnValueOnce(query({ upsertedCount: 0 }));
    await expect(service.put(publicationId.toString(), userId.toString())).resolves.toEqual({ salvo: true });
    await expect(service.put(publicationId.toString(), userId.toString())).resolves.toEqual({ salvo: true });
    const increments = publicacoes.updateOne.mock.calls.filter(([, update]) =>
      update.$inc?.['contadores.salvamentos'] === 1);
    expect(increments).toHaveLength(1);
    expect(cache.invalidate).toHaveBeenCalledTimes(1);
  });

  it('allows removal after access is lost and prevents negative counts', async () => {
    const { service, access, publicacoes, cache } = setup();
    vi.spyOn(service, 'reconcileCounter').mockResolvedValue(0);
    access.canRead.mockResolvedValue(false);
    await expect(service.remove(publicationId.toString(), userId.toString())).resolves.toEqual({ salvo: false });
    const decrement = publicacoes.updateOne.mock.calls.find(([, update]) =>
      update.$inc?.['contadores.salvamentos'] === -1);
    expect(decrement?.[0]).toMatchObject({ 'contadores.salvamentos': { $gt: 0 } });
    expect(access.canRead).not.toHaveBeenCalled();
    expect(cache.invalidate).toHaveBeenCalledOnce();
  });

  it('leaves an ambiguous write marked for recovery without compensating it', async () => {
    const { service, salvos, publicacoes, cache } = setup();
    salvos.updateOne.mockReturnValueOnce({ exec: vi.fn().mockRejectedValue(new Error('response lost')) });
    await expect(service.put(publicationId.toString(), userId.toString())).rejects.toMatchObject({ status: 503 });
    expect(publicacoes.updateOne).toHaveBeenCalledTimes(1);
    expect(publicacoes.updateOne.mock.calls[0][1]).toMatchObject({
      $set: { salvamentos_projecao_pendente: true },
    });
    expect(salvos.deleteOne).not.toHaveBeenCalled();
    expect(cache.invalidate).toHaveBeenCalledOnce();
  });

  it('counts confirmed saves and guards reconciliation against concurrent reservations', async () => {
    const { service, post, publicacoes, salvos } = setup();
    post.salvamentos_projecao_pendente = true;
    const count = await service.reconcileCounter(publicationId.toString());
    expect(count).toBe(1);
    expect(salvos.countDocuments).toHaveBeenCalledWith({ publicacao_id: publicationId });
    expect(publicacoes.updateOne.mock.calls[0][0]).toMatchObject({
      salvamentos_revisao: { $in: [0, null] },
      $or: [{ salvamentos_operacoes_pendentes: { $size: 0 } }, { salvamentos_operacoes_pendentes: { $exists: false } }],
    });
    post.salvamentos_operacoes_pendentes.push({ token: 'pending', expira_em: new Date(Date.now() + 60_000) });
    await expect(service.reconcileCounter(publicationId.toString())).rejects.toMatchObject({ status: 503 });
  });

  it('filters inaccessible and inactive publications before limiting the personal list', async () => {
    const { service, salvos, cursor, access, responses } = setup();
    const savedAt = new Date('2026-11-24T12:00:00.000Z');
    const id = new Types.ObjectId();
    salvos.aggregate.mockReturnValue(query([{ _id: id, criado_em: savedAt,
      publication: { _id: publicationId }, author: { _id: authorId } }]));
    const result = await service.list(userId.toString(), { limite: 1 });
    expect(result.items).toEqual([{ id: publicationId.toString(), salvaEm: savedAt }]);
    expect(result.hasMore).toBe(false);
    const pipeline = salvos.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({ $match: { usuario_id: userId } });
    expect(pipeline[1]).toEqual({ $sort: { criado_em: -1, _id: -1 } });
    expect(pipeline[2].$lookup.pipeline).toEqual([{ $match: { status: 'publicada', visibilidade: 'publico' } }]);
    expect(pipeline[4].$lookup.pipeline).toEqual([{ $match: { status: 'ativo' } }]);
    expect(pipeline[6]).toEqual({ $limit: 2 });
    expect(access.listVisibility).toHaveBeenCalledWith(userId.toString());
    expect(responses.toResponse).toHaveBeenCalledOnce();
    expect(cursor.decode(cursor.encode({ savedAt, id }, userId.toString()), userId.toString()))
      .toEqual({ savedAt, id });
  });
});
