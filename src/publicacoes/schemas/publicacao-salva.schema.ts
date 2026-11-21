import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'publicacoes_salvas',
  timestamps: { createdAt: 'criado_em', updatedAt: false },
})
export class PublicacaoSalva {
  @Prop({
    type: Types.ObjectId,
    ref: 'Usuario',
    required: true,
    immutable: true,
  })
  usuario_id: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'Publicacao',
    required: true,
    immutable: true,
  })
  publicacao_id: Types.ObjectId;

  criado_em: Date;
}

export type PublicacaoSalvaDocument = HydratedDocument<PublicacaoSalva>;
export const PublicacaoSalvaSchema =
  SchemaFactory.createForClass(PublicacaoSalva);
PublicacaoSalvaSchema.index(
  { usuario_id: 1, publicacao_id: 1 },
  { unique: true },
);
PublicacaoSalvaSchema.index({ usuario_id: 1, criado_em: -1, _id: -1 });
