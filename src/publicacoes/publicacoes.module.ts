import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { Usuario, UsuarioSchema } from '../usuarios/schemas/usuario.schema.js';
import { MEDIA_VERIFIER, UnavailableMediaVerifier } from './media-verifier.js';
import { OptionalAuthGuard } from './optional-auth.guard.js';
import { PublicacoesController } from './publicacoes.controller.js';
import { PublicacoesCursor } from './publicacoes.cursor.js';
import { PublicacoesService } from './publicacoes.service.js';
import { RequiredAuthGuard } from './required-auth.guard.js';
import { Publicacao, PublicacaoSchema } from './schemas/publicacao.schema.js';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: Publicacao.name, schema: PublicacaoSchema },
      { name: Usuario.name, schema: UsuarioSchema },
    ]),
  ],
  controllers: [PublicacoesController],
  providers: [
    PublicacoesService,
    PublicacoesCursor,
    OptionalAuthGuard,
    RequiredAuthGuard,
    { provide: MEDIA_VERIFIER, useClass: UnavailableMediaVerifier },
  ],
})
export class PublicacoesModule {}
