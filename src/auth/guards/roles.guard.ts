import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../../common/http/api.exception.js';
import { Usuario } from '../../usuarios/schemas/usuario.schema.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import type { AuthenticatedRequest } from './jwt-auth.guard.js';
import { REQUIRED_ROLES } from './roles.decorator.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    @Inject(JwtAuthGuard) private readonly auth: JwtAuthGuard,
    @Inject(Reflector) private readonly reflector: Reflector,
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
  ) {}

  async canActivate(context: ExecutionContext) {
    await this.auth.canActivate(context);
    const roles = this.reflector.getAllAndOverride<Usuario['papeis']>(REQUIRED_ROLES,
      [context.getHandler(), context.getClass()]);
    if (!roles?.length) return true;
    const { authUserId } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    let user;
    try {
      user = await this.usuarios.findOne({ _id: authUserId, status: 'ativo' })
        .select('papeis').lean().exec();
    } catch {
      throw new ApiException('AUTH_STATUS_UNAVAILABLE');
    }
    if (!user) throw new ApiException('INVALID_TOKEN');
    if (!roles.some((role) => user.papeis?.includes(role))) throw new ApiException('ROLE_FORBIDDEN');
    return true;
  }
}
