import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Model } from 'mongoose';
import { Usuario } from '../../usuarios/schemas/usuario.schema.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { RolesGuard } from './roles.guard.js';

function setup(papeis: Usuario['papeis'] = ['usuario']) {
  const request = { authUserId: '' };
  const auth = { canActivate: vi.fn().mockImplementation(() => {
    request.authUserId = '507f1f77bcf86cd799439011';
    return true;
  }) };
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(['administrador']) };
  const query = { select: vi.fn(), lean: vi.fn(), exec: vi.fn().mockResolvedValue({ papeis }) };
  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  const users = { findOne: vi.fn().mockReturnValue(query) };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => null,
    getClass: () => null,
  } as unknown as ExecutionContext;
  const guard = new RolesGuard(auth as unknown as JwtAuthGuard,
    reflector as unknown as Reflector, users as unknown as Model<Usuario>);
  return { guard, auth, reflector, users, query, context, request };
}

describe('RolesGuard', () => {
  it('requires authentication before checking current database roles', async () => {
    const { guard, auth, users, context } = setup();
    auth.canActivate.mockRejectedValue(new Error('session invalid'));
    await expect(guard.canActivate(context)).rejects.toThrow('session invalid');
    expect(users.findOne).not.toHaveBeenCalled();
  });

  it.each([['usuario'], ['moderador']])('denies %s without administrator role', async (...roles) => {
    const { guard, context } = setup(roles as Usuario['papeis']);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
  });

  it('permits an administrator and queries an active account each time', async () => {
    const { guard, users, context, request } = setup(['usuario', 'administrador']);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(users.findOne).toHaveBeenCalledWith({ _id: request.authUserId, status: 'ativo' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(users.findOne).toHaveBeenCalledTimes(2);
  });

  it('revokes access immediately after the role changes within a valid session', async () => {
    const { guard, query, context } = setup(['administrador']);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    query.exec.mockResolvedValue({ papeis: ['usuario'] });
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
  });

  it('rejects an inactive account and fails closed when role lookup fails', async () => {
    const { guard, query, context } = setup(['administrador']);
    query.exec.mockResolvedValueOnce(null);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
    query.exec.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 503 });
  });
});
