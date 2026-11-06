import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { ApiResponseInterceptor } from './api-response.interceptor.js';
import { ApiException } from './api.exception.js';

@Module({
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    {
      provide: APP_PIPE,
      useFactory: () =>
        new StandardSchemaValidationPipe({
          transform: true,
          exceptionFactory: (issues) =>
            new ApiException(
              'VALIDATION_ERROR',
              issues.map((issue) => ({
                field:
                  issue.path
                    ?.map((segment) =>
                      typeof segment === 'object'
                        ? String(segment.key)
                        : String(segment),
                    )
                    .join('.') ?? '',
                message: issue.message,
              })),
            ),
        }),
    },
  ],
})
export class ApiHttpModule {}
