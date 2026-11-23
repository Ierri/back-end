import { z } from 'zod';

export const replaceStacksSchema = z.strictObject({
  stackIds: z
    .array(z.string().regex(/^[a-f\d]{24}$/i))
    .max(20)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length),
});

export type ReplaceStacksDto = z.infer<typeof replaceStacksSchema>;
