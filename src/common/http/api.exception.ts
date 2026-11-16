import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorDetail } from './api-response.js';

export const API_ERRORS = {
  VALIDATION_ERROR: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Verifique os dados enviados.',
  },
  USER_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Usuário não encontrado.',
  },
  CHECK_EMAIL_RATE_LIMITED: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Muitas consultas. Tente novamente mais tarde.',
  },
  CHECK_EMAIL_RATE_LIMIT_UNAVAILABLE: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message:
      'Não foi possível verificar o e-mail agora. Tente novamente mais tarde.',
  },
  EMAIL_ALREADY_EXISTS: {
    status: HttpStatus.CONFLICT,
    message: 'E-mail já cadastrado.',
  },
  REGISTRATION_COMPLETED_SESSION_UNAVAILABLE: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message:
      'Sua conta foi criada, mas não foi possível iniciar a sessão. Tente entrar novamente quando o serviço estiver disponível.',
  },
  USER_ALREADY_EXISTS: {
    status: HttpStatus.CONFLICT,
    message: 'E-mail ou username já cadastrado.',
  },
  INVALID_CREDENTIALS: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'E-mail ou senha inválidos.',
  },
  AUTH_REQUIRED: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Autenticação obrigatória.',
  },
  TOKEN_REQUIRED: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Token de acesso obrigatório.',
  },
  INVALID_TOKEN: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Token inválido ou expirado.',
  },
  PUBLICACAO_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Publicação não encontrada.',
  },
  MEDIA_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'As mídias informadas não foram validadas.',
  },
  MEDIA_VERIFICATION_UNAVAILABLE: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'Não é possível validar mídias agora. Tente novamente mais tarde.',
  },
  MEDIA_STORAGE_UNAVAILABLE: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message:
      'Armazenamento de mídias indisponível. Tente novamente mais tarde.',
  },
  MEDIA_PROCESSING_UNAVAILABLE: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message:
      'Não foi possível analisar a mídia agora. Tente novamente mais tarde.',
  },
  MEDIA_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Mídia não encontrada.',
  },
} as const;

export type ApiErrorCode = keyof typeof API_ERRORS;

export class ApiException extends HttpException {
  constructor(code: ApiErrorCode, details: ApiErrorDetail[] = []) {
    const { status, message } = API_ERRORS[code];
    super({ code, message, details }, status);
  }
}
