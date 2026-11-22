import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { Tecnologia } from './schemas/tecnologia.schema.js';
import { Usuario } from './schemas/usuario.schema.js';
import type { UsuarioDocument } from './schemas/usuario.schema.js';

@Injectable()
export class PerfilReadService {
  constructor(
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
    @InjectModel(Tecnologia.name)
    private readonly tecnologias: Model<Tecnologia>,
  ) {}

  async findSelf(userId: string) {
    const user = await this.usuarios.findById(userId).exec();
    if (!user) throw new ApiException('USER_NOT_FOUND');
    const { stackIds, stacks } = await this.readStacks(user);
    return {
      id: user._id.toString(),
      nome: user.nome,
      username: user.username,
      email: user.email,
      biografia: user.biografia ?? null,
      avatarUrl: user.avatar_url ?? null,
      visibilidadePerfil: user.visibilidade_perfil ?? 'publico',
      stackIds,
      stacks,
      criadoEm: user.criado_em ?? null,
      atualizadoEm: user.atualizado_em ?? null,
    };
  }

  async findPublic(username: string, viewerId?: string) {
    const user = await this.usuarios
      .findOne({ username: username.trim().toLowerCase() })
      .exec();
    if (!user || (user.status ?? 'ativo') !== 'ativo') {
      throw new ApiException('USER_NOT_FOUND');
    }
    const base = {
      id: user._id.toString(),
      nome: user.nome,
      username: user.username,
      avatarUrl: user.avatar_url ?? null,
      visibilidadePerfil: user.visibilidade_perfil ?? 'publico',
    };
    if (base.visibilidadePerfil === 'privado' && viewerId !== base.id) {
      return base;
    }
    const { stacks } = await this.readStacks(user);
    return { ...base, biografia: user.biografia ?? null, stacks };
  }

  private async readStacks(user: UsuarioDocument) {
    const ids = (Array.isArray(user.stack_ids) ? user.stack_ids : [])
      .filter((id): id is Types.ObjectId => id instanceof Types.ObjectId)
      .slice(0, 20);
    const stackIds = ids.map((id) => id.toString());
    if (ids.length === 0) return { stackIds, stacks: [] };
    const technologies = await this.tecnologias
      .find({ _id: { $in: ids } })
      .select('_id nome slug categoria icone_url')
      .lean()
      .exec();
    const byId = new Map(technologies.map((technology) => [technology._id.toString(), technology]));
    const stacks = stackIds.flatMap((id) => {
      const technology = byId.get(id);
      return technology
        ? [{
            id,
            nome: technology.nome,
            slug: technology.slug,
            categoria: technology.categoria ?? null,
            iconeUrl: technology.icone_url ?? null,
          }]
        : [];
    });
    return { stackIds, stacks };
  }
}
