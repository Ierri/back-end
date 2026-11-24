import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';

const CURSOR_ORDER = 'publicada_em_desc_id_desc';
const SCORE_CURSOR_ORDER = 'score_desc_publicada_em_desc_id_desc';

export type PublicationCursorScope = {
  authorId: string | null;
  owner: boolean;
  viewerId?: string | null;
  feed?: 'geral' | 'seguindo';
  order?: 'cronologica' | 'score';
};

export type PublicationCursorPosition = {
  publishedAt: Date;
  id: Types.ObjectId;
  score?: number;
};

@Injectable()
export class PublicacoesCursor {
  private readonly key: Buffer;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.key = createHash('sha256')
      .update(config.getOrThrow<string>('JWT_SECRET'))
      .digest();
  }

  encode(position: PublicationCursorPosition, scope: PublicationCursorScope) {
    const following = scope.feed === 'seguindo';
    const ranked = scope.order === 'score';
    if (ranked && !Number.isSafeInteger(position.score))
      throw new Error('Invalid cursor score');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const payload = Buffer.from(
      JSON.stringify({
        v: ranked ? 5 : following ? 4 : 3,
        s: ranked ? SCORE_CURSOR_ORDER : CURSOR_ORDER,
        t: position.publishedAt.getTime(),
        i: position.id.toString(),
        a: scope.authorId,
        o: scope.owner,
        u: scope.viewerId ?? null,
        ...(following || ranked ? { f: scope.feed ?? 'geral' } : {}),
        ...(ranked ? { q: position.score } : {}),
      }),
    );
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      'base64url',
    );
  }

  decode(
    cursor: string,
    scope: PublicationCursorScope,
  ): PublicationCursorPosition {
    try {
      const following = scope.feed === 'seguindo';
      const ranked = scope.order === 'score';
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.length < 29 || bytes.toString('base64url') !== cursor) {
        throw new Error('Invalid cursor encoding');
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      const decrypted = Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]);
      const payload: unknown = JSON.parse(decrypted.toString('utf8'));
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('v' in payload) ||
        (ranked ? payload.v !== 5 : payload.v !== 2 && payload.v !== 3 && payload.v !== 4) ||
        !('s' in payload) ||
        payload.s !== (ranked ? SCORE_CURSOR_ORDER : CURSOR_ORDER) ||
        !('t' in payload) ||
        typeof payload.t !== 'number' ||
        !Number.isSafeInteger(payload.t) ||
        payload.t < 0 ||
        !('i' in payload) ||
        typeof payload.i !== 'string' ||
        !/^[a-f\d]{24}$/i.test(payload.i) ||
        !('a' in payload) ||
        payload.a !== scope.authorId ||
        !('o' in payload) ||
        payload.o !== scope.owner ||
        (ranked
          ? !('q' in payload) || typeof payload.q !== 'number' ||
            !Number.isSafeInteger(payload.q) || !('u' in payload) ||
            payload.u !== (scope.viewerId ?? null) || !('f' in payload) ||
            payload.f !== (scope.feed ?? 'geral') || (following && !scope.viewerId)
          : following
            ? payload.v !== 4 || !scope.viewerId || !('u' in payload) ||
              payload.u !== scope.viewerId || !('f' in payload) || payload.f !== 'seguindo'
            : payload.v === 4 ||
              (payload.v === 3 && (!('u' in payload) || payload.u !== (scope.viewerId ?? null))))
      ) {
        throw new Error('Invalid cursor payload');
      }
      const publishedAt = new Date(payload.t);
      if (Number.isNaN(publishedAt.getTime())) {
        throw new Error('Invalid cursor date');
      }
      return {
        publishedAt,
        id: new Types.ObjectId(payload.i),
        ...(ranked && 'q' in payload ? { score: payload.q as number } : {}),
      };
    } catch {
      throw new ApiException('VALIDATION_ERROR', [
        { field: 'cursor', message: 'Cursor inválido.' },
      ]);
    }
  }
}
