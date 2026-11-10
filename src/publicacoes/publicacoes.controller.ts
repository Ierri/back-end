import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import {
  createPublicacaoSchema,
  listPublicacoesSchema,
  publicacaoIdSchema,
  updatePublicacaoSchema,
} from './dto/publicacoes.dto.js';
import type {
  CreatePublicacaoDto,
  ListPublicacoesDto,
  UpdatePublicacaoDto,
} from './dto/publicacoes.dto.js';
import { OptionalAuthGuard } from './optional-auth.guard.js';
import { PublicacoesService } from './publicacoes.service.js';

@Controller('publicacoes')
export class PublicacoesController {
  constructor(
    @Inject(PublicacoesService)
    private readonly publicacoes: PublicacoesService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ResponseMessage('Publicação criada com sucesso.')
  create(
    @Body({ schema: createPublicacaoSchema }) body: CreatePublicacaoDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.publicacoes.create(request.authUserId, body);
  }

  @Get()
  @UseGuards(OptionalAuthGuard)
  @ResponseMessage('Publicações encontradas.')
  list(
    @Query({ schema: listPublicacoesSchema }) query: ListPublicacoesDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.publicacoes.list(query, request.authUserId);
  }

  @Get(':id')
  @UseGuards(OptionalAuthGuard)
  @ResponseMessage('Publicação encontrada.')
  findById(
    @Param('id', { schema: publicacaoIdSchema }) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.publicacoes.findById(id, request.authUserId);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ResponseMessage('Publicação atualizada com sucesso.')
  update(
    @Param('id', { schema: publicacaoIdSchema }) id: string,
    @Body({ schema: updatePublicacaoSchema }) body: UpdatePublicacaoDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.publicacoes.update(id, request.authUserId, body);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ResponseMessage('Publicação excluída com sucesso.')
  remove(
    @Param('id', { schema: publicacaoIdSchema }) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.publicacoes.remove(id, request.authUserId);
  }
}
