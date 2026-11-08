import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../common/http/api.exception.js';
import { RedisSessionClient } from './redis-session.client.js';

@Injectable()
export class SessoesService {
  constructor(
    @Inject(RedisSessionClient) private readonly redis: RedisSessionClient,
  ) {}

  async create(id: string, usuarioId: string, expiraEm: Date) {
    const ttlMs = Math.floor(expiraEm.getTime() - Date.now());
    if (ttlMs <= 0) throw new Error('Sessão expirada.');
    const result = await this.client.set(this.key(id), usuarioId, {
      PX: ttlMs,
      NX: true,
    });
    if (result !== 'OK') throw new Error('Não foi possível criar a sessão.');
  }

  async assertActive(id: string, usuarioId: string) {
    const storedUserId = await this.client.get(this.key(id));
    if (storedUserId !== usuarioId) throw new ApiException('INVALID_TOKEN');
  }

  async revoke(id: string, usuarioId: string) {
    const deleted = await this.client.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      { keys: [this.key(id)], arguments: [usuarioId] },
    );
    return deleted === 1 ? 'revoked' : 'missing';
  }

  private get client() {
    if (!this.redis.client.isReady) throw new Error('Redis indisponível.');
    return this.redis.client;
  }

  private key(id: string) {
    const hash = createHash('sha256').update(id).digest('hex');
    return `${this.redis.prefix}${hash}`;
  }
}
