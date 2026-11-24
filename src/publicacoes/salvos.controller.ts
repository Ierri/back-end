import { Controller, Delete, Get, Inject, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { listSalvosSchema } from './dto/salvos.dto.js';
import type { ListSalvosDto } from './dto/salvos.dto.js';
import { publicacaoIdSchema } from './dto/publicacoes.dto.js';
import { RequiredAuthGuard } from './required-auth.guard.js';
import { SalvosService } from './salvos.service.js';

@Controller()
export class SalvosController {
  constructor(@Inject(SalvosService) private readonly salvos: SalvosService) {}

  @Put('publicacoes/:id/salvar')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Publicação salva com sucesso.')
  put(@Param('id', { schema: publicacaoIdSchema }) id: string, @Req() request: AuthenticatedRequest) {
    return this.salvos.put(id, request.authUserId);
  }

  @Delete('publicacoes/:id/salvar')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Publicação removida dos salvos.')
  remove(@Param('id', { schema: publicacaoIdSchema }) id: string, @Req() request: AuthenticatedRequest) {
    return this.salvos.remove(id, request.authUserId);
  }

  @Get('publicacoes/:id/salvar')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Estado do salvamento encontrado.')
  get(@Param('id', { schema: publicacaoIdSchema }) id: string, @Req() request: AuthenticatedRequest) {
    return this.salvos.get(id, request.authUserId);
  }

  @Get('usuarios/me/publicacoes-salvas')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Publicações salvas encontradas.')
  list(@Query({ schema: listSalvosSchema }) query: ListSalvosDto, @Req() request: AuthenticatedRequest) {
    return this.salvos.list(request.authUserId, query);
  }
}
