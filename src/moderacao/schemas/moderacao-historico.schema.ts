import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

@Schema({ collection: 'moderacao_historico', timestamps: false })
export class ModeracaoHistorico {
  @Prop({ type: String, required: true, unique: true, immutable: true })
  chave: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Usuario', required: true, immutable: true })
  responsavel_id: Types.ObjectId;

  @Prop({ type: String, enum: ['usuario', 'publicacao', 'comentario', 'denuncia'], required: true, immutable: true })
  alvo_tipo: 'usuario' | 'publicacao' | 'comentario' | 'denuncia';

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, immutable: true })
  alvo_id: Types.ObjectId;

  @Prop({ type: String, required: true, immutable: true })
  acao: string;

  @Prop({ type: String, required: true, immutable: true })
  estado_anterior: string;

  @Prop({ type: String, required: true, immutable: true })
  novo_estado: string;

  @Prop({ type: String, required: true, immutable: true })
  justificativa: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Denuncia', default: null, immutable: true })
  denuncia_id: Types.ObjectId | null;

  @Prop({ type: Date, required: true, immutable: true })
  criada_em: Date;
}

export const ModeracaoHistoricoSchema = SchemaFactory.createForClass(ModeracaoHistorico);
ModeracaoHistoricoSchema.index({ criada_em: -1, _id: -1 });
ModeracaoHistoricoSchema.index({ alvo_tipo: 1, alvo_id: 1, criada_em: -1 });
