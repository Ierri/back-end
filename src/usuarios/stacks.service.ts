import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { Tecnologia } from './schemas/tecnologia.schema.js';
import { Usuario } from './schemas/usuario.schema.js';

@Injectable()
export class UsuariosStacksService {
  constructor(
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
    @InjectModel(Tecnologia.name) private readonly tecnologias: Model<Tecnologia>,
  ) {}

  async replace(userId: string, stackIds: string[]): Promise<string[]> {
    const normalized = stackIds.map((id) => id.toLowerCase());
    if (
      normalized.length > 20 ||
      normalized.some((id) => !/^[a-f\d]{24}$/.test(id)) ||
      new Set(normalized).size !== normalized.length
    ) {
      throw new ApiException('VALIDATION_ERROR');
    }

    const ids = normalized.map((id) => new Types.ObjectId(id));
    if (ids.length) {
      const found = await this.tecnologias
        .find({ _id: { $in: ids }, ativo: true })
        .select('_id')
        .limit(ids.length)
        .lean()
        .exec();
      if (found.length !== ids.length) throw new ApiException('TECNOLOGIAS_INVALIDAS');
    }

    const updated = await this.usuarios
      .findOneAndUpdate(
        { _id: new Types.ObjectId(userId), status: 'ativo' },
        { $set: { stack_ids: ids } },
        { returnDocument: 'after', runValidators: true },
      )
      .select('stack_ids')
      .exec();
    if (!updated) throw new ApiException('AUTH_REQUIRED');
    return updated.stack_ids.map((id) => id.toString());
  }
}
