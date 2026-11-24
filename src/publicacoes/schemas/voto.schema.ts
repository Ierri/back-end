import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ _id: false })
export class VotoOperacao {
  @Prop({ type: String, required: true })
  token: string;

  @Prop({ type: Date, required: true })
  expira_em: Date;

  @Prop({ type: String, required: true, enum: ['reservada', 'aplicada'] })
  estado: 'reservada' | 'aplicada';
}

export const VotoOperacaoSchema = SchemaFactory.createForClass(VotoOperacao);

@Schema({
  collection: 'votos',
  timestamps: { createdAt: 'criado_em', updatedAt: 'atualizado_em' },
})
export class Voto {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Publicacao', required: true, immutable: true })
  publicacao_id: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Usuario', required: true, immutable: true })
  usuario_id: Types.ObjectId;

  @Prop({ type: Number, enum: [1, -1], default: null })
  valor: 1 | -1 | null;

  @Prop({ type: Number, default: 0, min: 0 })
  revisao: number;

  @Prop({ type: VotoOperacaoSchema, default: null })
  operacao: VotoOperacao | null;

  @Prop({ type: Date, default: null })
  notificacao_upvote_em: Date | null;

  @Prop({ type: Boolean, default: false })
  notificacao_upvote_pendente: boolean;

  criado_em: Date;
  atualizado_em: Date;
}

export type VotoDocument = HydratedDocument<Voto>;
export const VotoSchema = SchemaFactory.createForClass(Voto);
VotoSchema.index({ publicacao_id: 1, usuario_id: 1 }, { unique: true });
VotoSchema.index({ usuario_id: 1, atualizado_em: -1, _id: -1 });
VotoSchema.index({ valor: 1, notificacao_upvote_pendente: 1, _id: 1 });
VotoSchema.index({ notificacao_upvote_pendente: 1, _id: 1 });
