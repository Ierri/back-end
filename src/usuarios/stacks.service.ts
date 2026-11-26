import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { PublicacoesCacheService } from '../publicacoes/publicacoes-cache.service.js';
import { Tecnologia } from './schemas/tecnologia.schema.js';
import { Usuario } from './schemas/usuario.schema.js';

@Injectable()
export class UsuariosStacksService {
  constructor(
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
    @InjectModel(Tecnologia.name)
    private readonly tecnologias: Model<Tecnologia>,
    @Optional()
    @Inject(PublicacoesCacheService)
    private readonly cache?: PublicacoesCacheService,
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
    const current = await this.usuarios
      .findOne({ _id: new Types.ObjectId(userId), status: 'ativo' })
      .select('stack_ids')
      .lean()
      .exec();
    if (!current) throw new ApiException('AUTH_REQUIRED');
    const previous = new Set(
      (current.stack_ids ?? []).map((id) => id.toString()),
    );
    const added = ids.filter((id) => !previous.has(id.toString()));
    if (added.length) {
      const found = await this.tecnologias
        .find({ _id: { $in: added }, ativo: true })
        .select('_id')
        .limit(added.length)
        .lean()
        .exec();
      if (found.length !== added.length)
        throw new ApiException('TECNOLOGIAS_INVALIDAS');
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
    await this.cache?.invalidateAuthor(userId).catch(() => undefined);
    return updated.stack_ids.map((id) => id.toString());
  }
}
