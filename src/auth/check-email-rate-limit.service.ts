import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../common/http/api.exception.js';
import { RedisSessionClient } from './redis-session.client.js';

const ORIGIN_LIMIT = 30;
const ORIGIN_WINDOW_MS = 60_000;
const ORIGIN_EMAIL_LIMIT = 10;
const ORIGIN_EMAIL_WINDOW_MS = 600_000;

const CONSUME_SCRIPT = `
local originCount = redis.call('INCR', KEYS[1])
if originCount == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local originEmailCount = redis.call('INCR', KEYS[2])
if originEmailCount == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[2]) end
return {
  originCount,
  originEmailCount,
  redis.call('PTTL', KEYS[1]),
  redis.call('PTTL', KEYS[2])
}
`;

@Injectable()
export class CheckEmailRateLimitService {
  private readonly prefix: string;
  private readonly secret: string;

  constructor(
    @Inject(RedisSessionClient) private readonly redis: RedisSessionClient,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.prefix =
      config.get<string>('REDIS_CHECK_EMAIL_RATE_PREFIX')?.trim() ||
      'ierri:auth:rate:check-email:';
    if (
      this.prefix.startsWith(this.redis.prefix) ||
      this.redis.prefix.startsWith(this.prefix)
    ) {
      throw new Error('O prefixo do rate limit deve ser separado das sessões.');
    }
    this.secret = config.getOrThrow<string>('JWT_SECRET');
  }

  async consume(
    origin: string | undefined,
    email: string,
  ): Promise<number | null> {
    if (!origin || !this.redis.client.isReady) {
      throw new ApiException('CHECK_EMAIL_RATE_LIMIT_UNAVAILABLE');
    }

    const originHash = this.digest(origin);
    const originEmailHash = this.digest(`${origin}\0${email}`);
    let result: unknown;
    try {
      result = await this.redis.client.eval(CONSUME_SCRIPT, {
        keys: [
          `${this.prefix}origin:${originHash}`,
          `${this.prefix}origin-email:${originEmailHash}`,
        ],
        arguments: [String(ORIGIN_WINDOW_MS), String(ORIGIN_EMAIL_WINDOW_MS)],
      });
    } catch {
      throw new ApiException('CHECK_EMAIL_RATE_LIMIT_UNAVAILABLE');
    }

    if (
      !Array.isArray(result) ||
      result.length !== 4 ||
      !result.every((value) => Number.isSafeInteger(value))
    ) {
      throw new ApiException('CHECK_EMAIL_RATE_LIMIT_UNAVAILABLE');
    }

    const [originCount, originEmailCount, originTtl, originEmailTtl] =
      result as number[];
    if (
      originCount < 1 ||
      originEmailCount < 1 ||
      originTtl <= 0 ||
      originEmailTtl <= 0
    ) {
      throw new ApiException('CHECK_EMAIL_RATE_LIMIT_UNAVAILABLE');
    }
    if (originCount <= ORIGIN_LIMIT && originEmailCount <= ORIGIN_EMAIL_LIMIT) {
      return null;
    }
    const retryMs = Math.max(
      originCount > ORIGIN_LIMIT ? originTtl : 0,
      originEmailCount > ORIGIN_EMAIL_LIMIT ? originEmailTtl : 0,
    );
    if (retryMs <= 0) {
      throw new ApiException('CHECK_EMAIL_RATE_LIMIT_UNAVAILABLE');
    }
    return Math.ceil(retryMs / 1000);
  }

  private digest(value: string) {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }
}
