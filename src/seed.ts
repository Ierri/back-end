import 'reflect-metadata';
import 'dotenv/config';
import mongoose from 'mongoose';
import { hash } from 'bcryptjs';
import { Usuario, UsuarioSchema } from './usuarios/schemas/usuario.schema.js';

async function seed() {
  const uri = process.env.MONGODB_URI?.trim();
  const password = '1234';

  if (!uri) {
    throw new Error('Defina MONGODB_URI no .env ou no ambiente.');
  }

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    const usuarios = mongoose.model(Usuario.name, UsuarioSchema);
    await usuarios.init();

    const usuario = new usuarios({
      nome: 'Admin',
      email: 'admin@ierri.com.br',
      username: 'admin',
      senha_hash: await hash(password, 12),
      biografia: 'Perfil fictício para desenvolvimento do Ierri.',
      avatar_url: '/brand/ierri/social/github-avatar-512.png',
    });
    await usuario.validate();

    const result = await usuarios.updateOne(
      { email: usuario.email },
      { $setOnInsert: usuario.toObject() },
      { upsert: true, runValidators: true },
    );

    console.log(
      result.upsertedCount
        ? 'Seed concluído: usuário criado.'
        : 'Seed concluído: usuário já existe.',
    );
  } finally {
    await mongoose.disconnect();
  }
}

seed().catch((error: unknown) => {
  // Avoid logging connection strings or credentials from database errors.
  const message =
    error instanceof Error && error.message.startsWith('Defina ')
      ? error.message
      : 'Verifique a conexão MongoDB, as permissões e conflitos nos índices únicos.';
  console.error(`Falha no seed: ${message}`);
  process.exitCode = 1;
});
