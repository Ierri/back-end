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
import type { Response } from 'express';
import { sessionCookieOptions, SESSION_COOKIE } from './session-cookie.js';
import { AuthService } from './auth.service.js';
import {
  checkEmailSchema,
  loginSchema,
  registerSchema,
} from './dto/auth.dto.js';
import type { CheckEmailDto, LoginDto, RegisterDto } from './dto/auth.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from './guards/jwt-auth.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @ResponseMessage('Usuário encontrado.')
  @Post('check-email')
  @HttpCode(HttpStatus.OK)
  checkEmail(@Body({ schema: checkEmailSchema }) body: CheckEmailDto) {
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
  logout(@Res({ passthrough: true }) response: Response) {
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
