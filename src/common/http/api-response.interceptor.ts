import { Inject, Injectable } from '@nestjs/common';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';
import type { ApiSuccess } from './api-response.js';
import { ResponseMessage } from './response-message.decorator.js';

@Injectable()
export class ApiResponseInterceptor implements NestInterceptor<
  unknown,
  ApiSuccess<unknown>
> {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiSuccess<unknown>> {
    const message =
      this.reflector.getAllAndOverride(ResponseMessage, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'Operação realizada com sucesso.';
    return next
      .handle()
      .pipe(
        map((data: unknown) => ({
          success: true as const,
          message,
          data: data ?? null,
        })),
      );
  }
}
