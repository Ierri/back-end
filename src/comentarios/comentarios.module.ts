import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { PublicacoesModule } from '../publicacoes/publicacoes.module.js';
import { Publicacao, PublicacaoSchema } from '../publicacoes/schemas/publicacao.schema.js';
import { Usuario, UsuarioSchema } from '../usuarios/schemas/usuario.schema.js';
import { ComentariosController } from './comentarios.controller.js';
import { ComentariosCursor } from './comentarios.cursor.js';
import { ComentariosService } from './comentarios.service.js';
import { Comentario, ComentarioSchema } from './schemas/comentario.schema.js';
import { NotificationProducerModule } from '../notificacoes/notification-producer.module.js';

@Module({
  imports: [
    AuthModule,
    PublicacoesModule,
    NotificationProducerModule,
    MongooseModule.forFeature([
      { name: Comentario.name, schema: ComentarioSchema },
      { name: Publicacao.name, schema: PublicacaoSchema },
      { name: Usuario.name, schema: UsuarioSchema },
    ]),
  ],
  controllers: [ComentariosController],
  providers: [ComentariosService, ComentariosCursor],
  exports: [ComentariosService],
})
export class ComentariosModule {}
