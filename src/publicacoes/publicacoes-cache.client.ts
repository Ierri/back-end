import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

const INVALIDATE_SCRIPT = `
for index = 1, #KEYS do
  redis.call('INCR', KEYS[index])
  redis.call('EXPIRE', KEYS[index], 86400)
end
return #KEYS
`;

export function cacheReconnectDelay(retries: number) {
  return Math.min(200 * 2 ** retries, 5000) + Math.floor(Math.random() * 250);
}

function ttl(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 3600
    ? parsed
    : fallback;
}

@Injectable()
export class PublicacoesCacheClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublicacoesCacheClient.name);
  private readonly client: ReturnType<typeof createClient> | null;
  private warned = false;
  readonly prefix: string;
  readonly feedTtl: number;
  readonly postTtl: number;
  readonly authorTtl: number;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.prefix =
      config.get<string>('REDIS_CACHE_PREFIX')?.trim() ||
      'ierri:cache:publicacoes:v1:';
    this.feedTtl = ttl(config.get<string>('REDIS_CACHE_FEED_TTL'), 20);
    this.postTtl = ttl(config.get<string>('REDIS_CACHE_POST_TTL'), 45);
    this.authorTtl = ttl(config.get<string>('REDIS_CACHE_AUTHOR_TTL'), 30);
    const enabled =
      config.get<string>('REDIS_CACHE_ENABLED')?.trim() === 'true';
    const url = config.get<string>('REDIS_CACHE_URL')?.trim();
    const authPrefixes = [
      config.get<string>('REDIS_SESSION_PREFIX')?.trim() ||
        'ierri:auth:session:',
      config.get<string>('REDIS_CHECK_EMAIL_RATE_PREFIX')?.trim() ||
        'ierri:auth:rate:check-email:',
    ];
    if (
      !enabled ||
      !url ||
      !/^[A-Za-z0-9:_-]{1,128}:$/.test(this.prefix) ||
      authPrefixes.some(
        (auth) => this.prefix.startsWith(auth) || auth.startsWith(this.prefix),
      )
    ) {
      this.client = null;
      if (enabled)
        this.logger.warn('Cache Redis desativado por configuração inválida.');
      return;
    }
    try {
      this.client = createClient({
        url,
        disableOfflineQueue: true,
        socket: {
          connectTimeout: 1500,
          reconnectStrategy: cacheReconnectDelay,
        },
      });
      this.client.on('error', () => this.warnUnavailable());
      this.client.on('ready', () => {
        this.warned = false;
      });
    } catch {
      this.client = null;
      this.logger.warn('Cache Redis desativado por configuração inválida.');
    }
  }

  get enabled() {
    return this.client !== null;
  }

  get ready() {
    return this.client?.isReady ?? false;
  }

  onModuleInit() {
    if (this.client)
      void this.client.connect().catch(() => this.warnUnavailable());
  }

  async onModuleDestroy() {
    if (!this.client) return;
    if (this.client.isReady)
      await this.client.close().catch(() => this.client?.destroy());
    else this.client.destroy();
  }

  async get(key: string): Promise<string | null | undefined> {
    if (!this.client?.isReady) return undefined;
    try {
      return await this.client
        .withAbortSignal(AbortSignal.timeout(350))
        .get(key);
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: string, seconds: number) {
    if (!this.client?.isReady) return false;
    try {
      return (
        (await this.client
          .withAbortSignal(AbortSignal.timeout(350))
          .set(key, value, { EX: seconds })) === 'OK'
      );
    } catch {
      return false;
    }
  }

  async del(key: string) {
    if (!this.client?.isReady) return;
    try {
      await this.client.withAbortSignal(AbortSignal.timeout(350)).del(key);
    } catch {}
  }

  async invalidate(keys: string[]) {
    if (!this.client?.isReady) return false;
    try {
      return (
        (await this.client
          .withAbortSignal(AbortSignal.timeout(350))
          .eval(INVALIDATE_SCRIPT, { keys, arguments: [] })) === keys.length
      );
    } catch {
      return false;
    }
  }

  private warnUnavailable() {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn('Cache Redis indisponível.');
  }
}
