import { z } from 'zod';

const email = z
  .string({ error: 'Informe um e-mail válido.' })
  .trim()
  .max(254, 'O e-mail deve ter no máximo 254 caracteres.')
  .pipe(z.email({ error: 'Informe um e-mail válido.' }))
  .transform((value) => value.toLowerCase());
const password = z
  .string({ error: 'Informe sua senha.' })
  .min(1, 'Informe sua senha.')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= 72,
    'A senha deve ter no máximo 72 bytes.',
  );

export const checkEmailSchema = z.object({ email });
export const loginSchema = checkEmailSchema.extend({ password });
export const registerSchema = checkEmailSchema.extend({
  name: z
    .string({ error: 'Informe seu nome.' })
    .trim()
    .min(1, 'Informe seu nome.')
    .max(100, 'O nome deve ter no máximo 100 caracteres.'),
  password: password.refine(
    (value) => value.length >= 8,
    'A senha deve ter pelo menos 8 caracteres.',
  ),
});

export type CheckEmailDto = z.infer<typeof checkEmailSchema>;
export type LoginDto = z.infer<typeof loginSchema>;
export type RegisterDto = z.infer<typeof registerSchema>;
