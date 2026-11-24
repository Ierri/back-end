import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

export const ALVO_TIPOS = ['usuario', 'publicacao', 'comentario'] as const;
export const DENUNCIA_MOTIVOS = ['spam', 'assedio', 'inapropriado', 'direitos_autorais', 'outro'] as const;

@Schema({ collection: 'denuncias', timestamps: { createdAt: 'criada_em', updatedAt: false } })
export class Denuncia {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Usuario', required: true, immutable: true })
  denunciante_id: Types.ObjectId;

  @Prop({ type: String, enum: ALVO_TIPOS, required: true, immutable: true })
  alvo_tipo: typeof ALVO_TIPOS[number];

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, immutable: true })
  alvo_id: Types.ObjectId;

  @Prop({ type: String, enum: DENUNCIA_MOTIVOS, required: true, immutable: true })
  motivo: typeof DENUNCIA_MOTIVOS[number];

  @Prop({ type: String, maxlength: 1000, default: null, immutable: true })
  descricao: string | null;

  @Prop({ type: String, enum: ['pendente', 'aceita', 'rejeitada'], default: 'pendente' })
  status: 'pendente' | 'aceita' | 'rejeitada';

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Usuario', default: null })
  moderador_id: Types.ObjectId | null;

  @Prop({ type: String, maxlength: 1000, default: null })
  justificativa: string | null;

  @Prop({ type: Date, default: null })
  resolvida_em: Date | null;

  @Prop({ type: Boolean, default: false })
  historico_pendente: boolean;

  criada_em: Date;
}

export const DenunciaSchema = SchemaFactory.createForClass(Denuncia);
DenunciaSchema.index({ denunciante_id: 1, criada_em: -1, _id: -1 });
DenunciaSchema.index({ status: 1, alvo_tipo: 1, criada_em: -1, _id: -1 });
DenunciaSchema.index({ alvo_tipo: 1, alvo_id: 1 });
DenunciaSchema.index({ historico_pendente: 1, _id: 1 });
DenunciaSchema.index({ denunciante_id: 1, alvo_tipo: 1, alvo_id: 1 },
  { unique: true, partialFilterExpression: { status: 'pendente' } });
