import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'comentarios', timestamps: { createdAt: 'criado_em', updatedAt: 'atualizado_em' } })
export class Comentario {
  @Prop({ type: Types.ObjectId, required: true, immutable: true })
  publicacao_id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, immutable: true })
  autor_id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, default: null, immutable: true })
  comentario_pai_id: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, default: null, immutable: true })
  comentario_raiz_id: Types.ObjectId | null;

  @Prop({ type: Number, required: true, enum: [0, 1, 2], immutable: true })
  profundidade: 0 | 1 | 2;

  @Prop({ type: String, required: true, trim: true, maxlength: 2000 })
  conteudo: string;

  @Prop({ type: String, enum: ['publicado', 'excluido', 'oculto'], default: 'publicado' })
  status: 'publicado' | 'excluido' | 'oculto';

  @Prop({ type: String, enum: ['pendente', 'confirmado', 'falhou'], default: 'confirmado' })
  criacao_estado: 'pendente' | 'confirmado' | 'falhou';

  @Prop({ type: Date, default: null })
  editado_em: Date | null;

  criado_em: Date;
  atualizado_em: Date;
}

export type ComentarioDocument = HydratedDocument<Comentario>;
export const ComentarioSchema = SchemaFactory.createForClass(Comentario);

ComentarioSchema.pre('validate', function () {
  if (
    (this.profundidade === 0 && (this.comentario_pai_id || this.comentario_raiz_id)) ||
    (this.profundidade === 1 && (!this.comentario_pai_id || !this.comentario_raiz_id || !this.comentario_pai_id.equals(this.comentario_raiz_id))) ||
    (this.profundidade === 2 && (!this.comentario_pai_id || !this.comentario_raiz_id))
  ) this.invalidate('profundidade', 'Hierarquia de comentário inválida.');
});

ComentarioSchema.index({ publicacao_id: 1, comentario_pai_id: 1, criado_em: 1, _id: 1 });
