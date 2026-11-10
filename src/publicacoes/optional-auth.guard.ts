import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';

@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(@Inject(JwtAuthGuard) private readonly auth: JwtAuthGuard) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const hasSessionCookie = request.headers.cookie
      ?.split(';')
      .some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`));
    if (request.headers.authorization === undefined && !hasSessionCookie)
      return true;
    return this.auth.authenticate(request);
  }
}
