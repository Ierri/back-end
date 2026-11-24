import type { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { PublicacaoAccessService } from '../publicacoes/publicacao-access.service.js';
import { listNotificacoesSchema } from './dto/notificacoes.dto.js';
import { NotificacoesCursor } from './notificacoes.cursor.js';
import { NotificacoesService } from './notificacoes.service.js';
import { Notificacao } from './schemas/notificacao.schema.js';

const userId = new Types.ObjectId().toString();
const otherId = new Types.ObjectId().toString();
const notificationId = new Types.ObjectId();
const actorId = new Types.ObjectId();
const createdAt = new Date('2026-11-24T10:00:00.000Z');

function query(value: unknown) { return { exec: vi.fn().mockResolvedValue(value) }; }

function setup(items: unknown[] = []) {
  const notifications = { aggregate: vi.fn().mockReturnValue(query(items)),
    updateOne: vi.fn().mockReturnValue(query({ modifiedCount: 1 })),
    updateMany: vi.fn().mockReturnValue(query({ modifiedCount: 1 })) };
  const access = { listVisibility: vi.fn().mockResolvedValue({ visibilidade: 'publico' }) };
  const cursor = new NotificacoesCursor({ getOrThrow: () => 'unit-test-notification-secret' } as unknown as ConfigService);
  const service = new NotificacoesService(notifications as unknown as Model<Notificacao>,
    access as unknown as PublicacaoAccessService, cursor);
  return { service, notifications, access, cursor };
}

describe('NotificacoesService', () => {
  it('validates the bounded list query and owner-bound unread cursor', () => {
    expect(listNotificacoesSchema.parse({})).toEqual({ limite: 20, naoLidas: false });
    expect(listNotificacoesSchema.parse({ limite: '5', naoLidas: 'true' }))
      .toEqual({ limite: 5, naoLidas: true });
    expect(listNotificacoesSchema.safeParse({ limite: '51' }).success).toBe(false);
    const { cursor } = setup();
    const encoded = cursor.encode({ date: createdAt, id: notificationId }, userId, true);
    expect(cursor.decode(encoded, userId, true)).toEqual({ date: createdAt, id: notificationId });
    expect(() => cursor.decode(encoded, otherId, true)).toThrow();
    expect(() => cursor.decode(encoded, userId, false)).toThrow();
    expect(() => cursor.decode(`${encoded.slice(0, -1)}!`, userId, true)).toThrow();
  });

  it('filters actors and references before pagination and returns only public actor fields', async () => {
    const item = { _id: notificationId, tipo: 'post_commented',
      ator: [{ _id: actorId, nome: 'Ana', username: 'ana', avatar_url: null }],
      entidade_tipo: 'comentario', entidade_id: new Types.ObjectId(),
      publicacao_id: new Types.ObjectId(), relacionamento_id: null,
      criada_em: createdAt, lida_em: null };
    const { service, notifications, access } = setup([item, { ...item, _id: new Types.ObjectId() }]);
    const result = await service.list(userId, { limite: 1, naoLidas: true });
    expect(result.items).toEqual([{ id: notificationId.toString(), tipo: 'post_commented',
      ator: { id: actorId.toString(), nome: 'Ana', username: 'ana', avatarUrl: null },
      publicacaoId: item.publicacao_id.toString(), comentarioId: item.entidade_id.toString(),
      relacionamentoId: null, criadaEm: createdAt, lidaEm: null }]);
    expect(result.hasMore).toBe(true);
    const pipeline = notifications.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toMatchObject({ destinatario_id: new Types.ObjectId(userId), lida_em: null });
    expect(pipeline[1]).toEqual({ $sort: { criada_em: -1, _id: -1 } });
    expect(pipeline.at(-1)).toEqual({ $limit: 2 });
    expect(access.listVisibility).toHaveBeenCalledWith(userId);
    expect(JSON.stringify(pipeline)).toContain('visibilidade');
  });

  it('counts only visible unread notifications using the same authorization pipeline', async () => {
    const { service, notifications } = setup([{ total: 3 }]);
    expect(await service.unreadCount(userId)).toEqual({ total: 3 });
    const pipeline = notifications.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toMatchObject({ destinatario_id: new Types.ObjectId(userId), lida_em: null });
    expect(pipeline.at(-1)).toEqual({ $count: 'total' });
  });

  it('marks only a visible owned notification and remains idempotent', async () => {
    const { service, notifications } = setup([{ _id: notificationId }]);
    await expect(service.markRead(userId, notificationId.toString())).resolves.toEqual({ lida: true });
    await expect(service.markRead(userId, notificationId.toString())).resolves.toEqual({ lida: true });
    expect(notifications.updateOne.mock.calls[0][0]).toMatchObject({
      _id: notificationId, destinatario_id: new Types.ObjectId(userId), lida_em: null,
    });
    notifications.aggregate.mockReturnValue(query([]));
    await expect(service.markRead(otherId, notificationId.toString()))
      .rejects.toMatchObject({ status: 404 });
  });

  it('marks all owned records without returning a count of hidden records', async () => {
    const { service, notifications } = setup();
    expect(await service.markAllRead(userId)).toEqual({ lidas: true });
    expect(notifications.updateMany.mock.calls[0][0]).toEqual({
      destinatario_id: new Types.ObjectId(userId), lida_em: null,
    });
  });
});
