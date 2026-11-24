import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { UsuariosModule } from '../usuarios/usuarios.module.js';
import { Usuario, UsuarioSchema } from '../usuarios/schemas/usuario.schema.js';
import { Seguidor, SeguidorSchema } from '../usuarios/schemas/seguidor.schema.js';
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
import { PublicacaoAccessService } from './publicacao-access.service.js';
import { RequiredAuthGuard } from './required-auth.guard.js';
import { Publicacao, PublicacaoSchema } from './schemas/publicacao.schema.js';
import {
  UploadMedia,
  UploadMediaSchema,
} from './schemas/upload-media.schema.js';
import { VideoProbeService } from './video-probe.service.js';
import { Voto, VotoSchema } from './schemas/voto.schema.js';
import { VotosController } from './votos.controller.js';
import { VotosService } from './votos.service.js';
import { PublicacaoSalva, PublicacaoSalvaSchema } from './schemas/publicacao-salva.schema.js';
import { SalvosController } from './salvos.controller.js';
import { SalvosCursor } from './salvos.cursor.js';
import { SalvosService } from './salvos.service.js';
import { NotificationProducerModule } from '../notificacoes/notification-producer.module.js';

@Module({
  imports: [
    AuthModule,
    UsuariosModule,
    NotificationProducerModule,
    MongooseModule.forFeature([
      { name: Publicacao.name, schema: PublicacaoSchema },
      { name: Usuario.name, schema: UsuarioSchema },
      { name: Seguidor.name, schema: SeguidorSchema },
      { name: UploadMedia.name, schema: UploadMediaSchema },
      { name: Voto.name, schema: VotoSchema },
      { name: PublicacaoSalva.name, schema: PublicacaoSalvaSchema },
    ]),
  ],
  controllers: [PublicacoesController, MediaController, VotosController, SalvosController],
  providers: [
    PublicacoesService,
    PublicacaoAccessService,
    PublicacoesCacheClient,
    PublicacoesCacheService,
    PublicacoesCursor,
    OptionalAuthGuard,
    RequiredAuthGuard,
    VotosService,
    SalvosService,
    SalvosCursor,
    MediaStorageService,
    VideoProbeService,
    MediaInspectionService,
    MediaUploadService,
    MediaAccessService,
    MediaCleanupService,
    { provide: MEDIA_VERIFIER, useClass: MongoMediaVerifierService },
  ],
  exports: [OptionalAuthGuard, RequiredAuthGuard, PublicacoesCacheService, PublicacaoAccessService],
})
export class PublicacoesModule {}
