import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { createConnection, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { technologySeedOperations, TECNOLOGIAS_INICIAIS } from '../src/tecnologias-iniciais.js';
import { PublicacaoSalva, PublicacaoSalvaSchema } from '../src/publicacoes/schemas/publicacao-salva.schema.js';
import { Voto, VotoSchema } from '../src/publicacoes/schemas/voto.schema.js';
import { Seguidor, SeguidorSchema } from '../src/usuarios/schemas/seguidor.schema.js';
import { Tecnologia, TecnologiaSchema } from '../src/usuarios/schemas/tecnologia.schema.js';
import { Usuario, UsuarioSchema } from '../src/usuarios/schemas/usuario.schema.js';

const execFileAsync = promisify(execFile);

const mongoUri = (() => {
  try {
    const uri = new URL(process.env.MONGODB_URI ?? '');
    if (uri.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(uri.hostname)) return null;
    uri.pathname = `/ierri_modelagem_test_${randomBytes(8).toString('hex')}`;
    return uri.toString();
  } catch {
    return null;
  }
})();

describe.runIf(mongoUri)('modelagem com MongoDB local isolado', () => {
  let connection: Connection | undefined;

  beforeAll(async () => {
    connection = await createConnection(mongoUri!, { serverSelectionTimeoutMS: 5000 }).asPromise();
    const models = [
      connection.model(Usuario.name, UsuarioSchema),
      connection.model(Tecnologia.name, TecnologiaSchema),
      connection.model(Seguidor.name, SeguidorSchema),
      connection.model(Voto.name, VotoSchema),
      connection.model(PublicacaoSalva.name, PublicacaoSalvaSchema),
    ];
    await Promise.all(models.map((entry) => entry.init()));
  });

  afterAll(async () => {
    if (!connection) return;
    await connection.dropDatabase();
    await connection.close();
  });

  it('enforces unique technology slugs in MongoDB', async () => {
    const tecnologias = connection!.model(Tecnologia.name, TecnologiaSchema);
    await tecnologias.create({ nome: 'Teste', slug: 'teste-unico' });
    await expect(tecnologias.create({ nome: 'Outro', slug: 'teste-unico' })).rejects.toMatchObject({ code: 11000 });
  });

  it('runs the complete seed twice without duplicating or overwriting existing records', async () => {
    const usuarios = connection!.model(Usuario.name, UsuarioSchema);
    const tecnologias = connection!.model(Tecnologia.name, TecnologiaSchema);
    const existing = await tecnologias.create({ nome: 'Tecnologia local', slug: 'tecnologia-local', ativo: false });
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      MONGODB_URI: mongoUri!,
      IERRI_SEED_NAME: 'Pessoa fictícia do seed',
      IERRI_SEED_EMAIL: 'seed@example.test',
      IERRI_SEED_USERNAME: 'seed_ficticio',
      IERRI_SEED_PASSWORD: randomBytes(24).toString('hex'),
    };
    const runSeed = () => execFileAsync('bun', ['src/seed.ts'], { cwd: process.cwd(), env, timeout: 30_000 });

    await runSeed();
    const firstUser = await usuarios.findOne({ email: env.IERRI_SEED_EMAIL }).select('+senha_hash').lean().exec();
    expect(firstUser).toMatchObject({ nome: env.IERRI_SEED_NAME, username: env.IERRI_SEED_USERNAME });
    expect(firstUser?.senha_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(await tecnologias.countDocuments({ slug: { $in: TECNOLOGIAS_INICIAIS.map((item) => item.slug) } })).toBe(14);

    await usuarios.updateOne({ email: env.IERRI_SEED_EMAIL }, { $set: { nome: 'Nome preservado' } });
    await tecnologias.updateOne({ slug: 'html' }, { $set: { nome: 'HTML personalizado', ativo: false } });
    const beforeUser = await usuarios.findOne({ email: env.IERRI_SEED_EMAIL }).select('+senha_hash').lean().exec();
    const beforeTechnology = await tecnologias.findOne({ slug: 'html' }).lean().exec();

    await runSeed();
    expect(await usuarios.countDocuments({ email: env.IERRI_SEED_EMAIL })).toBe(1);
    expect(await usuarios.findOne({ email: env.IERRI_SEED_EMAIL }).select('+senha_hash').lean().exec()).toEqual(beforeUser);
    expect(await tecnologias.findOne({ slug: 'html' }).lean().exec()).toEqual(beforeTechnology);
    expect(await tecnologias.findById(existing._id).lean().exec()).toMatchObject({ nome: 'Tecnologia local', ativo: false });
    expect(await tecnologias.countDocuments({ slug: { $in: TECNOLOGIAS_INICIAIS.map((item) => item.slug) } })).toBe(14);
  });

  it('keeps the catalogue idempotent and preserves edited or inactive entries', async () => {
    const tecnologias = connection!.model(Tecnologia.name, TecnologiaSchema);
    await tecnologias.bulkWrite(technologySeedOperations(new Date()));
    await tecnologias.updateOne({ slug: 'html' }, { $set: { nome: 'HTML personalizado', ativo: false } });
    const before = await tecnologias.findOne({ slug: 'html' }).lean().exec();
    await tecnologias.bulkWrite(technologySeedOperations(new Date()));
    const after = await tecnologias.findOne({ slug: 'html' }).lean().exec();
    expect(after).toEqual(before);
    expect(await tecnologias.countDocuments({ slug: { $in: TECNOLOGIAS_INICIAIS.map((entry) => entry.slug) } })).toBe(14);
  });

  it('enforces unique follower, vote and saved-publication pairs', async () => {
    const seguidores = connection!.model(Seguidor.name, SeguidorSchema);
    const votos = connection!.model(Voto.name, VotoSchema);
    const salvas = connection!.model(PublicacaoSalva.name, PublicacaoSalvaSchema);
    const usuario_id = new Types.ObjectId();
    const publicacao_id = new Types.ObjectId();
    const seguido_id = new Types.ObjectId();
    await seguidores.create({ seguidor_id: usuario_id, seguido_id, status: 'pendente' });
    await expect(seguidores.create({ seguidor_id: usuario_id, seguido_id, status: 'pendente' })).rejects.toMatchObject({ code: 11000 });
    await votos.create({ usuario_id, publicacao_id, valor: 1 });
    await expect(votos.create({ usuario_id, publicacao_id, valor: -1 })).rejects.toMatchObject({ code: 11000 });
    await salvas.create({ usuario_id, publicacao_id });
    await expect(salvas.create({ usuario_id, publicacao_id })).rejects.toMatchObject({ code: 11000 });
  });

  it('persists legacy users with social defaults while keeping credentials excluded', async () => {
    const usuarios = connection!.model(Usuario.name, UsuarioSchema);
    const created = await usuarios.create({ nome: 'Pessoa fictícia', email: 'ficticia@example.test', username: 'ficticia', senha_hash: 'hash-de-teste' });
    const read = await usuarios.findById(created._id).lean().exec();
    expect(read).toMatchObject({ stack_ids: [], visibilidade_perfil: 'publico', papeis: ['usuario'], status: 'ativo' });
    expect(read).not.toHaveProperty('senha_hash');
    expect(read?.atualizado_em).toBeInstanceOf(Date);
  });
});
