import { z } from 'zod';

const iconUrl = z.string().trim().min(1).max(2048).refine((value) => {
  if (/^\/brand\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:svg|png|webp)$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}).nullable();

const fields = {
  nome: z.string().trim().min(1).max(80),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  categoria: z.string().trim().max(80).nullable(),
  iconeUrl: iconUrl,
  ativo: z.boolean(),
};

export const createAdminTecnologiaSchema = z.strictObject({
  nome: fields.nome,
  slug: fields.slug,
  categoria: fields.categoria.optional(),
  iconeUrl: fields.iconeUrl.optional(),
  ativo: fields.ativo.optional(),
});

export const updateAdminTecnologiaSchema = z.strictObject({
  nome: fields.nome.optional(),
  slug: fields.slug.optional(),
  categoria: fields.categoria.optional(),
  iconeUrl: fields.iconeUrl.optional(),
  ativo: fields.ativo.optional(),
}).refine((value) => Object.keys(value).length > 0);

export const listAdminTecnologiasSchema = z.strictObject({
  busca: z.string().trim().min(1).max(80).transform((value) => value.toLowerCase()).optional(),
  status: z.enum(['ativo', 'inativo', 'todos']).default('todos'),
  limite: z.string().regex(/^(?:[1-9]|[1-4]\d|50)$/).optional()
    .transform((value) => value === undefined ? 20 : Number(value)),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{16,512}$/).optional(),
});

export type CreateAdminTecnologiaDto = z.infer<typeof createAdminTecnologiaSchema>;
export type UpdateAdminTecnologiaDto = z.infer<typeof updateAdminTecnologiaSchema>;
export type ListAdminTecnologiasDto = z.infer<typeof listAdminTecnologiasSchema>;
