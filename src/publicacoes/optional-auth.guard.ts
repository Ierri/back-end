import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { ApiException } from '../common/http/api.exception.js';
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
    try {
      return await this.auth.authenticate(request);
    } catch (error) {
      if (
        request.headers.authorization === undefined &&
        ['GET', 'HEAD'].includes(request.method) &&
        error instanceof ApiException &&
        error.getStatus() === HttpStatus.UNAUTHORIZED
      ) {
        // An expired browser session should not prevent anonymous reads.
        return true;
      }
      throw error;
    }
  }
}
