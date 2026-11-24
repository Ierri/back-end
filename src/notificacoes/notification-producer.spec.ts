import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { Comentario } from '../comentarios/schemas/comentario.schema.js';
import { Publicacao } from '../publicacoes/schemas/publicacao.schema.js';
import { Voto } from '../publicacoes/schemas/voto.schema.js';
import { Seguidor } from '../usuarios/schemas/seguidor.schema.js';
import { NotificationProducerService } from './notification-producer.service.js';
import { Notificacao } from './schemas/notificacao.schema.js';

const actor = new Types.ObjectId();
const recipient = new Types.ObjectId();
const postId = new Types.ObjectId();
const relationId = new Types.ObjectId();
const commentId = new Types.ObjectId();
const voteId = new Types.ObjectId();

function query(value: unknown) {
  const result = { exec: vi.fn().mockResolvedValue(value), select: vi.fn(), lean: vi.fn(),
    sort: vi.fn(), limit: vi.fn() };
  for (const name of ['select', 'lean', 'sort', 'limit'] as const) result[name].mockReturnValue(result);
  return result;
}

function setup() {
  const relation = { _id: relationId, seguidor_id: actor, seguido_id: recipient,
    status: 'aceito', notificacao_origem: 'publico',
    notificacao_follow_pendente: true, notificacao_aceite_pendente: false };
  const comment = { _id: commentId, autor_id: actor, publicacao_id: postId,
    comentario_pai_id: null as Types.ObjectId | null, criacao_estado: 'confirmado', status: 'publicado',
    notificacao_pendente: true };
  const vote = { _id: voteId, publicacao_id: postId, usuario_id: actor, valor: 1 as 1 | -1 | null,
    operacao: null, notificacao_upvote_em: null, notificacao_upvote_pendente: true };
  const notifications = { updateOne: vi.fn().mockReturnValue(query({ upsertedCount: 1 })) };
  const relations = { findById: vi.fn().mockReturnValue(query(relation)),
    updateOne: vi.fn().mockReturnValue(query({ modifiedCount: 1 })),
    find: vi.fn().mockReturnValue(query([])) };
  const comments = { findById: vi.fn().mockReturnValue(query(comment)),
    updateOne: vi.fn().mockReturnValue(query({ modifiedCount: 1 })),
    find: vi.fn().mockReturnValue(query([])) };
  const votes = { findById: vi.fn().mockReturnValue(query(vote)),
    updateOne: vi.fn().mockReturnValue(query({ modifiedCount: 1 })),
    find: vi.fn().mockReturnValue(query([])) };
  const posts = { findById: vi.fn().mockReturnValue(query({ autor_id: recipient, status: 'publicada' })) };
  const service = new NotificationProducerService(
    notifications as unknown as Model<Notificacao>, relations as unknown as Model<Seguidor>,
    comments as unknown as Model<Comentario>, votes as unknown as Model<Voto>,
    posts as unknown as Model<Publicacao>,
  );
  return { service, notifications, relations, comments, votes, posts, relation, comment, vote };
}

describe('NotificationProducerService', () => {
  it('creates one deterministic follow notification only after the relation exists', async () => {
    const { service, notifications, relation } = setup();
    await service.processRelation(relationId.toString());
    expect(notifications.updateOne.mock.calls[0][0]).toEqual({
      destinatario_id: recipient, chave_agrupamento: `user_followed:${relationId.toString()}`,
    });
    expect(notifications.updateOne.mock.calls[0][1].$setOnInsert).toMatchObject({
      ator_id: actor, tipo: 'user_followed', relacionamento_id: relationId,
    });
    relation.seguidor_id = recipient;
    await service.processRelation(relationId.toString());
    expect(notifications.updateOne).toHaveBeenCalledTimes(1);
  });

  it('distinguishes pending requests from accepted requests and skips obsolete requests', async () => {
    const { service, notifications, relation } = setup();
    relation.notificacao_origem = 'solicitacao';
    relation.status = 'pendente';
    await service.processRelation(relationId.toString());
    expect(notifications.updateOne.mock.calls[0][1].$setOnInsert.tipo).toBe('follow_requested');
    relation.status = 'aceito';
    relation.notificacao_aceite_pendente = true;
    await service.processRelation(relationId.toString());
    expect(notifications.updateOne.mock.calls.at(-1)![1].$setOnInsert).toMatchObject({
      tipo: 'follow_accepted', destinatario_id: actor, ator_id: recipient,
    });
  });

  it('sends post comments to the author and replies to the parent author', async () => {
    const { service, notifications, comment, comments } = setup();
    await service.processComment(commentId.toString());
    expect(notifications.updateOne.mock.calls[0][1].$setOnInsert).toMatchObject({
      tipo: 'post_commented', destinatario_id: recipient, entidade_id: commentId,
    });
    comment.comentario_pai_id = new Types.ObjectId();
    comments.findById.mockImplementation((id: Types.ObjectId) => query(
      id.toString() === commentId.toString() ? comment : { autor_id: recipient },
    ));
    await service.processComment(commentId.toString());
    expect(notifications.updateOne.mock.calls[1][1].$setOnInsert.tipo).toBe('comment_replied');
  });

  it('records a first upvote and never marks downvotes or removals', async () => {
    const { service, votes, vote, notifications } = setup();
    await service.recordUpvote(voteId.toString());
    expect(votes.updateOne.mock.calls[0][1].$set).toMatchObject({ notificacao_upvote_pendente: true });
    expect(notifications.updateOne.mock.calls[0][1].$setOnInsert.tipo).toBe('post_upvoted');
    vote.valor = -1;
    await service.recordUpvote(voteId.toString());
    vote.valor = null;
    await service.recordUpvote(voteId.toString());
    expect(notifications.updateOne).toHaveBeenCalledTimes(1);
  });

  it('keeps the source marker pending when notification persistence fails', async () => {
    const { service, notifications, comments } = setup();
    const failed = query(null);
    failed.exec.mockRejectedValue(new Error('database unavailable'));
    notifications.updateOne.mockReturnValue(failed);
    await expect(service.processComment(commentId.toString())).rejects.toThrow('database unavailable');
    expect(comments.updateOne).not.toHaveBeenCalled();
  });

  it('skips historical votes without a pending notification marker', async () => {
    const { service, votes } = setup();
    await service.recoverBatch();
    expect(votes.find).toHaveBeenCalledWith({ valor: 1, notificacao_upvote_pendente: true });
  });

  it('clears pending notifications for comments no longer published', async () => {
    const { service, comment, comments, notifications } = setup();
    comment.status = 'excluido';
    await service.processComment(commentId.toString());
    expect(notifications.updateOne).not.toHaveBeenCalled();
    expect(comments.updateOne.mock.calls[0][1]).toEqual({ $set: { notificacao_pendente: false } });
  });

  it('retries bounded source batches without letting one failed item stop later items', async () => {
    const { service, relations, comments, votes } = setup();
    relations.find.mockReturnValue(query([{ _id: relationId }, { _id: new Types.ObjectId() }]));
    comments.find.mockReturnValue(query([{ _id: commentId }]));
    votes.find.mockReturnValue(query([{ _id: voteId }]));
    const processRelation = vi.spyOn(service, 'processRelation').mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(undefined);
    const processComment = vi.spyOn(service, 'processComment').mockResolvedValue(undefined);
    const recordUpvote = vi.spyOn(service, 'recordUpvote').mockResolvedValue(undefined);
    expect(await service.recoverBatch()).toBe(4);
    expect(processRelation).toHaveBeenCalledTimes(2);
    expect(processComment).toHaveBeenCalledOnce();
    expect(recordUpvote).toHaveBeenCalledOnce();
    expect(relations.find.mock.results[0].value.limit).toHaveBeenCalledWith(50);
  });
});
