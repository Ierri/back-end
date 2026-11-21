import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'votos',
  timestamps: { createdAt: 'criado_em', updatedAt: 'atualizado_em' },
})
export class Voto {
  @Prop({
    type: Types.ObjectId,
    ref: 'Publicacao',
    required: true,
    immutable: true,
  })
  publicacao_id: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'Usuario',
    required: true,
    immutable: true,
  })
  usuario_id: Types.ObjectId;

  @Prop({ type: Number, required: true, enum: [1, -1] })
  valor: 1 | -1;

  criado_em: Date;
  atualizado_em: Date;
}

export type VotoDocument = HydratedDocument<Voto>;
export const VotoSchema = SchemaFactory.createForClass(Voto);
VotoSchema.index({ publicacao_id: 1, usuario_id: 1 }, { unique: true });
VotoSchema.index({ usuario_id: 1, atualizado_em: -1, _id: -1 });
