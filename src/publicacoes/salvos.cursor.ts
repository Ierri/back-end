import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';

export type SalvosPosition = { savedAt: Date; id: Types.ObjectId };

@Injectable()
export class SalvosCursor {
  private readonly key: Buffer;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.key = createHash('sha256').update(config.getOrThrow<string>('JWT_SECRET')).digest();
  }

  encode(position: SalvosPosition, userId: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const payload = Buffer.from(JSON.stringify({
      v: 1, s: 'salva_em_desc_id_desc', u: userId.toLowerCase(),
      t: position.savedAt.getTime(), i: position.id.toString(),
    }));
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  decode(cursor: string, userId: string): SalvosPosition {
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.length < 29 || bytes.toString('base64url') !== cursor)
        throw new Error('Invalid cursor');
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const payload: unknown = JSON.parse(Buffer.concat([
        decipher.update(bytes.subarray(28)), decipher.final(),
      ]).toString('utf8'));
      if (typeof payload !== 'object' || payload === null ||
        !('v' in payload) || payload.v !== 1 ||
        !('s' in payload) || payload.s !== 'salva_em_desc_id_desc' ||
        !('u' in payload) || payload.u !== userId.toLowerCase() ||
        !('t' in payload) || typeof payload.t !== 'number' ||
        !Number.isSafeInteger(payload.t) || payload.t < 0 ||
        !('i' in payload) || typeof payload.i !== 'string' ||
        !/^[a-f\d]{24}$/i.test(payload.i)) throw new Error('Invalid cursor');
      const savedAt = new Date(payload.t);
      if (Number.isNaN(savedAt.getTime())) throw new Error('Invalid date');
      return { savedAt, id: new Types.ObjectId(payload.i) };
    } catch {
      throw new ApiException('VALIDATION_ERROR', [{ field: 'cursor', message: 'Cursor inválido.' }]);
    }
  }
}
