import { z } from 'zod';

export const comentarioIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
const conteudo = z.string().trim().min(1).max(2000);

export const createComentarioSchema = z.strictObject({
  conteudo,
  comentarioPaiId: comentarioIdSchema.nullable().optional(),
});

export const updateComentarioSchema = z.strictObject({ conteudo });

export const listComentariosSchema = z.strictObject({
  limite: z.string().regex(/^(?:[1-9]|[1-4]\d|50)$/).optional().transform((value) => value === undefined ? 20 : Number(value)),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{40,512}$/).optional(),
});

export type CreateComentarioDto = z.infer<typeof createComentarioSchema>;
export type UpdateComentarioDto = z.infer<typeof updateComentarioSchema>;
export type ListComentariosDto = z.infer<typeof listComentariosSchema>;
