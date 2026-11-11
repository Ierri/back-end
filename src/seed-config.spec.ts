import { compare } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import {
  buildSeedUser,
  readSeedConfig,
  SeedConfigurationError,
} from './seed-config.js';

function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/ierri_seed_test',
    IERRI_SEED_NAME: 'Pessoa de Teste',
    IERRI_SEED_EMAIL: 'Pessoa@example.test',
    IERRI_SEED_USERNAME: 'Pessoa_Teste',
    IERRI_SEED_PASSWORD: randomBytes(24).toString('hex'),
  };
}

describe('seed configuration', () => {
  it.each(['development', 'test'])(
    'accepts %s with explicit local configuration',
    (environment) => {
      const env = validEnv();
      env.NODE_ENV = environment;

      const config = readSeedConfig(env);

      expect(config).toMatchObject({
        uri: env.MONGODB_URI,
        name: env.IERRI_SEED_NAME,
        email: 'pessoa@example.test',
        username: 'pessoa_teste',
        password: env.IERRI_SEED_PASSWORD,
      });
    },
  );

  it.each([undefined, 'production', 'staging'])(
    'blocks unsupported NODE_ENV %s',
    (environment) => {
      const env = validEnv();
      env.NODE_ENV = environment;
      expect(() => readSeedConfig(env)).toThrow(SeedConfigurationError);
    },
  );

  it.each([
    'mongodb+srv://cluster.example.test/ierri',
    'mongodb://db.example.test:27017/ierri',
    'mongodb://127.0.0.1:27017',
    'mongodb://127.0.0.1:27017/admin',
    'not-a-mongodb-uri',
  ])('rejects nonlocal or invalid MongoDB URI %s', (uri) => {
    const env = validEnv();
    env.MONGODB_URI = uri;
    expect(() => readSeedConfig(env)).toThrow(SeedConfigurationError);
  });

  it.each([
    'MONGODB_URI',
    'IERRI_SEED_NAME',
    'IERRI_SEED_EMAIL',
    'IERRI_SEED_USERNAME',
    'IERRI_SEED_PASSWORD',
  ])('requires %s without fallback credentials', (key) => {
    const env = validEnv();
    delete env[key];
    expect(() => readSeedConfig(env)).toThrow(SeedConfigurationError);
  });

  it('rejects invalid identities and predictable or incompatible passwords', () => {
    const env = validEnv();
    env.IERRI_SEED_EMAIL = 'invalid';
    expect(() => readSeedConfig(env)).toThrow(SeedConfigurationError);
    env.IERRI_SEED_EMAIL = 'pessoa@example.test';
    env.IERRI_SEED_USERNAME = 'a';
    expect(() => readSeedConfig(env)).toThrow(SeedConfigurationError);
    env.IERRI_SEED_USERNAME = 'pessoa_teste';
    for (const password of ['1234', 'a'.repeat(20), 'á'.repeat(40)]) {
      env.IERRI_SEED_PASSWORD = password;
      expect(() => readSeedConfig(env)).toThrow(SeedConfigurationError);
    }
  });

  it('builds an existing compatible user shape with a bcrypt hash and no plaintext field', async () => {
    const config = readSeedConfig(validEnv());
    const user = await buildSeedUser(config);

    expect(user).toMatchObject({
      nome: config.name,
      email: config.email,
      username: config.username,
    });
    expect(user.senha_hash).not.toBe(config.password);
    expect(user.senha_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(await compare(config.password, user.senha_hash)).toBe(true);
    expect(user).not.toHaveProperty('password');
  });
});
