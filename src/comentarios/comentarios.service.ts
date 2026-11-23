import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { PublicacoesCacheService } from '../publicacoes/publicacoes-cache.service.js';
import { Publicacao } from '../publicacoes/schemas/publicacao.schema.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import type { UsuarioDocument } from '../usuarios/schemas/usuario.schema.js';
import { ComentariosCursor } from './comentarios.cursor.js';
import type { CreateComentarioDto, ListComentariosDto, UpdateComentarioDto } from './dto/comentarios.dto.js';
import { Comentario } from './schemas/comentario.schema.js';
import type { ComentarioDocument } from './schemas/comentario.schema.js';

@Injectable()
export class ComentariosService {
  constructor(
    @InjectModel(Comentario.name) private readonly comentarios: Model<Comentario>,
    @InjectModel(Publicacao.name) private readonly publicacoes: Model<Publicacao>,
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
    @Inject(ComentariosCursor) private readonly cursor: ComentariosCursor,
    @Inject(PublicacoesCacheService) private readonly cache: PublicacoesCacheService,
  ) {}

  private async accessiblePublication(id: string, viewerId?: string) {
    const access = viewerId
      ? [{ visibilidade: 'publico' as const }, { autor_id: new Types.ObjectId(viewerId) }]
      : [{ visibilidade: 'publico' as const }];
    const publication = await this.publicacoes
      .findOne({ _id: id, status: 'publicada', $or: access })
      .select('autor_id')
      .exec();
    if (!publication) throw new ApiException('PUBLICACAO_NOT_FOUND');
    return publication;
  }

  async create(publicationId: string, authorId: string, body: CreateComentarioDto, idempotencyKey?: string) {
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))
      throw new ApiException('VALIDATION_ERROR', [{ field: 'Idempotency-Key', message: 'Chave inválida.' }]);
    const publication = await this.accessiblePublication(publicationId, authorId);
    const author = await this.usuarios.findById(authorId)
      .select('nome username avatar_url').exec();
    if (!author) throw new ApiException('AUTH_REQUIRED');
    const id = idempotencyKey
      ? new Types.ObjectId(createHash('sha256')
          .update(authorId.toLowerCase() + ':' + publicationId.toLowerCase() + ':' + idempotencyKey)
          .digest('hex').slice(0, 24))
      : new Types.ObjectId();
    const operation = 'c:' + id.toString();
    if (idempotencyKey) {
      const existing = await this.comentarios.findById(id).exec();
      if (existing) return this.repeatCreate(existing, author, publicationId, publication.autor_id.toString(), authorId, body, operation);
    }
    let parent: ComentarioDocument | null = null;
    if (body.comentarioPaiId) {
      parent = await this.comentarios.findOne({
        _id: body.comentarioPaiId,
        publicacao_id: new Types.ObjectId(publicationId),
        status: 'publicado',
        criacao_estado: { $nin: ['pendente', 'falhou'] },
      }).exec();
      if (!parent) throw new ApiException('COMENTARIO_NOT_FOUND');
      if (parent.profundidade === 2) throw new ApiException('COMENTARIO_DEPTH_EXCEEDED');
      if (parent.profundidade === 1 && !await this.comentarios.exists({
        _id: parent.comentario_raiz_id,
        publicacao_id: new Types.ObjectId(publicationId),
        profundidade: 0,
        criacao_estado: { $nin: ['pendente', 'falhou'] },
      })) throw new ApiException('COMENTARIO_NOT_FOUND');
    }
    const root = parent
      ? parent.profundidade === 0 ? parent._id : parent.comentario_raiz_id
      : null;
    let canMarkFailed = false;
    try {
      await this.reserveOperation(publicationId, operation, authorId);
      const created = await this.comentarios.create({
        _id: id,
        publicacao_id: new Types.ObjectId(publicationId),
        autor_id: new Types.ObjectId(authorId),
        comentario_pai_id: parent?._id ?? null,
        comentario_raiz_id: root,
        profundidade: parent ? (parent.profundidade + 1) as 1 | 2 : 0,
        conteudo: body.conteudo,
        status: 'publicado',
        criacao_estado: 'pendente',
      });
      if (parent) {
        const present = await this.comentarios.exists({
          _id: parent._id,
          publicacao_id: publication._id,
          status: 'publicado',
          criacao_estado: { $nin: ['pendente', 'falhou'] },
        });
        if (!present) {
          canMarkFailed = true;
          throw new ApiException('COMENTARIO_NOT_FOUND');
        }
      }
      const updated = await this.publicacoes.updateOne(
        {
          _id: publication._id,
          status: 'publicada',
          comentarios_operacoes_pendentes: operation,
          $or: [{ visibilidade: 'publico' }, { autor_id: new Types.ObjectId(authorId) }],
        },
        { $inc: { 'contadores.comentarios': 1, comentarios_revisao: 1 } },
      ).exec();
      if (updated.modifiedCount !== 1) {
        canMarkFailed = true;
        throw new ApiException('PUBLICACAO_NOT_FOUND');
      }
      const confirmed = await this.comentarios.updateOne(
        { _id: id, criacao_estado: 'pendente' },
        { $set: { criacao_estado: 'confirmado' } },
      ).exec();
      if (confirmed.modifiedCount !== 1) throw new ApiException('COMENTARIO_OPERATION_PENDING');
      await this.releaseOperation(publicationId, operation);
      await this.cache.invalidate(publicationId, publication.autor_id.toString());
      return this.toResponse(created, author);
    } catch (error) {
      if (idempotencyKey && typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
        await this.releaseOperation(publicationId, operation).catch(() => {
          throw new ApiException('COMENTARIO_OPERATION_PENDING');
        });
        const existing = await this.comentarios.findById(id).exec();
        if (existing) return this.repeatCreate(existing, author, publicationId, publication.autor_id.toString(), authorId, body, operation, true);
        throw new ApiException('COMENTARIO_IDEMPOTENCY_CONFLICT');
      }
      if (canMarkFailed) {
        await this.comentarios.updateOne(
          { _id: id, criacao_estado: 'pendente' },
          { $set: { criacao_estado: 'falhou' } },
        ).exec().catch(() => undefined);
        await this.releaseOperation(publicationId, operation).catch(() => undefined);
      }
      await this.cache.invalidate(publicationId, publication.autor_id.toString()).catch(() => undefined);
      if (error instanceof ApiException && error.getStatus() !== 503) throw error;
      throw new ApiException('COMENTARIO_WRITE_UNAVAILABLE');
    }
  }

  private async repeatCreate(
    existing: ComentarioDocument,
    author: UsuarioDocument,
    publicationId: string,
    publicationAuthorId: string,
    authorId: string,
    body: CreateComentarioDto,
    operation: string,
    reservationReleased = false,
  ) {
    if (
      existing.autor_id.toString() !== authorId.toLowerCase() ||
      existing.publicacao_id.toString() !== publicationId.toLowerCase() ||
      (existing.comentario_pai_id?.toString() ?? null) !== (body.comentarioPaiId?.toLowerCase() ?? null) ||
      existing.conteudo !== body.conteudo ||
      existing.status !== 'publicado'
    ) throw new ApiException('COMENTARIO_IDEMPOTENCY_CONFLICT');
    if (existing.criacao_estado === 'pendente' || existing.criacao_estado === 'falhou')
      throw new ApiException('COMENTARIO_OPERATION_PENDING');
    if (!reservationReleased) {
      await this.releaseOperation(publicationId, operation).catch(() => {
        throw new ApiException('COMENTARIO_OPERATION_PENDING');
      });
    }
    await this.cache.invalidate(publicationId, publicationAuthorId);
    return this.toResponse(existing, author);
  }

  private async reserveOperation(publicationId: string, operation: string, viewerId: string) {
    const result = await this.publicacoes.updateOne(
      {
        _id: new Types.ObjectId(publicationId),
        status: 'publicada',
        comentarios_operacoes_pendentes: { $ne: operation },
        $or: [{ visibilidade: 'publico' }, { autor_id: new Types.ObjectId(viewerId) }],
      },
      { $addToSet: { comentarios_operacoes_pendentes: operation }, $inc: { comentarios_revisao: 1 } },
    ).exec();
    if (result.modifiedCount !== 1) {
      await this.accessiblePublication(publicationId, viewerId);
      throw new ApiException('COMENTARIO_OPERATION_PENDING');
    }
  }

  private async releaseOperation(publicationId: string, operation: string) {
    const result = await this.publicacoes.updateOne(
      { _id: new Types.ObjectId(publicationId), comentarios_operacoes_pendentes: operation },
      { $pull: { comentarios_operacoes_pendentes: operation }, $inc: { comentarios_revisao: 1 } },
    ).exec();
    if (result.modifiedCount === 1) return;
    const publication = await this.publicacoes.findById(publicationId)
      .select('comentarios_operacoes_pendentes').exec();
    if (publication?.comentarios_operacoes_pendentes?.includes(operation))
      throw new ApiException('COMENTARIO_OPERATION_PENDING');
  }

  async list(publicationId: string, query: ListComentariosDto, viewerId?: string) {
    await this.accessiblePublication(publicationId, viewerId);
    return this.listChildren(publicationId, null, query);
  }

  async replies(commentId: string, query: ListComentariosDto, viewerId?: string) {
    const parent = await this.comentarios.findById(commentId).exec();
    if (!parent || parent.criacao_estado === 'pendente' || parent.criacao_estado === 'falhou')
      throw new ApiException('COMENTARIO_NOT_FOUND');
    try {
      await this.accessiblePublication(parent.publicacao_id.toString(), viewerId);
    } catch (error) {
      if (error instanceof ApiException) throw new ApiException('COMENTARIO_NOT_FOUND');
      throw error;
    }
    return this.listChildren(parent.publicacao_id.toString(), commentId, query);
  }

  private async listChildren(publicationId: string, parentId: string | null, query: ListComentariosDto) {
    publicationId = publicationId.toLowerCase();
    parentId = parentId?.toLowerCase() ?? null;
    const position = query.cursor
      ? this.cursor.decode(query.cursor, publicationId, parentId)
      : null;
    const filter = {
      publicacao_id: new Types.ObjectId(publicationId),
      comentario_pai_id: parentId ? new Types.ObjectId(parentId) : null,
      criacao_estado: { $nin: ['pendente', 'falhou'] as const },
      ...(position ? { $or: [
        { criado_em: { $gt: position.createdAt } },
        { criado_em: position.createdAt, _id: { $gt: position.id } },
      ] } : {}),
    };
    const found = await this.comentarios.find(filter)
      .sort({ criado_em: 1, _id: 1 }).limit(query.limite + 1).exec();
    const hasMore = found.length > query.limite;
    const page = found.slice(0, query.limite);
    const authorIds = [...new Set(page.map((item) => item.autor_id.toString()))];
    const authors = authorIds.length
      ? await this.usuarios.find({ _id: { $in: authorIds } })
          .select('nome username avatar_url').exec()
      : [];
    const byId = new Map(authors.map((author) => [author._id.toString(), author]));
    const items = page.flatMap((item) => {
      const author = byId.get(item.autor_id.toString());
      return author ? [this.toResponse(item, author)] : [];
    });
    const last = page.at(-1);
    return {
      items,
      nextCursor: hasMore && last
        ? this.cursor.encode({ createdAt: last.criado_em, id: last._id }, publicationId, parentId)
        : null,
      hasMore,
    };
  }

  async update(id: string, authorId: string, body: UpdateComentarioDto) {
    const existing = await this.comentarios.findById(id).exec();
    if (!existing || existing.autor_id.toString() !== authorId || existing.criacao_estado === 'pendente' || existing.criacao_estado === 'falhou')
      throw new ApiException('COMENTARIO_NOT_FOUND');
    await this.accessiblePublication(existing.publicacao_id.toString(), authorId);
    const updated = await this.comentarios.findOneAndUpdate(
      { _id: id, autor_id: new Types.ObjectId(authorId), status: 'publicado', criacao_estado: { $nin: ['pendente', 'falhou'] } },
      { $set: { conteudo: body.conteudo, editado_em: new Date() } },
      { new: true, runValidators: true },
    ).exec();
    if (!updated) throw new ApiException('COMENTARIO_NOT_FOUND');
    const author = await this.usuarios.findById(authorId)
      .select('nome username avatar_url').exec();
    if (!author) throw new ApiException('COMENTARIO_NOT_FOUND');
    return this.toResponse(updated, author);
  }

  async remove(id: string, authorId: string) {
    const existing = await this.comentarios.findById(id).exec();
    if (!existing || existing.autor_id.toString() !== authorId || existing.criacao_estado === 'pendente' || existing.criacao_estado === 'falhou')
      throw new ApiException('COMENTARIO_NOT_FOUND');
    const publication = await this.accessiblePublication(existing.publicacao_id.toString(), authorId);
    if (existing.status !== 'publicado') throw new ApiException('COMENTARIO_NOT_FOUND');
    const publicationId = existing.publicacao_id.toString();
    const operation = 'd:' + id.toLowerCase();
    await this.reserveOperation(publicationId, operation, authorId);
    let canRelease = false;
    try {
      const removed = await this.comentarios.findOneAndUpdate(
        { _id: id, autor_id: new Types.ObjectId(authorId), status: 'publicado', criacao_estado: { $nin: ['pendente', 'falhou'] } },
        { $set: { status: 'excluido', conteudo: 'Comentário removido' } },
        { new: true },
      ).exec();
      if (!removed) {
        canRelease = true;
        throw new ApiException('COMENTARIO_NOT_FOUND');
      }
      const updated = await this.publicacoes.updateOne(
        {
          _id: publication._id,
          status: 'publicada',
          comentarios_operacoes_pendentes: operation,
          'contadores.comentarios': { $gt: 0 },
          $or: [{ visibilidade: 'publico' }, { autor_id: new Types.ObjectId(authorId) }],
        },
        { $inc: { 'contadores.comentarios': -1, comentarios_revisao: 1 } },
      ).exec();
      if (updated.modifiedCount !== 1) {
        const restored = await this.comentarios.updateOne(
          { _id: id, status: 'excluido' },
          { $set: { status: 'publicado', conteudo: existing.conteudo } },
        ).exec();
        canRelease = restored.modifiedCount === 1;
        throw new ApiException('COMENTARIO_WRITE_UNAVAILABLE');
      }
      await this.releaseOperation(publicationId, operation);
      await this.cache.invalidate(publicationId, publication.autor_id.toString());
      return null;
    } catch (error) {
      if (canRelease) await this.releaseOperation(publicationId, operation).catch(() => undefined);
      await this.cache.invalidate(publicationId, publication.autor_id.toString()).catch(() => undefined);
      if (error instanceof ApiException && error.getStatus() !== 503) throw error;
      throw new ApiException('COMENTARIO_WRITE_UNAVAILABLE');
    }
  }

  async reconcileCounter(publicationId: string) {
    const publication = await this.publicacoes.findById(publicationId)
      .select('autor_id comentarios_revisao comentarios_operacoes_pendentes').exec();
    if (!publication) return;
    if (publication.comentarios_operacoes_pendentes?.length)
      throw new ApiException('COMENTARIO_OPERATION_PENDING');
    const revision = publication.comentarios_revisao ?? 0;
    const count = await this.comentarios.countDocuments({
      publicacao_id: new Types.ObjectId(publicationId),
      status: 'publicado',
      criacao_estado: { $nin: ['pendente', 'falhou'] },
    }).exec();
    let updated;
    try {
      updated = await this.publicacoes.updateOne(
        {
          _id: publication._id,
          comentarios_revisao: revision === 0 ? { $in: [0, null] } : revision,
          $or: [
            { comentarios_operacoes_pendentes: { $size: 0 } },
            { comentarios_operacoes_pendentes: { $exists: false } },
          ],
        },
        { $set: { 'contadores.comentarios': count }, $inc: { comentarios_revisao: 1 } },
      ).exec();
    } catch (error) {
      await this.cache.invalidate(publicationId, publication.autor_id.toString()).catch(() => undefined);
      throw error;
    }
    if (updated.modifiedCount !== 1)
      throw new ApiException('COMENTARIO_OPERATION_PENDING');
    await this.cache.invalidate(publicationId, publication.autor_id.toString());
  }

  private toResponse(comment: ComentarioDocument, author: UsuarioDocument) {
    return {
      id: comment._id.toString(),
      publicacaoId: comment.publicacao_id.toString(),
      autor: {
        id: author._id.toString(),
        nome: author.nome,
        username: author.username,
        avatarUrl: author.avatar_url ?? null,
      },
      conteudo: comment.status === 'publicado'
        ? comment.conteudo
        : comment.status === 'excluido' ? 'Comentário removido' : 'Comentário indisponível',
      profundidade: comment.profundidade,
      comentarioPaiId: comment.comentario_pai_id?.toString() ?? null,
      comentarioRaizId: comment.comentario_raiz_id?.toString() ?? null,
      status: comment.status,
      editadoEm: comment.editado_em,
      criadoEm: comment.criado_em,
    };
  }
}
