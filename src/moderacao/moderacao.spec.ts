import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import type { ConfigService } from '@nestjs/config';
import { ComentariosService } from '../comentarios/comentarios.service.js';
import { Comentario } from '../comentarios/schemas/comentario.schema.js';
import { PublicacaoAccessService } from '../publicacoes/publicacao-access.service.js';
import { PublicacoesCacheService } from '../publicacoes/publicacoes-cache.service.js';
import { Publicacao } from '../publicacoes/schemas/publicacao.schema.js';
import { CreatorStatsService } from '../usuarios/creator-stats.service.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import { DenunciasService } from './denuncias.service.js';
import { createDenunciaSchema } from './dto/moderacao.dto.js';
import { ModeracaoCursor } from './moderacao.cursor.js';
import { ModeracaoService } from './moderacao.service.js';
import { Denuncia, DenunciaSchema } from './schemas/denuncia.schema.js';
import { ModeracaoHistorico } from './schemas/moderacao-historico.schema.js';

const adminId = new Types.ObjectId();
const targetId = new Types.ObjectId();
const reporterId = new Types.ObjectId();
const postId = new Types.ObjectId();

function query(value: unknown) {
  const result = { exec: vi.fn().mockResolvedValue(value), select: vi.fn(), lean: vi.fn(),
    sort: vi.fn(), limit: vi.fn() };
  for (const name of ['select', 'lean', 'sort', 'limit'] as const) result[name].mockReturnValue(result);
  return result;
}

function setup() {
  const cursor = new ModeracaoCursor({ getOrThrow: () => 'x'.repeat(40) } as unknown as ConfigService);
  const post = { _id: postId, status: 'publicada', autor_id: targetId,
    moderacao_pendente: null as Record<string, unknown> | null };
  const target = { _id: targetId, status: 'ativo', papeis: ['usuario'],
    moderacao_pendente: null as Record<string, unknown> | null };
  const actor = { _id: adminId, status: 'ativo', papeis: ['usuario', 'administrador'] };
  const users = { findById: vi.fn((id: string) => query(id === adminId.toString() ? actor : target)),
    findOne: vi.fn().mockReturnValue(query(target)), exists: vi.fn().mockResolvedValue({ _id: targetId }),
    updateOne: vi.fn().mockReturnValue(query({ modifiedCount: 1 })),
    find: vi.fn().mockReturnValue(query([])) };
  const posts = { findById: vi.fn().mockReturnValue(query(post)),
    findOne: vi.fn().mockReturnValue(query(post)),
    updateOne: vi.fn().mockReturnValue(query({ modifiedCount: 1 })),
    find: vi.fn().mockReturnValue(query([])) };
  const comments = { findById: vi.fn().mockReturnValue(query(null)),
    findOne: vi.fn().mockReturnValue(query(null)),
    updateOne: vi.fn().mockReturnValue(query({ modifiedCount: 1 })),
    find: vi.fn().mockReturnValue(query([])) };
  const reports = { create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId(),
    denunciante_id: reporterId, alvo_tipo: 'publicacao', alvo_id: postId, motivo: 'spam',
    descricao: null, status: 'pendente', criada_em: new Date(), resolvida_em: null }),
    exists: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    findOneAndUpdate: vi.fn().mockReturnValue(query(null)),
    find: vi.fn().mockReturnValue(query([])),
    findOne: vi.fn().mockReturnValue(query(null)) };
  const history = { updateOne: vi.fn().mockReturnValue(query({ modifiedCount: 1 })),
    find: vi.fn().mockReturnValue(query([])) };
  const access = { canRead: vi.fn().mockResolvedValue(true) };
  const cache = { invalidate: vi.fn().mockResolvedValue(true),
    invalidateAuthor: vi.fn().mockResolvedValue(true) };
  const creators = { refresh: vi.fn().mockResolvedValue(undefined) };
  const commentService = { reconcileCounter: vi.fn().mockResolvedValue(undefined) };
  const denunciations = new DenunciasService(reports as unknown as Model<Denuncia>,
    users as unknown as Model<Usuario>, posts as unknown as Model<Publicacao>,
    comments as unknown as Model<Comentario>, access as unknown as PublicacaoAccessService, cursor);
  const moderation = new ModeracaoService(reports as unknown as Model<Denuncia>,
    history as unknown as Model<ModeracaoHistorico>, users as unknown as Model<Usuario>,
    posts as unknown as Model<Publicacao>, comments as unknown as Model<Comentario>,
    cache as unknown as PublicacoesCacheService, creators as unknown as CreatorStatsService,
    commentService as unknown as ComentariosService, cursor);
  return { denunciations, moderation, reports, history, users, posts, comments,
    post, target, actor, access, cache, creators, cursor };
}

describe('Denúncias e moderação', () => {
  it('validates report reasons and the unique pending-report index', () => {
    expect(createDenunciaSchema.safeParse({ alvoTipo: 'publicacao', alvoId: postId.toString(),
      motivo: 'outro' }).success).toBe(false);
    expect(createDenunciaSchema.safeParse({ alvoTipo: 'publicacao', alvoId: postId.toString(),
      motivo: 'spam', descricao: 'x'.repeat(1001) }).success).toBe(false);
    expect(DenunciaSchema.indexes()).toContainEqual([
      { denunciante_id: 1, alvo_tipo: 1, alvo_id: 1 },
      { unique: true, partialFilterExpression: { status: 'pendente' } },
    ]);
  });

  it('binds cursors to their owner and filter', () => {
    const { cursor } = setup();
    const encoded = cursor.encode(new Date(), postId, `reports:mine:${reporterId.toString()}`);
    expect(cursor.decode(encoded, `reports:mine:${reporterId.toString()}`).id).toEqual(postId);
    expect(() => cursor.decode(encoded, 'reports:admin:todos:todos')).toThrow();
  });

  it('rejects self-reporting and deduplicates a pending report', async () => {
    const { denunciations, posts, reports } = setup();
    posts.findOne.mockReturnValueOnce(query({ _id: postId, status: 'publicada',
      autor_id: reporterId, visibilidade: 'publico' }));
    await expect(denunciations.create(reporterId.toString(), { alvoTipo: 'publicacao',
      alvoId: postId.toString(), motivo: 'spam' })).rejects.toMatchObject({ status: 422 });
    reports.create.mockRejectedValueOnce({ code: 11000 });
    await expect(denunciations.create(reporterId.toString(), { alvoTipo: 'publicacao',
      alvoId: postId.toString(), motivo: 'spam' })).rejects.toMatchObject({ status: 409 });
  });

  it('creates a report without returning moderation-only data', async () => {
    const { denunciations } = setup();
    const created = await denunciations.create(reporterId.toString(), { alvoTipo: 'publicacao',
      alvoId: postId.toString(), motivo: 'spam' });
    expect(created).not.toHaveProperty('denuncianteId');
    expect(created).not.toHaveProperty('moderadorId');
  });

  it('resolves a report with a conditional update and a durable history marker', async () => {
    const { denunciations, reports } = setup();
    reports.findOneAndUpdate = vi.fn().mockReturnValue(query({ _id: new Types.ObjectId(),
      denunciante_id: reporterId, alvo_tipo: 'publicacao', alvo_id: postId,
      motivo: 'spam', descricao: null, status: 'aceita', criada_em: new Date(),
      moderador_id: adminId, justificativa: 'Justificativa suficiente.', resolvida_em: new Date() }));
    await denunciations.resolve(new Types.ObjectId().toString(), adminId.toString(), {
      status: 'aceita', justificativa: 'Justificativa suficiente.' });
    expect(reports.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ status: 'pendente' });
    expect(reports.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({
      status: 'aceita', historico_pendente: true,
    });
  });

  it('changes a post only when the previous status and free marker still match', async () => {
    const { moderation, posts } = setup();
    await moderation.moderatePost(postId.toString(), adminId.toString(), {
      status: 'oculta', justificativa: 'Justificativa suficiente.' });
    expect(posts.updateOne.mock.calls[0][0]).toMatchObject({
      _id: postId, status: 'publicada', moderacao_pendente: null,
    });
    expect(posts.updateOne.mock.calls[0][1].$set.moderacao_pendente).toMatchObject({
      responsavel: adminId.toString(), anterior: 'publicada', novo: 'oculta',
    });
  });

  it('rejects a concurrent status transition without claiming success', async () => {
    const { moderation, posts } = setup();
    posts.updateOne.mockReturnValueOnce(query({ modifiedCount: 0 }));
    await expect(moderation.moderatePost(postId.toString(), adminId.toString(), {
      status: 'oculta', justificativa: 'Justificativa suficiente.' }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('requires a related accepted report when an action cites one', async () => {
    const { moderation, reports, posts } = setup();
    reports.exists.mockResolvedValueOnce(null);
    await expect(moderation.moderatePost(postId.toString(), adminId.toString(), {
      status: 'oculta', justificativa: 'Justificativa suficiente.',
      denunciaId: new Types.ObjectId().toString() }))
      .rejects.toMatchObject({ status: 404 });
    expect(posts.updateOne).not.toHaveBeenCalled();
  });

  it('refuses to restore an excluded comment or archived publication', async () => {
    const { moderation, comments, posts } = setup();
    comments.findById.mockReturnValueOnce(query({ _id: new Types.ObjectId(),
      status: 'excluido', criacao_estado: 'confirmado', publicacao_id: postId }));
    await expect(moderation.moderateComment(new Types.ObjectId().toString(), adminId.toString(), {
      status: 'publicado', justificativa: 'Justificativa suficiente.' }))
      .rejects.toMatchObject({ status: 409 });
    posts.findById.mockReturnValueOnce(query({ _id: postId, status: 'arquivada', autor_id: targetId }));
    await expect(moderation.moderatePost(postId.toString(), adminId.toString(), {
      status: 'publicada', justificativa: 'Justificativa suficiente.' }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('blocks moderator self-actions and administrator targets', async () => {
    const { moderation, target } = setup();
    await expect(moderation.moderateUser(adminId.toString(), adminId.toString(), {
      status: 'bloqueado', justificativa: 'Justificativa suficiente.' }))
      .rejects.toMatchObject({ status: 403 });
    target.papeis = ['usuario', 'administrador'];
    await expect(moderation.moderateUser(targetId.toString(), adminId.toString(), {
      status: 'bloqueado', justificativa: 'Justificativa suficiente.' }))
      .rejects.toMatchObject({ status: 403 });
  });

  it('prevents a moderator from changing another moderator account', async () => {
    const { moderation, target, actor } = setup();
    target.papeis = ['usuario', 'moderador'];
    actor.papeis = ['usuario', 'moderador'];
    await expect(moderation.moderateUser(targetId.toString(), adminId.toString(), {
      status: 'bloqueado', justificativa: 'Justificativa suficiente.' }))
      .rejects.toMatchObject({ status: 403 });
  });

  it('increments authentication version atomically when blocking a user', async () => {
    const { moderation, users } = setup();
    await moderation.moderateUser(targetId.toString(), adminId.toString(), {
      status: 'bloqueado', justificativa: 'Justificativa suficiente.' });
    expect(users.updateOne.mock.calls[0][1]).toMatchObject({
      $set: { status: 'bloqueado' }, $inc: { auth_versao: 1 },
    });
  });

  it('retains a source marker when writing history fails', async () => {
    const { moderation, posts, post, history } = setup();
    post.moderacao_pendente = { id: 'operation', responsavel: adminId.toString(),
      anterior: 'publicada', novo: 'oculta', justificativa: 'Justificativa suficiente.',
      denunciaId: null, criadaEm: new Date() };
    const failed = query(null);
    failed.exec.mockRejectedValueOnce(new Error('history unavailable'));
    history.updateOne.mockReturnValueOnce(failed);
    posts.find.mockReturnValue(query([{ _id: postId }]));
    await moderation.moderatePost(postId.toString(), adminId.toString(), {
      status: 'oculta', justificativa: 'Justificativa suficiente.' });
    expect(posts.updateOne).toHaveBeenCalledTimes(1);
    await moderation.recoverBatch();
    expect(history.updateOne).toHaveBeenCalledTimes(2);
    expect(posts.updateOne).toHaveBeenCalledTimes(2);
  });
});
