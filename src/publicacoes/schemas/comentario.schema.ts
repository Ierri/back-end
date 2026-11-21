import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'comentarios',
  timestamps: { createdAt: 'criado_em', updatedAt: 'atualizado_em' },
})
export class Comentario {
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
  autor_id: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'Comentario',
    default: null,
    immutable: true,
  })
  comentario_pai_id: Types.ObjectId | null;

  @Prop({
    type: Types.ObjectId,
    ref: 'Comentario',
    default: null,
    immutable: true,
  })
  comentario_raiz_id: Types.ObjectId | null;

  @Prop({ type: Number, required: true, enum: [0, 1, 2], immutable: true })
  profundidade: 0 | 1 | 2;

  @Prop({
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 5000,
  })
  conteudo: string;

  @Prop({
    type: String,
    required: true,
    enum: ['publicado', 'excluido', 'oculto'],
    default: 'publicado',
  })
  status: 'publicado' | 'excluido' | 'oculto';

  @Prop({ type: Date, default: null })
  editado_em: Date | null;

  criado_em: Date;
  atualizado_em: Date;
}

export type ComentarioDocument = HydratedDocument<Comentario>;
export const ComentarioSchema = SchemaFactory.createForClass(Comentario);
ComentarioSchema.index({
  publicacao_id: 1,
  comentario_pai_id: 1,
  criado_em: 1,
  _id: 1,
});
ComentarioSchema.index({ comentario_raiz_id: 1, criado_em: 1, _id: 1 });
ComentarioSchema.index({ autor_id: 1, criado_em: -1, _id: -1 });
ComentarioSchema.pre('validate', function () {
  const hasParent = Boolean(this.comentario_pai_id);
  const hasRoot = Boolean(this.comentario_raiz_id);
  if (
    (this.profundidade === 0 && (hasParent || hasRoot)) ||
    (this.profundidade > 0 && (!hasParent || !hasRoot))
  ) {
    this.invalidate(
      'profundidade',
      'Pai e raiz incompatíveis com profundidade.',
    );
  }
  if (
    this.comentario_pai_id?.equals(this._id) ||
    this.comentario_raiz_id?.equals(this._id)
  ) {
    this.invalidate(
      'comentario_pai_id',
      'Um comentário não pode referenciar a si mesmo.',
    );
  }
  if (
    this.profundidade === 1 &&
    hasParent &&
    hasRoot &&
    !this.comentario_pai_id!.equals(this.comentario_raiz_id)
  ) {
    this.invalidate(
      'comentario_raiz_id',
      'Resposta direta deve apontar para o pai como raiz.',
    );
  }
});
