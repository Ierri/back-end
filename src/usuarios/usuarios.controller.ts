import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { OptionalAuthGuard } from '../publicacoes/optional-auth.guard.js';
import { RequiredAuthGuard } from '../publicacoes/required-auth.guard.js';
import { updatePerfilSchema } from './dto/perfil-update.dto.js';
import type { UpdatePerfilDto } from './dto/perfil-update.dto.js';
import { replaceStacksSchema } from './dto/stacks.dto.js';
import type { ReplaceStacksDto } from './dto/stacks.dto.js';
import { PerfilReadService } from './perfil-read.service.js';
import { PerfilUpdateService } from './perfil-update.service.js';
import { UsuariosStacksService } from './stacks.service.js';
import { CreatorStatsService } from './creator-stats.service.js';
import { rankingSchema } from './dto/ranking.dto.js';
import type { RankingDto } from './dto/ranking.dto.js';

const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9_]{1,128}$/);

@Controller('usuarios')
export class UsuariosController {
  constructor(
    @Inject(PerfilReadService) private readonly read: PerfilReadService,
    @Inject(PerfilUpdateService) private readonly update: PerfilUpdateService,
    @Inject(UsuariosStacksService) private readonly stacks: UsuariosStacksService,
    @Inject(CreatorStatsService) private readonly creatorStats: CreatorStatsService,
  ) {}

  @Get('me')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Perfil encontrado.')
  me(@Req() request: AuthenticatedRequest) {
    return this.read.findSelf(request.authUserId);
  }

  @Patch('me')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Perfil atualizado com sucesso.')
  async updateMe(
    @Body({ schema: updatePerfilSchema }) body: UpdatePerfilDto,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.update.update(request.authUserId, body);
    return this.read.findSelf(request.authUserId);
  }

  @Put('me/stacks')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Stacks atualizadas com sucesso.')
  async replaceStacks(
    @Body({ schema: replaceStacksSchema }) body: ReplaceStacksDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return { stackIds: await this.stacks.replace(request.authUserId, body.stackIds) };
  }

  @Get('ranking')
  @ResponseMessage('Ranking de criadores encontrado.')
  ranking(@Query({ schema: rankingSchema }) query: RankingDto) {
    return this.creatorStats.ranking(query);
  }

  @Get(':username')
  @UseGuards(OptionalAuthGuard)
  @ResponseMessage('Perfil encontrado.')
  publicProfile(
    @Param('username', { schema: usernameSchema }) username: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.read.findPublic(username, request.authUserId);
  }
}
