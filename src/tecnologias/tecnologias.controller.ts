import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { listTecnologiasSchema } from './dto/list-tecnologias.dto.js';
import type { ListTecnologiasDto } from './dto/list-tecnologias.dto.js';
import { TecnologiasService } from './tecnologias.service.js';

@Controller('tecnologias')
export class TecnologiasController {
  constructor(@Inject(TecnologiasService) private readonly tecnologias: TecnologiasService) {}

  @Get()
  @ResponseMessage('Tecnologias encontradas.')
  list(@Query({ schema: listTecnologiasSchema }) query: ListTecnologiasDto) {
    return this.tecnologias.list(query);
  }
}
