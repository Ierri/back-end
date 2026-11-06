import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
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
  register(@Body({ schema: registerSchema }) body: RegisterDto) {
    return this.auth.register(body);
  }

  @ResponseMessage('Login realizado com sucesso.')
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body({ schema: loginSchema }) body: LoginDto) {
    return this.auth.login(body);
  }

  @ResponseMessage('Usuário autenticado.')
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() request: AuthenticatedRequest) {
    return this.auth.me(request.authUserId);
  }
}
