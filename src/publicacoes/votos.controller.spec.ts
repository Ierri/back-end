import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { publicacaoIdSchema } from './dto/publicacoes.dto.js';
import { putVotoSchema } from './dto/votos.dto.js';
import { RequiredAuthGuard } from './required-auth.guard.js';
import { VotosController } from './votos.controller.js';
import type { VotosService } from './votos.service.js';

const publicationId = '507f1f77bcf86cd799439011';
const userId = '507f191e810c19729de860ea';
const request = { authUserId: userId } as AuthenticatedRequest;

describe('API de votos', () => {
  it.each(['put', 'remove', 'get'] as const)('requires authentication for %s', (method) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, VotosController.prototype[method])).toContain(RequiredAuthGuard);
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
    ]) expect(putVotoSchema.safeParse(body).success).toBe(false);
  });

  it('passes only the authenticated user and validated value to the service', async () => {
    const put = vi.fn().mockResolvedValue({ valor: 1, contadores: { upvotes: 1, downvotes: 0, score: 1 } });
    const controller = new VotosController({ put } as unknown as VotosService);
    const result = await controller.put(publicationId, putVotoSchema.parse({ valor: 1 }), request);
    expect(put).toHaveBeenCalledExactlyOnceWith(publicationId, userId, 1);
    expect(result).toEqual({ valor: 1, contadores: { upvotes: 1, downvotes: 0, score: 1 } });
  });

  it('uses the authenticated identity for removal and private vote lookup', async () => {
    const remove = vi.fn().mockResolvedValue({ valor: null });
    const get = vi.fn().mockResolvedValue({ valor: -1 });
    const controller = new VotosController({ remove, get } as unknown as VotosService);
    await expect(controller.remove(publicationId, request)).resolves.toEqual({ valor: null });
    await expect(controller.get(publicationId, request)).resolves.toEqual({ valor: -1 });
    expect(remove).toHaveBeenCalledExactlyOnceWith(publicationId, userId);
    expect(get).toHaveBeenCalledExactlyOnceWith(publicationId, userId);
  });
});
