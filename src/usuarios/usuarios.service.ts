import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Usuario } from './schemas/usuario.schema.js';
import { ApiException } from '../common/http/api.exception.js';

@Injectable()
export class UsuariosService {
  constructor(
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
  ) {}

  findByEmail(email: string) {
    return this.usuarios.findOne({ email }).exec();
  }

  findCredentials(email: string) {
    return this.usuarios.findOne({ email }).select('+senha_hash').exec();
  }

  findById(id: string) {
    return this.usuarios.findById(id).exec();
  }

  async create(data: Pick<Usuario, 'nome' | 'email' | 'senha_hash'>) {
    const base =
      data.nome
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'usuario';

    for (let suffix = 0; ; suffix++) {
      const username = suffix === 0 ? base : `${base}${suffix}`;
      try {
        return await this.usuarios.create({ ...data, username });
      } catch (error: unknown) {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== 11000
        ) {
          throw error;
        }
        const keys =
          'keyPattern' in error
            ? error.keyPattern
            : 'keyValue' in error
              ? error.keyValue
              : undefined;
        if (typeof keys === 'object' && keys !== null) {
          if ('email' in keys) throw new ApiException('EMAIL_ALREADY_EXISTS');
          // The unique index arbitrates simultaneous registrations as well.
          if ('username' in keys) continue;
        }
        throw new ApiException('USER_ALREADY_EXISTS');
      }
    }
  }
}
