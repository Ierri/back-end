import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';

export const NOTIFICATION_TYPES = [
  'post_commented', 'comment_replied', 'post_upvoted',
  'follow_requested', 'user_followed', 'follow_accepted',
  'post_trending',
] as const;

@Schema({ collection: 'notificacoes', timestamps: { createdAt: 'criada_em', updatedAt: false } })
export class Notificacao {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Usuario', required: true, immutable: true })
  destinatario_id: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Usuario', required: true, immutable: true })
  ator_id: Types.ObjectId;

  @Prop({ type: [MongooseSchema.Types.ObjectId], default: [] })
  atores_preview_ids: Types.ObjectId[];

  @Prop({ type: Number, default: 1, min: 1 })
  quantidade_atores: number;

  @Prop({ type: String, required: true, enum: NOTIFICATION_TYPES })
  tipo: typeof NOTIFICATION_TYPES[number];

  @Prop({ type: String, required: true, enum: ['publicacao', 'comentario', 'usuario'] })
  entidade_tipo: 'publicacao' | 'comentario' | 'usuario';

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  entidade_id: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Publicacao', default: null })
  publicacao_id: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Seguidor', default: null })
  relacionamento_id: Types.ObjectId | null;

  @Prop({ type: String, required: true, immutable: true })
  chave_agrupamento: string;

  @Prop({ type: Object, default: () => ({ v: 1 }) })
  metadados: { v: number };

  @Prop({ type: Date, default: null })
  lida_em: Date | null;

  @Prop({ type: Date, default: () => new Date() })
  ultimo_evento_em: Date;

  criada_em: Date;
}

export type NotificacaoDocument = HydratedDocument<Notificacao>;
export const NotificacaoSchema = SchemaFactory.createForClass(Notificacao);
NotificacaoSchema.index({ destinatario_id: 1, criada_em: -1, _id: -1 });
NotificacaoSchema.index({ destinatario_id: 1, lida_em: 1, criada_em: -1, _id: -1 });
NotificacaoSchema.index({ destinatario_id: 1, chave_agrupamento: 1 }, { unique: true });
