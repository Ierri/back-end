import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';
import { MAX_MEDIA_SIZE_BYTES } from '../media-verifier.js';

@Schema()
export class PublicacaoMidia {
  @Prop({ type: Types.ObjectId, default: () => new Types.ObjectId() })
  _id: Types.ObjectId;

  @Prop({ type: String, required: true, enum: ['imagem', 'video'] })
  tipo: 'imagem' | 'video';

  @Prop({ type: String, required: true })
  url: string;

  @Prop({ type: String, required: true })
  chave_storage: string;

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

  @Prop({ type: String, default: null })
  texto_alternativo: string | null;

  @Prop({ type: Number, required: true, min: 0 })
  ordem: number;
}

export const PublicacaoMidiaSchema =
  SchemaFactory.createForClass(PublicacaoMidia);

@Schema({ _id: false })
export class PublicacaoContadores {
  @Prop({ type: Number, default: 0, min: 0 })
  upvotes: number;

  @Prop({ type: Number, default: 0, min: 0 })
  downvotes: number;

  @Prop({ type: Number, default: 0 })
  score: number;

  @Prop({ type: Number, default: 0, min: 0 })
  comentarios: number;

  @Prop({ type: Number, default: 0, min: 0 })
  salvamentos: number;
}

export const PublicacaoContadoresSchema =
  SchemaFactory.createForClass(PublicacaoContadores);

export function validPublicationMedia(midias: PublicacaoMidia[]): boolean {
  if (!Array.isArray(midias) || midias.length < 1 || midias.length > 10)
    return false;
  if (
    midias.reduce((total, media) => total + media.tamanho_bytes, 0) >
    200_000_000
  )
    return false;
  if (
    new Set(midias.map((media) => media.chave_storage)).size !== midias.length
  )
    return false;
  return midias.every((media, index) => {
    if (
      media.ordem !== index ||
      !Number.isSafeInteger(media.tamanho_bytes) ||
      media.tamanho_bytes < 1
    )
      return false;
    if (!media.chave_storage?.trim() || !media.url?.trim()) return false;
    let url: URL;
    try {
      url = new URL(media.url);
    } catch {
      return false;
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search
    )
      return false;
    if (media.tipo === 'imagem') {
      return (
        ['image/jpeg', 'image/png', 'image/webp'].includes(media.mime_type) &&
        media.tamanho_bytes <= MAX_MEDIA_SIZE_BYTES &&
        Number.isSafeInteger(media.largura) &&
        media.largura! > 0 &&
        Number.isSafeInteger(media.altura) &&
        media.altura! > 0 &&
        media.duracao_segundos === null
      );
    }
    if (media.tipo === 'video') {
      return (
        ['video/mp4', 'video/webm'].includes(media.mime_type) &&
        media.tamanho_bytes <= MAX_MEDIA_SIZE_BYTES &&
        Number.isFinite(media.duracao_segundos) &&
        media.duracao_segundos! > 0 &&
        media.duracao_segundos! <= 120 &&
        (media.largura === null ||
          (Number.isSafeInteger(media.largura) && media.largura > 0)) &&
        (media.altura === null ||
          (Number.isSafeInteger(media.altura) && media.altura > 0))
      );
    }
    return false;
  });
}

@Schema({
  collection: 'publicacoes',
  timestamps: { createdAt: 'criada_em', updatedAt: 'atualizada_em' },
})
export class Publicacao {
  @Prop({ type: String, required: true, unique: true })
  slug: string;

  @Prop({
    type: Types.ObjectId,
    ref: 'Usuario',
    required: true,
    immutable: true,
  })
  autor_id: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  conteudo: string;

  @Prop({
    type: [PublicacaoMidiaSchema],
    required: true,
    validate: validPublicationMedia,
  })
  midias: PublicacaoMidia[];

  @Prop({ type: String, enum: ['publico', 'seguidores'], default: 'publico' })
  visibilidade: 'publico' | 'seguidores';

  @Prop({
    type: String,
    enum: ['processando', 'publicada', 'arquivada', 'oculta', 'excluida'],
    default: 'processando',
  })
  status: 'processando' | 'publicada' | 'arquivada' | 'oculta' | 'excluida';

  @Prop({ type: PublicacaoContadoresSchema, default: () => ({}) })
  contadores: PublicacaoContadores;

  @Prop({ type: Date, default: null })
  publicada_em: Date | null;

  @Prop({ type: Date, default: null })
  editada_em: Date | null;

  criada_em: Date;
  atualizada_em: Date;
}

export type PublicacaoDocument = HydratedDocument<Publicacao>;
export const PublicacaoSchema = SchemaFactory.createForClass(Publicacao);
PublicacaoSchema.pre('validate', function () {
  if (this.status === 'publicada' && !this.publicada_em) {
    this.invalidate(
      'publicada_em',
      'Publicação publicada exige data de publicação.',
    );
  }
});
PublicacaoSchema.index({
  status: 1,
  visibilidade: 1,
  publicada_em: -1,
  _id: -1,
});
PublicacaoSchema.index({ autor_id: 1, status: 1, publicada_em: -1, _id: -1 });
PublicacaoSchema.index({
  autor_id: 1,
  status: 1,
  visibilidade: 1,
  publicada_em: -1,
  _id: -1,
});
PublicacaoSchema.index({
  status: 1,
  visibilidade: 1,
  'contadores.score': -1,
  publicada_em: -1,
});
