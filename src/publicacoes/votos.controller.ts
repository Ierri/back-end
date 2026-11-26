import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Optional,
  Param,
  Put,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { publicacaoIdSchema } from './dto/publicacoes.dto.js';
import { putVotoSchema, streamVotosQuerySchema } from './dto/votos.dto.js';
import type { PutVotoDto, StreamVotosQueryDto } from './dto/votos.dto.js';
import { OptionalAuthGuard } from './optional-auth.guard.js';
import { RequiredAuthGuard } from './required-auth.guard.js';
import { VotosStreamService } from './votos-stream.service.js';
import { VotosService } from './votos.service.js';

@Controller()
export class VotosController {
  constructor(
    @Inject(VotosService) private readonly votos: VotosService,
    @Optional()
    @Inject(VotosStreamService)
    private readonly votosStream?: VotosStreamService,
  ) {}

  @Sse('publicacoes/votos/stream', { maxPendingDataLength: 65_536 })
  @UseGuards(OptionalAuthGuard)
  @Header('X-Accel-Buffering', 'no')
  @Header('Cache-Control', 'no-cache, no-transform')
  stream(
    @Query({ schema: streamVotosQuerySchema }) query: StreamVotosQueryDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<Observable<MessageEvent>> {
    return this.votosStream!.openStream(
      query.ids,
      request.authUserId,
      request.ip ?? request.socket?.remoteAddress ?? 'unknown',
    );
  }

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
