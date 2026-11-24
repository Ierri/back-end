import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { PublicacaoAccessService } from '../publicacoes/publicacao-access.service.js';
import { Publicacao } from '../publicacoes/schemas/publicacao.schema.js';
import { Comentario } from '../comentarios/schemas/comentario.schema.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import type { AdminDenunciasDto, CreateDenunciaDto, MinhasDenunciasDto,
  ResolveDenunciaDto } from './dto/moderacao.dto.js';
import { ModeracaoCursor } from './moderacao.cursor.js';
import { Denuncia } from './schemas/denuncia.schema.js';

@Injectable()
export class DenunciasService {
  constructor(
    @InjectModel(Denuncia.name) private readonly reports: Model<Denuncia>,
    @InjectModel(Usuario.name) private readonly users: Model<Usuario>,
    @InjectModel(Publicacao.name) private readonly posts: Model<Publicacao>,
    @InjectModel(Comentario.name) private readonly comments: Model<Comentario>,
    @Inject(PublicacaoAccessService) private readonly access: PublicacaoAccessService,
    @Inject(ModeracaoCursor) private readonly cursor: ModeracaoCursor,
  ) {}

  async create(userId: string, body: CreateDenunciaDto) {
    const targetId = new Types.ObjectId(body.alvoId);
    if (body.alvoTipo === 'usuario') {
      const target = await this.users.findOne({ _id: targetId, status: 'ativo' })
        .select('_id').lean().exec();
      if (!target) throw new ApiException('DENUNCIA_ALVO_NAO_ENCONTRADO');
      if (target._id.toString() === userId) throw new ApiException('DENUNCIA_PROPRIA');
    } else {
      const comment = body.alvoTipo === 'comentario'
        ? await this.comments.findOne({ _id: targetId, status: 'publicado',
          criacao_estado: { $nin: ['pendente', 'falhou'] } })
          .select('autor_id publicacao_id').lean().exec() : null;
      if (body.alvoTipo === 'comentario' && !comment)
        throw new ApiException('DENUNCIA_ALVO_NAO_ENCONTRADO');
      const post = await this.posts.findOne({ _id: comment?.publicacao_id ?? targetId,
        status: 'publicada' }).select('autor_id status visibilidade').lean().exec();
      if (!post || !await this.access.canRead(post, userId))
        throw new ApiException('DENUNCIA_ALVO_NAO_ENCONTRADO');
      const author = comment?.autor_id ?? post.autor_id;
      if (author.toString() === userId) throw new ApiException('DENUNCIA_PROPRIA');
      if (!await this.users.exists({ _id: author, status: 'ativo' }))
        throw new ApiException('DENUNCIA_ALVO_NAO_ENCONTRADO');
    }
    try {
      const report = await this.reports.create({ denunciante_id: new Types.ObjectId(userId),
        alvo_tipo: body.alvoTipo, alvo_id: targetId, motivo: body.motivo,
        descricao: body.descricao ?? null });
      return this.publicView(report);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)
        throw new ApiException('DENUNCIA_DUPLICADA');
      throw error;
    }
  }

  async mine(userId: string, query: MinhasDenunciasDto) {
    const scope = `reports:mine:${userId}`;
    const position = query.cursor ? this.cursor.decode(query.cursor, scope) : null;
    const found = await this.reports.find({ denunciante_id: new Types.ObjectId(userId),
      ...this.position(position) }).sort({ criada_em: -1, _id: -1 }).limit(query.limite + 1).exec();
    return this.page(found, query.limite, scope, false);
  }

  async adminList(query: AdminDenunciasDto) {
    const scope = `reports:admin:${query.status}:${query.alvoTipo}`;
    const position = query.cursor ? this.cursor.decode(query.cursor, scope) : null;
    const found = await this.reports.find({
      ...(query.status !== 'todos' ? { status: query.status } : {}),
      ...(query.alvoTipo !== 'todos' ? { alvo_tipo: query.alvoTipo } : {}),
      ...this.position(position),
    }).sort({ criada_em: -1, _id: -1 }).limit(query.limite + 1).exec();
    return this.page(found, query.limite, scope, true);
  }

  async detail(id: string) {
    const report = await this.reports.findById(id).exec();
    if (!report) throw new ApiException('DENUNCIA_NAO_ENCONTRADA');
    return this.adminView(report);
  }

  async resolve(id: string, moderatorId: string, body: ResolveDenunciaDto) {
    const report = await this.reports.findOneAndUpdate({ _id: new Types.ObjectId(id), status: 'pendente' },
      { $set: { status: body.status, moderador_id: new Types.ObjectId(moderatorId),
        justificativa: body.justificativa, resolvida_em: new Date(), historico_pendente: true } },
      { returnDocument: 'after', runValidators: true }).exec();
    if (!report) throw new ApiException('DENUNCIA_NAO_PENDENTE');
    return this.adminView(report);
  }

  private position(position: { date: Date; id: Types.ObjectId } | null) {
    return position ? { $or: [
      { criada_em: { $lt: position.date } },
      { criada_em: position.date, _id: { $lt: position.id } },
    ] } : {};
  }

  private page(found: (Denuncia & { _id: Types.ObjectId })[], limit: number,
    scope: string, admin: boolean) {
    const items = found.slice(0, limit);
    const last = items.at(-1);
    const hasMore = found.length > limit;
    return { items: items.map((item) => admin ? this.adminView(item) : this.publicView(item)),
      hasMore, nextCursor: hasMore && last
        ? this.cursor.encode(last.criada_em, last._id, scope) : null };
  }

  private publicView(item: Denuncia & { _id: Types.ObjectId }) {
    return { id: item._id.toString(), alvoTipo: item.alvo_tipo, alvoId: item.alvo_id.toString(),
      motivo: item.motivo, descricao: item.descricao, status: item.status,
      criadaEm: item.criada_em, resolvidaEm: item.resolvida_em };
  }

  private adminView(item: Denuncia & { _id: Types.ObjectId }) {
    return { ...this.publicView(item), denuncianteId: item.denunciante_id.toString(),
      moderadorId: item.moderador_id?.toString() ?? null, justificativa: item.justificativa };
  }
}
