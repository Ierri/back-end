import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { Tecnologia } from '../usuarios/schemas/tecnologia.schema.js';
import type { ListTecnologiasDto } from './dto/list-tecnologias.dto.js';

type Position = { name: string; id: Types.ObjectId };

@Injectable()
export class TecnologiasService {
  constructor(
    @InjectModel(Tecnologia.name) private readonly tecnologias: Model<Tecnologia>,
  ) {}

  async list(query: ListTecnologiasDto) {
    const position = query.cursor ? this.decode(query.cursor, query.busca ?? null) : null;
    const conditions: Record<string, unknown>[] = [{ ativo: true }];
    if (query.busca) {
      const escaped = query.busca.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      conditions.push({ $or: [
        { nome: { $regex: `^${escaped}`, $options: 'i' } },
        { slug: { $regex: `^${escaped}` } },
      ] });
    }
    if (position) {
      conditions.push({ $or: [
        { nome: { $gt: position.name } },
        { nome: position.name, _id: { $gt: position.id } },
      ] });
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
      nextCursor: hasMore && last ? this.encode(last.nome, last._id, query.busca ?? null) : null,
      hasMore,
    };
  }

  private encode(name: string, id: Types.ObjectId, search: string | null) {
    return Buffer.from(JSON.stringify({ n: name, i: id.toString(), q: search })).toString('base64url');
  }

  private decode(cursor: string, search: string | null): Position {
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor) throw new Error('Invalid cursor');
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (
        typeof value !== 'object' || value === null ||
        !('n' in value) || typeof value.n !== 'string' || !value.n || value.n.length > 80 ||
        !('i' in value) || typeof value.i !== 'string' || !/^[a-f\d]{24}$/i.test(value.i) ||
        !('q' in value) || value.q !== search
      ) throw new Error('Invalid cursor');
      return { name: value.n, id: new Types.ObjectId(value.i) };
    } catch {
      throw new ApiException('VALIDATION_ERROR');
    }
  }
}
