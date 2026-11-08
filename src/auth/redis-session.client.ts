import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

export function redisReconnectDelay(retries: number) {
  return Math.min(100 * 2 ** retries, 3000) + Math.floor(Math.random() * 200);
}

@Injectable()
export class RedisSessionClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisSessionClient.name);
  readonly client: ReturnType<typeof createClient>;
  readonly prefix: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const url = config.getOrThrow<string>('REDIS_URL').trim();
    if (!url) throw new Error('Defina REDIS_URL no ambiente.');
    this.prefix =
      config.get<string>('REDIS_SESSION_PREFIX')?.trim() ||
      'ierri:auth:session:';
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: redisReconnectDelay,
      },
    });
    this.client.on('error', () => this.logger.warn('Redis indisponível.'));
  }

  async onModuleInit() {
    await this.client.connect();
  }

  async onModuleDestroy() {
    if (this.client.isOpen) await this.client.close();
  }
}
