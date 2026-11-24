import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Comentario, ComentarioSchema } from '../comentarios/schemas/comentario.schema.js';
import { Publicacao, PublicacaoSchema } from '../publicacoes/schemas/publicacao.schema.js';
import { Voto, VotoSchema } from '../publicacoes/schemas/voto.schema.js';
import { Seguidor, SeguidorSchema } from '../usuarios/schemas/seguidor.schema.js';
import { Notificacao, NotificacaoSchema } from './schemas/notificacao.schema.js';
import { NotificationProducerService } from './notification-producer.service.js';

@Module({
  imports: [MongooseModule.forFeature([
    { name: Notificacao.name, schema: NotificacaoSchema },
    { name: Seguidor.name, schema: SeguidorSchema },
    { name: Comentario.name, schema: ComentarioSchema },
    { name: Voto.name, schema: VotoSchema },
    { name: Publicacao.name, schema: PublicacaoSchema },
  ])],
  providers: [NotificationProducerService],
  exports: [NotificationProducerService, MongooseModule],
})
export class NotificationProducerModule {}
