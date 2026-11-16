import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';
import { MAX_MEDIA_SIZE_BYTES } from '../media-verifier.js';

@Schema({
  collection: 'uploads_midias',
  timestamps: { createdAt: 'criado_em', updatedAt: 'atualizado_em' },
})
export class UploadMedia {
  @Prop({ type: String, required: true, unique: true })
  referencia: string;

  @Prop({ type: Types.ObjectId, required: true, immutable: true })
  usuario_id: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true })
  chave_storage: string;

  @Prop({ type: String, required: true, enum: ['imagem', 'video'] })
  tipo: 'imagem' | 'video';

  @Prop({ type: String, required: true })
  mime_type: string;

  @Prop({ type: Number, required: true, min: 1, max: MAX_MEDIA_SIZE_BYTES })
  tamanho_bytes: number;

  @Prop({ type: Number, default: null })
  largura: number | null;

  @Prop({ type: Number, default: null })
  altura: number | null;

  @Prop({ type: Number, default: null })
  duracao_segundos: number | null;

  @Prop({ type: String, required: true })
  sha256: string;

  @Prop({
    type: String,
    required: true,
    enum: ['recebendo', 'pronta', 'reservada', 'vinculada', 'excluindo'],
    default: 'recebendo',
  })
  estado: 'recebendo' | 'pronta' | 'reservada' | 'vinculada' | 'excluindo';

  @Prop({ type: Types.ObjectId, default: null })
  publicacao_id: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  reservada_em: Date | null;

  @Prop({ type: Date, default: null })
  expira_em: Date | null;

  criado_em: Date;
  atualizado_em: Date;
}

export type UploadMediaDocument = HydratedDocument<UploadMedia>;
export const UploadMediaSchema = SchemaFactory.createForClass(UploadMedia);
UploadMediaSchema.index({ estado: 1, expira_em: 1 });
UploadMediaSchema.index({ expira_em: 1, _id: 1 });
UploadMediaSchema.index({ publicacao_id: 1, estado: 1 });
