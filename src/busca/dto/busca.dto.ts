import { z } from 'zod';
import { stripAccents, stripOrphanCombiningMarks } from '../busca-pattern.js';

export const MAX_SEARCH_LENGTH = 80;

function hasControlChars(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export const searchTermSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SEARCH_LENGTH)
  .refine((value) => !hasControlChars(value), {
    message: 'Termo de busca inválido.',
  })
  .refine(
    (value) =>
      stripAccents(stripOrphanCombiningMarks(value)).replace(/@/g, ' ').trim()
        .length >= 1,
    {
      message: 'Informe ao menos um caractere válido para pesquisar.',
    },
  );

const limitOverviewSchema = z
  .string()
  .regex(/^(?:[1-9]|1\d|20)$/)
  .optional()
  .transform((value) => (value === undefined ? 10 : Number(value)));

const limitPageSchema = z
  .string()
  .regex(/^(?:[1-9]|1\d|20)$/)
  .optional()
  .transform((value) => (value === undefined ? 20 : Number(value)));

export const buscaOrderSchema = z
  .enum(['recentes', 'score'])
  .default('recentes');

const cursorSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{28,512}$/)
  .optional();

export const buscaGeralSchema = z.strictObject({
  q: searchTermSchema,
  limite: limitOverviewSchema,
  ordem: buscaOrderSchema,
});

export const buscaUsuariosSchema = z.strictObject({
  q: searchTermSchema,
  limite: limitPageSchema,
  cursor: cursorSchema,
});

export const buscaPublicacoesSchema = z.strictObject({
  q: searchTermSchema,
  limite: limitPageSchema,
  ordem: buscaOrderSchema,
  cursor: cursorSchema,
});

export type BuscaOrder = z.infer<typeof buscaOrderSchema>;
export type BuscaGeralDto = z.infer<typeof buscaGeralSchema>;
export type BuscaUsuariosDto = z.infer<typeof buscaUsuariosSchema>;
export type BuscaPublicacoesDto = z.infer<typeof buscaPublicacoesSchema>;
