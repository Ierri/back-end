import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { Sessao, SessaoSchema } from './schemas/sessao.schema.js';
import { SessoesService } from './sessoes.service.js';

const userId = new Types.ObjectId().toString();
const sessionId = 'a'.repeat(43);
const idHash = createHash('sha256').update(sessionId).digest('hex');

describe('SessoesService', () => {
  const create = vi.fn();
  const findOne = vi.fn();
  const findOneAndUpdate = vi.fn();
  const service = new SessoesService({
    create,
    findOne,
    findOneAndUpdate,
  } as unknown as Model<Sessao>);

  beforeEach(() => vi.clearAllMocks());

  it('stores only a hash and uses the existing MongoDB connection', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    create.mockResolvedValueOnce({});
    await service.create(sessionId, userId, expiresAt);
    expect(create).toHaveBeenCalledWith({
      id_hash: idHash,
      usuario_id: new Types.ObjectId(userId),
      expira_em: expiresAt,
    });
    expect(JSON.stringify(create.mock.calls[0])).not.toContain(sessionId);
    expect(SessaoSchema.path('usuario_id').instance).toBe('ObjectId');
  });

  it('checks ownership, revocation and expiration in the database query', async () => {
    findOne.mockReturnValueOnce({ exec: vi.fn().mockResolvedValue({}) });
    await service.assertActive(sessionId, userId);
    expect(findOne).toHaveBeenCalledWith({
      id_hash: idHash,
      usuario_id: new Types.ObjectId(userId),
      revogada_em: null,
      expira_em: { $gt: expect.any(Date) },
    });
    findOne.mockReturnValueOnce({ exec: vi.fn().mockResolvedValue(null) });
    await expect(service.assertActive(sessionId, userId)).rejects.toMatchObject(
      { status: 401 },
    );
  });

  it('revokes only an active matching session and classifies inactive sessions', async () => {
    findOneAndUpdate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue({}),
    });
    await expect(service.revoke(sessionId, userId)).resolves.toBe('revoked');
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      {
        id_hash: idHash,
        usuario_id: new Types.ObjectId(userId),
        revogada_em: null,
        expira_em: { $gt: expect.any(Date) },
      },
      { $set: { revogada_em: expect.any(Date) } },
      { new: true },
    );
    findOneAndUpdate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue(null),
    });
    findOne.mockReturnValueOnce({ exec: vi.fn().mockResolvedValue(null) });
    await expect(service.revoke(sessionId, userId)).resolves.toBe('missing');

    for (const [record, status] of [
      [
        { revogada_em: new Date(), expira_em: new Date(Date.now() + 60_000) },
        'already_revoked',
      ],
      [{ revogada_em: null, expira_em: new Date(0) }, 'expired'],
    ] as const) {
      findOneAndUpdate.mockReturnValueOnce({
        exec: vi.fn().mockResolvedValue(null),
      });
      findOne.mockReturnValueOnce({ exec: vi.fn().mockResolvedValue(record) });
      await expect(service.revoke(sessionId, userId)).resolves.toBe(status);
    }
  });

  it('does not turn a database failure into a successful logout', async () => {
    findOneAndUpdate.mockReturnValueOnce({
      exec: vi.fn().mockRejectedValue(new Error('unavailable')),
    });
    await expect(service.revoke(sessionId, userId)).rejects.toThrow(
      'unavailable',
    );
    findOneAndUpdate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue(null),
    });
    findOne.mockReturnValueOnce({
      exec: vi.fn().mockRejectedValue(new Error('unavailable')),
    });
    await expect(service.revoke(sessionId, userId)).rejects.toThrow(
      'unavailable',
    );
  });
});
