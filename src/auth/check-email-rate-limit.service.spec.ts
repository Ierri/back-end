import { ConfigService } from '@nestjs/config';
import { CheckEmailRateLimitService } from './check-email-rate-limit.service.js';
import { RedisSessionClient } from './redis-session.client.js';

describe('CheckEmailRateLimitService', () => {
  const client = { isReady: true, eval: vi.fn() };
  const redis = {
    client,
    prefix: 'ierri:test:session:',
  } as unknown as RedisSessionClient;
  const config = {
    get: vi.fn(() => 'ierri:test:rate:check-email:'),
    getOrThrow: vi.fn(() => 'test-secret-for-hashing-at-least-32-bytes'),
  } as unknown as ConfigService;
  const service = new CheckEmailRateLimitService(redis, config);

  beforeEach(() => {
    client.isReady = true;
    client.eval.mockReset();
  });

  it('uses one atomic Redis operation and hashed keys separate from sessions', async () => {
    client.eval.mockResolvedValueOnce([1, 1, 60_000, 600_000]);
    await expect(
      service.consume('127.0.0.1', 'ana@example.com'),
    ).resolves.toBeNull();
    const [script, options] = client.eval.mock.calls[0] as [
      string,
      { keys: string[]; arguments: string[] },
    ];
    expect(script).toContain("redis.call('INCR', KEYS[1])");
    expect(script).toContain("redis.call('INCR', KEYS[2])");
    expect(script).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[1])");
    expect(script).toContain("redis.call('PEXPIRE', KEYS[2], ARGV[2])");
    expect(options.arguments).toEqual(['60000', '600000']);
    expect(options.keys).toHaveLength(2);
    expect(options.keys[0]).toMatch(
      /^ierri:test:rate:check-email:origin:[a-f0-9]{64}$/,
    );
    expect(options.keys[1]).toMatch(
      /^ierri:test:rate:check-email:origin-email:[a-f0-9]{64}$/,
    );
    expect(options.keys.join('')).not.toContain('ana@example.com');
    expect(options.keys.join('')).not.toContain('127.0.0.1');
    expect(options.keys.join('')).not.toContain(redis.prefix);
  });

  it('allows both configured limits and reports the appropriate wait when exceeded', async () => {
    client.eval
      .mockResolvedValueOnce([30, 1, 45_000, 500_000])
      .mockResolvedValueOnce([31, 1, 45_000, 500_000])
      .mockResolvedValueOnce([1, 10, 45_000, 385_000])
      .mockResolvedValueOnce([1, 11, 45_000, 385_000])
      .mockResolvedValueOnce([31, 11, 45_000, 385_000]);
    await expect(
      service.consume('127.0.0.1', 'a@example.com'),
    ).resolves.toBeNull();
    await expect(service.consume('127.0.0.1', 'b@example.com')).resolves.toBe(
      45,
    );
    await expect(
      service.consume('127.0.0.1', 'a@example.com'),
    ).resolves.toBeNull();
    await expect(service.consume('127.0.0.1', 'a@example.com')).resolves.toBe(
      385,
    );
    await expect(service.consume('127.0.0.1', 'a@example.com')).resolves.toBe(
      385,
    );
  });

  it('keeps the same email independent across different origins', async () => {
    client.eval.mockResolvedValue([1, 1, 60_000, 600_000]);
    await service.consume('127.0.0.1', 'ana@example.com');
    await service.consume('127.0.0.2', 'ana@example.com');
    const firstKeys = client.eval.mock.calls[0][1].keys as string[];
    const secondKeys = client.eval.mock.calls[1][1].keys as string[];
    expect(firstKeys[0]).not.toBe(secondKeys[0]);
    expect(firstKeys[1]).not.toBe(secondKeys[1]);
  });

  it('handles concurrent requests according to the returned atomic counts', async () => {
    let count = 0;
    client.eval.mockImplementation(async () => [++count, 1, 60_000, 600_000]);
    const results = await Promise.all(
      Array.from({ length: 31 }, (_, index) =>
        service.consume('127.0.0.1', `user${index}@example.com`),
      ),
    );
    expect(results.filter((value) => value === null)).toHaveLength(30);
    expect(results.filter((value) => value === 60)).toHaveLength(1);
  });

  it('fails closed without an origin or a usable Redis response', async () => {
    await expect(
      service.consume(undefined, 'ana@example.com'),
    ).rejects.toMatchObject({
      status: 503,
    });
    client.isReady = false;
    await expect(
      service.consume('127.0.0.1', 'ana@example.com'),
    ).rejects.toMatchObject({
      status: 503,
    });
    client.isReady = true;
    client.eval.mockRejectedValueOnce(new Error('connection lost'));
    await expect(
      service.consume('127.0.0.1', 'ana@example.com'),
    ).rejects.toMatchObject({
      status: 503,
    });
    client.eval.mockResolvedValueOnce('invalid');
    await expect(
      service.consume('127.0.0.1', 'ana@example.com'),
    ).rejects.toMatchObject({
      status: 503,
    });
    client.eval.mockResolvedValueOnce([1, 1, -1, 600_000]);
    await expect(
      service.consume('127.0.0.1', 'ana@example.com'),
    ).rejects.toMatchObject({
      status: 503,
    });
    client.eval.mockResolvedValueOnce([NaN, 1, 60_000, 600_000]);
    await expect(
      service.consume('127.0.0.1', 'ana@example.com'),
    ).rejects.toMatchObject({
      status: 503,
    });
  });
});
