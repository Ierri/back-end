import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import { PublicacaoAccessService } from './publicacao-access.service.js';
import { PublicacoesCacheService } from './publicacoes-cache.service.js';
import { PublicacoesService } from './publicacoes.service.js';
import { PublicacaoSalva } from './schemas/publicacao-salva.schema.js';
import { Publicacao } from './schemas/publicacao.schema.js';
import type { PublicacaoDocument } from './schemas/publicacao.schema.js';
import { SalvosCursor } from './salvos.cursor.js';
import type { ListSalvosDto } from './dto/salvos.dto.js';

const FAR_FUTURE = new Date('9999-12-31T23:59:59.999Z');
const LEASE_MS = 120_000;

type SavedRow = {
  _id: Types.ObjectId;
  criado_em: Date;
  publication: Publicacao;
  author: Usuario;
};

@Injectable()
export class SalvosService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SalvosService.name);
  private timer?: ReturnType<typeof setInterval>;
  private recovering = false;
  private cycles = 0;

  constructor(
    @InjectModel(PublicacaoSalva.name) private readonly salvos: Model<PublicacaoSalva>,
    @InjectModel(Publicacao.name) private readonly publicacoes: Model<Publicacao>,
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
    @Inject(PublicacaoAccessService) private readonly access: PublicacaoAccessService,
    @Inject(PublicacoesCacheService) private readonly cache: PublicacoesCacheService,
    @Inject(PublicacoesService) private readonly publicationResponses: PublicacoesService,
    @Inject(SalvosCursor) private readonly cursor: SalvosCursor,
  ) {}

  onModuleInit() {
    void this.recoverPendingBatch().catch(() => this.logger.warn('Falha na recuperação de salvamentos.'));
    this.timer = setInterval(() => {
      void this.recoverPendingBatch().catch(() => this.logger.warn('Falha na recuperação de salvamentos.'));
    }, 30_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async activeUser(userId: string) {
    const active = await this.usuarios.exists({ _id: new Types.ObjectId(userId), status: 'ativo' });
    if (!active) throw new ApiException('AUTH_REQUIRED');
  }

  private pair(publicationId: string, userId: string) {
    return { publicacao_id: new Types.ObjectId(publicationId), usuario_id: new Types.ObjectId(userId) };
  }

  private async accessiblePublication(publicationId: string, userId: string) {
    const publication = await this.publicacoes.findOne({ _id: new Types.ObjectId(publicationId), status: 'publicada' })
      .select('autor_id status visibilidade').exec();
    if (!publication || !await this.access.canRead(publication, userId))
      throw new ApiException('PUBLICACAO_NOT_FOUND');
    return publication;
  }

  async get(publicationId: string, userId: string) {
    await this.activeUser(userId);
    await this.accessiblePublication(publicationId, userId);
    return { salvo: Boolean(await this.salvos.exists(this.pair(publicationId, userId))) };
  }

  async put(publicationId: string, userId: string) {
    await this.activeUser(userId);
    const publication = await this.accessiblePublication(publicationId, userId);
    return this.write(publicationId, userId, publication, true);
  }

  async remove(publicationId: string, userId: string) {
    await this.activeUser(userId);
    const publication = await this.publicacoes.findById(publicationId).select('autor_id status visibilidade').exec();
    if (!publication) {
      try {
        await this.salvos.deleteOne(this.pair(publicationId, userId)).exec();
      } catch {
        throw new ApiException('SALVO_WRITE_UNAVAILABLE');
      }
      return { salvo: false };
    }
    return this.write(publicationId, userId, publication, false);
  }

  private async reserve(publication: PublicacaoDocument, userId: string, requiredAccess: boolean) {
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + LEASE_MS);
    let result;
    try {
      result = await this.publicacoes.updateOne(
      {
        _id: publication._id,
        ...(requiredAccess ? this.access.writeFilter(publication) : {}),
        $expr: { $lt: [{ $size: { $ifNull: ['$salvamentos_operacoes_pendentes', []] } }, 128] },
      },
      {
        $push: { salvamentos_operacoes_pendentes: { token, expira_em: expiresAt } },
        $set: { salvamentos_projecao_pendente: true },
        $min: { salvamentos_proxima_tentativa_em: expiresAt },
        $inc: { salvamentos_revisao: 1 },
      },
      { timestamps: false },
      ).exec();
    } catch {
      throw new ApiException('SALVO_WRITE_UNAVAILABLE');
    }
    if (result.modifiedCount !== 1) {
      if (requiredAccess) await this.accessiblePublication(publication._id.toString(), userId);
      throw new ApiException('SALVO_OPERATION_PENDING');
    }
    return token;
  }

  private async release(publicationId: string, token: string) {
    const result = await this.publicacoes.updateOne(
      { _id: new Types.ObjectId(publicationId), 'salvamentos_operacoes_pendentes.token': token },
      {
        $pull: { salvamentos_operacoes_pendentes: { token } },
        $min: { salvamentos_proxima_tentativa_em: new Date() },
        $inc: { salvamentos_revisao: 1 },
      },
      { timestamps: false },
    ).exec();
    if (result.modifiedCount !== 1) throw new ApiException('SALVO_OPERATION_PENDING');
  }

  private async write(publicationId: string, userId: string, publication: PublicacaoDocument, save: boolean) {
    const token = await this.reserve(publication, userId, save);
    const pair = this.pair(publicationId, userId);
    try {
      let changed: boolean;
      if (save) {
        try {
          const result = await this.salvos.updateOne(pair, { $setOnInsert: pair }, { upsert: true }).exec();
          changed = result.upsertedCount === 1;
        } catch (error) {
          if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000 ||
            !await this.salvos.exists(pair)) throw error;
          changed = false;
        }
      } else {
        const result = await this.salvos.deleteOne(pair).exec();
        changed = result.deletedCount === 1;
      }
      if (changed) {
        const updated = await this.publicacoes.updateOne(
          {
            _id: publication._id,
            'salvamentos_operacoes_pendentes.token': token,
            ...(!save ? { 'contadores.salvamentos': { $gt: 0 } } : {}),
          },
          { $inc: { 'contadores.salvamentos': save ? 1 : -1, salvamentos_revisao: 1 } },
          { timestamps: false },
        ).exec();
        if (updated.modifiedCount !== 1) throw new ApiException('SALVO_OPERATION_PENDING');
      }
      await this.release(publicationId, token);
      if (changed) await this.cache.invalidate(publicationId, publication.autor_id.toString()).catch(() => undefined);
      await this.reconcileCounter(publicationId).catch(() => undefined);
      return { salvo: save };
    } catch {
      await this.cache.invalidate(publicationId, publication.autor_id.toString()).catch(() => undefined);
      throw new ApiException('SALVO_WRITE_UNAVAILABLE');
    }
  }

  async list(userId: string, query: ListSalvosDto) {
    await this.activeUser(userId);
    const position = query.cursor ? this.cursor.decode(query.cursor, userId) : null;
    const visibility = await this.access.listVisibility(userId);
    const found = await this.salvos.aggregate<SavedRow>([
      { $match: {
        usuario_id: new Types.ObjectId(userId),
        ...(position ? { $or: [
          { criado_em: { $lt: position.savedAt } },
          { criado_em: position.savedAt, _id: { $lt: position.id } },
        ] } : {}),
      } },
      { $sort: { criado_em: -1, _id: -1 } },
      { $lookup: {
        from: 'publicacoes', localField: 'publicacao_id', foreignField: '_id',
        pipeline: [{ $match: { status: 'publicada', ...visibility } }],
        as: 'publication',
      } },
      { $unwind: '$publication' },
      { $lookup: {
        from: 'usuarios', localField: 'publication.autor_id', foreignField: '_id',
        pipeline: [{ $match: { status: 'ativo' } }],
        as: 'author',
      } },
      { $unwind: '$author' },
      { $limit: query.limite + 1 },
    ]).exec();
    const hasMore = found.length > query.limite;
    const page = found.slice(0, query.limite);
    const last = page.at(-1);
    return {
      items: page.map((item) => ({
        ...this.publicationResponses.toResponse(
          this.publicacoes.hydrate(item.publication),
          this.usuarios.hydrate(item.author), userId,
        ),
        salvaEm: item.criado_em,
      })),
      nextCursor: hasMore && last ? this.cursor.encode({ savedAt: last.criado_em, id: last._id }, userId) : null,
      hasMore,
    };
  }

  async reconcileCounter(publicationId: string) {
    const publication = await this.publicacoes.findById(publicationId)
      .select('autor_id contadores salvamentos_revisao salvamentos_projecao_pendente salvamentos_operacoes_pendentes').exec();
    if (!publication) return 0;
    if (publication.salvamentos_operacoes_pendentes?.length)
      throw new ApiException('SALVO_OPERATION_PENDING');
    const revision = publication.salvamentos_revisao ?? 0;
    const count = await this.salvos.countDocuments({ publicacao_id: publication._id }).exec();
    if (!publication.salvamentos_projecao_pendente && publication.contadores.salvamentos === count)
      return count;
    const updated = await this.publicacoes.updateOne(
      {
        _id: publication._id,
        salvamentos_revisao: revision === 0 ? { $in: [0, null] } : revision,
        $or: [
          { salvamentos_operacoes_pendentes: { $size: 0 } },
          { salvamentos_operacoes_pendentes: { $exists: false } },
        ],
      },
      { $set: {
        'contadores.salvamentos': count,
        salvamentos_projecao_pendente: false,
        salvamentos_proxima_tentativa_em: FAR_FUTURE,
      }, $inc: { salvamentos_revisao: 1 } },
      { timestamps: false },
    ).exec();
    if (updated.modifiedCount !== 1) throw new ApiException('SALVO_OPERATION_PENDING');
    await this.cache.invalidate(publicationId, publication.autor_id.toString());
    return count;
  }

  async recoverPendingBatch() {
    if (this.recovering) return 0;
    this.recovering = true;
    try {
      const now = new Date();
      const publications = await this.publicacoes.find({
        salvamentos_projecao_pendente: true,
        $or: [
          { salvamentos_proxima_tentativa_em: { $lte: now } },
          { salvamentos_proxima_tentativa_em: null },
        ],
      }).sort({ salvamentos_proxima_tentativa_em: 1, _id: 1 }).limit(100)
        .select('_id salvamentos_operacoes_pendentes').exec();
      for (const publication of publications) {
        try {
          for (const pending of publication.salvamentos_operacoes_pendentes ?? []) {
            if (pending.expira_em > now) continue;
            await this.publicacoes.updateOne(
              { _id: publication._id, salvamentos_operacoes_pendentes: {
                $elemMatch: { token: pending.token, expira_em: { $lte: now } },
              } },
              { $pull: { salvamentos_operacoes_pendentes: { token: pending.token } },
                $inc: { salvamentos_revisao: 1 } },
              { timestamps: false },
            ).exec();
          }
          await this.reconcileCounter(publication._id.toString());
        } catch {
          await this.reschedule(publication._id).catch(() => undefined);
        }
      }
      if (++this.cycles % 10 === 0) await this.auditLegacyBatch();
      return publications.length;
    } finally {
      this.recovering = false;
    }
  }

  private async reschedule(id: Types.ObjectId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.publicacoes.findById(id)
        .select('salvamentos_revisao salvamentos_projecao_pendente salvamentos_proxima_tentativa_em')
        .lean().exec();
      if (!current || !current.salvamentos_projecao_pendente) return;
      const updated = await this.publicacoes.updateOne(
        { _id: id, salvamentos_revisao: current.salvamentos_revisao ?? null,
          salvamentos_projecao_pendente: true,
          salvamentos_proxima_tentativa_em: current.salvamentos_proxima_tentativa_em ?? null },
        { $set: { salvamentos_proxima_tentativa_em: new Date(Date.now() + 60_000) } },
        { timestamps: false },
      ).exec();
      if (updated.modifiedCount === 1) return;
    }
  }

  async auditLegacyBatch() {
    const publications = await this.publicacoes.find({})
      .sort({ salvamentos_auditoria_em: 1, _id: 1 }).limit(25).select('_id').lean().exec();
    for (const publication of publications) {
      await this.reconcileCounter(publication._id.toString()).catch(() => undefined);
      await this.publicacoes.updateOne(
        { _id: publication._id }, { $set: { salvamentos_auditoria_em: new Date() } },
        { timestamps: false },
      ).exec().catch(() => undefined);
    }
    return publications.length;
  }
}
