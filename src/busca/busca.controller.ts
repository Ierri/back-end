import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { OptionalAuthGuard } from '../publicacoes/optional-auth.guard.js';
import { BuscaService } from './busca.service.js';
import {
  buscaGeralSchema,
  buscaPublicacoesSchema,
  buscaUsuariosSchema,
} from './dto/busca.dto.js';
import type {
  BuscaGeralDto,
  BuscaPublicacoesDto,
  BuscaUsuariosDto,
} from './dto/busca.dto.js';

@Controller('busca')
@UseGuards(OptionalAuthGuard)
export class BuscaController {
  constructor(@Inject(BuscaService) private readonly busca: BuscaService) {}

  @Get()
  @ResponseMessage('Resultados da pesquisa encontrados.')
  searchAll(
    @Query({ schema: buscaGeralSchema }) query: BuscaGeralDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.busca.searchAll(query, request.authUserId);
  }

  @Get('usuarios')
  @ResponseMessage('Perfis encontrados.')
  searchUsers(
    @Query({ schema: buscaUsuariosSchema }) query: BuscaUsuariosDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.busca.searchUsers(query, request.authUserId);
  }

  @Get('publicacoes')
  @ResponseMessage('Publicações encontradas.')
  searchPublications(
    @Query({ schema: buscaPublicacoesSchema }) query: BuscaPublicacoesDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.busca.searchPublications(query, request.authUserId);
  }
}
