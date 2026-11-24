import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { NotificacoesAuthGuard } from '../notificacoes/notificacoes-auth.guard.js';
import { DenunciasService } from './denuncias.service.js';
import { createDenunciaSchema, minhasDenunciasSchema } from './dto/moderacao.dto.js';
import type { CreateDenunciaDto, MinhasDenunciasDto } from './dto/moderacao.dto.js';

@Controller('denuncias')
@UseGuards(NotificacoesAuthGuard)
export class DenunciasController {
  constructor(@Inject(DenunciasService) private readonly reports: DenunciasService) {}

  @Post()
  @ResponseMessage('Denúncia registrada.')
  create(@Req() request: AuthenticatedRequest,
    @Body({ schema: createDenunciaSchema }) body: CreateDenunciaDto) {
    return this.reports.create(request.authUserId, body);
  }

  @Get('minhas')
  @ResponseMessage('Denúncias encontradas.')
  mine(@Req() request: AuthenticatedRequest,
    @Query({ schema: minhasDenunciasSchema }) query: MinhasDenunciasDto) {
    return this.reports.mine(request.authUserId, query);
  }
}
