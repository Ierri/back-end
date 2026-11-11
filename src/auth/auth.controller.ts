import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { sessionCookieOptions, SESSION_COOKIE } from './session-cookie.js';
import { AuthService } from './auth.service.js';
import { SessoesService } from './sessoes.service.js';
import {
  checkEmailSchema,
  loginSchema,
  registerSchema,
} from './dto/auth.dto.js';
import type { CheckEmailDto, LoginDto, RegisterDto } from './dto/auth.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from './guards/jwt-auth.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { ApiException } from '../common/http/api.exception.js';
import { CheckEmailRateLimitService } from './check-email-rate-limit.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(JwtAuthGuard) private readonly guard: JwtAuthGuard,
    @Inject(SessoesService) private readonly sessoes: SessoesService,
    @Inject(CheckEmailRateLimitService)
    private readonly checkEmailRateLimit: CheckEmailRateLimitService,
  ) {}

  @ResponseMessage('Usuário encontrado.')
  @Post('check-email')
  @HttpCode(HttpStatus.OK)
  async checkEmail(
    @Body({ schema: checkEmailSchema }) body: CheckEmailDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const retryAfter = await this.checkEmailRateLimit.consume(
      request.ip,
      body.email,
    );
    if (retryAfter !== null) {
      response.setHeader('Retry-After', String(retryAfter));
      throw new ApiException('CHECK_EMAIL_RATE_LIMITED');
    }
    return this.auth.checkEmail(body);
  }

  @ResponseMessage('Conta criada com sucesso.')
  @Post('register')
  async register(
    @Body({ schema: registerSchema }) body: RegisterDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.register(body);
    response.cookie(SESSION_COOKIE, result.access_token, {
      ...sessionCookieOptions(),
      maxAge: result.expires_in * 1000,
    });
    return result;
  }

  @ResponseMessage('Login realizado com sucesso.')
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body({ schema: loginSchema }) body: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(body);
    response.cookie(SESSION_COOKIE, result.access_token, {
      ...sessionCookieOptions(),
      maxAge: result.expires_in * 1000,
    });
    return result;
  }

  @ResponseMessage('Você saiu da sua conta.')
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    let session: { id: string; userId: string } | null;
    try {
      session = await this.guard.logoutSession(request);
    } catch (error) {
      if (
        error instanceof ApiException &&
        error.getStatus() === HttpStatus.UNAUTHORIZED
      ) {
        response.clearCookie(SESSION_COOKIE, sessionCookieOptions());
      }
      throw error;
    }
    if (session) await this.sessoes.revoke(session.id, session.userId);
    response.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    return null;
  }

  @ResponseMessage('Usuário autenticado.')
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() request: AuthenticatedRequest) {
    return this.auth.me(request.authUserId);
  }
}
