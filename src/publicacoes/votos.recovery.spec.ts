import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import type { PublicacoesCacheService } from './publicacoes-cache.service.js';
import { Publicacao } from './schemas/publicacao.schema.js';
import { Voto } from './schemas/voto.schema.js';
import { VotosService } from './votos.service.js';

function query(value: unknown) {
  return { exec: async () => value };
}

function setup(failingCount: number) {
  let beforeRescheduleCas: (() => void) | undefined;
  let failLaterRelease = true;
  const documents = Array.from({ length: failingCount + 1 }, (_, index) => ({
    _id: new Types.ObjectId(),
    votos_revisao: 0,
    votos_projecao_pendente: true,
    votos_proxima_tentativa_em: new Date(index),
    votos_operacoes_pendentes: index < failingCount
      ? [
          { usuario_id: new Types.ObjectId(), token: `first-${index}`, expira_em: new Date(0) },
          { usuario_id: new Types.ObjectId(), token: `later-${index}`, expira_em: new Date(0) },
        ]
      : [],
    contadores: { upvotes: 0, downvotes: 0, score: 0 },
  }));
  const publicationModel = {
    findById: vi.fn((id: Types.ObjectId) => {
      const item = documents.find((candidate) => candidate._id.equals(id));
      const selected = {
        select: vi.fn(), lean: vi.fn(),
        exec: async () => item ? {
          _id: item._id,
          votos_revisao: item.votos_revisao,
          votos_projecao_pendente: item.votos_projecao_pendente,
          votos_proxima_tentativa_em: item.votos_proxima_tentativa_em,
        } : null,
      };
      selected.select.mockReturnValue(selected);
      selected.lean.mockReturnValue(selected);
      return selected;
    }),
    find: vi.fn(() => {
      const selected = {
        sort: vi.fn(), limit: vi.fn(), select: vi.fn(), lean: vi.fn(),
        exec: async () => documents
          .filter((item) => item.votos_projecao_pendente && item.votos_proxima_tentativa_em <= new Date())
          .sort((left, right) => left.votos_proxima_tentativa_em.getTime() - right.votos_proxima_tentativa_em.getTime())
          .slice(0, 100)
          .map((item) => ({
            ...item,
            votos_operacoes_pendentes: [...item.votos_operacoes_pendentes],
          })),
      };
      selected.sort.mockReturnValue(selected);
      selected.limit.mockReturnValue(selected);
      selected.select.mockReturnValue(selected);
      selected.lean.mockReturnValue(selected);
      return selected;
    }),
    updateOne: vi.fn((filter: Record<string, any>, update: Record<string, any>) => {
      const item = documents.find((candidate) => candidate._id.equals(filter._id));
      if (!item) return query({ modifiedCount: 0 });
      const releasedToken = update.$pull?.votos_operacoes_pendentes?.token as string | undefined;
      if (failLaterRelease && releasedToken?.startsWith('later-'))
        throw new Error('controlled cleanup failure');
      if (releasedToken) {
        const oldLength = item.votos_operacoes_pendentes.length;
        item.votos_operacoes_pendentes = item.votos_operacoes_pendentes.filter((pending) => pending.token !== releasedToken);
        if (item.votos_operacoes_pendentes.length === oldLength) return query({ modifiedCount: 0 });
        item.votos_revisao++;
        return query({ modifiedCount: 1 });
      }
      if (update.$set?.votos_proxima_tentativa_em) {
        if (beforeRescheduleCas) {
          const concurrentWrite = beforeRescheduleCas;
          beforeRescheduleCas = undefined;
          concurrentWrite();
        }
        if (filter.votos_revisao !== item.votos_revisao ||
          filter.votos_proxima_tentativa_em !== item.votos_proxima_tentativa_em)
          return query({ modifiedCount: 0 });
        item.votos_proxima_tentativa_em = update.$set.votos_proxima_tentativa_em;
        return query({ modifiedCount: 1 });
      }
      return query({ modifiedCount: 0 });
    }),
  };
  const voteModel = {
    findOne: vi.fn(() => {
      const selected = { select: vi.fn(), lean: vi.fn(), exec: async () => null };
      selected.select.mockReturnValue(selected);
      selected.lean.mockReturnValue(selected);
      return selected;
    }),
    updateOne: vi.fn(() => query({ modifiedCount: 1 })),
  };
  const service = new VotosService(
    voteModel as unknown as Model<Voto>,
    publicationModel as unknown as Model<Publicacao>,
    {} as Model<Usuario>,
    {} as PublicacoesCacheService,
  );
  const reconcile = vi.spyOn(service, 'reconcileCounter').mockImplementation(async (id) => {
    const item = documents.find((candidate) => candidate._id.toString() === id)!;
    item.votos_projecao_pendente = false;
    item.contadores = { upvotes: 1, downvotes: 0, score: 1 };
    return item.contadores;
  });
  return {
    service, documents, publicationModel, voteModel, reconcile,
    beforeNextRescheduleCas: (action: () => void) => { beforeRescheduleCas = action; },
    allowLaterRelease: () => { failLaterRelease = false; },
  };
}

describe('recuperação de votos após falha parcial', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reschedules a publication after one reservation was released before a later failure', async () => {
    const { service, documents, publicationModel, voteModel, reconcile } = setup(1);
    await service.recoverPendingBatch();
    const failed = documents[0];
    expect(failed.votos_revisao).toBe(1);
    expect(failed.votos_operacoes_pendentes.map((item) => item.token)).toEqual(['later-0']);
    expect(voteModel.updateOne).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalledWith(failed._id.toString());
    expect(publicationModel.updateOne.mock.calls.at(-1)?.[0]).toMatchObject({
      _id: failed._id, votos_revisao: 1,
    });
    expect(failed.votos_proxima_tentativa_em.getTime()).toBeGreaterThan(Date.now());
  });

  it('reaches healthy work after 100 partially failed publications', async () => {
    const { service, documents, reconcile } = setup(100);
    await service.recoverPendingBatch();
    expect(documents.slice(0, 100).every((item) => item.votos_proxima_tentativa_em > new Date())).toBe(true);
    await service.recoverPendingBatch();
    expect(reconcile).toHaveBeenCalledWith(documents[100]._id.toString());
    expect(documents[100].contadores).toEqual({ upvotes: 1, downvotes: 0, score: 1 });
  });

  it('completes the pending release and projection on a later retry', async () => {
    const { service, documents, reconcile, allowLaterRelease } = setup(1);
    await service.recoverPendingBatch();
    const failed = documents[0];
    expect(failed.votos_projecao_pendente).toBe(true);
    allowLaterRelease();
    failed.votos_proxima_tentativa_em = new Date(0);
    await service.recoverPendingBatch();
    expect(failed.votos_operacoes_pendentes).toHaveLength(0);
    expect(failed.votos_revisao).toBe(2);
    expect(reconcile).toHaveBeenCalledWith(failed._id.toString());
    expect(failed.contadores).toEqual({ upvotes: 1, downvotes: 0, score: 1 });
    expect(failed.votos_projecao_pendente).toBe(false);
  });

  it('retries after a concurrent revision change without touching a valid reservation', async () => {
    const { service, documents, publicationModel, voteModel, beforeNextRescheduleCas } = setup(1);
    const failed = documents[0];
    beforeNextRescheduleCas(() => {
      failed.votos_revisao++;
      failed.votos_operacoes_pendentes.push({
        usuario_id: new Types.ObjectId(), token: 'valid', expira_em: new Date(Date.now() + 120_000),
      });
    });
    await service.recoverPendingBatch();
    const rescheduleCalls = publicationModel.updateOne.mock.calls
      .filter(([, update]) => update.$set?.votos_proxima_tentativa_em);
    expect(rescheduleCalls.map(([filter]) => filter.votos_revisao)).toEqual([1, 2]);
    expect(failed.votos_revisao).toBe(2);
    expect(failed.votos_operacoes_pendentes.map((item) => item.token)).toEqual(['later-0', 'valid']);
    expect(voteModel.updateOne).toHaveBeenCalledOnce();
    expect(failed.votos_proxima_tentativa_em.getTime()).toBeGreaterThan(Date.now());
  });

  it('reports failed rescheduling without leaking tokens and throttles repeated warnings', async () => {
    const { service, publicationModel } = setup(1);
    publicationModel.findById.mockImplementation(() => { throw new Error('controlled reschedule failure'); });
    const warn = vi.spyOn((service as unknown as { logger: Logger }).logger, 'warn')
      .mockImplementation(() => undefined);
    await service.recoverPendingBatch();
    await service.recoverPendingBatch();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('reagendamento_falhou=1');
    expect(warn.mock.calls[0][0]).not.toContain('first-0');
    expect(warn.mock.calls[0][0]).not.toContain('later-0');
  });

  it('reports discarded legacy audit failures in one warning', async () => {
    const { service, publicationModel, reconcile } = setup(1);
    reconcile.mockRejectedValue(new Error('controlled reconciliation failure'));
    publicationModel.updateOne.mockImplementationOnce(() => ({
      exec: async () => { throw new Error('controlled audit update failure'); },
    }));
    const warn = vi.spyOn((service as unknown as { logger: Logger }).logger, 'warn')
      .mockImplementation(() => undefined);
    expect(await service.auditLegacyBatch()).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('reconciliacao_falhou=2');
    expect(warn.mock.calls[0][0]).toContain('atualizacao_falhou=1');
  });
});
