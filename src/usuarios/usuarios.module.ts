import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsuariosService } from './usuarios.service.js';
import { Usuario, UsuarioSchema } from './schemas/usuario.schema.js';
import { Tecnologia, TecnologiaSchema } from './schemas/tecnologia.schema.js';
import { Seguidor, SeguidorSchema } from './schemas/seguidor.schema.js';
import { Publicacao, PublicacaoSchema } from '../publicacoes/schemas/publicacao.schema.js';
import { CreatorStatsService } from './creator-stats.service.js';
import { CreatorRankingCursor } from './creator-ranking.cursor.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Usuario.name, schema: UsuarioSchema },
      { name: Tecnologia.name, schema: TecnologiaSchema },
      { name: Seguidor.name, schema: SeguidorSchema },
      { name: Publicacao.name, schema: PublicacaoSchema },
    ]),
  ],
  providers: [UsuariosService, CreatorStatsService, CreatorRankingCursor],
  exports: [UsuariosService, CreatorStatsService, CreatorRankingCursor, MongooseModule],
})
export class UsuariosModule {}
