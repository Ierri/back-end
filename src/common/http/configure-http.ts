import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

export function configureHttp(app: INestApplication) {
  const origins = (process.env.FRONTEND_URL ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim());
  app.enableCors({ origin: origins, credentials: true });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      ((req.headers.origin && !origins.includes(req.headers.origin)) ||
        req.headers['sec-fetch-site'] === 'cross-site')
    ) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Acesso não permitido.',
          details: [],
        },
      });
      return;
    }
    next();
  });
}
