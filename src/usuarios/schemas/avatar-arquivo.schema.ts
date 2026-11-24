import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

@Schema({ collection: 'avatar_arquivos', timestamps: { createdAt: 'criado_em', updatedAt: 'atualizado_em' } })
export class AvatarArquivo {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Usuario', required: true, immutable: true })
  usuario_id: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true, immutable: true })
  referencia: string;

  @Prop({ type: String, required: true, unique: true, immutable: true })
  chave_storage: string;

  @Prop({ type: String, required: true, enum: ['preparando', 'ativo', 'excluindo'] })
  estado: 'preparando' | 'ativo' | 'excluindo';

  criado_em: Date;
  atualizado_em: Date;
}

export const AvatarArquivoSchema = SchemaFactory.createForClass(AvatarArquivo);
AvatarArquivoSchema.index({ estado: 1, _id: 1 });
