import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { UsuariosModule } from './usuarios/usuarios.module.js';
import { ApiHttpModule } from './common/http/api-http.module.js';
import { PublicacoesModule } from './publicacoes/publicacoes.module.js';

@Module({
  imports: [
    ApiHttpModule,
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const uri = config.getOrThrow<string>('MONGODB_URI').trim();

        if (!uri) {
          throw new Error('Defina MONGODB_URI no arquivo .env ou no ambiente.');
        }

        return { uri };
      },
    }),
    UsuariosModule,
    AuthModule,
    PublicacoesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
