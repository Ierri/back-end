import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'seguidores',
  timestamps: { createdAt: 'solicitado_em', updatedAt: 'atualizado_em' },
})
export class Seguidor {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Usuario', required: true, immutable: true })
  seguidor_id: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Usuario', required: true, immutable: true })
  seguido_id: Types.ObjectId;

  @Prop({ type: String, required: true, enum: ['pendente', 'aceito'] })
  status: 'pendente' | 'aceito';

  @Prop({ type: Date, default: null })
  aceito_em: Date | null;

  solicitado_em: Date;
  atualizado_em: Date;
}

export type SeguidorDocument = HydratedDocument<Seguidor>;
export const SeguidorSchema = SchemaFactory.createForClass(Seguidor);
SeguidorSchema.index({ seguidor_id: 1, seguido_id: 1 }, { unique: true });
SeguidorSchema.index({ seguido_id: 1, status: 1, solicitado_em: -1, _id: -1 });
SeguidorSchema.index({ seguidor_id: 1, status: 1, atualizado_em: -1, _id: -1 });
SeguidorSchema.pre('validate', function () {
  if (this.seguidor_id?.equals(this.seguido_id)) {
    this.invalidate('seguido_id', 'Não é permitido seguir a si mesmo.');
  }
  if ((this.status === 'aceito') !== Boolean(this.aceito_em)) {
    this.invalidate('aceito_em', 'Data de aceite incompatível com status.');
  }
});
