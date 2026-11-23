import 'reflect-metadata';
import 'dotenv/config';
import mongoose from 'mongoose';
import { Usuario, UsuarioSchema } from './usuarios/schemas/usuario.schema.js';
import { Tecnologia, TecnologiaSchema } from './usuarios/schemas/tecnologia.schema.js';
import { technologySeedOperations } from './tecnologias-iniciais.js';
import {
  buildSeedUser,
  readSeedConfig,
  SeedConfigurationError,
} from './seed-config.js';

async function seed() {
  const config = readSeedConfig(process.env);

  try {
    await mongoose.connect(config.uri, {
      directConnection: true,
      serverSelectionTimeoutMS: 10000,
    });
    const usuarios = mongoose.model(Usuario.name, UsuarioSchema);
    const tecnologias = mongoose.model(Tecnologia.name, TecnologiaSchema);
    await usuarios.init();
    await tecnologias.init();

    const usuario = new usuarios(await buildSeedUser(config));
    await usuario.validate();
    const now = new Date();
    const insertedUser = usuario.toObject();
    insertedUser.criado_em = now;
    insertedUser.atualizado_em = now;

    const result = await usuarios.updateOne(
      { email: usuario.email },
      { $setOnInsert: insertedUser },
      { upsert: true, runValidators: true, timestamps: false },
    );

    await tecnologias.bulkWrite(technologySeedOperations(now));

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
  const message =
    error instanceof SeedConfigurationError
      ? error.message
      : 'Verifique a conexão MongoDB, as permissões e conflitos nos índices únicos.';
  console.error(`Falha no seed: ${message}`);
  process.exitCode = 1;
});
