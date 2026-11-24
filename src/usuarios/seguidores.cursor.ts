import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';

export type SeguidoresCursorScope = {
  kind: 'seguidores' | 'seguindo' | 'solicitacoes';
  userId: string;
};

@Injectable()
export class SeguidoresCursor {
  private readonly key: Buffer;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.key = createHash('sha256').update(config.getOrThrow<string>('JWT_SECRET')).digest();
  }

  encode(position: { date: Date; id: Types.ObjectId }, scope: SeguidoresCursorScope) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      k: scope.kind,
      u: scope.userId,
      t: position.date.getTime(),
      i: position.id.toString(),
    }));
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  decode(cursor: string, scope: SeguidoresCursorScope) {
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.length < 29 || bytes.toString('base64url') !== cursor) throw new Error('encoding');
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const raw = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
      const value: unknown = JSON.parse(raw.toString('utf8'));
      if (
        typeof value !== 'object' || value === null ||
        !('v' in value) || value.v !== 1 ||
        !('k' in value) || value.k !== scope.kind ||
        !('u' in value) || value.u !== scope.userId ||
        !('t' in value) || typeof value.t !== 'number' || !Number.isSafeInteger(value.t) || value.t < 0 ||
        !('i' in value) || typeof value.i !== 'string' || !/^[a-f\d]{24}$/i.test(value.i)
      ) throw new Error('payload');
      const date = new Date(value.t);
      if (Number.isNaN(date.getTime())) throw new Error('date');
      return { date, id: new Types.ObjectId(value.i) };
    } catch {
      throw new ApiException('VALIDATION_ERROR', [{ field: 'cursor', message: 'Cursor inválido.' }]);
    }
  }
}
