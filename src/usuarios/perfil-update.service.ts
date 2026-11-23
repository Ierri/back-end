import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import type { UpdatePerfilDto } from './dto/perfil-update.dto.js';
import { Usuario } from './schemas/usuario.schema.js';
import type { UsuarioDocument } from './schemas/usuario.schema.js';

@Injectable()
export class PerfilUpdateService {
  constructor(@InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>) {}

  async update(userId: string, dto: UpdatePerfilDto): Promise<UsuarioDocument> {
    const changes: Record<string, string | null> = {};
    if (dto.nome !== undefined) changes.nome = dto.nome;
    if (dto.username !== undefined) changes.username = dto.username;
    if (dto.biografia !== undefined) changes.biografia = dto.biografia;
    if (dto.avatarUrl !== undefined) changes.avatar_url = dto.avatarUrl;
    if (dto.visibilidadePerfil !== undefined) changes.visibilidade_perfil = dto.visibilidadePerfil;

    try {
      const updated = await this.usuarios
        .findOneAndUpdate(
          { _id: userId },
          { $set: changes },
          { new: true, runValidators: true },
        )
        .exec();
      if (!updated) throw new ApiException('USER_NOT_FOUND');
      return updated;
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 11000
      ) {
        const keys =
          'keyPattern' in error ? error.keyPattern : 'keyValue' in error ? error.keyValue : null;
        if (typeof keys === 'object' && keys !== null && 'username' in keys) {
          throw new ApiException('USERNAME_ALREADY_EXISTS');
        }
        throw new ApiException('USER_ALREADY_EXISTS');
      }
      throw error;
    }
  }
}
