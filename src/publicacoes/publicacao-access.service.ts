import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model, QueryFilter } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { Seguidor } from '../usuarios/schemas/seguidor.schema.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import type { Publicacao } from './schemas/publicacao.schema.js';

type PublicationAccess = Pick<Publicacao, 'autor_id' | 'status' | 'visibilidade'>;

@Injectable()
export class PublicacaoAccessService {
  constructor(
    @InjectModel(Seguidor.name) private readonly seguidores: Model<Seguidor>,
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
  ) {}

  async canRead(publication: PublicationAccess, viewerId?: string) {
    if (publication.status !== 'publicada') return false;
    if (publication.visibilidade === 'publico') return true;
    if (publication.visibilidade !== 'seguidores' || !viewerId) return false;
    const viewer = new Types.ObjectId(viewerId);
    const author = publication.autor_id;
    if (viewer.equals(author)) {
      return Boolean(await this.usuarios.exists({ _id: viewer, status: 'ativo' }));
    }
    const [active, relation] = await Promise.all([
      this.usuarios.countDocuments({ _id: { $in: [viewer, author] }, status: 'ativo' }).exec(),
      this.seguidores.exists({ seguidor_id: viewer, seguido_id: author, status: 'aceito' }),
    ]);
    return active === 2 && Boolean(relation);
  }

  async listVisibility(viewerId?: string, authorId?: string | null): Promise<QueryFilter<Publicacao>> {
    if (!viewerId) return { visibilidade: 'publico' };
    const viewer = new Types.ObjectId(viewerId);
    if (!await this.usuarios.exists({ _id: viewer, status: 'ativo' }))
      return { visibilidade: 'publico' };
    if (authorId) {
      const author = new Types.ObjectId(authorId);
      if (viewer.equals(author)) return {};
      const [activeAuthor, relation] = await Promise.all([
        this.usuarios.exists({ _id: author, status: 'ativo' }),
        this.seguidores.exists({ seguidor_id: viewer, seguido_id: author, status: 'aceito' }),
      ]);
      return activeAuthor && relation ? {} : { visibilidade: 'publico' };
    }
    const activeAuthors = await this.activeFollowedAuthors(viewer);
    return {
      $or: [
        { visibilidade: 'publico' },
        { autor_id: viewer },
        ...(activeAuthors.length ? [{ visibilidade: 'seguidores' as const, autor_id: { $in: activeAuthors } }] : []),
      ],
    };
  }

  async followingVisibility(viewerId: string): Promise<QueryFilter<Publicacao>> {
    const viewer = new Types.ObjectId(viewerId);
    if (!await this.usuarios.exists({ _id: viewer, status: 'ativo' }))
      throw new ApiException('AUTH_REQUIRED');
    return { autor_id: { $in: await this.activeFollowedAuthors(viewer) } };
  }

  private async activeFollowedAuthors(viewer: Types.ObjectId) {
    const followed = await this.seguidores.distinct('seguido_id', {
      seguidor_id: viewer,
      status: 'aceito',
    }).exec();
    const activeAuthors = followed.length
      ? await this.usuarios.find({ _id: { $in: followed }, status: 'ativo' }).select('_id').lean().exec()
      : [];
    return activeAuthors.map((author) => author._id).filter((id) => !id.equals(viewer));
  }

  writeFilter(publication: PublicationAccess) {
    return {
      autor_id: publication.autor_id,
      status: 'publicada' as const,
      visibilidade: publication.visibilidade,
    };
  }
}
