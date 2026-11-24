import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { ComentariosService } from '../comentarios/comentarios.service.js';
import { Comentario } from '../comentarios/schemas/comentario.schema.js';
import { PublicacoesCacheService } from '../publicacoes/publicacoes-cache.service.js';
import { Publicacao } from '../publicacoes/schemas/publicacao.schema.js';
import { CreatorStatsService } from '../usuarios/creator-stats.service.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import type { CommentModerationDto, HistoryQueryDto, PublicationModerationDto,
  UserModerationDto } from './dto/moderacao.dto.js';
import { ModeracaoCursor } from './moderacao.cursor.js';
import { Denuncia } from './schemas/denuncia.schema.js';
import { ModeracaoHistorico } from './schemas/moderacao-historico.schema.js';

type TargetType = 'usuario' | 'publicacao' | 'comentario';
type Marker = { id: string; responsavel: string; anterior: string; novo: string;
  justificativa: string; denunciaId: string | null; criadaEm: Date };

@Injectable()
export class ModeracaoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModeracaoService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly after: Record<'report' | 'post' | 'comment' | 'user', Types.ObjectId | null> = {
    report: null, post: null, comment: null, user: null,
  };

  constructor(
    @InjectModel(Denuncia.name) private readonly reports: Model<Denuncia>,
    @InjectModel(ModeracaoHistorico.name) private readonly history: Model<ModeracaoHistorico>,
    @InjectModel(Usuario.name) private readonly users: Model<Usuario>,
    @InjectModel(Publicacao.name) private readonly posts: Model<Publicacao>,
    @InjectModel(Comentario.name) private readonly comments: Model<Comentario>,
    @Inject(PublicacoesCacheService) private readonly cache: PublicacoesCacheService,
    @Inject(CreatorStatsService) private readonly creators: CreatorStatsService,
    @Inject(ComentariosService) private readonly commentService: ComentariosService,
    @Inject(ModeracaoCursor) private readonly cursor: ModeracaoCursor,
  ) {}

  onModuleInit() {
    void this.recoverBatch().catch(() => this.logger.warn('Falha na recuperação da moderação.'));
    this.timer = setInterval(() => {
      void this.recoverBatch().catch(() => this.logger.warn('Falha na recuperação da moderação.'));
    }, 30_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async moderatePost(id: string, actor: string, body: PublicationModerationDto) {
    const post = await this.posts.findById(id).select('status autor_id').lean().exec();
    if (!post || !['publicada', 'oculta'].includes(post.status) || post.status === body.status)
      throw new ApiException('MODERACAO_TRANSICAO_INVALIDA');
    await this.assertReport(body.denunciaId, 'publicacao', id);
    const marker = this.marker(actor, post.status, body.status, body.justificativa, body.denunciaId);
    const result = await this.posts.updateOne({ _id: post._id, status: post.status,
      moderacao_pendente: null }, { $set: { status: body.status, moderacao_pendente: marker } },
    { runValidators: true }).exec();
    if (result.modifiedCount !== 1) throw new ApiException('MODERACAO_CONCORRENTE');
    await this.flushPost(id).catch(() => undefined);
    return { id, status: body.status };
  }

  async moderateComment(id: string, actor: string, body: CommentModerationDto) {
    const comment = await this.comments.findById(id)
      .select('status publicacao_id criacao_estado').lean().exec();
    if (!comment || comment.criacao_estado === 'pendente' || comment.criacao_estado === 'falhou' ||
      !['publicado', 'oculto'].includes(comment.status) || comment.status === body.status)
      throw new ApiException('MODERACAO_TRANSICAO_INVALIDA');
    await this.assertReport(body.denunciaId, 'comentario', id);
    const marker = this.marker(actor, comment.status, body.status, body.justificativa, body.denunciaId);
    const result = await this.comments.updateOne({ _id: comment._id, status: comment.status,
      moderacao_pendente: null }, { $set: { status: body.status, moderacao_pendente: marker } },
    { runValidators: true }).exec();
    if (result.modifiedCount !== 1) throw new ApiException('MODERACAO_CONCORRENTE');
    await this.flushComment(id).catch(() => undefined);
    return { id, status: body.status };
  }

  async moderateUser(id: string, actorId: string, body: UserModerationDto) {
    if (id.toLowerCase() === actorId.toLowerCase()) throw new ApiException('MODERACAO_SEM_PERMISSAO');
    const [actor, target] = await Promise.all([
      this.users.findById(actorId).select('papeis status').lean().exec(),
      this.users.findById(id).select('papeis status').lean().exec(),
    ]);
    if (!actor || actor.status !== 'ativo' || !target ||
      !['ativo', 'bloqueado'].includes(target.status) || target.status === body.status)
      throw new ApiException('MODERACAO_TRANSICAO_INVALIDA');
    if (target.papeis?.includes('administrador') ||
      (target.papeis?.includes('moderador') && !actor.papeis?.includes('administrador')))
      throw new ApiException('MODERACAO_SEM_PERMISSAO');
    await this.assertReport(body.denunciaId, 'usuario', id);
    const marker = this.marker(actorId, target.status, body.status, body.justificativa, body.denunciaId);
    const result = await this.users.updateOne({ _id: target._id, status: target.status,
      moderacao_pendente: null, papeis: target.papeis },
    { $set: { status: body.status, moderacao_pendente: marker },
      ...(body.status === 'bloqueado' ? { $inc: { auth_versao: 1 } } : {}) },
    { runValidators: true }).exec();
    if (result.modifiedCount !== 1) throw new ApiException('MODERACAO_CONCORRENTE');
    await this.flushUser(id).catch(() => undefined);
    return { id, status: body.status };
  }

  async historyList(query: HistoryQueryDto) {
    const scope = 'moderacao:historico';
    const position = query.cursor ? this.cursor.decode(query.cursor, scope) : null;
    const found = await this.history.find(position ? { $or: [
      { criada_em: { $lt: position.date } },
      { criada_em: position.date, _id: { $lt: position.id } },
    ] } : {}).sort({ criada_em: -1, _id: -1 }).limit(query.limite + 1).lean().exec();
    const page = found.slice(0, query.limite);
    const last = page.at(-1);
    const hasMore = found.length > query.limite;
    return { items: page.map((item) => ({ id: item._id.toString(),
      responsavelId: item.responsavel_id.toString(), alvoTipo: item.alvo_tipo,
      alvoId: item.alvo_id.toString(), acao: item.acao,
      estadoAnterior: item.estado_anterior, novoEstado: item.novo_estado,
      justificativa: item.justificativa, denunciaId: item.denuncia_id?.toString() ?? null,
      criadaEm: item.criada_em })), hasMore,
    nextCursor: hasMore && last ? this.cursor.encode(last.criada_em, last._id, scope) : null };
  }

  private marker(actor: string, previous: string, next: string,
    reason: string, report?: string): Marker {
    return { id: randomUUID(), responsavel: actor, anterior: previous, novo: next,
      justificativa: reason, denunciaId: report ?? null, criadaEm: new Date() };
  }

  private async assertReport(id: string | undefined, type: TargetType, target: string) {
    if (!id) return;
    if (!await this.reports.exists({ _id: new Types.ObjectId(id), alvo_tipo: type,
      alvo_id: new Types.ObjectId(target), status: 'aceita' }))
      throw new ApiException('DENUNCIA_NAO_ENCONTRADA');
  }

  private async insertHistory(data: Omit<ModeracaoHistorico, '_id'>) {
    try {
      await this.history.updateOne({ chave: data.chave }, { $setOnInsert: data },
        { upsert: true, timestamps: false }).exec();
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000)
        throw error;
    }
  }

  async flushReport(id: string) {
    const report = await this.reports.findOne({ _id: new Types.ObjectId(id), historico_pendente: true }).exec();
    if (!report?.moderador_id || !report.resolvida_em || !report.justificativa) return;
    await this.insertHistory({ chave: `denuncia:${id}`, responsavel_id: report.moderador_id,
      alvo_tipo: 'denuncia', alvo_id: report._id, acao: report.status,
      estado_anterior: 'pendente', novo_estado: report.status,
      justificativa: report.justificativa, denuncia_id: report._id, criada_em: report.resolvida_em });
    await this.reports.updateOne({ _id: report._id, historico_pendente: true },
      { $set: { historico_pendente: false } }, { timestamps: false }).exec();
  }

  private async flushPost(id: string) {
    const post = await this.posts.findById(id).select('autor_id moderacao_pendente').lean().exec();
    const marker = post?.moderacao_pendente as Marker | null | undefined;
    if (!post || !marker) return;
    await this.flushMarker('publicacao', id, marker);
    if (!await this.cache.invalidate(id, post.autor_id.toString()))
      throw new Error('Cache invalidation pending');
    await this.creators.refresh(post.autor_id.toString());
    await this.posts.updateOne({ _id: post._id, 'moderacao_pendente.id': marker.id },
      { $set: { moderacao_pendente: null } }, { timestamps: false }).exec();
  }

  private async flushComment(id: string) {
    const comment = await this.comments.findById(id)
      .select('publicacao_id moderacao_pendente').lean().exec();
    const marker = comment?.moderacao_pendente as Marker | null | undefined;
    if (!comment || !marker) return;
    await this.flushMarker('comentario', id, marker);
    await this.commentService.reconcileCounter(comment.publicacao_id.toString());
    await this.comments.updateOne({ _id: comment._id, 'moderacao_pendente.id': marker.id },
      { $set: { moderacao_pendente: null } }, { timestamps: false }).exec();
  }

  private async flushUser(id: string) {
    const user = await this.users.findById(id).select('moderacao_pendente').lean().exec();
    const marker = user?.moderacao_pendente as Marker | null | undefined;
    if (!user || !marker) return;
    await this.flushMarker('usuario', id, marker);
    if (!await this.cache.invalidateAuthor(id)) throw new Error('Cache invalidation pending');
    await this.users.updateOne({ _id: user._id, 'moderacao_pendente.id': marker.id },
      { $set: { moderacao_pendente: null } }, { timestamps: false }).exec();
  }

  private flushMarker(type: TargetType, id: string, marker: Marker) {
    return this.insertHistory({ chave: marker.id, responsavel_id: new Types.ObjectId(marker.responsavel),
      alvo_tipo: type, alvo_id: new Types.ObjectId(id), acao: marker.novo,
      estado_anterior: marker.anterior, novo_estado: marker.novo,
      justificativa: marker.justificativa,
      denuncia_id: marker.denunciaId ? new Types.ObjectId(marker.denunciaId) : null,
      criada_em: marker.criadaEm });
  }

  async recoverBatch() {
    if (this.running) return 0;
    this.running = true;
    try {
      let count = 0;
      const reports = await this.reports.find({ historico_pendente: true,
        ...(this.after.report ? { _id: { $gt: this.after.report } } : {}) })
        .sort({ _id: 1 }).limit(50).select('_id').lean().exec();
      for (const item of reports) {
        await this.flushReport(item._id.toString()).catch(() => undefined);
        count++;
      }
      this.after.report = reports.length === 50 ? reports[49]._id : null;
      const posts = await this.posts.find({ 'moderacao_pendente.id': { $exists: true },
        ...(this.after.post ? { _id: { $gt: this.after.post } } : {}) })
        .sort({ _id: 1 }).limit(50).select('_id').lean().exec();
      for (const item of posts) {
        await this.flushPost(item._id.toString()).catch(() => undefined);
        count++;
      }
      this.after.post = posts.length === 50 ? posts[49]._id : null;
      const comments = await this.comments.find({ 'moderacao_pendente.id': { $exists: true },
        ...(this.after.comment ? { _id: { $gt: this.after.comment } } : {}) })
        .sort({ _id: 1 }).limit(50).select('_id').lean().exec();
      for (const item of comments) {
        await this.flushComment(item._id.toString()).catch(() => undefined);
        count++;
      }
      this.after.comment = comments.length === 50 ? comments[49]._id : null;
      const users = await this.users.find({ 'moderacao_pendente.id': { $exists: true },
        ...(this.after.user ? { _id: { $gt: this.after.user } } : {}) })
        .sort({ _id: 1 }).limit(50).select('_id').lean().exec();
      for (const item of users) {
        await this.flushUser(item._id.toString()).catch(() => undefined);
        count++;
      }
      this.after.user = users.length === 50 ? users[49]._id : null;
      return count;
    } finally {
      this.running = false;
    }
  }
}
