import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { PublicacoesModule } from '../publicacoes/publicacoes.module.js';
import { Notificacao, NotificacaoSchema } from './schemas/notificacao.schema.js';
import { NotificationProducerModule } from './notification-producer.module.js';
import { NotificacoesAuthGuard } from './notificacoes-auth.guard.js';
import { NotificacoesController } from './notificacoes.controller.js';
import { NotificacoesCursor } from './notificacoes.cursor.js';
import { NotificacoesService } from './notificacoes.service.js';

@Module({
  imports: [AuthModule, PublicacoesModule, NotificationProducerModule,
    MongooseModule.forFeature([{ name: Notificacao.name, schema: NotificacaoSchema }])],
  controllers: [NotificacoesController],
  providers: [NotificacoesAuthGuard, NotificacoesCursor, NotificacoesService],
})
export class NotificacoesModule {}
