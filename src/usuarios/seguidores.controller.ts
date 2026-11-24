import { Controller, Delete, Get, Inject, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { OptionalAuthGuard } from '../publicacoes/optional-auth.guard.js';
import { RequiredAuthGuard } from '../publicacoes/required-auth.guard.js';
import { listSeguidoresSchema, seguidorUserIdSchema } from './dto/seguidores.dto.js';
import type { ListSeguidoresDto } from './dto/seguidores.dto.js';
import { SeguidoresService } from './seguidores.service.js';

@Controller('usuarios')
export class SeguidoresController {
  constructor(@Inject(SeguidoresService) private readonly seguidores: SeguidoresService) {}

  @Put(':id/seguir')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Relação de seguimento atualizada.')
  follow(
    @Param('id', { schema: seguidorUserIdSchema }) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.seguidores.follow(request.authUserId, id);
  }

  @Delete(':id/seguir')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Relação de seguimento removida.')
  unfollow(
    @Param('id', { schema: seguidorUserIdSchema }) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.seguidores.unfollow(request.authUserId, id);
  }

  @Get(':id/seguidores')
  @UseGuards(OptionalAuthGuard)
  @ResponseMessage('Seguidores encontrados.')
  followers(
    @Param('id', { schema: seguidorUserIdSchema }) id: string,
    @Query({ schema: listSeguidoresSchema }) query: ListSeguidoresDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.seguidores.list(id, request.authUserId, 'seguidores', query);
  }

  @Get(':id/seguindo')
  @UseGuards(OptionalAuthGuard)
  @ResponseMessage('Usuários seguidos encontrados.')
  following(
    @Param('id', { schema: seguidorUserIdSchema }) id: string,
    @Query({ schema: listSeguidoresSchema }) query: ListSeguidoresDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.seguidores.list(id, request.authUserId, 'seguindo', query);
  }

  @Get('me/solicitacoes')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Solicitações encontradas.')
  requests(@Query({ schema: listSeguidoresSchema }) query: ListSeguidoresDto, @Req() request: AuthenticatedRequest) {
    return this.seguidores.requests(request.authUserId, query);
  }

  @Put('me/solicitacoes/:id/aceitar')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Solicitação aceita.')
  accept(
    @Param('id', { schema: seguidorUserIdSchema }) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.seguidores.accept(request.authUserId, id);
  }

  @Delete('me/solicitacoes/:id')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Solicitação recusada.')
  decline(
    @Param('id', { schema: seguidorUserIdSchema }) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.seguidores.decline(request.authUserId, id);
  }
}
