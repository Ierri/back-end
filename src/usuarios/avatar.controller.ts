import { pipeline } from 'node:stream/promises';
import { Controller, Delete, Get, Inject, Param, Put, Req, Res, UploadedFile,
  UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { RequiredAuthGuard } from '../publicacoes/required-auth.guard.js';
import { AvatarService, MAX_AVATAR_SIZE_BYTES } from './avatar.service.js';
import type { UploadedAvatarFile } from './avatar.service.js';

const idSchema = z.string().regex(/^[a-f\d]{24}$/i);
const referenceSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);

@Controller('usuarios')
export class AvatarController {
  constructor(@Inject(AvatarService) private readonly avatars: AvatarService) {}

  @Put('me/avatar')
  @UseGuards(RequiredAuthGuard)
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: MAX_AVATAR_SIZE_BYTES, files: 1, fields: 0, parts: 1 },
  }))
  @ResponseMessage('Avatar atualizado.')
  upload(@UploadedFile() file: UploadedAvatarFile | undefined,
    @Req() request: AuthenticatedRequest) {
    return this.avatars.upload(request.authUserId, file);
  }

  @Delete('me/avatar')
  @UseGuards(RequiredAuthGuard)
  @ResponseMessage('Avatar removido.')
  remove(@Req() request: AuthenticatedRequest) {
    return this.avatars.remove(request.authUserId);
  }

  @Get(':id/avatar/:referencia')
  async read(@Param('id', { schema: idSchema }) id: string,
    @Param('referencia', { schema: referenceSchema }) reference: string,
    @Res() response: Response) {
    const avatar = await this.avatars.open(id, reference);
    response.setHeader('Content-Type', avatar.mimeType);
    response.setHeader('Content-Length', avatar.size);
    response.setHeader('Content-Disposition', 'inline');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await pipeline(avatar.body, response);
    } catch {
      response.destroy();
    }
  }
}
