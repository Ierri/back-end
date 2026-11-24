import { z } from 'zod';

export const putVotoSchema = z.strictObject({
  valor: z.union([z.literal(1), z.literal(-1)]),
});

export type PutVotoDto = z.infer<typeof putVotoSchema>;
