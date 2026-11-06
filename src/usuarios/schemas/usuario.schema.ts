import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type UsuarioDocument = HydratedDocument<Usuario>;

@Schema({
  collection: 'usuarios',
  timestamps: { createdAt: 'criado_em', updatedAt: false },
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

  criado_em: Date;
}

export const UsuarioSchema = SchemaFactory.createForClass(Usuario);

UsuarioSchema.index({ email: 1 }, { unique: true });
UsuarioSchema.index({ username: 1 }, { unique: true });
