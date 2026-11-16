import { pipeline } from 'node:stream/promises';
import {
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { mediaReferenceSchema } from './dto/publicacoes.dto.js';
import {
  MediaAccessService,
  UnsatisfiableMediaRange,
} from './media-access.service.js';
import { MediaUploadService } from './media-upload.service.js';
import type { UploadedMediaFile } from './media-upload.service.js';
import { MAX_MEDIA_SIZE_BYTES } from './media-verifier.js';
import { OptionalAuthGuard } from './optional-auth.guard.js';
import { RequiredAuthGuard } from './required-auth.guard.js';

@Controller('publicacoes/midias')
export class MediaController {
  constructor(
    @Inject(MediaUploadService)
    private readonly uploadService: MediaUploadService,
    @Inject(MediaAccessService) private readonly access: MediaAccessService,
  ) {}

  @Post()
  @UseGuards(RequiredAuthGuard)
  @UseInterceptors(
    FileInterceptor('arquivo', {
      limits: { fileSize: MAX_MEDIA_SIZE_BYTES, files: 1, fields: 0, parts: 1 },
    }),
  )
  @ResponseMessage('Mídia recebida e validada.')
  upload(
    @UploadedFile() file: UploadedMediaFile | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.uploadService.upload(request.authUserId, file);
  }

  @Get(':referencia')
  @UseGuards(OptionalAuthGuard)
  async read(
    @Param('referencia', { schema: mediaReferenceSchema }) reference: string,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    let media: Awaited<ReturnType<MediaAccessService['open']>>;
    try {
      media = await this.access.open(
        reference,
        request.authUserId,
        request.headers.range,
      );
    } catch (error) {
      if (error instanceof UnsatisfiableMediaRange) {
        response.setHeader('Accept-Ranges', 'bytes');
        response.setHeader('Content-Range', `bytes */${error.size}`);
        response.status(416).end();
        return;
      }
      throw error;
    }
    response.setHeader('Content-Type', media.mimeType);
    response.setHeader('Content-Length', media.length);
    if (media.isVideo) response.setHeader('Accept-Ranges', 'bytes');
    if (media.range) {
      response.status(206);
      response.setHeader(
        'Content-Range',
        `bytes ${media.range.start}-${media.range.end}/${media.size}`,
      );
    }
    response.setHeader('Content-Disposition', 'inline');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await pipeline(media.body, response);
    } catch {
      response.destroy();
    }
  }
}
