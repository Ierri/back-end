import type { ExecutionContext } from '@nestjs/common';
import { ApiException } from '../common/http/api.exception.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RequiredAuthGuard } from './required-auth.guard.js';

describe('RequiredAuthGuard', () => {
  const canActivate = vi.fn();
  const guard = new RequiredAuthGuard({
    canActivate,
  } as unknown as JwtAuthGuard);
  const context = {} as ExecutionContext;

  beforeEach(() => canActivate.mockReset());

  it('delegates successful authentication to the existing guard', async () => {
    canActivate.mockResolvedValueOnce(true);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(canActivate).toHaveBeenCalledOnce();
    expect(canActivate).toHaveBeenCalledWith(context);
  });

  it.each(['TOKEN_REQUIRED', 'INVALID_TOKEN'] as const)(
    'preserves %s for missing or invalid credentials',
    async (code) => {
      canActivate.mockRejectedValueOnce(new ApiException(code));
      await expect(guard.canActivate(context)).rejects.toMatchObject({
        status: 401,
      });
    },
  );

  it('does not grant access when the session check fails', async () => {
    canActivate.mockRejectedValueOnce(new Error('Redis indisponível'));
    await expect(guard.canActivate(context)).rejects.toThrow();
  });
});
