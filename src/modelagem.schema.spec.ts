import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { model, Types } from 'mongoose';
import { Usuario, UsuarioSchema } from './usuarios/schemas/usuario.schema.js';
import {
  Tecnologia,
  TecnologiaSchema,
} from './usuarios/schemas/tecnologia.schema.js';
import {
  Seguidor,
  SeguidorSchema,
} from './usuarios/schemas/seguidor.schema.js';
import { Voto, VotoSchema } from './publicacoes/schemas/voto.schema.js';
import {
  PublicacaoSalva,
  PublicacaoSalvaSchema,
} from './publicacoes/schemas/publicacao-salva.schema.js';
import {
  Comentario,
  ComentarioSchema,
} from './publicacoes/schemas/comentario.schema.js';
import {
  Publicacao,
  PublicacaoSchema,
} from './publicacoes/schemas/publicacao.schema.js';

const Usuarios = model(Usuario.name, UsuarioSchema);
const Tecnologias = model(Tecnologia.name, TecnologiaSchema);
const Seguidores = model(Seguidor.name, SeguidorSchema);
const Votos = model(Voto.name, VotoSchema);
const Salvas = model(PublicacaoSalva.name, PublicacaoSalvaSchema);
const Comentarios = model(Comentario.name, ComentarioSchema);
const Publicacoes = model(Publicacao.name, PublicacaoSchema);

describe('contrato dos schemas sociais', () => {
  it('declara índices únicos das identidades e relações', () => {
    for (const [schema, key] of [
      [UsuarioSchema, 'email'],
      [UsuarioSchema, 'username'],
      [TecnologiaSchema, 'slug'],
      [SeguidorSchema, 'seguidor_id,seguido_id'],
      [VotoSchema, 'publicacao_id,usuario_id'],
      [PublicacaoSalvaSchema, 'usuario_id,publicacao_id'],
    ] as const) {
      expect(
        schema
          .indexes()
          .some(
            ([fields, options]) =>
              Object.keys(fields).join(',') === key && options.unique === true,
          ),
      ).toBe(true);
    }
  });

  it('aceita documentos antigos de usuário com defaults sociais', async () => {
    const user = new Usuarios({
      nome: 'Pessoa Teste',
      email: 'TESTE@EXAMPLE.COM',
      username: 'PESSOA',
      senha_hash: 'hash',
    });
    await expect(user.validate()).resolves.toBeUndefined();
    expect(user.email).toBe('teste@example.com');
    expect(user.stack_ids).toEqual([]);
    expect(user.contadores.seguidores).toBe(0);
  });

  it('rejeita stacks repetidas, auto-follow e estado de aceite inconsistente', async () => {
    const id = new Types.ObjectId();
    const user = new Usuarios({
      nome: 'Pessoa',
      email: 'x@example.com',
      username: 'pessoa',
      senha_hash: 'hash',
      stack_ids: [id, id],
    });
    await expect(user.validate()).rejects.toMatchObject({
      errors: { stack_ids: expect.anything() },
    });
    const follow = new Seguidores({
      seguidor_id: id,
      seguido_id: id,
      status: 'aceito',
    });
    await expect(follow.validate()).rejects.toMatchObject({
      errors: { seguido_id: expect.anything(), aceito_em: expect.anything() },
    });
  });

  it('rejeita campos sociais nulos e contadores fracionários', async () => {
    const user = new Usuarios({
      nome: 'Pessoa',
      email: 'y@example.com',
      username: 'pessoay',
      senha_hash: 'hash',
      stack_ids: null,
      papeis: null,
      status: null,
      contadores: { seguidores: 1.5 },
    });
    await expect(user.validate()).rejects.toMatchObject({
      errors: {
        stack_ids: expect.anything(),
        papeis: expect.anything(),
        status: expect.anything(),
        'contadores.seguidores': expect.anything(),
      },
    });
  });

  it('rejeita score de publicação incompatível e contador nulo', async () => {
    const post = new Publicacoes({
      slug: 'post-audit',
      autor_id: new Types.ObjectId(),
      conteudo: 'Teste',
      midias: [
        {
          tipo: 'imagem',
          url: 'https://example.com/image.png',
          chave_storage: 'image',
          mime_type: 'image/png',
          tamanho_bytes: 10,
          largura: 1,
          altura: 1,
          duracao_segundos: null,
          ordem: 0,
        },
      ],
      contadores: { upvotes: 1, downvotes: 0, score: 0, comentarios: null },
    });
    await expect(post.validate()).rejects.toMatchObject({
      errors: {
        'contadores.score': expect.anything(),
        'contadores.comentarios': expect.anything(),
      },
    });
  });

  it('restringe valor de voto e slug do catálogo', async () => {
    const id = new Types.ObjectId();
    await expect(
      new Votos({ publicacao_id: id, usuario_id: id, valor: 0 }).validate(),
    ).rejects.toMatchObject({ errors: { valor: expect.anything() } });
    await expect(
      new Tecnologias({ nome: 'Teste', slug: 'Slug Inválido' }).validate(),
    ).rejects.toMatchObject({ errors: { slug: expect.anything() } });
    await expect(
      new Salvas({ publicacao_id: id, usuario_id: id }).validate(),
    ).resolves.toBeUndefined();
  });

  it('valida a estrutura local da árvore de comentários', async () => {
    const id = new Types.ObjectId();
    await expect(
      new Comentarios({
        publicacao_id: id,
        autor_id: id,
        profundidade: 1,
        conteudo: 'Resposta sem pai',
      }).validate(),
    ).rejects.toMatchObject({ errors: { profundidade: expect.anything() } });
    await expect(
      new Comentarios({
        publicacao_id: id,
        autor_id: id,
        profundidade: 0,
        conteudo: 'Comentário raiz',
      }).validate(),
    ).resolves.toBeUndefined();
    await expect(
      new Comentarios({
        publicacao_id: id,
        autor_id: id,
        profundidade: 1,
        comentario_pai_id: id,
        comentario_raiz_id: new Types.ObjectId(),
        conteudo: 'Raiz incorreta',
      }).validate(),
    ).rejects.toMatchObject({
      errors: { comentario_raiz_id: expect.anything() },
    });
  });
});
