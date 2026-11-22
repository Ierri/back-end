import { Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { OptionalAuthGuard } from '../publicacoes/optional-auth.guard.js';
import { RequiredAuthGuard } from '../publicacoes/required-auth.guard.js';
import { ComentariosService } from './comentarios.service.js';
import { comentarioIdSchema, createComentarioSchema, listComentariosSchema, updateComentarioSchema } from './dto/comentarios.dto.js';
import type { CreateComentarioDto, ListComentariosDto, UpdateComentarioDto } from './dto/comentarios.dto.js';

@Controller()
export class ComentariosController {
  constructor(@Inject(ComentariosService) private readonly comentarios: ComentariosService) {}

  @Post('publicacoes/:publicacaoId/comentarios')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Comentário criado com sucesso.')
  create(
    @Param('publicacaoId', { schema: comentarioIdSchema }) publicationId: string,
    @Body({ schema: createComentarioSchema }) body: CreateComentarioDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.comentarios.create(publicationId, request.authUserId, body, idempotencyKey);
  }

  @Get('publicacoes/:publicacaoId/comentarios')
  @UseGuards(OptionalAuthGuard)
  @ResponseMessage('Comentários encontrados.')
  list(
    @Param('publicacaoId', { schema: comentarioIdSchema }) publicationId: string,
    @Query({ schema: listComentariosSchema }) query: ListComentariosDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.comentarios.list(publicationId, query, request.authUserId);
  }

  @Get('comentarios/:comentarioId/respostas')
  @UseGuards(OptionalAuthGuard)
  @ResponseMessage('Respostas encontradas.')
  replies(
    @Param('comentarioId', { schema: comentarioIdSchema }) commentId: string,
    @Query({ schema: listComentariosSchema }) query: ListComentariosDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.comentarios.replies(commentId, query, request.authUserId);
  }

  @Patch('comentarios/:comentarioId')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Comentário atualizado com sucesso.')
  update(
    @Param('comentarioId', { schema: comentarioIdSchema }) commentId: string,
    @Body({ schema: updateComentarioSchema }) body: UpdateComentarioDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.comentarios.update(commentId, request.authUserId, body);
  }

  @Delete('comentarios/:comentarioId')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Comentário excluído com sucesso.')
  remove(
    @Param('comentarioId', { schema: comentarioIdSchema }) commentId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.comentarios.remove(commentId, request.authUserId);
  }
}
