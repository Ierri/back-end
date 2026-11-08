import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { SESSION_COOKIE } from '../session-cookie.js';
import { ApiException } from '../../common/http/api.exception.js';
import { SessoesService } from '../sessoes.service.js';

export type AuthenticatedRequest = Request & {
  authUserId: string;
  authSessionId: string;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(SessoesService) private readonly sessoes: SessoesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return this.authenticate(request);
  }

  async authenticate(request: AuthenticatedRequest) {
    const token = this.readToken(request);
    if (!token) throw new ApiException('TOKEN_REQUIRED');
    const payload = await this.verifyToken(token, false);
    await this.sessoes.assertActive(payload.sid, payload.sub);
    request.authUserId = payload.sub;
    request.authSessionId = payload.sid;
    return true;
  }

  async logoutSession(request: AuthenticatedRequest) {
    const token = this.readToken(request);
    if (!token) return null;
    const payload = await this.verifyToken(token, true);
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return { id: payload.sid, userId: payload.sub };
  }

  private readToken(request: AuthenticatedRequest) {
    const match = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization ?? '',
    );
    const cookieToken = request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    const token = request.headers.authorization ? match?.[1] : cookieToken;
    if (request.headers.authorization && !token)
      throw new ApiException('INVALID_TOKEN');
    return token;
  }

  private async verifyToken(token: string, ignoreExpiration: boolean) {
    let payload: { sub: string; sid: string; exp: number };
    try {
      payload = await this.jwt.verifyAsync<{
        sub: string;
        sid: string;
        exp: number;
      }>(token, {
        algorithms: ['HS256'],
        issuer: 'ierri-api',
        audience: 'ierri-api',
        ignoreExpiration,
      });
      if (
        typeof payload.sub !== 'string' ||
        !/^[a-f\d]{24}$/i.test(payload.sub) ||
        typeof payload.sid !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(payload.sid) ||
        typeof payload.exp !== 'number' ||
        !Number.isFinite(payload.exp)
      ) {
        throw new Error('Invalid subject');
      }
    } catch {
      throw new ApiException('INVALID_TOKEN');
    }
    return payload;
  }
}
