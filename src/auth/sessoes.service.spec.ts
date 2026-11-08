import { createHash } from 'node:crypto';
import { RedisSessionClient } from './redis-session.client.js';
import { SessoesService } from './sessoes.service.js';

const userId = '507f1f77bcf86cd799439011';
const sessionId = 'a'.repeat(43);
const key = `ierri:test:session:${createHash('sha256').update(sessionId).digest('hex')}`;

describe('SessoesService', () => {
  const client = {
    isReady: true,
    set: vi.fn(),
    get: vi.fn(),
    eval: vi.fn(),
  };
  const service = new SessoesService({
    client,
    prefix: 'ierri:test:session:',
  } as unknown as RedisSessionClient);

  beforeEach(() => {
    vi.clearAllMocks();
    client.isReady = true;
  });

  it('stores the user under a hashed key with an expiring, unique value', async () => {
    client.set.mockResolvedValueOnce('OK');
    const expiresAt = new Date(Date.now() + 60_000);
    await service.create(sessionId, userId, expiresAt);
    expect(client.set).toHaveBeenCalledWith(key, userId, {
      PX: expect.any(Number),
      NX: true,
    });
    const ttl = client.set.mock.calls[0][2].PX as number;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
    expect(JSON.stringify(client.set.mock.calls[0])).not.toContain(sessionId);
  });

  it('does not create a session when Redis rejects the write or the JWT is expired', async () => {
    client.set.mockResolvedValueOnce(null);
    await expect(
      service.create(sessionId, userId, new Date(Date.now() + 60_000)),
    ).rejects.toThrow();
    await expect(
      service.create(sessionId, userId, new Date(0)),
    ).rejects.toThrow();
    expect(client.set).toHaveBeenCalledOnce();
  });

  it('allows only a session belonging to the JWT user', async () => {
    client.get
      .mockResolvedValueOnce(userId)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('another-user');
    await expect(
      service.assertActive(sessionId, userId),
    ).resolves.toBeUndefined();
    await expect(service.assertActive(sessionId, userId)).rejects.toMatchObject(
      { status: 401 },
    );
    await expect(service.assertActive(sessionId, userId)).rejects.toMatchObject(
      { status: 401 },
    );
    expect(client.get).toHaveBeenCalledWith(key);
  });

  it('revokes atomically without deleting a session belonging to another user', async () => {
    client.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(service.revoke(sessionId, userId)).resolves.toBe('revoked');
    await expect(service.revoke(sessionId, userId)).resolves.toBe('missing');
    expect(client.eval.mock.calls[0][0]).toContain(
      "redis.call('GET', KEYS[1]) == ARGV[1]",
    );
    expect(client.eval.mock.calls[0][1]).toEqual({
      keys: [key],
      arguments: [userId],
    });
  });

  it('fails closed when Redis is unavailable', async () => {
    client.isReady = false;
    await expect(service.assertActive(sessionId, userId)).rejects.toThrow(
      'Redis indisponível.',
    );
    await expect(service.revoke(sessionId, userId)).rejects.toThrow(
      'Redis indisponível.',
    );
    await expect(
      service.create(sessionId, userId, new Date(Date.now() + 60_000)),
    ).rejects.toThrow('Redis indisponível.');
    client.isReady = true;
    client.get.mockRejectedValueOnce(new Error('connection lost'));
    await expect(service.assertActive(sessionId, userId)).rejects.toThrow(
      'connection lost',
    );
    client.eval.mockRejectedValueOnce(new Error('connection lost'));
    await expect(service.revoke(sessionId, userId)).rejects.toThrow(
      'connection lost',
    );
  });
});
