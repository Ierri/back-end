import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { ComentariosModule } from '../comentarios/comentarios.module.js';
import { NotificacoesModule } from '../notificacoes/notificacoes.module.js';
import { PublicacoesModule } from '../publicacoes/publicacoes.module.js';
import { UsuariosModule } from '../usuarios/usuarios.module.js';
import { Comentario, ComentarioSchema } from '../comentarios/schemas/comentario.schema.js';
import { Publicacao, PublicacaoSchema } from '../publicacoes/schemas/publicacao.schema.js';
import { Usuario, UsuarioSchema } from '../usuarios/schemas/usuario.schema.js';
import { AdminModeracaoController } from './admin-moderacao.controller.js';
import { DenunciasController } from './denuncias.controller.js';
import { DenunciasService } from './denuncias.service.js';
import { ModeracaoCursor } from './moderacao.cursor.js';
import { ModeracaoRolesGuard } from './moderacao-roles.guard.js';
import { ModeracaoService } from './moderacao.service.js';
import { Denuncia, DenunciaSchema } from './schemas/denuncia.schema.js';
import { ModeracaoHistorico, ModeracaoHistoricoSchema } from './schemas/moderacao-historico.schema.js';

@Module({
  imports: [AuthModule, UsuariosModule, PublicacoesModule, ComentariosModule, NotificacoesModule,
    MongooseModule.forFeature([
      { name: Denuncia.name, schema: DenunciaSchema },
      { name: ModeracaoHistorico.name, schema: ModeracaoHistoricoSchema },
      { name: Usuario.name, schema: UsuarioSchema },
      { name: Publicacao.name, schema: PublicacaoSchema },
      { name: Comentario.name, schema: ComentarioSchema },
    ])],
  controllers: [DenunciasController, AdminModeracaoController],
  providers: [DenunciasService, ModeracaoService, ModeracaoCursor, ModeracaoRolesGuard],
})
export class ModeracaoModule {}
