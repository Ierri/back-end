import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PublicacoesModule } from '../publicacoes/publicacoes.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AvatarController } from './avatar.controller.js';
import { AvatarService } from './avatar.service.js';
import { AvatarArquivo, AvatarArquivoSchema } from './schemas/avatar-arquivo.schema.js';
import { Usuario, UsuarioSchema } from './schemas/usuario.schema.js';

@Module({
  imports: [AuthModule, PublicacoesModule, MongooseModule.forFeature([
    { name: AvatarArquivo.name, schema: AvatarArquivoSchema },
    { name: Usuario.name, schema: UsuarioSchema },
  ])],
  controllers: [AvatarController],
  providers: [AvatarService],
  exports: [AvatarService],
})
export class AvatarModule {}
