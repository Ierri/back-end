import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model, PipelineStage } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { PublicacaoAccessService } from '../publicacoes/publicacao-access.service.js';
import { Notificacao } from './schemas/notificacao.schema.js';
import { NotificacoesCursor } from './notificacoes.cursor.js';
import type { ListNotificacoesDto } from './dto/notificacoes.dto.js';

type VisibleNotification = Notificacao & {
  _id: Types.ObjectId;
  criada_em: Date;
  ator: { _id: Types.ObjectId; nome: string; username: string; avatar_url?: string | null }[];
};

@Injectable()
export class NotificacoesService {
  constructor(
    @InjectModel(Notificacao.name) private readonly notifications: Model<Notificacao>,
    @Inject(PublicacaoAccessService) private readonly access: PublicacaoAccessService,
    @Inject(NotificacoesCursor) private readonly cursor: NotificacoesCursor,
  ) {}

  private async visiblePipeline(userId: string, unread: boolean,
    position?: { date: Date; id: Types.ObjectId } | null, id?: Types.ObjectId) {
    const visibility = await this.access.listVisibility(userId);
    const match = { destinatario_id: new Types.ObjectId(userId),
      ...(unread ? { lida_em: null } : {}),
      ...(id ? { _id: id } : {}),
      ...(position ? { $or: [
        { criada_em: { $lt: position.date } },
        { criada_em: position.date, _id: { $lt: position.id } },
      ] } : {}) };
    const pipeline: PipelineStage[] = [
      { $match: match },
      { $lookup: { from: 'usuarios', localField: 'ator_id', foreignField: '_id',
        pipeline: [{ $match: { status: 'ativo' } },
          { $project: { nome: 1, username: 1, avatar_url: 1 } }], as: 'ator' } },
      { $match: { 'ator.0': { $exists: true } } },
      { $lookup: { from: 'publicacoes', localField: 'publicacao_id', foreignField: '_id',
        pipeline: [
          { $match: { status: 'publicada', ...visibility } },
          { $lookup: { from: 'usuarios', localField: 'autor_id', foreignField: '_id',
            pipeline: [{ $match: { status: 'ativo' } }, { $project: { _id: 1 } }], as: 'autorAtivo' } },
          { $match: { 'autorAtivo.0': { $exists: true } } },
          { $project: { _id: 1 } },
        ], as: 'publicacao' } },
      { $lookup: { from: 'comentarios', localField: 'entidade_id', foreignField: '_id',
        pipeline: [{ $match: { status: 'publicado', criacao_estado: { $nin: ['pendente', 'falhou'] } } },
          { $project: { _id: 1 } }], as: 'comentario' } },
      { $lookup: { from: 'seguidores', localField: 'relacionamento_id', foreignField: '_id',
        pipeline: [{ $project: { status: 1 } }], as: 'relacao' } },
      { $lookup: { from: 'votos', let: { post: '$publicacao_id', actor: '$ator_id' },
        pipeline: [{ $match: { valor: 1, $expr: { $and: [
          { $eq: ['$publicacao_id', '$$post'] }, { $eq: ['$usuario_id', '$$actor'] },
        ] } } }, { $project: { _id: 1 } }], as: 'voto' } },
      { $match: { $or: [
        { tipo: 'follow_requested', 'relacao.0.status': 'pendente' },
        { tipo: 'user_followed', 'relacao.0.status': 'aceito' },
        { tipo: 'follow_accepted', 'relacao.0.status': 'aceito' },
        { tipo: { $in: ['post_commented', 'comment_replied'] },
          'publicacao.0': { $exists: true }, 'comentario.0': { $exists: true } },
        { tipo: 'post_upvoted', 'publicacao.0': { $exists: true }, 'voto.0': { $exists: true } },
      ] } },
    ];
    return pipeline;
  }

  async list(userId: string, query: ListNotificacoesDto) {
    const position = query.cursor ? this.cursor.decode(query.cursor, userId, query.naoLidas) : null;
    const pipeline = await this.visiblePipeline(userId, query.naoLidas, position);
    pipeline.splice(1, 0, { $sort: { criada_em: -1, _id: -1 } });
    pipeline.push({ $limit: query.limite + 1 });
    const found = await this.notifications.aggregate<VisibleNotification>(pipeline).exec();
    const page = found.slice(0, query.limite);
    const last = page.at(-1);
    const hasMore = found.length > query.limite;
    return { items: page.map((item) => this.view(item)),
      nextCursor: hasMore && last
        ? this.cursor.encode({ date: last.criada_em, id: last._id }, userId, query.naoLidas) : null,
      hasMore };
  }

  async unreadCount(userId: string) {
    const pipeline = await this.visiblePipeline(userId, true);
    pipeline.push({ $count: 'total' });
    const result = await this.notifications.aggregate<{ total: number }>(pipeline).exec();
    return { total: result[0]?.total ?? 0 };
  }

  async markRead(userId: string, id: string) {
    const notificationId = new Types.ObjectId(id);
    const pipeline = await this.visiblePipeline(userId, false, null, notificationId);
    pipeline.push({ $limit: 1 });
    const visible = await this.notifications.aggregate<VisibleNotification>(pipeline).exec();
    if (!visible.length) throw new ApiException('NOTIFICACAO_NOT_FOUND');
    await this.notifications.updateOne({ _id: notificationId, destinatario_id: new Types.ObjectId(userId),
      lida_em: null }, { $set: { lida_em: new Date() } }).exec();
    return { lida: true };
  }

  async markAllRead(userId: string) {
    await this.notifications.updateMany({ destinatario_id: new Types.ObjectId(userId), lida_em: null },
      { $set: { lida_em: new Date() } }).exec();
    return { lidas: true };
  }

  private view(item: VisibleNotification) {
    const actor = item.ator[0];
    return { id: item._id.toString(), tipo: item.tipo,
      ator: { id: actor._id.toString(), nome: actor.nome, username: actor.username,
        avatarUrl: actor.avatar_url ?? null },
      publicacaoId: item.publicacao_id?.toString() ?? null,
      comentarioId: item.entidade_tipo === 'comentario' ? item.entidade_id.toString() : null,
      relacionamentoId: item.relacionamento_id?.toString() ?? null,
      criadaEm: item.criada_em, lidaEm: item.lida_em ?? null };
  }
}
