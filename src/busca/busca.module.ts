import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PublicacoesModule } from '../publicacoes/publicacoes.module.js';
import { UsuariosModule } from '../usuarios/usuarios.module.js';
import { BuscaController } from './busca.controller.js';
import { BuscaCursor } from './busca.cursor.js';
import { BuscaService } from './busca.service.js';

@Module({
  imports: [AuthModule, UsuariosModule, PublicacoesModule],
  controllers: [BuscaController],
  providers: [BuscaService, BuscaCursor],
})
export class BuscaModule {}
