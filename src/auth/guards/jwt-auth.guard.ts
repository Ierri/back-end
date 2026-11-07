import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { SESSION_COOKIE } from '../session-cookie.js';
import { ApiException } from '../../common/http/api.exception.js';

export type AuthenticatedRequest = Request & { authUserId: string };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization ?? '',
    );
    const cookieToken = request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    const token = match?.[1] ?? cookieToken;
    if (!token) throw new ApiException('TOKEN_REQUIRED');

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token, {
        algorithms: ['HS256'],
        issuer: 'ierri-api',
        audience: 'ierri-api',
      });
      if (
        typeof payload.sub !== 'string' ||
        !/^[a-f\d]{24}$/i.test(payload.sub)
      ) {
        throw new Error('Invalid subject');
      }
      request.authUserId = payload.sub;
      return true;
    } catch {
      throw new ApiException('INVALID_TOKEN');
    }
  }
}
