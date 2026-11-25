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
import type { BuscaOrder } from './dto/busca.dto.js';

export type BuscaUserCursorScope = {
  queryHash: string;
  viewerId: string | null;
};

export type BuscaUserCursorPosition = {
  relevancia: number;
  score: number;
  id: Types.ObjectId;
};

export type BuscaPublicationCursorScope = {
  queryHash: string;
  viewerId: string | null;
  order: BuscaOrder;
};

export type BuscaPublicationCursorPosition = {
  tier: 0 | 1;
  publishedAt: Date;
  score?: number;
  id: Types.ObjectId;
};

@Injectable()
export class BuscaCursor {
  private readonly key: Buffer;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.key = createHash('sha256')
      .update(config.getOrThrow<string>('JWT_SECRET'))
      .digest();
  }

  encodeUsers(
    position: BuscaUserCursorPosition,
    scope: BuscaUserCursorScope,
  ): string {
    return this.encrypt({
      v: 1,
      k: 'busca_usuarios',
      q: scope.queryHash,
      u: scope.viewerId?.toLowerCase() ?? null,
      r: position.relevancia,
      s: position.score,
      i: position.id.toString(),
    });
  }

  decodeUsers(
    cursor: string,
    scope: BuscaUserCursorScope,
  ): BuscaUserCursorPosition {
    const payload = this.decrypt(cursor);
    const expectedViewer = scope.viewerId?.toLowerCase() ?? null;
    if (
      payload.v !== 1 ||
      payload.k !== 'busca_usuarios' ||
      payload.q !== scope.queryHash ||
      payload.u !== expectedViewer ||
      typeof payload.r !== 'number' ||
      !Number.isInteger(payload.r) ||
      payload.r < 0 ||
      payload.r > 5 ||
      typeof payload.s !== 'number' ||
      !Number.isSafeInteger(payload.s) ||
      typeof payload.i !== 'string' ||
      !/^[a-f\d]{24}$/i.test(payload.i)
    ) {
      throw this.invalidCursor();
    }
    return {
      relevancia: payload.r,
      score: payload.s,
      id: new Types.ObjectId(payload.i),
    };
  }

  encodePublications(
    position: BuscaPublicationCursorPosition,
    scope: BuscaPublicationCursorScope,
  ): string {
    if (scope.order === 'score' && !Number.isSafeInteger(position.score)) {
      throw new Error('Invalid publication cursor score');
    }
    return this.encrypt({
      v: 1,
      k: 'busca_publicacoes',
      q: scope.queryHash,
      o: scope.order,
      u: scope.viewerId?.toLowerCase() ?? null,
      r: position.tier,
      t: position.publishedAt.getTime(),
      ...(scope.order === 'score' ? { s: position.score } : {}),
      i: position.id.toString(),
    });
  }

  decodePublications(
    cursor: string,
    scope: BuscaPublicationCursorScope,
  ): BuscaPublicationCursorPosition {
    const payload = this.decrypt(cursor);
    const expectedViewer = scope.viewerId?.toLowerCase() ?? null;
    const ranked = scope.order === 'score';
    if (
      payload.v !== 1 ||
      payload.k !== 'busca_publicacoes' ||
      payload.q !== scope.queryHash ||
      payload.o !== scope.order ||
      payload.u !== expectedViewer ||
      (payload.r !== 0 && payload.r !== 1) ||
      typeof payload.t !== 'number' ||
      !Number.isSafeInteger(payload.t) ||
      payload.t < 0 ||
      typeof payload.i !== 'string' ||
      !/^[a-f\d]{24}$/i.test(payload.i) ||
      (ranked &&
        (typeof payload.s !== 'number' || !Number.isSafeInteger(payload.s)))
    ) {
      throw this.invalidCursor();
    }
    const publishedAt = new Date(payload.t);
    if (Number.isNaN(publishedAt.getTime())) {
      throw this.invalidCursor();
    }
    return {
      tier: payload.r,
      publishedAt,
      ...(ranked ? { score: payload.s as number } : {}),
      id: new Types.ObjectId(payload.i),
    };
  }

  private encrypt(data: Record<string, unknown>): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(data));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      'base64url',
    );
  }

  private decrypt(cursor: string): Record<string, unknown> {
    try {
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
      const parsed: unknown = JSON.parse(decrypted.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('Invalid cursor payload');
      }
      return parsed as Record<string, unknown>;
    } catch {
      throw this.invalidCursor();
    }
  }

  private invalidCursor(): ApiException {
    return new ApiException('VALIDATION_ERROR', [
      { field: 'cursor', message: 'Cursor inválido.' },
    ]);
  }
}
