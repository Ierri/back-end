import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { Publicacao } from '../publicacoes/schemas/publicacao.schema.js';
import { Usuario } from './schemas/usuario.schema.js';
import { CreatorRankingCursor } from './creator-ranking.cursor.js';
import type { RankingDto } from './dto/ranking.dto.js';

const FAR_FUTURE = new Date('9999-12-31T23:59:59.999Z');

@Injectable()
export class CreatorStatsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CreatorStatsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private recovering = false;

  constructor(
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
    @InjectModel(Publicacao.name) private readonly publicacoes: Model<Publicacao>,
    @Inject(CreatorRankingCursor) private readonly cursor: CreatorRankingCursor,
  ) {}

  onModuleInit() {
    void this.recoverBatch().catch(() => this.logger.warn('Falha na recuperação dos contadores de criadores.'));
    this.timer = setInterval(() => {
      void this.recoverBatch().catch(() => this.logger.warn('Falha na recuperação dos contadores de criadores.'));
    }, 30_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async markDirty(userId: string) {
    await this.usuarios.updateOne(
      { _id: new Types.ObjectId(userId) },
      { $set: { criador_projecao_pendente: true, criador_proxima_tentativa_em: new Date() },
        $inc: { criador_revisao: 1 } },
      { timestamps: false },
    ).exec();
  }

  async refresh(userId: string) {
    await this.markDirty(userId);
    await this.reconcile(userId);
  }

  async publicPublicationCount(userId: string) {
    return this.publicacoes.countDocuments({
      autor_id: new Types.ObjectId(userId), status: 'publicada', visibilidade: 'publico',
    }).exec();
  }

  async ranking(query: RankingDto) {
    const position = query.cursor ? this.cursor.decode(query.cursor) : null;
    const found = await this.usuarios.find({
      status: 'ativo', visibilidade_perfil: { $ne: 'privado' },
      ...(position ? { $or: [
        { 'contadores.score': { $lt: position.score } },
        { 'contadores.score': position.score, _id: { $lt: position.id } },
      ] } : {}),
    }).sort({ 'contadores.score': -1, _id: -1 }).limit(query.limite + 1)
      .select('_id nome username avatar_url contadores.score').lean().exec();
    const page = found.slice(0, query.limite);
    const last = page.at(-1);
    const hasMore = found.length > query.limite;
    return {
      items: page.map((user) => ({ id: user._id.toString(), nome: user.nome,
        username: user.username, avatarUrl: user.avatar_url ?? null, score: user.contadores?.score ?? 0 })),
      nextCursor: hasMore && last ? this.cursor.encode({ score: last.contadores?.score ?? 0, id: last._id }) : null,
      hasMore,
    };
  }

  async reconcile(userId: string) {
    const id = new Types.ObjectId(userId);
    const user = await this.usuarios.findById(id)
      .select('criador_revisao criador_projecao_pendente contadores.publicacoes contadores.score').lean().exec();
    if (!user) return null;
    const totals = await this.publicacoes.aggregate<{ _id: null; publicacoes: number; score: number }>([
      { $match: { autor_id: id, status: 'publicada' } },
      { $group: { _id: null, publicacoes: { $sum: 1 }, score: {
        $sum: { $cond: [{ $eq: ['$visibilidade', 'publico'] }, { $ifNull: ['$contadores.score', 0] }, 0] },
      } } },
    ]).exec();
    const counts = { publicacoes: totals[0]?.publicacoes ?? 0, score: totals[0]?.score ?? 0 };
    if (!user.criador_projecao_pendente &&
      user.contadores?.publicacoes === counts.publicacoes && user.contadores?.score === counts.score)
      return counts;
    const revision = user.criador_revisao ?? 0;
    const updated = await this.usuarios.updateOne(
      { _id: id, criador_revisao: revision === 0 ? { $in: [0, null] } : revision },
      { $set: { 'contadores.publicacoes': counts.publicacoes, 'contadores.score': counts.score,
        criador_projecao_pendente: false, criador_proxima_tentativa_em: FAR_FUTURE },
        $inc: { criador_revisao: 1 } },
      { timestamps: false },
    ).exec();
    if (updated.modifiedCount !== 1) throw new Error('Creator statistics changed concurrently');
    return counts;
  }

  async recoverBatch() {
    if (this.recovering) return 0;
    this.recovering = true;
    try {
      const due = await this.usuarios.find({ criador_projecao_pendente: true,
        criador_proxima_tentativa_em: { $lte: new Date() } })
        .sort({ criador_proxima_tentativa_em: 1, _id: 1 }).limit(100).select('_id').lean().exec();
      for (const user of due) {
        try {
          await this.reconcile(user._id.toString());
        } catch {
          const current = await this.usuarios.findById(user._id)
            .select('criador_revisao criador_projecao_pendente criador_proxima_tentativa_em')
            .lean().exec().catch(() => null);
          if (current?.criador_projecao_pendente)
            await this.usuarios.updateOne({ _id: user._id,
              criador_revisao: current.criador_revisao ?? null,
              criador_proxima_tentativa_em: current.criador_proxima_tentativa_em ?? null },
            { $set: { criador_proxima_tentativa_em: new Date(Date.now() + 60_000) } },
            { timestamps: false }).exec().catch(() => undefined);
        }
      }
      const legacy = await this.usuarios.find({})
        .sort({ criador_auditoria_em: 1, _id: 1 }).limit(25).select('_id').lean().exec();
      for (const user of legacy) {
        await this.reconcile(user._id.toString()).catch(() => undefined);
        await this.usuarios.updateOne({ _id: user._id },
          { $set: { criador_auditoria_em: new Date() } },
          { timestamps: false }).exec().catch(() => undefined);
      }
      return due.length + legacy.length;
    } finally {
      this.recovering = false;
    }
  }
}
