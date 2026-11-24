import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';

export type UsuarioDocument = HydratedDocument<Usuario>;

@Schema({ _id: false })
export class UsuarioContadores {
  @Prop({ type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  publicacoes: number;

  @Prop({ type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  seguidores: number;

  @Prop({ type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  seguindo: number;

  @Prop({ type: Number, required: true, default: 0, validate: Number.isSafeInteger })
  score: number;
}

const UsuarioContadoresSchema = SchemaFactory.createForClass(UsuarioContadores);

@Schema({
  collection: 'usuarios',
  timestamps: { createdAt: 'criado_em', updatedAt: 'atualizado_em' },
})
export class Usuario {
  @Prop({ type: String, required: true, trim: true })
  nome: string;

  @Prop({ type: String, required: true, trim: true, lowercase: true })
  email: string;

  @Prop({ type: String, required: true, trim: true, lowercase: true })
  username: string;

  // Auth must hash the password before persistence and explicitly select it for login.
  @Prop({ type: String, required: true, select: false })
  senha_hash: string;

  @Prop({ type: String })
  biografia?: string;

  @Prop({ type: String })
  avatar_url?: string;

  @Prop({
    type: [MongooseSchema.Types.ObjectId],
    ref: 'Tecnologia',
    required: true,
    default: [],
    validate: {
      validator: (ids: Types.ObjectId[] | null) =>
        Array.isArray(ids) &&
        ids.length <= 20 &&
        new Set(ids.map((id) => id.toString())).size === ids.length,
      message: 'stack_ids deve conter até 20 tecnologias distintas.',
    },
  })
  stack_ids: Types.ObjectId[];

  @Prop({ type: String, required: true, enum: ['publico', 'privado'], default: 'publico' })
  visibilidade_perfil: 'publico' | 'privado';

  @Prop({
    type: [String],
    required: true,
    enum: ['usuario', 'moderador', 'administrador'],
    default: ['usuario'],
    validate: {
      validator: (roles: string[] | null) =>
        Array.isArray(roles) &&
        roles.length > 0 &&
        new Set(roles).size === roles.length,
      message: 'papeis deve conter valores distintos.',
    },
  })
  papeis: ('usuario' | 'moderador' | 'administrador')[];

  @Prop({ type: String, required: true, enum: ['ativo', 'bloqueado', 'excluido'], default: 'ativo' })
  status: 'ativo' | 'bloqueado' | 'excluido';

  @Prop({ type: Number, default: 0, min: 0 })
  auth_versao: number;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  moderacao_pendente: Record<string, unknown> | null;

  @Prop({ type: UsuarioContadoresSchema, required: true, default: () => ({}) })
  contadores: UsuarioContadores;

  @Prop({ type: Number, default: 0 })
  criador_revisao: number;

  @Prop({ type: Boolean, default: false })
  criador_projecao_pendente: boolean;

  @Prop({ type: Date, default: () => new Date('9999-12-31T23:59:59.999Z') })
  criador_proxima_tentativa_em: Date;

  @Prop({ type: Date, default: null })
  criador_auditoria_em: Date | null;

  @Prop({ type: Date, default: null })
  email_verificado_em: Date | null;

  @Prop({ type: Date, default: null })
  termos_aceitos_em: Date | null;

  @Prop({ type: String, default: null })
  versao_termos_aceita: string | null;

  @Prop({ type: Date, default: null })
  excluido_em: Date | null;

  criado_em: Date;
  atualizado_em: Date;
}

export const UsuarioSchema = SchemaFactory.createForClass(Usuario);

UsuarioSchema.index({ email: 1 }, { unique: true });
UsuarioSchema.index({ username: 1 }, { unique: true });
UsuarioSchema.index({ criador_projecao_pendente: 1, criador_proxima_tentativa_em: 1, _id: 1 });
UsuarioSchema.index({ criador_auditoria_em: 1, _id: 1 });
UsuarioSchema.index({ status: 1, 'contadores.score': -1, _id: -1 });
UsuarioSchema.index({ 'moderacao_pendente.id': 1, _id: 1 },
  { partialFilterExpression: { 'moderacao_pendente.id': { $exists: true } } });
UsuarioSchema.pre('validate', function () {
  if ((this.status === 'excluido') !== Boolean(this.excluido_em)) {
    this.invalidate('excluido_em', 'Data de exclusão incompatível com status.');
  }
  if (Boolean(this.termos_aceitos_em) !== Boolean(this.versao_termos_aceita)) {
    this.invalidate('versao_termos_aceita', 'Data e versão dos termos devem acompanhar-se.');
  }
});
