import { GUARDS_METADATA, SSE_METADATA } from '@nestjs/common/constants';
import { of } from 'rxjs';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { publicacaoIdSchema } from './dto/publicacoes.dto.js';
import {
  MAX_STREAM_PUBLICATION_IDS,
  putVotoSchema,
  streamVotosQuerySchema,
} from './dto/votos.dto.js';
import { OptionalAuthGuard } from './optional-auth.guard.js';
import { RequiredAuthGuard } from './required-auth.guard.js';
import { VotosController } from './votos.controller.js';
import type { VotosStreamService } from './votos-stream.service.js';
import type { VotosService } from './votos.service.js';

const publicationId = '507f1f77bcf86cd799439011';
const secondPublicationId = '507f1f77bcf86cd799439012';
const userId = '507f191e810c19729de860ea';
const request = {
  authUserId: userId,
  ip: '127.0.0.1',
} as AuthenticatedRequest;

describe('API de votos', () => {
  it.each(['put', 'remove', 'get'] as const)(
    'requires authentication for %s',
    (method) => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, VotosController.prototype[method]),
      ).toContain(RequiredAuthGuard);
    },
  );

  it('exposes optional-auth SSE stream metadata on stream()', () => {
    const streamMethod = 'stream' as const;
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        VotosController.prototype[streamMethod],
      ),
    ).toContain(OptionalAuthGuard);
    expect(
      Reflect.getMetadata(
        SSE_METADATA,
        VotosController.prototype[streamMethod],
      ),
    ).toBe(true);
  });

  it('accepts only a valid publication ID and a strict upvote or downvote body', () => {
    expect(publicacaoIdSchema.safeParse(publicationId).success).toBe(true);
    expect(publicacaoIdSchema.safeParse('invalid').success).toBe(false);
    expect(putVotoSchema.parse({ valor: 1 })).toEqual({ valor: 1 });
    expect(putVotoSchema.parse({ valor: -1 })).toEqual({ valor: -1 });
    for (const body of [
      { valor: 0 },
      { valor: 2 },
      { valor: '1' },
      { valor: null },
      { valor: 1, usuarioId: userId },
      {},
    ])
      expect(putVotoSchema.safeParse(body).success).toBe(false);
  });

  it('validates and deduplicates stream query IDs up to the maximum limit', () => {
    expect(
      streamVotosQuerySchema.parse({
        ids: `${publicationId.toUpperCase()}, ${secondPublicationId}, ${publicationId}`,
      }),
    ).toEqual({
      ids: [publicationId, secondPublicationId],
    });

    const tooMany = Array.from(
      { length: MAX_STREAM_PUBLICATION_IDS + 1 },
      (_, idx) => `507f1f77bcf86cd7994390${String(idx).padStart(2, '0')}`,
    ).join(',');

    for (const badQuery of [
      {},
      { ids: '' },
      { ids: 'invalid-id' },
      { ids: `${publicationId},not-an-object-id` },
      { ids: tooMany },
      { ids: publicationId, extra: '1' },
    ]) {
      expect(streamVotosQuerySchema.safeParse(badQuery).success).toBe(false);
    }
  });

  it('passes only the authenticated user and validated value to the service', async () => {
    const put = vi.fn().mockResolvedValue({
      valor: 1,
      contadores: { upvotes: 1, downvotes: 0, score: 1 },
    });
    const controller = new VotosController({ put } as unknown as VotosService);
    const result = await controller.put(
      publicationId,
      putVotoSchema.parse({ valor: 1 }),
      request,
    );
    expect(put).toHaveBeenCalledExactlyOnceWith(publicationId, userId, 1);
    expect(result).toEqual({
      valor: 1,
      contadores: { upvotes: 1, downvotes: 0, score: 1 },
    });
  });

  it('uses the authenticated identity for removal, private vote lookup, and stream subscription', async () => {
    const remove = vi.fn().mockResolvedValue({ valor: null });
    const get = vi.fn().mockResolvedValue({ valor: -1 });
    const openStream = vi.fn().mockResolvedValue(of({ comment: 'ping' }));
    const controller = new VotosController(
      { remove, get } as unknown as VotosService,
      { openStream } as unknown as VotosStreamService,
    );
    await expect(controller.remove(publicationId, request)).resolves.toEqual({
      valor: null,
    });
    await expect(controller.get(publicationId, request)).resolves.toEqual({
      valor: -1,
    });
    await controller.stream({ ids: [publicationId] }, request);
    expect(remove).toHaveBeenCalledExactlyOnceWith(publicationId, userId);
    expect(get).toHaveBeenCalledExactlyOnceWith(publicationId, userId);
    expect(openStream).toHaveBeenCalledExactlyOnceWith(
      [publicationId],
      userId,
      '127.0.0.1',
    );
  });
});
