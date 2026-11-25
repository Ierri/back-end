import { MODULE_METADATA } from '@nestjs/common/constants';
import { getModelToken } from '@nestjs/mongoose';
import { Types, model } from 'mongoose';
import type { Schema } from 'mongoose';
import { ComentariosModule } from './comentarios/comentarios.module.js';
import { ComentarioSchema } from './comentarios/schemas/comentario.schema.js';
import { PublicacoesModule } from './publicacoes/publicacoes.module.js';
import { PublicacaoSalvaSchema } from './publicacoes/schemas/publicacao-salva.schema.js';
import { PublicacaoSchema } from './publicacoes/schemas/publicacao.schema.js';
import { UploadMediaSchema } from './publicacoes/schemas/upload-media.schema.js';
import { VotoSchema } from './publicacoes/schemas/voto.schema.js';
import { technologySeedOperations, TECNOLOGIAS_INICIAIS } from './tecnologias-iniciais.js';
import { UsuariosModule } from './usuarios/usuarios.module.js';
import { SeguidorSchema } from './usuarios/schemas/seguidor.schema.js';
import { TecnologiaSchema } from './usuarios/schemas/tecnologia.schema.js';
import { UsuarioSchema } from './usuarios/schemas/usuario.schema.js';

const UsuarioModel = model('ModelagemUsuario', UsuarioSchema);
const TecnologiaModel = model('ModelagemTecnologia', TecnologiaSchema);
const SeguidorModel = model('ModelagemSeguidor', SeguidorSchema);
const VotoModel = model('ModelagemVoto', VotoSchema);
const PublicacaoSalvaModel = model('ModelagemPublicacaoSalva', PublicacaoSalvaSchema);
const ComentarioModel = model('ModelagemComentario', ComentarioSchema);

function user(overrides: Record<string, unknown> = {}) {
  return {
    nome: 'Pessoa de teste',
    email: 'pessoa@example.test',
    username: 'pessoa_teste',
    senha_hash: 'hash-de-teste',
    ...overrides,
  };
}

function hasIndex(schema: Schema, keys: Record<string, number>, unique = false) {
  return schema.indexes().some(([fields, options]) =>
    JSON.stringify(fields) === JSON.stringify(keys) && (!unique || options.unique === true),
  );
}

function registeredModels(module: object) {
  const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) as Array<{
    providers?: Array<{ provide?: string }>;
  }>;
  return imports.flatMap((entry) => entry.providers ?? []).map((provider) => provider.provide);
}

describe('modelagem MongoDB consolidada', () => {
  it('preserves legacy user documents and confidential authentication fields', async () => {
    const old = UsuarioModel.hydrate({ _id: new Types.ObjectId(), ...user(), criado_em: new Date() });
    expect(old.stack_ids).toEqual([]);
    expect(old.visibilidade_perfil).toBe('publico');
    expect(old.papeis).toEqual(['usuario']);
    expect(old.status).toBe('ativo');
    expect(old.contadores).toMatchObject({ publicacoes: 0, seguidores: 0, seguindo: 0, score: 0 });
    await expect(old.validate()).resolves.toBeUndefined();
    expect(UsuarioSchema.path('senha_hash').options.select).toBe(false);
    expect(hasIndex(UsuarioSchema, { email: 1 }, true)).toBe(true);
    expect(hasIndex(UsuarioSchema, { username: 1 }, true)).toBe(true);
  });

  it('limits user stacks and roles without accepting duplicates or invalid references', async () => {
    const ids = Array.from({ length: 20 }, () => new Types.ObjectId());
    await expect(new UsuarioModel(user({ stack_ids: ids })).validate()).resolves.toBeUndefined();
    const invalidStacks = [[...ids, new Types.ObjectId()], [ids[0], ids[0]], ['invalid']];
    const stackResults = await Promise.all(invalidStacks.map(async (stack_ids) =>
      new UsuarioModel(user({ stack_ids })).validate().then(() => 'accepted', () => 'rejected'),
    ));
    expect(stackResults).toEqual(['rejected', 'rejected', 'rejected']);
    for (const papeis of [[], ['usuario', 'usuario'], ['invalido']]) {
      await expect(new UsuarioModel(user({ papeis })).validate()).rejects.toThrow();
    }
  });

  it('validates user lifecycle and counter projections', async () => {
    await expect(new UsuarioModel(user({ status: 'excluido' })).validate()).rejects.toThrow();
    await expect(new UsuarioModel(user({ status: 'excluido', excluido_em: new Date() })).validate()).resolves.toBeUndefined();
    await expect(new UsuarioModel(user({ termos_aceitos_em: new Date() })).validate()).rejects.toThrow();
    await expect(new UsuarioModel(user({ contadores: { publicacoes: -1 } })).validate()).rejects.toThrow();
    await expect(new UsuarioModel(user({ contadores: { seguidores: 1.5 } })).validate()).rejects.toThrow();
  });

  it('validates technology slugs and exposes catalogue indexes', async () => {
    await expect(new TecnologiaModel({ nome: '  Node.js  ', slug: '  NODE-JS  ' }).validate()).resolves.toBeUndefined();
    await expect(new TecnologiaModel({ nome: 'Node', slug: 'Node js' }).validate()).rejects.toThrow();
    expect(hasIndex(TecnologiaSchema, { slug: 1 }, true)).toBe(true);
    expect(hasIndex(TecnologiaSchema, { ativo: 1, nome: 1, _id: 1 })).toBe(true);
  });

  it('rejects self follows and inconsistent acceptance dates', async () => {
    const follower = new Types.ObjectId();
    const followed = new Types.ObjectId();
    await expect(new SeguidorModel({ seguidor_id: follower, seguido_id: followed, status: 'pendente' }).validate()).resolves.toBeUndefined();
    await expect(new SeguidorModel({ seguidor_id: follower, seguido_id: follower, status: 'pendente' }).validate()).rejects.toThrow();
    await expect(new SeguidorModel({ seguidor_id: follower, seguido_id: followed, status: 'aceito' }).validate()).rejects.toThrow();
    await expect(new SeguidorModel({ seguidor_id: follower, seguido_id: followed, status: 'aceito', aceito_em: new Date() }).validate()).resolves.toBeUndefined();
    expect(hasIndex(SeguidorSchema, { seguidor_id: 1, seguido_id: 1 }, true)).toBe(true);
    expect(hasIndex(SeguidorSchema, { seguido_id: 1, status: 1, solicitado_em: -1, _id: -1 })).toBe(true);
    await expect(new SeguidorModel({ seguidor_id: 'invalid', seguido_id: followed, status: 'pendente' }).validate()).rejects.toThrow();
  });

  it('restricts votes and preserves unique and paginated relations', async () => {
    const publicacao_id = new Types.ObjectId();
    const usuario_id = new Types.ObjectId();
    await expect(new VotoModel({ publicacao_id, usuario_id, valor: 1 }).validate()).resolves.toBeUndefined();
    await expect(new VotoModel({ publicacao_id, usuario_id, valor: 0 }).validate()).rejects.toThrow();
    await expect(new VotoModel({ publicacao_id: 'invalid', usuario_id, valor: 1 }).validate()).rejects.toThrow();
    await expect(new PublicacaoSalvaModel({ publicacao_id, usuario_id }).validate()).resolves.toBeUndefined();
    expect(hasIndex(VotoSchema, { publicacao_id: 1, usuario_id: 1 }, true)).toBe(true);
    expect(hasIndex(VotoSchema, { usuario_id: 1, atualizado_em: -1, _id: -1 })).toBe(true);
    expect(hasIndex(PublicacaoSalvaSchema, { usuario_id: 1, publicacao_id: 1 }, true)).toBe(true);
    expect(hasIndex(PublicacaoSalvaSchema, { usuario_id: 1, criado_em: -1, _id: -1 })).toBe(true);
    await expect(new PublicacaoSalvaModel({ publicacao_id: 'invalid', usuario_id }).validate()).rejects.toThrow();
  });

  it('preserves the canonical comment hierarchy, idempotency and publication counters', async () => {
    const id = new Types.ObjectId();
    const base = { _id: id, publicacao_id: new Types.ObjectId(), autor_id: new Types.ObjectId(), profundidade: 1, conteudo: 'Texto', comentario_pai_id: id, comentario_raiz_id: id };
    await expect(new ComentarioModel(base).validate()).rejects.toThrow();
    await expect(new ComentarioModel({ ...base, _id: new Types.ObjectId(), conteudo: '  ' }).validate()).rejects.toThrow();
    expect(ComentarioSchema.path('criacao_estado')).toBeDefined();
    expect(ComentarioSchema.path('conteudo').options.maxlength).toBe(2000);
    expect(PublicacaoSchema.path('comentarios_revisao')).toBeDefined();
    expect(PublicacaoSchema.path('comentarios_operacoes_pendentes')).toBeDefined();
    for (const [schema, path] of [
      [ComentarioSchema, 'publicacao_id'],
      [ComentarioSchema, 'comentario_pai_id'],
      [PublicacaoSchema, 'autor_id'],
      [UploadMediaSchema, 'usuario_id'],
      [UploadMediaSchema, 'publicacao_id'],
    ] as const) expect((schema as Schema).path(path).instance).toBe('ObjectId');
    expect(hasIndex(ComentarioSchema, { publicacao_id: 1, comentario_pai_id: 1, criado_em: 1, _id: 1 })).toBe(true);
  });

  it('registers one comment model and preserves module exports', () => {
    expect(registeredModels(UsuariosModule)).toEqual(expect.arrayContaining([getModelToken('Usuario'), getModelToken('Tecnologia'), getModelToken('Seguidor')]));
    expect(registeredModels(PublicacoesModule)).toEqual(expect.arrayContaining([getModelToken('Publicacao'), getModelToken('UploadMedia'), getModelToken('Voto'), getModelToken('PublicacaoSalva')]));
    expect(registeredModels(PublicacoesModule)).not.toContain(getModelToken('Comentario'));
    expect(registeredModels(ComentariosModule)).toContain(getModelToken('Comentario'));
    const exports = Reflect.getMetadata(MODULE_METADATA.EXPORTS, PublicacoesModule) as Array<{ name: string }>;
    expect(exports.map((provider) => provider.name)).toEqual(expect.arrayContaining(['OptionalAuthGuard', 'RequiredAuthGuard', 'PublicacoesCacheService']));
  });

  it('builds an insert-only synthetic catalogue with stable unique slugs', () => {
    const now = new Date();
    const operations = technologySeedOperations(now);
    expect(operations).toHaveLength(TECNOLOGIAS_INICIAIS.length);
    expect(new Set(TECNOLOGIAS_INICIAIS.map((item) => item.slug)).size).toBe(operations.length);
    for (const { updateOne } of operations) {
      expect(updateOne.filter.slug).toBe(updateOne.update.$setOnInsert.slug);
      expect(updateOne.upsert).toBe(true);
      expect(updateOne.timestamps).toBe(false);
      expect(updateOne.update).not.toHaveProperty('$set');
      expect(updateOne.update.$setOnInsert.criado_em).toBe(now);
    }
  });
});
