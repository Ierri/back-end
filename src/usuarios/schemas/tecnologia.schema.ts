import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'tecnologias',
  timestamps: { createdAt: 'criado_em', updatedAt: 'atualizado_em' },
})
export class Tecnologia {
  @Prop({ type: String, required: true, trim: true, minlength: 1, maxlength: 80 })
  nome: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  })
  slug: string;

  @Prop({ type: String, default: null, trim: true, maxlength: 80 })
  categoria: string | null;

  @Prop({ type: String, default: null })
  icone_url: string | null;

  @Prop({ type: Boolean, required: true, default: true })
  ativo: boolean;

  criado_em: Date;
  atualizado_em: Date;
}

export type TecnologiaDocument = HydratedDocument<Tecnologia>;
export const TecnologiaSchema = SchemaFactory.createForClass(Tecnologia);
TecnologiaSchema.index({ slug: 1 }, { unique: true });
TecnologiaSchema.index({ ativo: 1, nome: 1, _id: 1 });
