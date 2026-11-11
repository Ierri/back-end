import { hash } from 'bcryptjs';
import { checkEmailSchema } from './auth/dto/auth.dto.js';

export class SeedConfigurationError extends Error {}

export type SeedConfig = {
  uri: string;
  name: string;
  email: string;
  username: string;
  password: string;
};

function required(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  if (!value) throw new SeedConfigurationError(`Defina ${key} no ambiente.`);
  return value;
}

export function readSeedConfig(env: NodeJS.ProcessEnv): SeedConfig {
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new SeedConfigurationError(
      'O seed é permitido apenas com NODE_ENV=development ou test.',
    );
  }

  const uri = required(env, 'MONGODB_URI');
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new SeedConfigurationError('MONGODB_URI do seed é inválida.');
  }
  const database = parsed.pathname.slice(1);
  if (
    parsed.protocol !== 'mongodb:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(
      parsed.hostname.toLowerCase(),
    ) ||
    !/^[a-zA-Z0-9_-]+$/.test(database) ||
    ['admin', 'config', 'local'].includes(database.toLowerCase())
  ) {
    throw new SeedConfigurationError(
      'MONGODB_URI do seed deve apontar para um banco de aplicação local.',
    );
  }

  const name = required(env, 'IERRI_SEED_NAME');
  if (name.length > 100) {
    throw new SeedConfigurationError('IERRI_SEED_NAME é inválido.');
  }
  const parsedEmail = checkEmailSchema.safeParse({
    email: required(env, 'IERRI_SEED_EMAIL'),
  });
  if (!parsedEmail.success) {
    throw new SeedConfigurationError('IERRI_SEED_EMAIL é inválido.');
  }
  const username = required(env, 'IERRI_SEED_USERNAME').toLowerCase();
  if (!/^[a-z0-9_]{3,30}$/.test(username)) {
    throw new SeedConfigurationError('IERRI_SEED_USERNAME é inválido.');
  }
  const password = env.IERRI_SEED_PASSWORD;
  if (
    !password ||
    password.trim().length < 16 ||
    Buffer.byteLength(password, 'utf8') > 72 ||
    new Set(password).size < 6
  ) {
    throw new SeedConfigurationError(
      'Defina IERRI_SEED_PASSWORD com pelo menos 16 caracteres, até 72 bytes e valor não trivial.',
    );
  }

  return { uri, name, email: parsedEmail.data.email, username, password };
}

export async function buildSeedUser(config: SeedConfig) {
  return {
    nome: config.name,
    email: config.email,
    username: config.username,
    senha_hash: await hash(config.password, 12),
    biografia: 'Perfil fictício para desenvolvimento do Ierri.',
    avatar_url: '/brand/ierri/social/github-avatar-512.png',
  };
}
