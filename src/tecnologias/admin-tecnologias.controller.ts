import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../auth/guards/roles.decorator.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { ResponseMessage } from '../common/http/response-message.decorator.js';
import { createAdminTecnologiaSchema, listAdminTecnologiasSchema,
  updateAdminTecnologiaSchema } from './dto/admin-tecnologias.dto.js';
import type { CreateAdminTecnologiaDto, ListAdminTecnologiasDto,
  UpdateAdminTecnologiaDto } from './dto/admin-tecnologias.dto.js';
import { TecnologiasService } from './tecnologias.service.js';

const tecnologiaIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

@Controller('admin/tecnologias')
@UseGuards(AdminRolesGuard)
@Roles('administrador')
export class AdminTecnologiasController {
  constructor(@Inject(TecnologiasService) private readonly tecnologias: TecnologiasService) {}

  @Get()
  @ResponseMessage('Tecnologias encontradas.')
  list(@Query({ schema: listAdminTecnologiasSchema }) query: ListAdminTecnologiasDto) {
    return this.tecnologias.adminList(query);
  }

  @Post()
  @ResponseMessage('Tecnologia cadastrada com sucesso.')
  create(@Body({ schema: createAdminTecnologiaSchema }) body: CreateAdminTecnologiaDto) {
    return this.tecnologias.create(body);
  }

  @Patch(':id')
  @ResponseMessage('Tecnologia atualizada com sucesso.')
  update(@Param('id', { schema: tecnologiaIdSchema }) id: string,
    @Body({ schema: updateAdminTecnologiaSchema }) body: UpdateAdminTecnologiaDto) {
    return this.tecnologias.update(id, body);
  }
}
