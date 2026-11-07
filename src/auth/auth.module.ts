import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { UsuariosModule } from '../usuarios/usuarios.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { Sessao, SessaoSchema } from './schemas/sessao.schema.js';
import { SessoesService } from './sessoes.service.js';

@Module({
  imports: [
    UsuariosModule,
    MongooseModule.forFeature([{ name: Sessao.name, schema: SessaoSchema }]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.getOrThrow<string>('JWT_SECRET');
        if (Buffer.byteLength(secret) < 32) {
          throw new Error('JWT_SECRET deve conter pelo menos 32 bytes.');
        }
        return {
          secret,
          signOptions: {
            algorithm: 'HS256',
            expiresIn: '15m',
            issuer: 'ierri-api',
            audience: 'ierri-api',
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, SessoesService],
  exports: [JwtAuthGuard],
})
export class AuthModule {}
