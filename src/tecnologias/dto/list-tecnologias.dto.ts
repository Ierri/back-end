import { z } from 'zod';

export const listTecnologiasSchema = z.strictObject({
  busca: z.string().trim().min(1).max(80).transform((value) => value.toLowerCase()).optional(),
  limite: z.string().regex(/^(?:[1-9]|[1-4]\d|50)$/).optional().transform((value) => value === undefined ? 20 : Number(value)),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{16,512}$/).optional(),
});

export type ListTecnologiasDto = z.infer<typeof listTecnologiasSchema>;
