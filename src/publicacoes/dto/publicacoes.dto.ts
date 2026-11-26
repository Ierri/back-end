import { z } from 'zod';

export const publicacaoIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
export const mediaReferenceSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

export const listPublicacoesSchema = z.strictObject({
  limite: z
    .string()
    .regex(/^(?:[1-9]|[1-4]\d|50)$/)
    .optional()
    .transform((value) => (value === undefined ? 20 : Number(value))),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{40,512}$/)
    .optional(),
  autorId: publicacaoIdSchema.optional(),
  escopo: z.literal('seguindo').optional(),
  ordem: z.literal('score').optional(),
}).refine((query) => !query.escopo || !query.autorId, {
  path: ['autorId'],
  message: 'autorId não pode ser combinado com escopo=seguindo.',
});

export const publicationStacksSchema = z.array(z.strictObject({
  id: publicacaoIdSchema,
  slug: z.string(),
  nome: z.string(),
  categoria: z.string().nullable(),
  iconeUrl: z.string().nullable(),
})).max(20);

const stackIdsSchema = z.array(publicacaoIdSchema.transform((id) => id.toLowerCase())).max(20)
  .refine((ids) => new Set(ids).size === ids.length);

export const createPublicacaoSchema = z.strictObject({
  conteudo: z.string().trim().min(1),
  visibilidade: z.enum(['publico', 'seguidores']).default('publico'),
  stackIds: stackIdsSchema.optional(),
  midias: z
    .array(mediaReferenceSchema)
    .min(1)
    .max(10)
    .refine((references) => new Set(references).size === references.length),
});

export const updatePublicacaoSchema = z
  .strictObject({
    conteudo: z.string().trim().min(1).optional(),
    visibilidade: z.enum(['publico', 'seguidores']).optional(),
    stackIds: stackIdsSchema.optional(),
    midias: z.array(z.union([
      z.strictObject({ id: publicacaoIdSchema.transform((id) => id.toLowerCase()) }),
      z.strictObject({ referencia: mediaReferenceSchema }),
    ])).min(1).max(10)
      .refine((items) => new Set(items.map((item) => 'id' in item ? item.id : item.referencia)).size === items.length)
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0);

export type CreatePublicacaoDto = z.infer<typeof createPublicacaoSchema>;
export type UpdatePublicacaoDto = z.infer<typeof updatePublicacaoSchema>;
export type ListPublicacoesDto = z.infer<typeof listPublicacoesSchema>;
