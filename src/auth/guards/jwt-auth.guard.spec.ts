import type { JwtService } from '@nestjs/jwt';
import type { AuthenticatedRequest } from './jwt-auth.guard.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import type { SessoesService } from '../sessoes.service.js';
import type { UsuariosService } from '../../usuarios/usuarios.service.js';

const userId = '507f1f77bcf86cd799439011';
const sessionId = 'a'.repeat(43);

function setup() {
  const jwt = {
    verifyAsync: vi.fn().mockResolvedValue({
      sub: userId,
      sid: sessionId,
      exp: Math.floor(Date.now() / 1000) + 900,
    }),
  };
  const sessoes = { assertActive: vi.fn().mockResolvedValue(undefined) };
  const usuarios = { hasActiveStatus: vi.fn().mockResolvedValue({ _id: userId }) };
  const guard = new JwtAuthGuard(
    jwt as unknown as JwtService,
    sessoes as unknown as SessoesService,
    usuarios as unknown as UsuariosService,
  );
  const request = { headers: { authorization: 'Bearer valid-token' } } as AuthenticatedRequest;
  return { guard, request, jwt, sessoes, usuarios };
}

describe('JwtAuthGuard account status', () => {
  it('sets the authenticated identity only after session and active status checks', async () => {
    const { guard, request, sessoes, usuarios } = setup();
    await expect(guard.authenticate(request)).resolves.toBe(true);
    expect(sessoes.assertActive).toHaveBeenCalledWith(sessionId, userId);
    expect(usuarios.hasActiveStatus).toHaveBeenCalledOnce();
    expect(usuarios.hasActiveStatus).toHaveBeenCalledWith(userId);
    expect(request.authUserId).toBe(userId);
    expect(request.authSessionId).toBe(sessionId);
  });

  it('rejects inactive or absent accounts without setting an identity', async () => {
    const { guard, request, usuarios } = setup();
    usuarios.hasActiveStatus.mockResolvedValue(null);
    await expect(guard.authenticate(request)).rejects.toMatchObject({
      status: 401, response: { code: 'INVALID_TOKEN' },
    });
    expect(request.authUserId).toBeUndefined();
    expect(request.authSessionId).toBeUndefined();
  });

  it('maps MongoDB status lookup failure to 503 without granting access', async () => {
    const { guard, request, usuarios } = setup();
    usuarios.hasActiveStatus.mockRejectedValue(new Error('MongoDB unavailable'));
    await expect(guard.authenticate(request)).rejects.toMatchObject({
      status: 503, response: { code: 'AUTH_STATUS_UNAVAILABLE' },
    });
    expect(request.authUserId).toBeUndefined();
    expect(request.authSessionId).toBeUndefined();
  });

  it('does not query MongoDB when Redis session validation fails', async () => {
    const { guard, request, sessoes, usuarios } = setup();
    sessoes.assertActive.mockRejectedValue(new Error('Redis unavailable'));
    await expect(guard.authenticate(request)).rejects.toThrow('Redis unavailable');
    expect(usuarios.hasActiveStatus).not.toHaveBeenCalled();
    expect(request.authUserId).toBeUndefined();
  });

  it('allows logout to identify the session without querying account status', async () => {
    const { guard, request, sessoes, usuarios } = setup();
    await expect(guard.logoutSession(request)).resolves.toEqual({ id: sessionId, userId });
    expect(sessoes.assertActive).not.toHaveBeenCalled();
    expect(usuarios.hasActiveStatus).not.toHaveBeenCalled();
  });
});
