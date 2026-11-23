import { Types, model } from 'mongoose';
import type { Model } from 'mongoose';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import type { PublicacoesCacheService } from './publicacoes-cache.service.js';
import { Publicacao } from './schemas/publicacao.schema.js';
import { Voto, VotoSchema } from './schemas/voto.schema.js';
import { VotosService } from './votos.service.js';

const publicationId = new Types.ObjectId();
const authorId = new Types.ObjectId();
const userId = new Types.ObjectId();

function query(value: unknown) {
  const result = {
    exec: vi.fn().mockResolvedValue(value),
    select: vi.fn(),
    lean: vi.fn(),
  };
  result.select.mockReturnValue(result);
  result.lean.mockReturnValue(result);
  return result;
}

function setup() {
  let vote: {
    valor: 1 | -1 | null;
    revisao: number;
    operacao: { token: string; expira_em: Date; estado: 'reservada' | 'aplicada' } | null;
    criado_em: Date;
    atualizado_em: Date;
  } | null = null;
  const post = {
    _id: publicationId,
    autor_id: authorId,
    status: 'publicada',
    visibilidade: 'publico',
    votos_revisao: 0,
    votos_projecao_pendente: false,
    votos_proxima_tentativa_em: null as Date | null,
    votos_operacoes_pendentes: [] as { usuario_id: Types.ObjectId; token: string; expira_em: Date }[],
    contadores: { upvotes: 0, downvotes: 0, score: 0 },
  };
  let active = true;
  const voteModel = {
    findOne: vi.fn(() => query(vote)),
    updateOne: vi.fn((filter: Record<string, any>, update: Record<string, any>, options?: { timestamps?: boolean }) => {
      if (update.$setOnInsert) {
        if (!vote) vote = {
          valor: null,
          revisao: 0,
          operacao: null,
          criado_em: update.$setOnInsert.criado_em,
          atualizado_em: update.$setOnInsert.atualizado_em,
        };
        return query({ modifiedCount: 1 });
      }
      if (update.$set?.['operacao.estado'] === 'aplicada') {
        if (!vote?.operacao || vote.operacao.token !== filter['operacao.token'] ||
          vote.revisao !== filter.revisao || vote.operacao.expira_em <= new Date())
          return query({ modifiedCount: 0 });
        vote.valor = update.$set.valor;
        vote.operacao.estado = 'aplicada';
        vote.revisao++;
        if (options?.timestamps !== false) vote.atualizado_em = new Date();
        return query({ modifiedCount: 1 });
      }
      if (update.$set?.operacao === null && vote && vote.operacao?.token === filter['operacao.token']) {
        vote.operacao = null;
        return query({ modifiedCount: 1 });
      }
      return query({ modifiedCount: 0 });
    }),
    findOneAndUpdate: vi.fn((filter: Record<string, any>, update: Record<string, any>[]) => {
      if (!vote || (vote.operacao && vote.operacao.expira_em > new Date() &&
        !(vote.operacao.estado === 'aplicada' && filter.$or?.some(
          (condition: Record<string, unknown>) => condition['operacao.estado'] === 'aplicada',
        )))) return query(null);
      vote.revisao++;
      vote.operacao = {
        token: update[0].$set.operacao.token,
        expira_em: new Date(Date.now() + 120_000),
        estado: 'reservada',
      };
      return query({ ...vote });
    }),
    aggregate: vi.fn(() => query([
      { _id: 1, total: vote?.valor === 1 ? 1 : 0 },
      { _id: -1, total: vote?.valor === -1 ? 1 : 0 },
    ])),
  };
  const publicationModel = {
    findOne: vi.fn(() => query(post.status === 'publicada' && post.visibilidade === 'publico' ? post : null)),
    findById: vi.fn(() => query(post)),
    updateOne: vi.fn((filter: Record<string, any>, update: Record<string, any>) => {
      if (update.$push) {
        const reservation = update.$push.votos_operacoes_pendentes;
        if (post.votos_operacoes_pendentes.some((item) => item.usuario_id.toString() === reservation.usuario_id.toString()))
          return query({ modifiedCount: 0 });
        post.votos_operacoes_pendentes.push(reservation);
        post.votos_projecao_pendente = true;
        post.votos_proxima_tentativa_em = reservation.expira_em;
      } else if (update.$pull?.votos_operacoes_pendentes?.token) {
        const token = update.$pull.votos_operacoes_pendentes.token;
        const index = post.votos_operacoes_pendentes.findIndex((item) => item.token === token);
        if (index < 0) return query({ modifiedCount: 0 });
        post.votos_operacoes_pendentes.splice(index, 1);
        post.votos_proxima_tentativa_em = new Date();
      } else if (update.$set?.['contadores.upvotes'] !== undefined) {
        const expected = filter.votos_revisao;
        if (post.votos_operacoes_pendentes.length ||
          (typeof expected === 'number' && expected !== post.votos_revisao))
          return query({ modifiedCount: 0 });
        post.contadores.upvotes = update.$set['contadores.upvotes'];
        post.contadores.downvotes = update.$set['contadores.downvotes'];
        post.contadores.score = update.$set['contadores.score'];
        post.votos_projecao_pendente = false;
        post.votos_proxima_tentativa_em = update.$set.votos_proxima_tentativa_em;
      }
      post.votos_revisao++;
      return query({ modifiedCount: 1 });
    }),
  };
  const users = { findOne: vi.fn(() => query(active ? { _id: userId } : null)) };
  const cache = { invalidate: vi.fn().mockResolvedValue(undefined) };
  const service = new VotosService(
    voteModel as unknown as Model<Voto>,
    publicationModel as unknown as Model<Publicacao>,
    users as unknown as Model<Usuario>,
    cache as unknown as PublicacoesCacheService,
  );
  return {
    service, post, cache, voteModel, publicationModel,
    currentVote: () => vote,
    blockUser: () => { active = false; },
  };
}

describe('votos: transições e projeção', () => {
  it.each([
    { steps: [1], counts: [1, 0, 1] },
    { steps: [-1], counts: [0, 1, -1] },
    { steps: [1, 1], counts: [1, 0, 1] },
    { steps: [-1, -1], counts: [0, 1, -1] },
    { steps: [1, -1], counts: [0, 1, -1] },
    { steps: [-1, 1], counts: [1, 0, 1] },
    { steps: [1, null], counts: [0, 0, 0] },
    { steps: [-1, null], counts: [0, 0, 0] },
    { steps: [null], counts: [0, 0, 0] },
  ] as const)('keeps vote and counters consistent for $steps', async ({ steps, counts }) => {
    const { service, post, currentVote } = setup();
    for (const step of steps) {
      if (step === null) await service.remove(publicationId.toString(), userId.toString());
      else await service.put(publicationId.toString(), userId.toString(), step);
    }
    expect([post.contadores.upvotes, post.contadores.downvotes, post.contadores.score]).toEqual(counts);
    expect(currentVote()?.valor).toBe(steps.at(-1) ?? null);
    expect(post.contadores.upvotes).toBeGreaterThanOrEqual(0);
    expect(post.contadores.downvotes).toBeGreaterThanOrEqual(0);
    expect(post.votos_operacoes_pendentes).toHaveLength(0);
    expect(post.votos_projecao_pendente).toBe(false);
  });

  it('denies inactive users and unpublished posts without changing votes', async () => {
    const { service, currentVote, post, blockUser } = setup();
    blockUser();
    await expect(service.put(publicationId.toString(), userId.toString(), 1)).rejects.toMatchObject({ status: 403 });
    post.status = 'arquivada';
    await expect(service.get(publicationId.toString(), userId.toString())).rejects.toMatchObject({ status: 404 });
    expect(currentVote()).toBeNull();
  });

  it('keeps a durable dirty marker after an ambiguous persisted write', async () => {
    const { service, voteModel, currentVote, post } = setup();
    const normal = voteModel.updateOne.getMockImplementation()!;
    voteModel.updateOne.mockImplementation((filter, update) => {
      const result = normal(filter, update);
      if (update.$set?.['operacao.estado'] !== 'aplicada') return result;
      return { exec: async () => {
        await result.exec();
        throw new Error('response lost after persistence');
      } } as ReturnType<typeof query>;
    });
    await expect(service.put(publicationId.toString(), userId.toString(), 1))
      .rejects.toMatchObject({ status: 503 });
    expect(currentVote()?.valor).toBe(1);
    expect(post.votos_projecao_pendente).toBe(true);
    expect(post.votos_operacoes_pendentes).toHaveLength(1);
    const token = currentVote()?.operacao?.token;
    const expiresAt = currentVote()?.operacao?.expira_em;
    expect(currentVote()?.operacao?.estado).toBe('aplicada');
    expect(post.votos_operacoes_pendentes[0].token).toBe(token);
    await expect(service.put(publicationId.toString(), userId.toString(), -1))
      .rejects.toMatchObject({ status: 503 });
    expect(currentVote()?.valor).toBe(1);
    expect(currentVote()?.operacao).toMatchObject({ token, expira_em: expiresAt, estado: 'aplicada' });
    expect(post.votos_operacoes_pendentes[0].token).toBe(token);
  });

  it('leaves the projection dirty if reconciliation fails after the vote changed', async () => {
    const { service, publicationModel, currentVote, post } = setup();
    const normal = publicationModel.updateOne.getMockImplementation()!;
    publicationModel.updateOne.mockImplementation((filter, update) => {
      if (update.$set?.['contadores.upvotes'] !== undefined)
        return query(Promise.reject(new Error('projection unavailable')));
      return normal(filter, update);
    });
    await expect(service.put(publicationId.toString(), userId.toString(), -1))
      .rejects.toMatchObject({ status: 503 });
    expect(currentVote()?.valor).toBe(-1);
    expect(post.votos_projecao_pendente).toBe(true);
    expect(post.votos_operacoes_pendentes).toHaveLength(0);
    expect(currentVote()?.operacao?.estado).toBe('aplicada');
    expect(post.contadores).toEqual({ upvotes: 0, downvotes: 0, score: 0 });
  });

  it('keeps a completed vote fenced until expiry when clearing its token fails', async () => {
    const { service, voteModel, currentVote, post } = setup();
    const normal = voteModel.updateOne.getMockImplementation()!;
    let failClear = true;
    voteModel.updateOne.mockImplementation((filter, update, options) => {
      if (failClear && update.$set?.operacao === null) {
        failClear = false;
        return query(Promise.reject(new Error('clear unavailable')));
      }
      return normal(filter, update, options);
    });
    await expect(service.put(publicationId.toString(), userId.toString(), 1))
      .resolves.toMatchObject({ valor: 1 });
    const token = currentVote()?.operacao?.token;
    expect(currentVote()?.operacao?.estado).toBe('aplicada');
    await expect(service.put(publicationId.toString(), userId.toString(), -1))
      .rejects.toMatchObject({ status: 503 });
    expect(currentVote()?.operacao?.token).toBe(token);
    expect(post.contadores).toEqual({ upvotes: 1, downvotes: 0, score: 1 });
    currentVote()!.operacao!.expira_em = new Date(0);
    await expect(service.put(publicationId.toString(), userId.toString(), -1))
      .resolves.toMatchObject({ valor: -1 });
    expect(post.contadores).toEqual({ upvotes: 0, downvotes: 1, score: -1 });
  });

  it('rejects a second operation for the same user while the first is pending', async () => {
    const { service, voteModel, currentVote, post } = setup();
    const normal = voteModel.updateOne.getMockImplementation()!;
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    voteModel.updateOne.mockImplementation((filter, update) => {
      const result = normal(filter, update);
      if (update.$set?.['operacao.estado'] !== 'aplicada') return result;
      return { exec: async () => { await pending; return result.exec(); } } as ReturnType<typeof query>;
    });
    const first = service.put(publicationId.toString(), userId.toString(), 1);
    await vi.waitFor(() => expect(post.votos_operacoes_pendentes).toHaveLength(1));
    await expect(service.put(publicationId.toString(), userId.toString(), -1))
      .rejects.toMatchObject({ status: 503 });
    complete();
    await expect(first).resolves.toMatchObject({ valor: 1 });
    expect(currentVote()?.valor).toBe(1);
    expect(post.contadores).toEqual({ upvotes: 1, downvotes: 0, score: 1 });
  });

  it('keeps vote and projection when Redis cache invalidation fails', async () => {
    const { service, currentVote, post, cache } = setup();
    cache.invalidate.mockRejectedValue(new Error('Redis unavailable'));
    await expect(service.put(publicationId.toString(), userId.toString(), -1))
      .resolves.toEqual({ valor: -1, contadores: { upvotes: 0, downvotes: 1, score: -1 } });
    expect(currentVote()?.valor).toBe(-1);
    expect(post.contadores).toEqual({ upvotes: 0, downvotes: 1, score: -1 });
  });

  it('creates timestamps, preserves creation through changes and removal, and reuses the vote document', async () => {
    vi.useFakeTimers();
    try {
      const firstTime = new Date('2026-11-22T10:00:00.000Z');
      vi.setSystemTime(firstTime);
      const { service, currentVote, voteModel } = setup();
      await service.put(publicationId.toString(), userId.toString(), 1);
      const original = currentVote()!;
      expect(original.criado_em).toBeInstanceOf(Date);
      expect(original.atualizado_em).toBeInstanceOf(Date);
      expect(original.criado_em).toEqual(firstTime);
      expect(original.atualizado_em).toEqual(firstTime);

      const secondTime = new Date('2026-11-22T10:01:00.000Z');
      vi.setSystemTime(secondTime);
      await service.put(publicationId.toString(), userId.toString(), -1);
      expect(currentVote()).toBe(original);
      expect(original.criado_em).toEqual(firstTime);
      expect(original.atualizado_em).toEqual(secondTime);

      const thirdTime = new Date('2026-11-22T10:02:00.000Z');
      vi.setSystemTime(thirdTime);
      await service.remove(publicationId.toString(), userId.toString());
      expect(currentVote()).toBe(original);
      expect(original.valor).toBeNull();
      expect(original.criado_em).toEqual(firstTime);
      expect(original.atualizado_em).toEqual(thirdTime);

      const fourthTime = new Date('2026-11-22T10:03:00.000Z');
      vi.setSystemTime(fourthTime);
      await service.put(publicationId.toString(), userId.toString(), 1);
      expect(currentVote()).toBe(original);
      expect(original.valor).toBe(1);
      expect(original.criado_em).toEqual(firstTime);
      expect(original.atualizado_em).toEqual(fourthTime);
      expect(voteModel.updateOne.mock.calls.filter(([, update]) => update.$setOnInsert)).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not change existing timestamps while claiming a vote', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-22T10:00:00.000Z'));
      const { service, currentVote, voteModel } = setup();
      await service.put(publicationId.toString(), userId.toString(), 1);
      const original = currentVote()!;
      const createdAt = original.criado_em;
      const updatedAt = original.atualizado_em;

      vi.setSystemTime(new Date('2026-11-22T10:05:00.000Z'));
      await (service as unknown as {
        claimVote: (publicationId: string, userId: string) => Promise<unknown>;
      }).claimVote(publicationId.toString(), userId.toString());
      expect(original.criado_em).toEqual(createdAt);
      expect(original.atualizado_em).toEqual(updatedAt);
      expect(voteModel.updateOne.mock.lastCall?.[2]).toMatchObject({ upsert: true, timestamps: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('votos: execução da query pelo Mongoose', () => {
  it('executes the claim pipeline with Mongoose 9 after the atomic upsert', async () => {
    const voteModel = model('VotoPipelineRegression', VotoSchema);
    const collection = voteModel.collection as unknown as {
      updateOne: (...args: unknown[]) => Promise<unknown>;
      findOneAndUpdate: (...args: unknown[]) => Promise<unknown>;
    };
    const originalUpsert = collection.updateOne;
    const originalClaim = collection.findOneAndUpdate;
    let upsertUpdate: Record<string, any> | undefined;
    let claimPipeline: Record<string, any>[] | undefined;
    collection.updateOne = async (_filter, update) => {
      upsertUpdate = update as Record<string, any>;
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    };
    collection.findOneAndUpdate = async (_filter, update) => {
      claimPipeline = update as Record<string, any>[];
      return {
        _id: new Types.ObjectId(),
        publicacao_id: publicationId,
        usuario_id: userId,
        valor: null,
        revisao: 1,
        operacao: {
          token: claimPipeline[0].$set.operacao.token,
          expira_em: new Date(Date.now() + 120_000),
          estado: 'reservada',
        },
      };
    };
    try {
      const service = new VotosService(
        voteModel as Model<Voto>,
        {} as Model<Publicacao>,
        {} as Model<Usuario>,
        {} as PublicacoesCacheService,
      );
      const claim = await (service as unknown as {
        claimVote: (publicationId: string, userId: string) => Promise<{
          token: string;
          revision: number;
          expiresAt: Date;
        }>;
      }).claimVote(publicationId.toString(), userId.toString());
      expect(upsertUpdate?.$setOnInsert).toMatchObject({
        criado_em: expect.any(Date),
        atualizado_em: expect.any(Date),
      });
      expect(claimPipeline).toHaveLength(1);
      expect(claimPipeline?.[0].$set.operacao.expira_em.$dateAdd.startDate).toBe('$$NOW');
      expect(claim).toMatchObject({ token: expect.any(String), revision: 1, expiresAt: expect.any(Date) });
    } finally {
      collection.updateOne = originalUpsert;
      collection.findOneAndUpdate = originalClaim;
    }
  });
});
