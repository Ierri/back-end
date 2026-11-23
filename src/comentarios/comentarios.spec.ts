import { createHash } from 'node:crypto';
import { Types, model } from 'mongoose';
import type { Model } from 'mongoose';
import type { ConfigService } from '@nestjs/config';
import { ApiException } from '../common/http/api.exception.js';
import type { PublicacoesCacheService } from '../publicacoes/publicacoes-cache.service.js';
import type { Publicacao } from '../publicacoes/schemas/publicacao.schema.js';
import type { Usuario } from '../usuarios/schemas/usuario.schema.js';
import { ComentariosCursor } from './comentarios.cursor.js';
import { ComentariosService } from './comentarios.service.js';
import type { Comentario } from './schemas/comentario.schema.js';
import { ComentarioSchema } from './schemas/comentario.schema.js';
import { createComentarioSchema, listComentariosSchema, updateComentarioSchema } from './dto/comentarios.dto.js';

const publicationId = new Types.ObjectId();
const authorId = new Types.ObjectId();
const otherId = new Types.ObjectId();
const rootId = new Types.ObjectId();
const replyId = new Types.ObjectId();

function q(value: unknown) {
  const result = { exec: vi.fn().mockResolvedValue(value), select: vi.fn(), sort: vi.fn(), limit: vi.fn() };
  result.select.mockReturnValue(result);
  result.sort.mockReturnValue(result);
  result.limit.mockReturnValue(result);
  return result;
}

function comment(overrides: Record<string, unknown> = {}) {
  return {
    _id: rootId,
    publicacao_id: publicationId,
    autor_id: authorId,
    comentario_pai_id: null,
    comentario_raiz_id: null,
    profundidade: 0,
    conteudo: 'Texto',
    status: 'publicado',
    editado_em: null,
    criado_em: new Date('2026-11-13T00:00:00Z'),
    atualizado_em: new Date('2026-11-13T00:00:00Z'),
    ...overrides,
  };
}

function setup() {
  const publication = { _id: publicationId, autor_id: authorId };
  const author = { _id: authorId, nome: 'Autora', username: 'autora', avatar_url: null };
  const comments = {
    create: vi.fn().mockImplementation(async (value: Record<string, unknown>) => comment(value)),
    findOne: vi.fn().mockReturnValue(q(null)),
    findById: vi.fn().mockReturnValue(q(comment())),
    find: vi.fn().mockReturnValue(q([])),
    findOneAndUpdate: vi.fn().mockReturnValue(q(comment())),
    updateOne: vi.fn().mockReturnValue(q({ modifiedCount: 1 })),
    deleteOne: vi.fn().mockReturnValue(q({ deletedCount: 1 })),
    countDocuments: vi.fn().mockReturnValue(q(0)),
    exists: vi.fn().mockResolvedValue({ _id: rootId }),
  };
  const publications = {
    findOne: vi.fn().mockReturnValue(q(publication)),
    findById: vi.fn().mockReturnValue(q(publication)),
    updateOne: vi.fn().mockReturnValue(q({ modifiedCount: 1 })),
  };
  const users = {
    findById: vi.fn().mockReturnValue(q(author)),
    find: vi.fn().mockReturnValue(q([author])),
  };
  const cache = { invalidate: vi.fn().mockResolvedValue(undefined) };
  const cursor = new ComentariosCursor({ getOrThrow: () => 'unit-test-secret-for-comment-cursors' } as unknown as ConfigService);
  const service = new ComentariosService(
    comments as unknown as Model<Comentario>,
    publications as unknown as Model<Publicacao>,
    users as unknown as Model<Usuario>,
    cursor,
    cache as unknown as PublicacoesCacheService,
  );
  return { service, comments, publications, users, cache, cursor };
}

describe('comentários: validação, hierarquia e consistência', () => {
  it('accepts a trimmed 2000-character text and rejects empty, long or injected input', () => {
    expect(createComentarioSchema.parse({ conteudo: '  texto  ' }).conteudo).toBe('texto');
    expect(createComentarioSchema.safeParse({ conteudo: 'x'.repeat(2000) }).success).toBe(true);
    for (const invalid of [
      { conteudo: '  ' },
      { conteudo: 'x'.repeat(2001) },
      { conteudo: 1 },
      { conteudo: 'x', autor_id: authorId.toString() },
      { conteudo: 'x', profundidade: 2 },
      { conteudo: 'x', comentarioPaiId: { $ne: null } },
      { conteudo: 'x', comentarioPaiId: 'invalid' },
    ]) expect(createComentarioSchema.safeParse(invalid).success).toBe(false);
    expect(updateComentarioSchema.safeParse({ conteudo: 'x', status: 'oculto' }).success).toBe(false);
    expect(listComentariosSchema.parse({}).limite).toBe(20);
    expect(listComentariosSchema.parse({ limite: '50' }).limite).toBe(50);
    expect(listComentariosSchema.safeParse({ limite: '51' }).success).toBe(false);
  });

  it('validates schema depth and immutable parent/author links', async () => {
    const ValidationModel = model('ComentarioValidation', ComentarioSchema);
    await expect(new ValidationModel(comment()).validate()).resolves.toBeUndefined();
    await expect(new ValidationModel(comment({ profundidade: 1, comentario_pai_id: rootId, comentario_raiz_id: null })).validate()).rejects.toThrow();
    await expect(new ValidationModel(comment({ profundidade: 2, comentario_pai_id: replyId, comentario_raiz_id: rootId })).validate()).resolves.toBeUndefined();
    expect(ComentarioSchema.path('autor_id').options.immutable).toBe(true);
    expect(ComentarioSchema.path('publicacao_id').options.immutable).toBe(true);
    expect(ComentarioSchema.path('comentario_pai_id').options.immutable).toBe(true);
  });

  it('creates a root and increments the publication counter once', async () => {
    const { service, comments, publications, cache } = setup();
    const result = await service.create(publicationId.toString(), authorId.toString(), { conteudo: 'Texto' });
    expect(result.profundidade).toBe(0);
    expect(result.comentarioPaiId).toBeNull();
    expect(comments.create).toHaveBeenCalledWith(expect.objectContaining({ autor_id: authorId, comentario_pai_id: null, comentario_raiz_id: null }));
    expect(publications.updateOne).toHaveBeenCalledWith(expect.objectContaining({ status: 'publicada' }), { $inc: { 'contadores.comentarios': 1, comentarios_revisao: 1 } });
    expect(cache.invalidate).toHaveBeenCalledWith(publicationId.toString(), authorId.toString());
  });

  it('derives depth one and two from the parent and rejects depth three', async () => {
    const { service, comments } = setup();
    comments.findOne.mockReturnValueOnce(q(comment()));
    const first = await service.create(publicationId.toString(), authorId.toString(), { conteudo: 'Resposta', comentarioPaiId: rootId.toString() });
    expect(first.profundidade).toBe(1);
    expect(first.comentarioRaizId).toBe(rootId.toString());
    comments.findOne.mockReturnValueOnce(q(comment({ _id: replyId, profundidade: 1, comentario_pai_id: rootId, comentario_raiz_id: rootId })));
    const second = await service.create(publicationId.toString(), authorId.toString(), { conteudo: 'Resposta da resposta', comentarioPaiId: replyId.toString() });
    expect(second.profundidade).toBe(2);
    expect(second.comentarioRaizId).toBe(rootId.toString());
    comments.findOne.mockReturnValueOnce(q(comment({ profundidade: 2 })));
    await expect(service.create(publicationId.toString(), authorId.toString(), { conteudo: 'Excesso', comentarioPaiId: replyId.toString() })).rejects.toMatchObject({ response: { code: 'COMENTARIO_DEPTH_EXCEEDED' } });
  });

  it('rejects missing or foreign parents and unavailable publications', async () => {
    const { service, comments, publications } = setup();
    await expect(service.create(publicationId.toString(), authorId.toString(), { conteudo: 'x', comentarioPaiId: rootId.toString() })).rejects.toBeInstanceOf(ApiException);
    expect(comments.create).not.toHaveBeenCalled();
    expect(comments.findOne).toHaveBeenCalledWith(expect.objectContaining({ publicacao_id: publicationId }));
    publications.findOne.mockReturnValue(q(null));
    await expect(service.create(publicationId.toString(), otherId.toString(), { conteudo: 'x' })).rejects.toMatchObject({ response: { code: 'PUBLICACAO_NOT_FOUND' } });
  });

  it('rejects creation when access changes before the operation is reserved', async () => {
    const { service, comments, publications } = setup();
    publications.findOne.mockReturnValueOnce(q({ _id: publicationId, autor_id: authorId }))
      .mockReturnValueOnce(q(null));
    publications.updateOne.mockReturnValueOnce(q({ modifiedCount: 0 }));
    await expect(service.create(publicationId.toString(), otherId.toString(), { conteudo: 'Texto' }))
      .rejects.toMatchObject({ response: { code: 'PUBLICACAO_NOT_FOUND' } });
    expect(publications.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ $or: [{ visibilidade: 'publico' }, { autor_id: otherId }] }),
      expect.anything(),
    );
    expect(comments.create).not.toHaveBeenCalled();
  });

  it('checks access again when the counter is incremented', async () => {
    const { service, comments, publications } = setup();
    publications.updateOne.mockReturnValueOnce(q({ modifiedCount: 1 }))
      .mockReturnValueOnce(q({ modifiedCount: 0 }));
    await expect(service.create(publicationId.toString(), otherId.toString(), { conteudo: 'Texto' }))
      .rejects.toMatchObject({ response: { code: 'PUBLICACAO_NOT_FOUND' } });
    expect(publications.updateOne).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ $or: [{ visibilidade: 'publico' }, { autor_id: otherId }] }),
      expect.anything(),
    );
    expect(comments.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ criacao_estado: 'pendente' }),
      { $set: { criacao_estado: 'falhou' } },
    );
  });

  it('rejects a reply whose recorded root is not in the same publication', async () => {
    const { service, comments } = setup();
    comments.findOne.mockReturnValue(q(comment({ _id: replyId, profundidade: 1, comentario_pai_id: rootId, comentario_raiz_id: rootId })));
    comments.exists.mockResolvedValueOnce(null);
    await expect(service.create(publicationId.toString(), authorId.toString(), { conteudo: 'x', comentarioPaiId: replyId.toString() })).rejects.toMatchObject({ response: { code: 'COMENTARIO_NOT_FOUND' } });
    expect(comments.create).not.toHaveBeenCalled();
  });

  it('marks a pending comment as failed if the publication disappears before increment', async () => {
    const { service, comments, publications } = setup();
    publications.updateOne.mockReturnValueOnce(q({ modifiedCount: 1 })).mockReturnValueOnce(q({ modifiedCount: 0 }));
    await expect(service.create(publicationId.toString(), authorId.toString(), { conteudo: 'x' })).rejects.toMatchObject({ response: { code: 'PUBLICACAO_NOT_FOUND' } });
    expect(comments.updateOne).toHaveBeenCalledWith(expect.objectContaining({ criacao_estado: 'pendente' }), { $set: { criacao_estado: 'falhou' } });
    expect(comments.deleteOne).not.toHaveBeenCalled();
    expect(comments.countDocuments).not.toHaveBeenCalled();
  });

  it('marks a reply as failed when its parent is removed during creation', async () => {
    const { service, comments, publications } = setup();
    comments.findOne.mockReturnValue(q(comment()));
    comments.exists.mockResolvedValueOnce(null);
    await expect(service.create(publicationId.toString(), authorId.toString(), { conteudo: 'x', comentarioPaiId: rootId.toString() })).rejects.toMatchObject({ response: { code: 'COMENTARIO_NOT_FOUND' } });
    expect(comments.updateOne).toHaveBeenCalledWith(expect.objectContaining({ criacao_estado: 'pendente' }), { $set: { criacao_estado: 'falhou' } });
    expect(publications.updateOne).toHaveBeenCalledTimes(2);
  });

  it('leaves an ambiguous counter update pending without deleting or reconciling', async () => {
    const { service, comments, publications, cache } = setup();
    publications.updateOne.mockReturnValueOnce(q({ modifiedCount: 1 })).mockReturnValueOnce({ exec: vi.fn().mockRejectedValue(new Error('connection lost')) });
    await expect(service.create(publicationId.toString(), authorId.toString(), { conteudo: 'x' })).rejects.toMatchObject({ response: { code: 'COMENTARIO_WRITE_UNAVAILABLE' } });
    expect(comments.deleteOne).not.toHaveBeenCalled();
    expect(comments.updateOne).not.toHaveBeenCalled();
    expect(comments.countDocuments).not.toHaveBeenCalled();
    expect(publications.updateOne).toHaveBeenCalledTimes(2);
    expect(cache.invalidate).toHaveBeenCalledWith(publicationId.toString(), authorId.toString());
  });

  it('allows a new attempt after a known failed counter update', async () => {
    const { service, comments, publications } = setup();
    publications.updateOne.mockReturnValueOnce(q({ modifiedCount: 1 })).mockReturnValueOnce(q({ modifiedCount: 0 }));
    await expect(service.create(publicationId.toString(), authorId.toString(), { conteudo: 'x' })).rejects.toMatchObject({ response: { code: 'PUBLICACAO_NOT_FOUND' } });
    await expect(service.create(publicationId.toString(), authorId.toString(), { conteudo: 'x' })).resolves.toMatchObject({ conteudo: 'x' });
    expect(comments.create).toHaveBeenCalledTimes(2);
    expect(comments.deleteOne).not.toHaveBeenCalled();
  });

  it('edits only the author comment without changing its counter', async () => {
    const { service, comments, publications } = setup();
    const result = await service.update(rootId.toString(), authorId.toString(), { conteudo: 'Novo' });
    expect(result.id).toBe(rootId.toString());
    expect(comments.findOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({ autor_id: authorId, status: 'publicado' }), expect.anything(), expect.anything());
    expect(publications.updateOne).not.toHaveBeenCalled();
    await expect(service.update(rootId.toString(), otherId.toString(), { conteudo: 'Não' })).rejects.toMatchObject({ response: { code: 'COMENTARIO_NOT_FOUND' } });
  });

  it('redacts removed and hidden text while loading page authors in one query', async () => {
    const { service, comments, users } = setup();
    comments.find.mockReturnValue(q([
      comment({ status: 'excluido', conteudo: 'Segredo removido' }),
      comment({ _id: replyId, status: 'oculto', conteudo: 'Segredo oculto' }),
    ]));
    const page = await service.list(publicationId.toString(), { limite: 20 });
    expect(page.items.map((item) => item.conteudo)).toEqual(['Comentário removido', 'Comentário indisponível']);
    expect(JSON.stringify(page)).not.toContain('Segredo');
    expect(users.find).toHaveBeenCalledOnce();
    expect(page.hasMore).toBe(false);
  });

  it('decrements conditionally and leaves ambiguous deletion pending', async () => {
    const { service, comments, publications, cache } = setup();
    await service.remove(rootId.toString(), authorId.toString());
    expect(comments.findOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'publicado' }), expect.anything(), expect.anything());
    expect(publications.updateOne).toHaveBeenCalledWith(expect.objectContaining({ 'contadores.comentarios': { $gt: 0 } }), { $inc: { 'contadores.comentarios': -1, comentarios_revisao: 1 } });
    publications.updateOne.mockReturnValueOnce(q({ modifiedCount: 1 })).mockReturnValueOnce({ exec: vi.fn().mockRejectedValue(new Error('lost')) });
    await expect(service.remove(rootId.toString(), authorId.toString())).rejects.toMatchObject({ response: { code: 'COMENTARIO_WRITE_UNAVAILABLE' } });
    expect(comments.countDocuments).not.toHaveBeenCalled();
    expect(cache.invalidate).toHaveBeenCalledTimes(2);
  });

  it('refuses reconciliation while a persistent publication operation is pending', async () => {
    const { service, comments, publications, cache } = setup();
    publications.findById.mockReturnValue(q({
      _id: publicationId, autor_id: authorId, comentarios_revisao: 4,
      comentarios_operacoes_pendentes: ['c:pending'],
    }));
    await expect(service.reconcileCounter(publicationId.toString())).rejects.toMatchObject({ response: { code: 'COMENTARIO_OPERATION_PENDING' } });
    expect(comments.countDocuments).not.toHaveBeenCalled();
    expect(publications.updateOne).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it('rejects a reconciliation whose revision changed before the conditional write', async () => {
    const { service, comments, publications, cache } = setup();
    publications.findById.mockReturnValue(q({
      _id: publicationId, autor_id: authorId, comentarios_revisao: 7,
      comentarios_operacoes_pendentes: [],
    }));
    comments.countDocuments.mockReturnValue(q(12));
    publications.updateOne.mockReturnValueOnce(q({ modifiedCount: 0 }));
    await expect(service.reconcileCounter(publicationId.toString())).rejects.toMatchObject({ response: { code: 'COMENTARIO_OPERATION_PENDING' } });
    expect(publications.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ comentarios_revisao: 7 }),
      { $set: { 'contadores.comentarios': 12 }, $inc: { comentarios_revisao: 1 } },
    );
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it('lets only one of two reconcilers write the same revision', async () => {
    const { service, comments, publications, cache } = setup();
    publications.findById.mockReturnValue(q({
      _id: publicationId, autor_id: authorId, comentarios_revisao: 3,
      comentarios_operacoes_pendentes: [],
    }));
    comments.countDocuments.mockReturnValue(q(6));
    publications.updateOne.mockReturnValueOnce(q({ modifiedCount: 1 }))
      .mockReturnValueOnce(q({ modifiedCount: 0 }));
    const outcomes = await Promise.allSettled([
      service.reconcileCounter(publicationId.toString()),
      service.reconcileCounter(publicationId.toString()),
    ]);
    expect(outcomes.map((item) => item.status).sort((a, b) => a.localeCompare(b))).toEqual(['fulfilled', 'rejected']);
    expect(cache.invalidate).toHaveBeenCalledOnce();
  });

  it('invalidates cached counters when reconciliation may have been persisted', async () => {
    const { service, publications, cache } = setup();
    publications.findById.mockReturnValue(q({
      _id: publicationId, autor_id: authorId, comentarios_revisao: 2,
      comentarios_operacoes_pendentes: [],
    }));
    publications.updateOne.mockReturnValueOnce({ exec: vi.fn().mockRejectedValue(new Error('response lost')) });
    await expect(service.reconcileCounter(publicationId.toString())).rejects.toThrow('response lost');
    expect(cache.invalidate).toHaveBeenCalledWith(publicationId.toString(), authorId.toString());
  });

  it('keeps an ambiguous applied increment pending and never removes its comment', async () => {
    const { service, comments, publications } = setup();
    let applied = false;
    publications.updateOne.mockReturnValueOnce(q({ modifiedCount: 1 })).mockReturnValueOnce({
      exec: vi.fn().mockImplementation(async () => {
        applied = true;
        throw new Error('response lost after server write');
      }),
    });
    await expect(service.create(publicationId.toString(), authorId.toString(), { conteudo: 'Texto' })).rejects.toMatchObject({ response: { code: 'COMENTARIO_WRITE_UNAVAILABLE' } });
    expect(applied).toBe(true);
    expect(comments.deleteOne).not.toHaveBeenCalled();
    expect(comments.updateOne).not.toHaveBeenCalled();
    expect(comments.countDocuments).not.toHaveBeenCalled();
  });

  it('returns pending rather than success for an unfinished keyed creation', async () => {
    const { service, comments, publications } = setup();
    const key = 'a_valid_retry_key_123456';
    const id = new Types.ObjectId(createHash('sha256')
      .update(authorId.toString() + ':' + publicationId.toString() + ':' + key)
      .digest('hex').slice(0, 24));
    comments.findById.mockReturnValue(q(comment({ _id: id, conteudo: 'Texto', criacao_estado: 'pendente' })));
    await expect(service.create(publicationId.toString(), authorId.toString(), { conteudo: 'Texto' }, key)).rejects.toMatchObject({ response: { code: 'COMENTARIO_OPERATION_PENDING' } });
    expect(comments.create).not.toHaveBeenCalled();
    expect(publications.updateOne).not.toHaveBeenCalled();
  });

  it('returns a confirmed keyed creation without incrementing twice', async () => {
    const { service, comments, publications, cache } = setup();
    const key = 'a_valid_retry_key_123456';
    const id = new Types.ObjectId(createHash('sha256')
      .update(authorId.toString() + ':' + publicationId.toString() + ':' + key)
      .digest('hex').slice(0, 24));
    comments.findById.mockReturnValue(q(comment({ _id: id, conteudo: 'Texto', criacao_estado: 'confirmado' })));
    const result = await service.create(publicationId.toString(), authorId.toString(), { conteudo: 'Texto' }, key);
    expect(result.id).toBe(id.toString());
    expect(comments.create).not.toHaveBeenCalled();
    expect(publications.updateOne).toHaveBeenCalledOnce();
    expect(cache.invalidate).toHaveBeenCalledOnce();
    await expect(service.create(publicationId.toString(), authorId.toString(), { conteudo: 'Diferente' }, key)).rejects.toMatchObject({ response: { code: 'COMENTARIO_IDEMPOTENCY_CONFLICT' } });
  });

  it('releases its own reservation when a racing keyed request conflicts', async () => {
    const { service, comments, publications, cache } = setup();
    const key = 'a_valid_retry_key_123456';
    const id = new Types.ObjectId(createHash('sha256')
      .update(authorId.toString() + ':' + publicationId.toString() + ':' + key)
      .digest('hex').slice(0, 24));
    comments.findById.mockReturnValueOnce(q(null))
      .mockReturnValueOnce(q(comment({ _id: id, conteudo: 'Primeiro', criacao_estado: 'confirmado' })));
    comments.create.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }));
    await expect(service.create(publicationId.toString(), authorId.toString(),
      { conteudo: 'Segundo' }, key))
      .rejects.toMatchObject({ response: { code: 'COMENTARIO_IDEMPOTENCY_CONFLICT' } });
    expect(publications.updateOne).toHaveBeenCalledTimes(2);
    expect(publications.updateOne).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ comentarios_operacoes_pendentes: 'c:' + id.toString() }),
      expect.objectContaining({ $pull: { comentarios_operacoes_pendentes: 'c:' + id.toString() } }),
    );
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it('replays a racing keyed request only after releasing its reservation', async () => {
    const { service, comments, publications, cache } = setup();
    const key = 'a_valid_retry_key_123456';
    const id = new Types.ObjectId(createHash('sha256')
      .update(authorId.toString() + ':' + publicationId.toString() + ':' + key)
      .digest('hex').slice(0, 24));
    comments.findById.mockReturnValueOnce(q(null))
      .mockReturnValueOnce(q(comment({ _id: id, criacao_estado: 'confirmado' })));
    comments.create.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }));
    const result = await service.create(publicationId.toString(), authorId.toString(),
      { conteudo: 'Texto' }, key);
    expect(result.id).toBe(id.toString());
    expect(publications.updateOne).toHaveBeenCalledTimes(2);
    expect(cache.invalidate).toHaveBeenCalledOnce();
  });

  it('replays a confirmed reply after its parent is logically deleted', async () => {
    const { service, comments, publications } = setup();
    const key = 'a_valid_retry_key_123456';
    const id = new Types.ObjectId(createHash('sha256')
      .update(authorId.toString() + ':' + publicationId.toString() + ':' + key)
      .digest('hex').slice(0, 24));
    comments.findById.mockReturnValue(q(comment({
      _id: id, comentario_pai_id: rootId, comentario_raiz_id: rootId,
      profundidade: 1, criacao_estado: 'confirmado',
    })));
    const result = await service.create(publicationId.toString(), authorId.toString(),
      { conteudo: 'Texto', comentarioPaiId: rootId.toString() }, key);
    expect(result.id).toBe(id.toString());
    expect(comments.findOne).not.toHaveBeenCalled();
    expect(publications.updateOne).toHaveBeenCalledOnce();
  });

  it('binds encrypted cursors to publication and parent', () => {
    const { cursor } = setup();
    const position = { createdAt: new Date('2026-11-13T00:00:00Z'), id: rootId };
    const encoded = cursor.encode(position, publicationId.toString(), null);
    expect(cursor.decode(encoded, publicationId.toString(), null)).toEqual(position);
    expect(() => cursor.decode(encoded, otherId.toString(), null)).toThrow(ApiException);
    expect(() => cursor.decode(encoded, publicationId.toString(), rootId.toString())).toThrow(ApiException);
    expect(() => cursor.decode(encoded.slice(0, -2) + 'aa', publicationId.toString(), null)).toThrow(ApiException);
  });
});
