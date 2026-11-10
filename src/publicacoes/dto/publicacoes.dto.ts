import { z } from 'zod';

export const publicacaoIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const createPublicacaoSchema = z.strictObject({
  conteudo: z.string().trim().min(1),
  visibilidade: z.enum(['publico', 'seguidores']).default('publico'),
  midias: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{16,128}$/))
    .min(1)
    .max(10)
    .refine((references) => new Set(references).size === references.length),
});

export const updatePublicacaoSchema = z
  .strictObject({
    conteudo: z.string().trim().min(1).optional(),
    visibilidade: z.enum(['publico', 'seguidores']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0);

export type CreatePublicacaoDto = z.infer<typeof createPublicacaoSchema>;
export type UpdatePublicacaoDto = z.infer<typeof updatePublicacaoSchema>;
