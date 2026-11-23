import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { publicacaoIdSchema } from './dto/publicacoes.dto.js';
import { putVotoSchema } from './dto/votos.dto.js';
import type { PutVotoDto } from './dto/votos.dto.js';
import { RequiredAuthGuard } from './required-auth.guard.js';
import { VotosService } from './votos.service.js';

@Controller()
export class VotosController {
  constructor(@Inject(VotosService) private readonly votos: VotosService) {}

  @Put('publicacoes/:id/voto')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Voto registrado com sucesso.')
  put(
    @Param('id', { schema: publicacaoIdSchema }) publicationId: string,
    @Body({ schema: putVotoSchema }) body: PutVotoDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.votos.put(publicationId, request.authUserId, body.valor);
  }

  @Delete('publicacoes/:id/voto')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Voto removido com sucesso.')
  remove(
    @Param('id', { schema: publicacaoIdSchema }) publicationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.votos.remove(publicationId, request.authUserId);
  }

  @Get('publicacoes/:id/voto')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Voto encontrado.')
  get(
    @Param('id', { schema: publicacaoIdSchema }) publicationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.votos.get(publicationId, request.authUserId);
  }
}
