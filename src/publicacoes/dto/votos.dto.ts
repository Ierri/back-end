import { z } from 'zod';
import { publicacaoIdSchema } from './publicacoes.dto.js';

export const MAX_STREAM_PUBLICATION_IDS = 30;

export const putVotoSchema = z.strictObject({
  valor: z.union([z.literal(1), z.literal(-1)]),
});

export const streamVotosQuerySchema = z.strictObject({
  ids: z
    .string()
    .trim()
    .min(24)
    .max(MAX_STREAM_PUBLICATION_IDS * 25 + 32)
    .transform((raw, ctx) => {
      const parts = raw
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0);
      if (parts.length < 1 || parts.length > MAX_STREAM_PUBLICATION_IDS) {
        ctx.addIssue({
          code: 'custom',
          message: `Informe entre 1 e ${MAX_STREAM_PUBLICATION_IDS} publicações.`,
        });
        return z.NEVER;
      }
      const unique: string[] = [];
      const seen = new Set<string>();
      for (const part of parts) {
        if (!publicacaoIdSchema.safeParse(part).success) {
          ctx.addIssue({
            code: 'custom',
            message: 'Identificador de publicação inválido.',
          });
          return z.NEVER;
        }
        if (!seen.has(part)) {
          seen.add(part);
          unique.push(part);
        }
      }
      return unique;
    }),
});

export type PutVotoDto = z.infer<typeof putVotoSchema>;
export type StreamVotosQueryDto = z.infer<typeof streamVotosQuerySchema>;
