import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsuariosService } from './usuarios.service.js';
import { Usuario, UsuarioSchema } from './schemas/usuario.schema.js';
import { Tecnologia, TecnologiaSchema } from './schemas/tecnologia.schema.js';
import { Seguidor, SeguidorSchema } from './schemas/seguidor.schema.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Usuario.name, schema: UsuarioSchema },
      { name: Tecnologia.name, schema: TecnologiaSchema },
      { name: Seguidor.name, schema: SeguidorSchema },
    ]),
  ],
  providers: [UsuariosService],
  exports: [UsuariosService, MongooseModule],
})
export class UsuariosModule {}
