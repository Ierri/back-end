import { Types } from 'mongoose';
import type { ConfigService } from '@nestjs/config';
import { RedisSessionClient } from '../auth/redis-session.client.js';
import {
  PublicacoesCacheClient,
  cacheReconnectDelay,
} from './publicacoes-cache.client.js';
import { PublicacoesCacheService } from './publicacoes-cache.service.js';

const authorId = '000000000000000000000001';
const postId = '000000000000000000000002';
const publishedAt = new Date('2026-11-13T12:00:00.000Z');

function post(id = postId) {
  return {
    id,
    slug: 'post-teste',
    autor: {
      id: authorId,
      nome: 'Pessoa',
      username: 'pessoa',
      biografia: null,
      avatarUrl: null,
    },
    conteudo: 'Conteúdo público',
    midias: [
      {
        id: '000000000000000000000003',
        tipo: 'imagem',
        url: 'http://127.0.0.1:3001/publicacoes/midias/referencia-opaca',
        mimeType: 'image/png',
        tamanhoBytes: 100,
        largura: 10,
        altura: 10,
        duracaoSegundos: null,
        textoAlternativo: null,
        ordem: 0,
      },
    ],
    visibilidade: 'publico',
    status: 'publicada',
    contadores: {
      upvotes: 0,
      downvotes: 0,
      score: 0,
      comentarios: 0,
      salvamentos: 0,
    },
    publicadaEm: publishedAt,
    editadaEm: null,
    criadaEm: publishedAt,
    atualizadaEm: publishedAt,
  };
}

class FakeClient {
  enabled = true;
  prefix = 'ierri:cache:publicacoes:v1:';
  feedTtl = 20;
  postTtl = 45;
  authorTtl = 30;
  available = true;
  now = 0;
  values = new Map<string, { value: string; expires: number }>();

  async get(key: string) {
    if (!this.available) return undefined;
    const entry = this.values.get(key);
    if (!entry || entry.expires <= this.now) return null;
    return entry.value;
  }

  async set(key: string, value: string, seconds: number) {
    if (!this.available) return false;
    this.values.set(key, { value, expires: this.now + seconds * 1000 });
    return true;
  }

  async del(key: string) {
    this.values.delete(key);
  }

  async invalidate(keys: string[]) {
    if (!this.available) return false;
    for (const key of keys) {
      const old = Number((await this.get(key)) ?? '0');
      await this.set(key, String(old + 1), 86400);
    }
    return true;
  }
}

function setup() {
  const client = new FakeClient();
  return {
    client,
    cache: new PublicacoesCacheService(
      client as unknown as PublicacoesCacheClient,
    ),
  };
}

describe('PublicacoesCacheService', () => {
  it('misses, hits, expires and rejects corrupt responses', async () => {
    const { client, cache } = setup();
    const address = (await cache.pageAddress(20, null, null, false))!;
    const page = { items: [post()], nextCursor: null, hasMore: false };
    expect(await cache.readPage(address)).toBeNull();
    await cache.writePage(address, page);
    expect(await cache.readPage(address)).toEqual(page);
    cache.countHit();
    client.values.set(address.key, { value: '{invalid', expires: 30_000 });
    expect(await cache.readPage(address)).toBeNull();
    expect(client.values.has(address.key)).toBe(false);
    await cache.writePage(address, page);
    client.now = 20_001;
    expect(await cache.readPage(address)).toBeNull();
    expect(cache.metrics()).toMatchObject({ hit: 1, miss: 3, error: 1 });
  });

  it('separates pages, limits and authors using normalized cursor positions', async () => {
    const { cache } = setup();
    const position = {
      publishedAt,
      id: new Types.ObjectId(postId),
    };
    const first = (await cache.pageAddress(20, null, position, false))!;
    const same = (await cache.pageAddress(
      20,
      null,
      { publishedAt: new Date(publishedAt), id: new Types.ObjectId(postId) },
      false,
    ))!;
    const otherLimit = (await cache.pageAddress(10, null, position, false))!;
    const otherCursor = (await cache.pageAddress(20, null, null, false))!;
    const author = (await cache.pageAddress(20, authorId, position, false))!;
    expect(first.key).toBe(same.key);
    expect(
      new Set([first.key, otherLimit.key, otherCursor.key, author.key]).size,
    ).toBe(4);
    expect(first.key).not.toContain(postId);
    expect(author.key).not.toContain(authorId);
    expect(await cache.pageAddress(20, authorId, position, true)).toBeNull();
  });

  it('invalidates known generations and rejects a late stale fill', async () => {
    const { client, cache } = setup();
    const oldFeed = (await cache.pageAddress(20, null, null, false))!;
    const oldAuthor = (await cache.pageAddress(20, authorId, null, false))!;
    const oldPost = (await cache.postAddress(postId))!;
    await cache.invalidate(postId, authorId);
    expect(await cache.isCurrent(oldFeed)).toBe(false);
    expect(await cache.isCurrent(oldAuthor)).toBe(false);
    expect(await cache.isCurrent(oldPost)).toBe(false);
    await cache.writePage(oldFeed, {
      items: [post()],
      nextCursor: null,
      hasMore: false,
    });
    expect(client.values.has(oldFeed.key)).toBe(false);
    const newFeed = (await cache.pageAddress(20, null, null, false))!;
    expect(newFeed.key).not.toBe(oldFeed.key);
    expect(cache.metrics().invalidation).toBe(1);
  });

  it('falls back when cache is disabled, unavailable or serialization is invalid', async () => {
    const { client, cache } = setup();
    client.enabled = false;
    expect(await cache.pageAddress(20, null, null, false)).toBeNull();
    expect(await cache.postAddress(postId)).toBeNull();
    client.enabled = true;
    client.available = false;
    expect(await cache.pageAddress(20, null, null, false)).toBeNull();
    client.available = true;
    const address = (await cache.postAddress(postId))!;
    await cache.writePost(address, { ...post(), visibilidade: 'seguidores' });
    expect(await cache.readPost(address)).toBeNull();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await cache.writePost(address, circular);
    expect(cache.metrics().error).toBeGreaterThanOrEqual(3);
  });

  it('coalesces simultaneous misses for the same public key', async () => {
    const { cache } = setup();
    let release!: (value: number) => void;
    const loader = vi.fn().mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    const calls = Array.from({ length: 12 }, () =>
      cache.coalesce('page', loader),
    );
    await Promise.resolve();
    expect(loader).toHaveBeenCalledOnce();
    release(42);
    expect(await Promise.all(calls)).toEqual(Array(12).fill(42));
  });
});

describe('PublicacoesCacheClient', () => {
  const config = (values: Record<string, string>) =>
    ({
      get: (key: string) => values[key],
      getOrThrow: (key: string) => values[key],
    }) as ConfigService;

  it('keeps its connection separate from sessions and honors configuration', () => {
    const values = {
      REDIS_URL: 'redis://127.0.0.1:6379',
      REDIS_CACHE_URL: 'redis://127.0.0.1:6380',
      REDIS_CACHE_ENABLED: 'true',
      REDIS_CACHE_FEED_TTL: '25',
      REDIS_CACHE_POST_TTL: 'bad',
    };
    const sessions = new RedisSessionClient(config(values));
    const cache = new PublicacoesCacheClient(config(values));
    expect(cache.enabled).toBe(true);
    expect(cache.feedTtl).toBe(25);
    expect(cache.postTtl).toBe(45);
    expect(cache.authorTtl).toBe(30);
    expect(cache).not.toBe(sessions);
    expect((cache as unknown as { client: unknown }).client).not.toBe(
      sessions.client,
    );
    expect(cache.prefix).not.toBe(sessions.prefix);
  });

  it('does not connect without a valid independent configuration', async () => {
    const missing = new PublicacoesCacheClient(
      config({ REDIS_CACHE_ENABLED: 'true' }),
    );
    const overlap = new PublicacoesCacheClient(
      config({
        REDIS_CACHE_ENABLED: 'true',
        REDIS_CACHE_URL: 'redis://127.0.0.1:6379',
        REDIS_CACHE_PREFIX: 'ierri:auth:session:',
      }),
    );
    expect(missing.enabled).toBe(false);
    expect(overlap.enabled).toBe(false);
    missing.onModuleInit();
    overlap.onModuleInit();
    await missing.onModuleDestroy();
    await overlap.onModuleDestroy();
  });

  it('bounds reconnect delays and command timeouts', async () => {
    expect(cacheReconnectDelay(0)).toBeLessThan(450);
    expect(cacheReconnectDelay(100)).toBeLessThan(5250);
    const cache = new PublicacoesCacheClient(
      config({
        REDIS_CACHE_ENABLED: 'true',
        REDIS_CACHE_URL: 'redis://127.0.0.1:6380',
      }),
    );
    const client = cache as unknown as { client: unknown };
    client.client = {
      isReady: true,
      withAbortSignal: (signal: AbortSignal) => ({
        get: () =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      }),
    };
    await expect(cache.get('stalled')).resolves.toBeUndefined();
  });
});
