import { z } from 'zod';

const avatarReference = z.string().regex(
  /^\/brand\/ierri\/social\/(?:github-avatar-512|avatar-light-1024|avatar-dark-1024)\.png$/,
);

export const updatePerfilSchema = z
  .strictObject({
    nome: z.string().trim().min(1).max(100).optional(),
    username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,30}$/).optional(),
    biografia: z.string().trim().max(500).nullable().optional(),
    avatarUrl: avatarReference.nullable().optional(),
    visibilidadePerfil: z.enum(['publico', 'privado']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0);

export type UpdatePerfilDto = z.infer<typeof updatePerfilSchema>;
