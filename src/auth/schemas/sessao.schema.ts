import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

@Schema({
  collection: 'sessoes',
  timestamps: { createdAt: 'criada_em', updatedAt: false },
})
export class Sessao {
  @Prop({ type: String, required: true })
  id_hash: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  usuario_id: Types.ObjectId;

  @Prop({ type: Date, required: true })
  expira_em: Date;

  @Prop({ type: Date, default: null })
  revogada_em: Date | null;

  criada_em: Date;
}

export const SessaoSchema = SchemaFactory.createForClass(Sessao);

SessaoSchema.index({ id_hash: 1 }, { unique: true });
SessaoSchema.index({ expira_em: 1 }, { expireAfterSeconds: 0 });
