import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OptionalAuthGuard } from '../publicacoes/optional-auth.guard.js';
import { RequiredAuthGuard } from '../publicacoes/required-auth.guard.js';
import { TecnologiasController } from '../tecnologias/tecnologias.controller.js';
import { TecnologiasService } from '../tecnologias/tecnologias.service.js';
import { PerfilReadService } from '../usuarios/perfil-read.service.js';
import { PerfilUpdateService } from '../usuarios/perfil-update.service.js';
import { UsuariosController } from '../usuarios/usuarios.controller.js';
import { UsuariosModule } from '../usuarios/usuarios.module.js';
import { UsuariosStacksService } from '../usuarios/stacks.service.js';

@Module({
  imports: [AuthModule, UsuariosModule],
  controllers: [UsuariosController, TecnologiasController],
  providers: [
    OptionalAuthGuard,
    RequiredAuthGuard,
    PerfilReadService,
    PerfilUpdateService,
    UsuariosStacksService,
    TecnologiasService,
  ],
})
export class PerfisModule {}
