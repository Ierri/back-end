import { z } from 'zod';

export const seguidorUserIdSchema = z.string().regex(/^[a-f\d]{24}$/i).toLowerCase();

export const listSeguidoresSchema = z.strictObject({
  limite: z
    .string()
    .regex(/^(?:[1-9]|[1-4]\d|50)$/)
    .optional()
    .transform((value) => (value === undefined ? 20 : Number(value))),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{40,512}$/).optional(),
});

export type ListSeguidoresDto = z.infer<typeof listSeguidoresSchema>;
