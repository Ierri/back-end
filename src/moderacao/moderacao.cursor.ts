import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';

@Injectable()
export class ModeracaoCursor {
  private readonly secret: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.secret = config.getOrThrow<string>('JWT_SECRET');
  }

  encode(date: Date, id: Types.ObjectId, scope: string) {
    const body = Buffer.from(JSON.stringify({ v: 1, d: date.getTime(), i: id.toString(), s: scope }));
    const mac = createHmac('sha256', this.secret).update(body).digest();
    return Buffer.concat([mac, body]).toString('base64url');
  }

  decode(value: string, scope: string) {
    try {
      const raw = Buffer.from(value, 'base64url');
      if (raw.length < 34 || raw.toString('base64url') !== value) throw new Error('cursor');
      const mac = createHmac('sha256', this.secret).update(raw.subarray(32)).digest();
      if (!timingSafeEqual(mac, raw.subarray(0, 32))) throw new Error('mac');
      const data: unknown = JSON.parse(raw.subarray(32).toString('utf8'));
      if (typeof data !== 'object' || data === null ||
        !('v' in data) || data.v !== 1 || !('s' in data) || data.s !== scope ||
        !('d' in data) || typeof data.d !== 'number' || !Number.isSafeInteger(data.d) ||
        !('i' in data) || typeof data.i !== 'string' || !/^[a-f\d]{24}$/i.test(data.i))
        throw new Error('payload');
      const date = new Date(data.d);
      if (Number.isNaN(date.getTime())) throw new Error('date');
      return { date, id: new Types.ObjectId(data.i) };
    } catch {
      throw new ApiException('VALIDATION_ERROR', [{ field: 'cursor', message: 'Cursor inválido.' }]);
    }
  }
}
