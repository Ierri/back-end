import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
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
    if (!match) throw new ApiException('TOKEN_REQUIRED');

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(match[1], {
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
