import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OptionalAuthGuard } from '../publicacoes/optional-auth.guard.js';
import { RequiredAuthGuard } from '../publicacoes/required-auth.guard.js';
import { TecnologiasController } from '../tecnologias/tecnologias.controller.js';
import { AdminTecnologiasController } from '../tecnologias/admin-tecnologias.controller.js';
import { AdminRolesGuard } from '../tecnologias/admin-roles.guard.js';
import { TecnologiasService } from '../tecnologias/tecnologias.service.js';
import { PerfilReadService } from '../usuarios/perfil-read.service.js';
import { PerfilUpdateService } from '../usuarios/perfil-update.service.js';
import { UsuariosController } from '../usuarios/usuarios.controller.js';
import { UsuariosModule } from '../usuarios/usuarios.module.js';
import { UsuariosStacksService } from '../usuarios/stacks.service.js';
import { SeguidoresController } from '../usuarios/seguidores.controller.js';
import { SeguidoresCursor } from '../usuarios/seguidores.cursor.js';
import { SeguidoresService } from '../usuarios/seguidores.service.js';

@Module({
  imports: [AuthModule, UsuariosModule],
  controllers: [UsuariosController, TecnologiasController, AdminTecnologiasController, SeguidoresController],
  providers: [
    OptionalAuthGuard,
    RequiredAuthGuard,
    AdminRolesGuard,
    PerfilReadService,
    PerfilUpdateService,
    UsuariosStacksService,
    TecnologiasService,
    SeguidoresCursor,
    SeguidoresService,
  ],
})
export class PerfisModule {}
