import { z } from 'zod';
import { ALVO_TIPOS, DENUNCIA_MOTIVOS } from '../schemas/denuncia.schema.js';

export const mongoId = z.string().regex(/^[a-f\d]{24}$/i);
const justificativa = z.string().trim().min(10).max(1000);
const limit = z.string().regex(/^(?:[1-9]|[1-4]\d|50)$/).optional()
  .transform((value) => value === undefined ? 20 : Number(value));
const cursor = z.string().regex(/^[A-Za-z0-9_-]{20,512}$/).optional();

export const createDenunciaSchema = z.strictObject({
  alvoTipo: z.enum(ALVO_TIPOS),
  alvoId: mongoId,
  motivo: z.enum(DENUNCIA_MOTIVOS),
  descricao: z.string().trim().min(1).max(1000).nullable().optional(),
}).refine((value) => value.motivo !== 'outro' || Boolean(value.descricao),
  { path: ['descricao'], message: 'Descreva o motivo.' });

export const minhasDenunciasSchema = z.strictObject({ limite: limit, cursor });
export const adminDenunciasSchema = z.strictObject({
  limite: limit, cursor,
  status: z.enum(['pendente', 'aceita', 'rejeitada', 'todos']).default('todos'),
  alvoTipo: z.enum([...ALVO_TIPOS, 'todos']).default('todos'),
});
export const resolveDenunciaSchema = z.strictObject({
  status: z.enum(['aceita', 'rejeitada']), justificativa,
});
export const publicationModerationSchema = z.strictObject({
  status: z.enum(['oculta', 'publicada']), justificativa, denunciaId: mongoId.optional(),
});
export const commentModerationSchema = z.strictObject({
  status: z.enum(['oculto', 'publicado']), justificativa, denunciaId: mongoId.optional(),
});
export const userModerationSchema = z.strictObject({
  status: z.enum(['bloqueado', 'ativo']), justificativa, denunciaId: mongoId.optional(),
});
export const historyQuerySchema = z.strictObject({ limite: limit, cursor });

export type CreateDenunciaDto = z.infer<typeof createDenunciaSchema>;
export type MinhasDenunciasDto = z.infer<typeof minhasDenunciasSchema>;
export type AdminDenunciasDto = z.infer<typeof adminDenunciasSchema>;
export type ResolveDenunciaDto = z.infer<typeof resolveDenunciaSchema>;
export type PublicationModerationDto = z.infer<typeof publicationModerationSchema>;
export type CommentModerationDto = z.infer<typeof commentModerationSchema>;
export type UserModerationDto = z.infer<typeof userModerationSchema>;
export type HistoryQueryDto = z.infer<typeof historyQuerySchema>;
