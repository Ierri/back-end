import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { Comentario } from '../comentarios/schemas/comentario.schema.js';
import { Publicacao } from '../publicacoes/schemas/publicacao.schema.js';
import { Voto } from '../publicacoes/schemas/voto.schema.js';
import { Seguidor } from '../usuarios/schemas/seguidor.schema.js';
import { Notificacao } from './schemas/notificacao.schema.js';

type Event = Pick<Notificacao, 'tipo' | 'entidade_tipo' | 'entidade_id' | 'publicacao_id' | 'relacionamento_id'> & {
  destinatario_id: Types.ObjectId;
  ator_id: Types.ObjectId;
  chave_agrupamento: string;
};

@Injectable()
export class NotificationProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationProducerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private relationAfter: Types.ObjectId | null = null;
  private commentAfter: Types.ObjectId | null = null;
  private voteAfter: Types.ObjectId | null = null;

  constructor(
    @InjectModel(Notificacao.name) private readonly notifications: Model<Notificacao>,
    @InjectModel(Seguidor.name) private readonly relations: Model<Seguidor>,
    @InjectModel(Comentario.name) private readonly comments: Model<Comentario>,
    @InjectModel(Voto.name) private readonly votes: Model<Voto>,
    @InjectModel(Publicacao.name) private readonly posts: Model<Publicacao>,
  ) {}

  onModuleInit() {
    void this.recoverBatch().catch(() => this.logger.warn('Falha na recuperação de notificações.'));
    this.timer = setInterval(() => {
      void this.recoverBatch().catch(() => this.logger.warn('Falha na recuperação de notificações.'));
    }, 30_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async deliver(event: Event) {
    if (event.destinatario_id.equals(event.ator_id)) return;
    const createdAt = new Date();
    try {
      await this.notifications.updateOne(
        { destinatario_id: event.destinatario_id, chave_agrupamento: event.chave_agrupamento },
        { $setOnInsert: { ...event, atores_preview_ids: [event.ator_id], quantidade_atores: 1,
          metadados: { v: 1 }, lida_em: null, criada_em: createdAt, ultimo_evento_em: createdAt } },
        { upsert: true, timestamps: false },
      ).exec();
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000)
        throw error;
    }
  }

  async processRelation(id: string) {
    const relation = await this.relations.findById(id).exec();
    if (!relation) return;
    const actor = relation.seguidor_id;
    const target = relation.seguido_id;
    if (relation.notificacao_follow_pendente) {
      const requested = relation.notificacao_origem === 'solicitacao';
      const type = requested ? 'follow_requested' : 'user_followed';
      if ((requested && relation.status === 'pendente') || (!requested && relation.status === 'aceito'))
        await this.deliver({ destinatario_id: target, ator_id: actor,
          tipo: type, entidade_tipo: 'usuario', entidade_id: actor,
          publicacao_id: null, relacionamento_id: relation._id,
          chave_agrupamento: `${type}:${relation._id.toString()}` });
      await this.relations.updateOne({ _id: relation._id, notificacao_follow_pendente: true },
        { $set: { notificacao_follow_pendente: false } }, { timestamps: false }).exec();
    }
    if (relation.notificacao_aceite_pendente) {
      if (relation.status === 'aceito' && relation.notificacao_origem === 'solicitacao')
        await this.deliver({ destinatario_id: actor, ator_id: target,
          tipo: 'follow_accepted', entidade_tipo: 'usuario', entidade_id: target,
          publicacao_id: null, relacionamento_id: relation._id,
          chave_agrupamento: `follow_accepted:${relation._id.toString()}` });
      await this.relations.updateOne({ _id: relation._id, notificacao_aceite_pendente: true },
        { $set: { notificacao_aceite_pendente: false } }, { timestamps: false }).exec();
    }
  }

  async processComment(id: string) {
    const comment = await this.comments.findById(id).exec();
    if (!comment?.notificacao_pendente) return;
    if (comment.criacao_estado !== 'confirmado') return;
    if (comment.status !== 'publicado') {
      await this.comments.updateOne({ _id: comment._id, notificacao_pendente: true },
        { $set: { notificacao_pendente: false } }, { timestamps: false }).exec();
      return;
    }
    const post = await this.posts.findById(comment.publicacao_id).select('autor_id status').lean().exec();
    if (!post || post.status !== 'publicada') {
      await this.comments.updateOne({ _id: comment._id }, { $set: { notificacao_pendente: false } },
        { timestamps: false }).exec();
      return;
    }
    const parent = comment.comentario_pai_id
      ? await this.comments.findById(comment.comentario_pai_id).select('autor_id').lean().exec() : null;
    const recipient = parent?.autor_id ?? post.autor_id;
    const type = comment.comentario_pai_id ? 'comment_replied' : 'post_commented';
    await this.deliver({ destinatario_id: recipient, ator_id: comment.autor_id,
      tipo: type, entidade_tipo: 'comentario', entidade_id: comment._id,
      publicacao_id: comment.publicacao_id, relacionamento_id: null,
      chave_agrupamento: `${type}:${comment._id.toString()}` });
    await this.comments.updateOne({ _id: comment._id, notificacao_pendente: true },
      { $set: { notificacao_pendente: false } }, { timestamps: false }).exec();
  }

  async recordUpvote(id: string) {
    const vote = await this.votes.findById(id)
      .select('publicacao_id valor operacao notificacao_upvote_em').lean().exec();
    if (!vote || vote.valor !== 1 || !await this.voteConfirmed(vote)) return;
    if (!vote.notificacao_upvote_em)
      await this.votes.updateOne({ _id: vote._id, valor: 1,
        notificacao_upvote_em: null },
      { $set: { notificacao_upvote_em: new Date(), notificacao_upvote_pendente: true } },
      { timestamps: false }).exec();
    await this.processVote(id);
  }

  async processVote(id: string) {
    const vote = await this.votes.findById(id).exec();
    if (!vote?.notificacao_upvote_pendente || !await this.voteConfirmed(vote)) return;
    if (vote.valor === 1) {
      const post = await this.posts.findById(vote.publicacao_id).select('autor_id status').lean().exec();
      if (post?.status === 'publicada')
        await this.deliver({ destinatario_id: post.autor_id, ator_id: vote.usuario_id,
          tipo: 'post_upvoted', entidade_tipo: 'publicacao', entidade_id: vote.publicacao_id,
          publicacao_id: vote.publicacao_id, relacionamento_id: null,
          chave_agrupamento: `post_upvoted:${vote.publicacao_id.toString()}:${vote.usuario_id.toString()}` });
    }
    await this.votes.updateOne({ _id: vote._id, notificacao_upvote_pendente: true },
      { $set: { notificacao_upvote_pendente: false } }, { timestamps: false }).exec();
  }

  private async voteConfirmed(vote: Pick<Voto, 'publicacao_id' | 'operacao'>) {
    if (!vote.operacao) return true;
    if (vote.operacao.estado !== 'aplicada') return false;
    const post = await this.posts.findById(vote.publicacao_id)
      .select('votos_projecao_pendente votos_operacoes_pendentes').lean().exec();
    return Boolean(post && !post.votos_projecao_pendente &&
      !post.votos_operacoes_pendentes?.some((item) => item.token === vote.operacao?.token));
  }

  async recoverBatch() {
    if (this.running) return 0;
    this.running = true;
    try {
      const relations = await this.relations.find({ $or: [
        { notificacao_follow_pendente: true }, { notificacao_aceite_pendente: true }],
        ...(this.relationAfter ? { _id: { $gt: this.relationAfter } } : {}) })
        .sort({ _id: 1 }).limit(50).select('_id').lean().exec();
      for (const relation of relations)
        await this.processRelation(relation._id.toString()).catch(() => undefined);
      this.relationAfter = relations.length === 50 ? relations[49]._id : null;

      const comments = await this.comments.find({ notificacao_pendente: true,
        ...(this.commentAfter ? { _id: { $gt: this.commentAfter } } : {}) })
        .sort({ _id: 1 }).limit(50).select('_id').lean().exec();
      for (const comment of comments)
        await this.processComment(comment._id.toString()).catch(() => undefined);
      this.commentAfter = comments.length === 50 ? comments[49]._id : null;

      const votes = await this.votes.find({ valor: 1, notificacao_upvote_pendente: true,
        ...(this.voteAfter ? { _id: { $gt: this.voteAfter } } : {}) })
        .sort({ _id: 1 }).limit(50).select('_id').lean().exec();
      for (const vote of votes)
        await this.recordUpvote(vote._id.toString()).catch(() => undefined);
      this.voteAfter = votes.length === 50 ? votes[49]._id : null;
      return relations.length + comments.length + votes.length;
    } finally {
      this.running = false;
    }
  }
}
