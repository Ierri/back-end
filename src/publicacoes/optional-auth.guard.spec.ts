import type { ExecutionContext } from '@nestjs/common';
import { ApiException } from '../common/http/api.exception.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { OptionalAuthGuard } from './optional-auth.guard.js';

function context(headers: Partial<Record<string, string>>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('OptionalAuthGuard', () => {
  const authenticate = vi.fn();
  const guard = new OptionalAuthGuard({
    authenticate,
  } as unknown as JwtAuthGuard);

  beforeEach(() => authenticate.mockReset());

  it('allows an anonymous public read without claiming a user', async () => {
    await expect(guard.canActivate(context({}))).resolves.toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it.each([
    { authorization: 'Bearer token' },
    { cookie: 'ierri_session=token' },
  ])('validates a supplied session before reading', async (headers) => {
    authenticate.mockResolvedValueOnce(true);
    await expect(guard.canActivate(context(headers))).resolves.toBe(true);
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it('rejects an invalid supplied session', async () => {
    authenticate.mockRejectedValueOnce(new ApiException('INVALID_TOKEN'));
    await expect(
      guard.canActivate(context({ authorization: 'Bearer invalid' })),
    ).rejects.toMatchObject({ status: 401 });
    authenticate.mockRejectedValueOnce(new ApiException('INVALID_TOKEN'));
    await expect(
      guard.canActivate(context({ cookie: 'ierri_session=invalid' })),
    ).rejects.toMatchObject({ status: 401 });
  });
});
