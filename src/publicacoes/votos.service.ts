import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import { CreatorStatsService } from '../usuarios/creator-stats.service.js';
import { PublicacoesCacheService } from './publicacoes-cache.service.js';
import { PublicacaoAccessService } from './publicacao-access.service.js';
import { Publicacao } from './schemas/publicacao.schema.js';
import type { PublicacaoDocument } from './schemas/publicacao.schema.js';
import { Voto } from './schemas/voto.schema.js';
import type { VotoDocument } from './schemas/voto.schema.js';

type VoteValue = 1 | -1;
type VoteCounts = { upvotes: number; downvotes: number; score: number };
type Claim = { token: string; revision: number; expiresAt: Date };
type Reservation = Claim & { authorId: string };

const FAR_FUTURE = new Date('9999-12-31T23:59:59.999Z');
const LEASE_MS = 120_000;
const RECOVERY_BATCH = 100;

@Injectable()
export class VotosService implements OnModuleInit, OnModuleDestroy {
  @Inject(CreatorStatsService) private creatorStats?: CreatorStatsService;
  private readonly logger = new Logger(VotosService.name);
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private recovering = false;
  private cycles = 0;
  private lastRecoveryWarningAt: number | null = null;
  private suppressedRecoveryWarnings = 0;

  constructor(
    @InjectModel(Voto.name) private readonly votos: Model<Voto>,
    @InjectModel(Publicacao.name) private readonly publicacoes: Model<Publicacao>,
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
    @Inject(PublicacoesCacheService) private readonly cache: PublicacoesCacheService,
    @Inject(PublicacaoAccessService) private readonly access: PublicacaoAccessService,
  ) {}

  onModuleInit() {
    void this.recoverPendingBatch().catch(() => this.warnRecovery('Falha ao executar a recuperação de votos.'));
    this.recoveryTimer = setInterval(() => {
      void this.recoverPendingBatch().catch(() => this.warnRecovery('Falha ao executar a recuperação de votos.'));
    }, 30_000);
    this.recoveryTimer.unref();
  }

  onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  async get(publicationId: string, userId: string) {
    await this.accessiblePublication(publicationId, userId);
    const vote = await this.votos.findOne({
      publicacao_id: new Types.ObjectId(publicationId),
      usuario_id: new Types.ObjectId(userId),
    }).select('valor').lean().exec();
    return { valor: vote?.valor ?? null };
  }

  async put(publicationId: string, userId: string, valor: VoteValue) {
    if (valor !== 1 && valor !== -1) throw new ApiException('VALIDATION_ERROR');
    return this.write(publicationId, userId, valor);
  }

  async remove(publicationId: string, userId: string) {
    return this.write(publicationId, userId, null);
  }

  private async write(publicationId: string, userId: string, valor: VoteValue | null) {
    await this.activeUser(userId);
    const publication = await this.accessiblePublication(publicationId, userId);
    const claim = await this.claimVote(publicationId, userId);
    let reservation: Reservation;
    try {
      reservation = await this.reservePublication(publicationId, userId, publication, claim);
    } catch (error) {
      if (error instanceof ApiException && error.getStatus() !== 503)
        await this.clearVoteClaim(publicationId, userId, claim.token).catch(() => undefined);
      throw error;
    }

    let applied;
    try {
      applied = await this.votos.updateOne(
        {
          publicacao_id: new Types.ObjectId(publicationId),
          usuario_id: new Types.ObjectId(userId),
          revisao: claim.revision,
          'operacao.token': claim.token,
          'operacao.estado': 'reservada',
          $expr: { $gt: ['$operacao.expira_em', '$$NOW'] },
        },
        {
          $set: { valor, 'operacao.estado': 'aplicada' },
          $inc: { revisao: 1 },
        },
        { runValidators: true },
      ).exec();
    } catch {
      await this.invalidate(publicationId, reservation.authorId);
      throw new ApiException('VOTO_WRITE_UNAVAILABLE');
    }
    if (applied.modifiedCount !== 1) {
      await this.invalidate(publicationId, reservation.authorId);
      throw new ApiException('VOTO_OPERATION_PENDING');
    }

    try {
      await this.releasePublication(publicationId, claim.token);
      const contadores = await this.reconcileCounter(publicationId);
      await this.clearVoteClaim(publicationId, userId, claim.token).catch(() => undefined);
      return { valor, contadores };
    } catch {
      await this.invalidate(publicationId, reservation.authorId);
      throw new ApiException('VOTO_OPERATION_PENDING');
    }
  }

  private async activeUser(userId: string) {
    let user;
    try {
      user = await this.usuarios.findOne({
        _id: new Types.ObjectId(userId),
        status: 'ativo',
      }).select('_id').exec();
    } catch {
      throw new ApiException('VOTO_WRITE_UNAVAILABLE');
    }
    if (!user) throw new ApiException('VOTO_USER_INACTIVE');
  }

  private async accessiblePublication(publicationId: string, userId: string) {
    const publication = await this.publicacoes.findOne({
      _id: new Types.ObjectId(publicationId),
      status: 'publicada',
    }).select('autor_id status visibilidade').exec();
    if (!publication || !await this.access.canRead(publication, userId))
      throw new ApiException('PUBLICACAO_NOT_FOUND');
    return publication;
  }

  private async claimVote(publicationId: string, userId: string): Promise<Claim> {
    const pair = {
      publicacao_id: new Types.ObjectId(publicationId),
      usuario_id: new Types.ObjectId(userId),
    };
    const createdAt = new Date();
    try {
      await this.votos.updateOne(pair, {
        $setOnInsert: {
          valor: null,
          revisao: 0,
          operacao: null,
          criado_em: createdAt,
          atualizado_em: createdAt,
        },
      }, { upsert: true, timestamps: false }).exec();
    } catch (error) {
      if (!this.duplicateKey(error)) throw new ApiException('VOTO_WRITE_UNAVAILABLE');
    }
    const token = randomUUID();
    let claimed: VotoDocument | null;
    try {
      claimed = await this.votos.findOneAndUpdate(
        {
          ...pair,
          $or: [
            { operacao: null },
            { $expr: { $lte: ['$operacao.expira_em', '$$NOW'] } },
          ],
        },
        [{ $set: {
          operacao: {
            token,
            expira_em: { $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: LEASE_MS } },
            estado: 'reservada',
          },
          revisao: { $add: [{ $ifNull: ['$revisao', 0] }, 1] },
        } }],
        { new: true, timestamps: false, updatePipeline: true },
      ).exec();
    } catch {
      throw new ApiException('VOTO_WRITE_UNAVAILABLE');
    }
    if (!claimed?.operacao) throw new ApiException('VOTO_OPERATION_PENDING');
    return { token, revision: claimed.revisao, expiresAt: claimed.operacao.expira_em };
  }

  private async reservePublication(
    publicationId: string,
    userId: string,
    publication: PublicacaoDocument,
    claim: Claim,
  ): Promise<Reservation> {
    let result;
    try {
      result = await this.publicacoes.updateOne(
        {
          _id: new Types.ObjectId(publicationId),
          'votos_operacoes_pendentes.usuario_id': { $ne: new Types.ObjectId(userId) },
          $expr: { $lt: [{ $size: { $ifNull: ['$votos_operacoes_pendentes', []] } }, 128] },
          ...this.access.writeFilter(publication),
        },
        {
          $push: { votos_operacoes_pendentes: {
            usuario_id: new Types.ObjectId(userId),
            token: claim.token,
            expira_em: claim.expiresAt,
          } },
          $set: { votos_projecao_pendente: true },
          $min: { votos_proxima_tentativa_em: claim.expiresAt },
          $inc: { votos_revisao: 1 },
        },
        { timestamps: false },
      ).exec();
    } catch {
      throw new ApiException('VOTO_WRITE_UNAVAILABLE');
    }
    if (result.modifiedCount !== 1) {
      await this.clearVoteClaim(publicationId, userId, claim.token).catch(() => undefined);
      await this.accessiblePublication(publicationId, userId);
      throw new ApiException('VOTO_OPERATION_PENDING');
    }
    return { ...claim, authorId: publication.autor_id.toString() };
  }

  private async releasePublication(publicationId: string, token: string) {
    const result = await this.publicacoes.updateOne(
      { _id: new Types.ObjectId(publicationId), 'votos_operacoes_pendentes.token': token },
      {
        $pull: { votos_operacoes_pendentes: { token } },
        $min: { votos_proxima_tentativa_em: new Date() },
        $inc: { votos_revisao: 1 },
      },
      { timestamps: false },
    ).exec();
    if (result.modifiedCount !== 1) throw new ApiException('VOTO_OPERATION_PENDING');
  }

  private async clearVoteClaim(publicationId: string, userId: string, token: string) {
    await this.votos.updateOne(
      {
        publicacao_id: new Types.ObjectId(publicationId),
        usuario_id: new Types.ObjectId(userId),
        'operacao.token': token,
      },
      { $set: { operacao: null } },
      { timestamps: false },
    ).exec();
  }

  private duplicateKey(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
  }

  private async invalidate(publicationId: string, authorId: string) {
    await this.cache.invalidate(publicationId, authorId).catch(() => undefined);
  }

  private async countVotes(publicationId: string): Promise<VoteCounts> {
    const totals = await this.votos.aggregate<{ _id: VoteValue; total: number }>([
      { $match: { publicacao_id: new Types.ObjectId(publicationId), valor: { $in: [1, -1] } } },
      { $group: { _id: '$valor', total: { $sum: 1 } } },
    ]).exec();
    const upvotes = totals.find((item) => item._id === 1)?.total ?? 0;
    const downvotes = totals.find((item) => item._id === -1)?.total ?? 0;
    return { upvotes, downvotes, score: upvotes - downvotes };
  }

  async reconcileCounter(publicationId: string): Promise<VoteCounts> {
    const publication = await this.publicacoes.findById(publicationId)
      .select('autor_id contadores votos_revisao votos_operacoes_pendentes votos_projecao_pendente').exec();
    if (!publication) throw new ApiException('PUBLICACAO_NOT_FOUND');
    if (publication.votos_operacoes_pendentes?.length)
      throw new ApiException('VOTO_OPERATION_PENDING');
    const revision = publication.votos_revisao ?? 0;
    const counts = await this.countVotes(publicationId);
    if (
      !publication.votos_projecao_pendente &&
      publication.contadores.upvotes === counts.upvotes &&
      publication.contadores.downvotes === counts.downvotes &&
      publication.contadores.score === counts.score
    ) return counts;
    const result = await this.publicacoes.updateOne(
      {
        _id: publication._id,
        votos_revisao: revision === 0 ? { $in: [0, null] } : revision,
        $or: [
          { votos_operacoes_pendentes: { $size: 0 } },
          { votos_operacoes_pendentes: { $exists: false } },
        ],
      },
      {
        $set: {
          'contadores.upvotes': counts.upvotes,
          'contadores.downvotes': counts.downvotes,
          'contadores.score': counts.score,
          votos_projecao_pendente: false,
          votos_proxima_tentativa_em: FAR_FUTURE,
        },
        $inc: { votos_revisao: 1 },
      },
    ).exec();
    if (result.modifiedCount !== 1) throw new ApiException('VOTO_OPERATION_PENDING');
    await this.invalidate(publicationId, publication.autor_id.toString());
    await this.creatorStats?.refresh(publication.autor_id.toString()).catch(() => undefined);
    return counts;
  }

  private async recoverExpired(publication: PublicacaoDocument) {
    let released = 0;
    for (const pending of publication.votos_operacoes_pendentes ?? []) {
      if (pending.expira_em.getTime() > Date.now()) continue;
      const active = await this.votos.findOne({
        publicacao_id: publication._id,
        usuario_id: pending.usuario_id,
        'operacao.token': pending.token,
        $expr: { $gt: ['$operacao.expira_em', '$$NOW'] },
      }).select('_id').lean().exec();
      if (active) continue;
      const result = await this.publicacoes.updateOne(
        { _id: publication._id, 'votos_operacoes_pendentes.token': pending.token },
        {
          $pull: { votos_operacoes_pendentes: { token: pending.token } },
          $inc: { votos_revisao: 1 },
        },
        { timestamps: false },
      ).exec();
      if (result.modifiedCount === 1) released++;
      await this.votos.updateOne(
        {
          publicacao_id: publication._id,
          usuario_id: pending.usuario_id,
          'operacao.token': pending.token,
          $expr: { $lte: ['$operacao.expira_em', '$$NOW'] },
        },
        { $set: { operacao: null } },
        { timestamps: false },
      ).exec();
    }
    return released;
  }

  async recoverPendingBatch(): Promise<number> {
    if (this.recovering) return 0;
    this.recovering = true;
    try {
      const startedAt = Date.now();
      let processed = 0;
      let failed = 0;
      let rescheduleFailed = 0;
      const now = new Date();
      const publications = await this.publicacoes.find({
        votos_projecao_pendente: true,
        $or: [
          { votos_proxima_tentativa_em: { $lte: now } },
          { votos_proxima_tentativa_em: null },
        ],
      }).sort({ votos_proxima_tentativa_em: 1, _id: 1 })
        .limit(RECOVERY_BATCH).select('_id votos_revisao votos_operacoes_pendentes').exec();
      for (const publication of publications) {
        const id = publication._id.toString();
        try {
          await this.recoverExpired(publication);
          await this.reconcileCounter(id);
          processed++;
        } catch {
          failed++;
          if (!(await this.reschedulePending(publication._id).catch(() => false)))
            rescheduleFailed++;
        }
      }
      if (failed) this.warnRecovery(
        `Lote de votos: examinadas=${publications.length}, concluidas=${processed}, falhas=${failed}, reagendamento_falhou=${rescheduleFailed}, duracao_ms=${Date.now() - startedAt}.`,
      );
      if (++this.cycles % 10 === 0) await this.auditLegacyBatch();
      return publications.length;
    } finally {
      this.recovering = false;
    }
  }

  private warnRecovery(message: string) {
    this.suppressedRecoveryWarnings++;
    const now = Date.now();
    if (this.lastRecoveryWarningAt !== null && now - this.lastRecoveryWarningAt < 300_000)
      return;
    try {
      this.logger.warn(`${message} eventos_com_falha=${this.suppressedRecoveryWarnings}`);
    } catch {}
    this.lastRecoveryWarningAt = now;
    this.suppressedRecoveryWarnings = 0;
  }

  private async reschedulePending(id: Types.ObjectId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.publicacoes.findById(id)
        .select('votos_revisao votos_projecao_pendente votos_proxima_tentativa_em')
        .lean().exec();
      if (!current || !current.votos_projecao_pendente) return true;
      if (current.votos_proxima_tentativa_em && current.votos_proxima_tentativa_em > new Date())
        return true;
      const rescheduled = await this.publicacoes.updateOne(
        {
          _id: id,
          votos_projecao_pendente: true,
          votos_revisao: current.votos_revisao ?? null,
          votos_proxima_tentativa_em: current.votos_proxima_tentativa_em ?? null,
        },
        { $set: { votos_proxima_tentativa_em: new Date(Date.now() + 60_000) } },
        { timestamps: false },
      ).exec();
      if (rescheduled.modifiedCount === 1) return true;
    }
    return false;
  }

  async auditLegacyBatch(): Promise<number> {
    const publications = await this.publicacoes.find({})
      .sort({ votos_auditoria_em: 1, _id: 1 }).limit(25)
      .select('_id').lean().exec();
    let reconcileFailed = 0;
    let auditUpdateFailed = 0;
    for (const publication of publications) {
      await this.reconcileCounter(publication._id.toString()).catch(() => { reconcileFailed++; });
      await this.publicacoes.updateOne(
        { _id: publication._id },
        { $set: { votos_auditoria_em: new Date() } },
        { timestamps: false },
      ).exec().catch(() => { auditUpdateFailed++; });
    }
    if (reconcileFailed || auditUpdateFailed) this.warnRecovery(
      `Auditoria de votos: examinadas=${publications.length}, reconciliacao_falhou=${reconcileFailed}, atualizacao_falhou=${auditUpdateFailed}.`,
    );
    return publications.length;
  }
}
