import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { RolesGuard } from '../auth/guards/roles.guard.js';

@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(@Inject(RolesGuard) private readonly roles: RolesGuard) {}

  canActivate(context: ExecutionContext) {
    return this.roles.canActivate(context);
  }
}
