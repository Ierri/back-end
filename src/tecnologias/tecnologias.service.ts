import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { PublicacoesCacheService } from '../publicacoes/publicacoes-cache.service.js';
import { Tecnologia } from '../usuarios/schemas/tecnologia.schema.js';
import type { ListTecnologiasDto } from './dto/list-tecnologias.dto.js';
import type {
  CreateAdminTecnologiaDto,
  ListAdminTecnologiasDto,
  UpdateAdminTecnologiaDto,
} from './dto/admin-tecnologias.dto.js';

type Position = { name: string; id: Types.ObjectId };

@Injectable()
export class TecnologiasService {
  constructor(
    @InjectModel(Tecnologia.name)
    private readonly tecnologias: Model<Tecnologia>,
    @Optional()
    @Inject(PublicacoesCacheService)
    private readonly cache?: PublicacoesCacheService,
  ) {}

  async list(query: ListTecnologiasDto) {
    const position = query.cursor
      ? this.decode(query.cursor, query.busca ?? null)
      : null;
    const conditions: Record<string, unknown>[] = [{ ativo: true }];
    if (query.busca) {
      const escaped = query.busca.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      conditions.push({
        $or: [
          { nome: { $regex: `^${escaped}`, $options: 'i' } },
          { slug: { $regex: `^${escaped}` } },
        ],
      });
    }
    if (position) {
      conditions.push({
        $or: [
          { nome: { $gt: position.name } },
          { nome: position.name, _id: { $gt: position.id } },
        ],
      });
    }
    const found = await this.tecnologias
      .find({ $and: conditions })
      .select('_id nome slug categoria icone_url')
      .sort({ nome: 1, _id: 1 })
      .limit(query.limite + 1)
      .lean()
      .exec();
    const hasMore = found.length > query.limite;
    const page = found.slice(0, query.limite);
    const last = page.at(-1);
    return {
      items: page.map((item) => ({
        id: item._id.toString(),
        nome: item.nome,
        slug: item.slug,
        categoria: item.categoria ?? null,
        iconeUrl: item.icone_url ?? null,
      })),
      nextCursor:
        hasMore && last
          ? this.encode(last.nome, last._id, query.busca ?? null)
          : null,
      hasMore,
    };
  }

  async adminList(query: ListAdminTecnologiasDto) {
    const position = query.cursor
      ? this.decodeAdmin(query.cursor, query.busca ?? null, query.status)
      : null;
    const conditions: Record<string, unknown>[] = [];
    if (query.status !== 'todos')
      conditions.push({ ativo: query.status === 'ativo' });
    if (query.busca) {
      const escaped = query.busca.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      conditions.push({
        $or: [
          { nome: { $regex: `^${escaped}`, $options: 'i' } },
          { slug: { $regex: `^${escaped}` } },
        ],
      });
    }
    if (position)
      conditions.push({
        $or: [
          { nome: { $gt: position.name } },
          { nome: position.name, _id: { $gt: position.id } },
        ],
      });
    const found = await this.tecnologias
      .find(conditions.length ? { $and: conditions } : {})
      .select('_id nome slug categoria icone_url ativo')
      .sort({ nome: 1, _id: 1 })
      .limit(query.limite + 1)
      .lean()
      .exec();
    const page = found.slice(0, query.limite);
    const last = page.at(-1);
    const hasMore = found.length > query.limite;
    return {
      items: page.map((item) => this.adminView(item)),
      nextCursor:
        hasMore && last
          ? this.encodeAdmin(
              last.nome,
              last._id,
              query.busca ?? null,
              query.status,
            )
          : null,
      hasMore,
    };
  }

  async create(body: CreateAdminTecnologiaDto) {
    try {
      const created = await this.tecnologias.create({
        nome: body.nome,
        slug: body.slug,
        categoria: body.categoria ?? null,
        icone_url: body.iconeUrl ?? null,
        ativo: body.ativo ?? true,
      });
      await this.cache?.invalidateTechnologies().catch(() => undefined);
      return this.adminView(created);
    } catch (error) {
      if (this.duplicateSlug(error))
        throw new ApiException('TECNOLOGIA_SLUG_EXISTS');
      throw error;
    }
  }

  async update(id: string, body: UpdateAdminTecnologiaDto) {
    const changes: Record<string, unknown> = {};
    if (body.nome !== undefined) changes.nome = body.nome;
    if (body.slug !== undefined) changes.slug = body.slug;
    if (body.categoria !== undefined) changes.categoria = body.categoria;
    if (body.iconeUrl !== undefined) changes.icone_url = body.iconeUrl;
    if (body.ativo !== undefined) changes.ativo = body.ativo;
    try {
      const updated = await this.tecnologias
        .findOneAndUpdate(
          { _id: new Types.ObjectId(id) },
          { $set: changes },
          { returnDocument: 'after', runValidators: true },
        )
        .exec();
      if (!updated) throw new ApiException('TECNOLOGIA_NOT_FOUND');
      await this.cache?.invalidateTechnologies().catch(() => undefined);
      return this.adminView(updated);
    } catch (error) {
      if (this.duplicateSlug(error))
        throw new ApiException('TECNOLOGIA_SLUG_EXISTS');
      throw error;
    }
  }

  private adminView(
    item: Pick<
      Tecnologia,
      'nome' | 'slug' | 'categoria' | 'icone_url' | 'ativo'
    > & { _id: Types.ObjectId },
  ) {
    return {
      id: item._id.toString(),
      nome: item.nome,
      slug: item.slug,
      categoria: item.categoria ?? null,
      iconeUrl: item.icone_url ?? null,
      ativo: item.ativo,
    };
  }

  private duplicateSlug(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 11000
    );
  }

  private encodeAdmin(
    name: string,
    id: Types.ObjectId,
    search: string | null,
    status: ListAdminTecnologiasDto['status'],
  ) {
    return Buffer.from(
      JSON.stringify({ v: 1, n: name, i: id.toString(), q: search, s: status }),
    ).toString('base64url');
  }

  private decodeAdmin(
    cursor: string,
    search: string | null,
    status: ListAdminTecnologiasDto['status'],
  ): Position {
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor)
        throw new Error('Invalid cursor');
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (
        typeof value !== 'object' ||
        value === null ||
        !('v' in value) ||
        value.v !== 1 ||
        !('n' in value) ||
        typeof value.n !== 'string' ||
        !value.n ||
        value.n.length > 80 ||
        !('i' in value) ||
        typeof value.i !== 'string' ||
        !/^[a-f\d]{24}$/i.test(value.i) ||
        !('q' in value) ||
        value.q !== search ||
        !('s' in value) ||
        value.s !== status
      )
        throw new Error('Invalid cursor');
      return { name: value.n, id: new Types.ObjectId(value.i) };
    } catch {
      throw new ApiException('VALIDATION_ERROR');
    }
  }

  private encode(name: string, id: Types.ObjectId, search: string | null) {
    return Buffer.from(
      JSON.stringify({ n: name, i: id.toString(), q: search }),
    ).toString('base64url');
  }

  private decode(cursor: string, search: string | null): Position {
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor)
        throw new Error('Invalid cursor');
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (
        typeof value !== 'object' ||
        value === null ||
        !('n' in value) ||
        typeof value.n !== 'string' ||
        !value.n ||
        value.n.length > 80 ||
        !('i' in value) ||
        typeof value.i !== 'string' ||
        !/^[a-f\d]{24}$/i.test(value.i) ||
        !('q' in value) ||
        value.q !== search
      )
        throw new Error('Invalid cursor');
      return { name: value.n, id: new Types.ObjectId(value.i) };
    } catch {
      throw new ApiException('VALIDATION_ERROR');
    }
  }
}
