import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { Usuario, UsuarioSchema } from '../usuarios/schemas/usuario.schema.js';
import { MEDIA_VERIFIER } from './media-verifier.js';
import { PublicacoesCacheClient } from './publicacoes-cache.client.js';
import { PublicacoesCacheService } from './publicacoes-cache.service.js';
import { MediaAccessService } from './media-access.service.js';
import { MediaCleanupService } from './media-cleanup.service.js';
import { MediaController } from './media.controller.js';
import { MediaInspectionService } from './media-inspection.service.js';
import { MediaStorageService } from './media-storage.service.js';
import { MediaUploadService } from './media-upload.service.js';
import { MongoMediaVerifierService } from './mongo-media-verifier.service.js';
import { OptionalAuthGuard } from './optional-auth.guard.js';
import { PublicacoesController } from './publicacoes.controller.js';
import { PublicacoesCursor } from './publicacoes.cursor.js';
import { PublicacoesService } from './publicacoes.service.js';
import { RequiredAuthGuard } from './required-auth.guard.js';
import { Publicacao, PublicacaoSchema } from './schemas/publicacao.schema.js';
import {
  UploadMedia,
  UploadMediaSchema,
} from './schemas/upload-media.schema.js';
import { VideoProbeService } from './video-probe.service.js';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: Publicacao.name, schema: PublicacaoSchema },
      { name: Usuario.name, schema: UsuarioSchema },
      { name: UploadMedia.name, schema: UploadMediaSchema },
    ]),
  ],
  controllers: [PublicacoesController, MediaController],
  providers: [
    PublicacoesService,
    PublicacoesCacheClient,
    PublicacoesCacheService,
    PublicacoesCursor,
    OptionalAuthGuard,
    RequiredAuthGuard,
    MediaStorageService,
    VideoProbeService,
    MediaInspectionService,
    MediaUploadService,
    MediaAccessService,
    MediaCleanupService,
    { provide: MEDIA_VERIFIER, useClass: MongoMediaVerifierService },
  ],
})
export class PublicacoesModule {}
