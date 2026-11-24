import { Controller, Get, Inject, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { listNotificacoesSchema } from './dto/notificacoes.dto.js';
import type { ListNotificacoesDto } from './dto/notificacoes.dto.js';
import { NotificacoesAuthGuard } from './notificacoes-auth.guard.js';
import { NotificacoesService } from './notificacoes.service.js';

const notificationIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

@Controller('notificacoes')
@UseGuards(NotificacoesAuthGuard)
export class NotificacoesController {
  constructor(@Inject(NotificacoesService) private readonly notifications: NotificacoesService) {}

  @Get()
  @ResponseMessage('Notificações encontradas.')
  list(@Query({ schema: listNotificacoesSchema }) query: ListNotificacoesDto,
    @Req() request: AuthenticatedRequest) {
    return this.notifications.list(request.authUserId, query);
  }

  @Get('nao-lidas')
  @ResponseMessage('Total de notificações não lidas encontrado.')
  unreadCount(@Req() request: AuthenticatedRequest) {
    return this.notifications.unreadCount(request.authUserId);
  }

  @Patch('ler-todas')
  @ResponseMessage('Notificações marcadas como lidas.')
  markAllRead(@Req() request: AuthenticatedRequest) {
    return this.notifications.markAllRead(request.authUserId);
  }

  @Patch(':id/lida')
  @ResponseMessage('Notificação marcada como lida.')
  markRead(@Param('id', { schema: notificationIdSchema }) id: string,
    @Req() request: AuthenticatedRequest) {
    return this.notifications.markRead(request.authUserId, id);
  }
}
