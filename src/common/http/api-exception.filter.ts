import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiFailure } from './api-response.js';
import { ApiException } from './api.exception.js';

const HTTP_ERRORS: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'Requisição inválida.' },
  401: { code: 'AUTH_REQUIRED', message: 'Autenticação obrigatória.' },
  403: { code: 'FORBIDDEN', message: 'Acesso não permitido.' },
  404: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' },
  409: { code: 'CONFLICT', message: 'Conflito com um registro existente.' },
  413: {
    code: 'PAYLOAD_TOO_LARGE',
    message: 'O corpo da requisição excede o limite permitido.',
  },
  415: {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'Formato de conteúdo não suportado.',
  },
  429: {
    code: 'TOO_MANY_REQUESTS',
    message: 'Muitas requisições. Tente novamente mais tarde.',
  },
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    let status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    // Express body-parser errors happen before the controller and are not HttpExceptions.
    if (
      !(exception instanceof HttpException) &&
      typeof exception === 'object' &&
      exception !== null &&
      'type' in exception
    ) {
      if (exception.type === 'entity.parse.failed')
        status = HttpStatus.BAD_REQUEST;
      if (exception.type === 'entity.too.large')
        status = HttpStatus.PAYLOAD_TOO_LARGE;
    }
    let error: ApiFailure['error'];
    if (exception instanceof ApiException) {
      error = exception.getResponse() as ApiFailure['error'];
    } else if (status >= 500) {
      error = {
        code: 'INTERNAL_ERROR',
        message: 'Ocorreu um erro interno. Tente novamente mais tarde.',
        details: [],
      };
      // Do not log request bodies, credentials, or raw database errors.
      this.logger.error(
        `Falha HTTP ${status}; tipo: ${exception instanceof Error ? exception.name : 'UnknownError'}`,
      );
    } else {
      const fallback = HTTP_ERRORS[status] ?? {
        code: 'REQUEST_ERROR',
        message: 'Não foi possível concluir a requisição.',
      };
      error = { ...fallback, details: [] };
    }
    response
      .status(status)
      .json({ success: false, error } satisfies ApiFailure);
  }
}
