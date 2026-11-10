import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';

@Injectable()
export class RequiredAuthGuard implements CanActivate {
  constructor(@Inject(JwtAuthGuard) private readonly auth: JwtAuthGuard) {}

  canActivate(context: ExecutionContext) {
    return this.auth.canActivate(context);
  }
}
