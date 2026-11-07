import { NestFactory } from '@nestjs/core';
import { configureHttp } from './common/http/configure-http.js';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  configureHttp(app);
  await app.listen(process.env.PORT ?? 3001);
}
await bootstrap();
