import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import type { UsuarioDocument } from '../usuarios/schemas/usuario.schema.js';
import type {
  CreatePublicacaoDto,
  ListPublicacoesDto,
  UpdatePublicacaoDto,
} from './dto/publicacoes.dto.js';
import { MEDIA_VERIFIER } from './media-verifier.js';
import type { MediaVerifier } from './media-verifier.js';
import { PublicacoesCursor } from './publicacoes.cursor.js';
import {
  Publicacao,
  validPublicationMedia,
} from './schemas/publicacao.schema.js';
import type {
  PublicacaoDocument,
  PublicacaoMidia,
} from './schemas/publicacao.schema.js';

@Injectable()
export class PublicacoesService {
  constructor(
    @InjectModel(Publicacao.name)
    private readonly publicacoes: Model<Publicacao>,
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
    @Inject(MEDIA_VERIFIER) private readonly mediaVerifier: MediaVerifier,
    @Inject(PublicacoesCursor) private readonly cursor: PublicacoesCursor,
  ) {}

  async list(query: ListPublicacoesDto, viewerId?: string) {
    const authorId = query.autorId?.toLowerCase() ?? null;
    const scope = {
      authorId,
      owner: authorId !== null && authorId === viewerId?.toLowerCase(),
    };
    const position = query.cursor
      ? this.cursor.decode(query.cursor, scope)
      : null;
    const filter = {
      status: 'publicada' as const,
      ...(authorId ? { autor_id: new Types.ObjectId(authorId) } : {}),
      ...(!scope.owner ? { visibilidade: 'publico' as const } : {}),
      ...(position
        ? {
            $or: [
              { publicada_em: { $lt: position.publishedAt } },
              { publicada_em: position.publishedAt, _id: { $lt: position.id } },
            ],
          }
        : {}),
    };
    const found = await this.publicacoes
      .find(filter)
      .sort({ publicada_em: -1, _id: -1 })
      .limit(query.limite + 1)
      .exec();
    const hasMore = found.length > query.limite;
    const page = found.slice(0, query.limite);
    const authorIds = [
      ...new Set(page.map((post) => post.autor_id.toString())),
    ];
    const authors = authorIds.length
      ? await this.usuarios
          .find({ _id: { $in: authorIds } })
          .select('nome username biografia avatar_url')
          .exec()
      : [];
    const byId = new Map(
      authors.map((author) => [author._id.toString(), author]),
    );
    const items = page.flatMap((post) => {
      const author = byId.get(post.autor_id.toString());
      return author ? [this.toResponse(post, author)] : [];
    });
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? this.cursor.encode(
              { publishedAt: last.publicada_em!, id: last._id },
              scope,
            )
          : null,
      hasMore,
    };
  }

  async create(authorId: string, body: CreatePublicacaoDto) {
    const author = await this.usuarios
      .findById(authorId)
      .select('nome username biografia avatar_url')
      .exec();
    if (!author) throw new ApiException('AUTH_REQUIRED');

    const publicationId = new Types.ObjectId();
    const verified = await this.mediaVerifier.resolveForPublication(
      authorId,
      body.midias,
      publicationId.toString(),
    );
    let writeStarted = false;
    let postPersisted = false;
    try {
      if (
        verified.length !== body.midias.length ||
        verified.some((media, index) => media.referencia !== body.midias[index])
      ) {
        throw new ApiException('MEDIA_INVALID');
      }
      const midias: PublicacaoMidia[] = verified.map((media, ordem) => ({
        _id: new Types.ObjectId(),
        tipo: media.tipo,
        url: media.url,
        chave_storage: media.chave_storage,
        mime_type: media.mime_type,
        tamanho_bytes: media.tamanho_bytes,
        largura: media.largura,
        altura: media.altura,
        duracao_segundos: media.duracao_segundos,
        texto_alternativo: null,
        ordem,
      }));
      if (!validPublicationMedia(midias))
        throw new ApiException('MEDIA_INVALID');

      writeStarted = true;
      const created = await this.publicacoes.create({
        _id: publicationId,
        slug: `post-${randomBytes(12).toString('hex')}`,
        autor_id: new Types.ObjectId(authorId),
        conteudo: body.conteudo,
        midias,
        visibilidade: body.visibilidade,
        status: 'processando',
        publicada_em: null,
      });
      postPersisted = true;
      await this.mediaVerifier.confirmForPublication(
        publicationId.toString(),
        body.midias,
      );
      const published = await this.publicacoes
        .findOneAndUpdate(
          { _id: created._id, status: 'processando' },
          { $set: { status: 'publicada', publicada_em: new Date() } },
          { new: true, runValidators: true },
        )
        .exec();
      if (!published) throw new ApiException('MEDIA_INVALID');
      await this.mediaVerifier
        .finalizeForPublication(publicationId.toString(), body.midias)
        .catch(() => undefined);
      return this.toResponse(published, author);
    } catch (error) {
      let safeToRelease = !writeStarted;
      if (postPersisted) {
        const deleted = await this.publicacoes
          .deleteOne({ _id: publicationId, status: 'processando' })
          .exec()
          .catch(() => null);
        safeToRelease = deleted?.deletedCount === 1;
      }
      if (safeToRelease) {
        await this.mediaVerifier
          .releaseForPublication(publicationId.toString(), body.midias)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async findById(id: string, viewerId?: string) {
    const accessible = viewerId
      ? [
          { visibilidade: 'publico' as const },
          { autor_id: new Types.ObjectId(viewerId) },
        ]
      : [{ visibilidade: 'publico' as const }];
    const publication = await this.publicacoes
      .findOne({ _id: id, status: 'publicada', $or: accessible })
      .exec();
    if (!publication) throw new ApiException('PUBLICACAO_NOT_FOUND');
    const author = await this.usuarios
      .findById(publication.autor_id)
      .select('nome username biografia avatar_url')
      .exec();
    if (!author) throw new ApiException('PUBLICACAO_NOT_FOUND');
    return this.toResponse(publication, author);
  }

  async update(id: string, authorId: string, body: UpdatePublicacaoDto) {
    const changes: Record<string, unknown> = {};
    if (body.conteudo !== undefined) {
      changes.conteudo = body.conteudo;
      changes.editada_em = new Date();
    }
    if (body.visibilidade !== undefined)
      changes.visibilidade = body.visibilidade;
    const publication = await this.publicacoes
      .findOneAndUpdate(
        {
          _id: id,
          autor_id: new Types.ObjectId(authorId),
          status: 'publicada',
        },
        { $set: changes },
        { new: true, runValidators: true },
      )
      .exec();
    if (!publication) throw new ApiException('PUBLICACAO_NOT_FOUND');
    const author = await this.usuarios
      .findById(authorId)
      .select('nome username biografia avatar_url')
      .exec();
    if (!author) throw new ApiException('PUBLICACAO_NOT_FOUND');
    return this.toResponse(publication, author);
  }

  async remove(id: string, authorId: string) {
    const publication = await this.publicacoes
      .findOneAndUpdate(
        {
          _id: id,
          autor_id: new Types.ObjectId(authorId),
          status: 'publicada',
        },
        { $set: { status: 'excluida' } },
        { new: false },
      )
      .exec();
    if (!publication) throw new ApiException('PUBLICACAO_NOT_FOUND');
    return null;
  }

  private toResponse(publication: PublicacaoDocument, author: UsuarioDocument) {
    return {
      id: publication._id.toString(),
      slug: publication.slug,
      autor: {
        id: author._id.toString(),
        nome: author.nome,
        username: author.username,
        biografia: author.biografia ?? null,
        avatarUrl: author.avatar_url ?? null,
      },
      conteudo: publication.conteudo,
      midias: publication.midias.map((media) => ({
        id: media._id.toString(),
        tipo: media.tipo,
        url: media.url,
        mimeType: media.mime_type,
        tamanhoBytes: media.tamanho_bytes,
        largura: media.largura,
        altura: media.altura,
        duracaoSegundos: media.duracao_segundos,
        textoAlternativo: media.texto_alternativo,
        ordem: media.ordem,
      })),
      visibilidade: publication.visibilidade,
      status: publication.status,
      contadores: {
        upvotes: publication.contadores.upvotes,
        downvotes: publication.contadores.downvotes,
        score: publication.contadores.score,
        comentarios: publication.contadores.comentarios,
        salvamentos: publication.contadores.salvamentos,
      },
      publicadaEm: publication.publicada_em,
      editadaEm: publication.editada_em,
      criadaEm: publication.criada_em,
      atualizadaEm: publication.atualizada_em,
    };
  }
}
