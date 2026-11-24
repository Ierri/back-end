import { Body, Controller, Get, Inject, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { Roles } from '../auth/guards/roles.decorator.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { DenunciasService } from './denuncias.service.js';
import { adminDenunciasSchema, commentModerationSchema, historyQuerySchema, mongoId,
  publicationModerationSchema, resolveDenunciaSchema, userModerationSchema } from './dto/moderacao.dto.js';
import type { AdminDenunciasDto, CommentModerationDto, HistoryQueryDto,
  PublicationModerationDto, ResolveDenunciaDto, UserModerationDto } from './dto/moderacao.dto.js';
import { ModeracaoRolesGuard } from './moderacao-roles.guard.js';
import { ModeracaoService } from './moderacao.service.js';

@Controller('admin')
@UseGuards(ModeracaoRolesGuard)
@Roles('moderador', 'administrador')
export class AdminModeracaoController {
  constructor(
    @Inject(DenunciasService) private readonly reports: DenunciasService,
    @Inject(ModeracaoService) private readonly moderation: ModeracaoService,
  ) {}

  @Get('denuncias')
  @ResponseMessage('Denúncias encontradas.')
  list(@Query({ schema: adminDenunciasSchema }) query: AdminDenunciasDto) {
    return this.reports.adminList(query);
  }

  @Get('denuncias/:id')
  @ResponseMessage('Denúncia encontrada.')
  detail(@Param('id', { schema: mongoId }) id: string) {
    return this.reports.detail(id);
  }

  @Patch('denuncias/:id')
  @ResponseMessage('Denúncia analisada.')
  async resolve(@Param('id', { schema: mongoId }) id: string, @Req() request: AuthenticatedRequest,
    @Body({ schema: resolveDenunciaSchema }) body: ResolveDenunciaDto) {
    const result = await this.reports.resolve(id, request.authUserId, body);
    await this.moderation.flushReport(id).catch(() => undefined);
    return result;
  }

  @Patch('publicacoes/:id/status')
  @ResponseMessage('Publicação moderada.')
  post(@Param('id', { schema: mongoId }) id: string, @Req() request: AuthenticatedRequest,
    @Body({ schema: publicationModerationSchema }) body: PublicationModerationDto) {
    return this.moderation.moderatePost(id, request.authUserId, body);
  }

  @Patch('comentarios/:id/status')
  @ResponseMessage('Comentário moderado.')
  comment(@Param('id', { schema: mongoId }) id: string, @Req() request: AuthenticatedRequest,
    @Body({ schema: commentModerationSchema }) body: CommentModerationDto) {
    return this.moderation.moderateComment(id, request.authUserId, body);
  }

  @Patch('usuarios/:id/status')
  @ResponseMessage('Usuário moderado.')
  user(@Param('id', { schema: mongoId }) id: string, @Req() request: AuthenticatedRequest,
    @Body({ schema: userModerationSchema }) body: UserModerationDto) {
    return this.moderation.moderateUser(id, request.authUserId, body);
  }

  @Get('moderacao/historico')
  @ResponseMessage('Histórico encontrado.')
  history(@Query({ schema: historyQuerySchema }) query: HistoryQueryDto) {
    return this.moderation.historyList(query);
  }
}
