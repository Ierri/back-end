import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { ApiException } from '../common/http/api.exception.js';
import { Tecnologia } from '../usuarios/schemas/tecnologia.schema.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import type { UsuarioDocument } from '../usuarios/schemas/usuario.schema.js';
import { CreatorStatsService } from '../usuarios/creator-stats.service.js';
import type {
  CreatePublicacaoDto,
  ListPublicacoesDto,
  UpdatePublicacaoDto,
} from './dto/publicacoes.dto.js';
import { PublicacoesCacheService } from './publicacoes-cache.service.js';
import { PublicacaoAccessService } from './publicacao-access.service.js';
import type {
  CachedPublicacao,
  CachedPublicacoesPage,
} from './publicacoes-cache.service.js';
import { MEDIA_VERIFIER } from './media-verifier.js';
import type { MediaVerifier, VerifiedMedia } from './media-verifier.js';
import { PublicacoesCursor } from './publicacoes.cursor.js';
import {
  Publicacao,
  validPublicationMedia,
} from './schemas/publicacao.schema.js';
import type {
  PublicacaoDocument,
  PublicacaoMidia,
} from './schemas/publicacao.schema.js';
import { VotosStreamService } from './votos-stream.service.js';

type AuthorSnapshot = {
  _id: Types.ObjectId;
  nome: string;
  username: string;
  biografia?: string | null;
  avatar_url?: string | null;
  visibilidade_perfil?: 'publico' | 'privado';
};

@Injectable()
export class PublicacoesService {
  @Inject(CreatorStatsService) private creatorStats?: CreatorStatsService;
  @InjectModel(Tecnologia.name) private tecnologias!: Model<Tecnologia>;
  @Optional()
  @Inject(VotosStreamService)
  private votosStream?: VotosStreamService;
  constructor(
    @InjectModel(Publicacao.name)
    private readonly publicacoes: Model<Publicacao>,
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
    @Inject(MEDIA_VERIFIER) private readonly mediaVerifier: MediaVerifier,
    @Inject(PublicacoesCursor) private readonly cursor: PublicacoesCursor,
    @Inject(PublicacoesCacheService)
    private readonly cache: PublicacoesCacheService,
    @Inject(PublicacaoAccessService)
    private readonly access: PublicacaoAccessService,
  ) {}

  async list(query: ListPublicacoesDto, viewerId?: string) {
    const authorId = query.autorId?.toLowerCase() ?? null;
    if (query.escopo === 'seguindo' && authorId)
      throw new ApiException('VALIDATION_ERROR', [
        {
          field: 'autorId',
          message: 'autorId não pode ser combinado com escopo=seguindo.',
        },
      ]);
    if (query.escopo === 'seguindo' && !viewerId)
      throw new ApiException('AUTH_REQUIRED');
    const scope = {
      authorId,
      owner: authorId !== null && authorId === viewerId?.toLowerCase(),
      viewerId: viewerId?.toLowerCase() ?? null,
      feed:
        query.escopo === 'seguindo'
          ? ('seguindo' as const)
          : ('geral' as const),
      order:
        query.ordem === 'score' ? ('score' as const) : ('cronologica' as const),
    };
    const position = query.cursor
      ? this.cursor.decode(query.cursor, scope)
      : null;
    const address =
      viewerId || query.ordem === 'score'
        ? null
        : await this.cache.pageAddress(
            query.limite,
            authorId,
            position,
            scope.owner,
          );
    if (address) {
      const cached = await this.cache.readPage(address);
      const currentAuthors = cached
        ? await this.cachedPageCurrent(cached, query.limite, authorId, position)
        : null;
      if (cached && currentAuthors && (await this.cache.isCurrent(address))) {
        this.cache.countHit();
        return {
          ...cached,
          items: cached.items.map((item) =>
            this.forViewer(item, viewerId, currentAuthors),
          ),
        };
      }
      if (cached) this.cache.countStaleMiss();
      const load = async () => {
        this.cache.countMongoAfterMiss();
        const fresh = await this.loadList(
          query,
          authorId,
          scope.owner,
          position,
          viewerId,
        );
        if (fresh.cacheable) await this.cache.writePage(address, fresh.shared);
        return fresh.viewer;
      };
      return viewerId ? load() : this.cache.coalesce(address.key, load);
    }
    return (
      await this.loadList(query, authorId, scope.owner, position, viewerId)
    ).viewer;
  }

  private async loadList(
    query: ListPublicacoesDto,
    authorId: string | null,
    owner: boolean,
    position: { publishedAt: Date; id: Types.ObjectId; score?: number } | null,
    viewerId?: string,
  ) {
    const visibility =
      query.escopo === 'seguindo'
        ? await this.access.followingVisibility(viewerId!)
        : await this.access.listVisibility(viewerId, authorId);
    const positionFilter = position
      ? query.ordem === 'score'
        ? {
            $or: [
              { 'contadores.score': { $lt: position.score! } },
              {
                'contadores.score': position.score,
                publicada_em: { $lt: position.publishedAt },
              },
              {
                'contadores.score': position.score,
                publicada_em: position.publishedAt,
                _id: { $lt: position.id },
              },
            ],
          }
        : {
            $or: [
              { publicada_em: { $lt: position.publishedAt } },
              { publicada_em: position.publishedAt, _id: { $lt: position.id } },
            ],
          }
      : null;
    const filter = {
      status: 'publicada' as const,
      ...(authorId ? { autor_id: new Types.ObjectId(authorId) } : {}),
      ...(positionFilter ? { $and: [visibility, positionFilter] } : visibility),
    };
    const found =
      query.ordem === 'score'
        ? (
            await this.publicacoes
              .aggregate<Publicacao>([
                { $match: filter },
                {
                  $sort: { 'contadores.score': -1, publicada_em: -1, _id: -1 },
                },
                {
                  $lookup: {
                    from: 'usuarios',
                    localField: 'autor_id',
                    foreignField: '_id',
                    pipeline: [
                      { $match: { status: 'ativo' } },
                      { $project: { _id: 1 } },
                    ],
                    as: 'activeAuthor',
                  },
                },
                { $match: { 'activeAuthor.0': { $exists: true } } },
                { $limit: query.limite + 1 },
                { $unset: 'activeAuthor' },
              ])
              .exec()
          ).map((post) => this.publicacoes.hydrate(post))
        : await this.publicacoes
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
          .find({ _id: { $in: authorIds }, status: 'ativo' })
          .select('nome username biografia avatar_url visibilidade_perfil')
          .exec()
      : [];
    const byId = new Map(
      authors.map((author) => [author._id.toString(), author]),
    );
    const sharedItems = page.flatMap((post) => {
      const author = byId.get(post.autor_id.toString());
      return author ? [this.toResponse(post, author)] : [];
    });
    const viewerItems = viewerId
      ? page.flatMap((post) => {
          const author = byId.get(post.autor_id.toString());
          return author ? [this.toResponse(post, author, viewerId)] : [];
        })
      : sharedItems;
    const last = page.at(-1);
    const shared = {
      items: sharedItems,
      nextCursor:
        hasMore && last
          ? this.cursor.encode(
              {
                publishedAt: last.publicada_em!,
                id: last._id,
                ...(query.ordem === 'score'
                  ? { score: last.contadores.score }
                  : {}),
              },
              {
                authorId,
                owner,
                viewerId: viewerId?.toLowerCase() ?? null,
                feed: query.escopo === 'seguindo' ? 'seguindo' : 'geral',
                order: query.ordem === 'score' ? 'score' : 'cronologica',
              },
            )
          : null,
      hasMore,
    };
    return {
      shared,
      viewer: viewerId ? { ...shared, items: viewerItems } : shared,
      cacheable:
        !viewerId &&
        query.ordem !== 'score' &&
        page.every(
          (post) =>
            post.visibilidade === 'publico' &&
            !post.votos_projecao_pendente &&
            !post.votos_operacoes_pendentes?.length &&
            !post.salvamentos_projecao_pendente &&
            !post.salvamentos_operacoes_pendentes?.length,
        ),
    };
  }

  private async resolveStacks(stackIds: string[]) {
    const catalog = stackIds.length
      ? await this.tecnologias
          .find({ _id: { $in: stackIds }, ativo: true })
          .select('slug nome categoria icone_url')
          .lean()
          .exec()
      : [];
    if (catalog.length !== stackIds.length)
      throw new ApiException('TECNOLOGIAS_INVALIDAS');
    const byId = new Map(catalog.map((item) => [item._id.toString(), item]));
    return stackIds.map((id) => {
      const item = byId.get(id)!;
      return {
        id,
        slug: item.slug,
        nome: item.nome,
        categoria: item.categoria ?? null,
        iconeUrl: item.icone_url ?? null,
      };
    });
  }

  async create(authorId: string, body: CreatePublicacaoDto) {
    const author = await this.usuarios
      .findById(authorId)
      .select('nome username biografia avatar_url visibilidade_perfil')
      .exec();
    if (!author) throw new ApiException('AUTH_REQUIRED');

    const stacks = await this.resolveStacks(body.stackIds ?? []);

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
      const midias = verified.map((media, ordem) =>
        this.toPublicationMedia(media, ordem),
      );
      if (!validPublicationMedia(midias))
        throw new ApiException('MEDIA_INVALID');

      writeStarted = true;
      const created = await this.publicacoes.create({
        _id: publicationId,
        slug: `post-${randomBytes(12).toString('hex')}`,
        autor_id: new Types.ObjectId(authorId),
        conteudo: body.conteudo,
        stacks,
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
      await this.cache.invalidate(publicationId.toString(), authorId);
      await this.creatorStats?.refresh(authorId).catch(() => undefined);
      return this.toResponse(published, author, authorId);
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
    const address = await this.cache.postAddress(id);
    if (address) {
      const cached = await this.cache.readPost(address);
      const currentAuthors =
        cached && cached.id.toLowerCase() === id.toLowerCase()
          ? await this.cachedPostsCurrent([cached], null)
          : null;
      if (cached && currentAuthors && (await this.cache.isCurrent(address))) {
        this.cache.countHit();
        return this.forViewer(cached, viewerId, currentAuthors);
      }
      if (cached) this.cache.countStaleMiss();
      const load = async () => {
        this.cache.countMongoAfterMiss();
        const fresh = await this.loadById(id, viewerId);
        if (fresh.cacheable && fresh.shared.visibilidade === 'publico')
          await this.cache.writePost(address, fresh.shared);
        return fresh.viewer;
      };
      return viewerId ? load() : this.cache.coalesce(address.key, load);
    }
    return (await this.loadById(id, viewerId)).viewer;
  }

  private async loadById(id: string, viewerId?: string) {
    const publication = await this.publicacoes
      .findOne({ _id: id, status: 'publicada' })
      .exec();
    if (!publication || !(await this.access.canRead(publication, viewerId)))
      throw new ApiException('PUBLICACAO_NOT_FOUND');
    const author = await this.usuarios
      .findById(publication.autor_id)
      .select('nome username biografia avatar_url visibilidade_perfil')
      .exec();
    if (
      !author ||
      author.status === 'bloqueado' ||
      author.status === 'excluido'
    )
      throw new ApiException('PUBLICACAO_NOT_FOUND');
    return {
      shared: this.toResponse(publication, author),
      viewer: this.toResponse(publication, author, viewerId),
      cacheable:
        !publication.votos_projecao_pendente &&
        !publication.votos_operacoes_pendentes?.length &&
        !publication.salvamentos_projecao_pendente &&
        !publication.salvamentos_operacoes_pendentes?.length,
    };
  }

  private async cachedPageCurrent(
    cached: CachedPublicacoesPage,
    limit: number,
    authorId: string | null,
    position: { publishedAt: Date; id: Types.ObjectId } | null,
  ) {
    if (
      cached.items.length > limit ||
      cached.hasMore !== (cached.nextCursor !== null) ||
      (cached.hasMore && cached.items.length === 0)
    )
      return null;
    const compare = (left: CachedPublicacao, right: CachedPublicacao) =>
      left.publicadaEm.getTime() - right.publicadaEm.getTime() ||
      left.id.localeCompare(right.id);
    for (let index = 0; index < cached.items.length; index++) {
      const item = cached.items[index];
      if (authorId && item.autor.id.toLowerCase() !== authorId) return null;
      if (index > 0 && compare(cached.items[index - 1], item) <= 0) return null;
      if (
        position &&
        (item.publicadaEm.getTime() > position.publishedAt.getTime() ||
          (item.publicadaEm.getTime() === position.publishedAt.getTime() &&
            item.id >= position.id.toString()))
      )
        return null;
    }
    if (cached.nextCursor) {
      try {
        const last = cached.items.at(-1)!;
        const decoded = this.cursor.decode(cached.nextCursor, {
          authorId,
          owner: false,
        });
        if (
          decoded.id.toString() !== last.id ||
          decoded.publishedAt.getTime() !== last.publicadaEm.getTime()
        )
          return null;
      } catch {
        return null;
      }
    }
    return this.cachedPostsCurrent(cached.items, authorId);
  }

  private async cachedPostsCurrent(
    cached: CachedPublicacao[],
    authorId: string | null,
  ) {
    if (!cached.length) return new Map<string, AuthorSnapshot>();
    const ids = cached.map((item) => new Types.ObjectId(item.id));
    const stored = await this.publicacoes
      .find({ _id: { $in: ids } })
      .select(
        '_id status visibilidade autor_id publicada_em atualizada_em contadores.salvamentos votos_projecao_pendente votos_operacoes_pendentes salvamentos_projecao_pendente salvamentos_operacoes_pendentes',
      )
      .lean()
      .exec();
    if (stored.length !== cached.length) return null;
    const byId = new Map(stored.map((item) => [item._id.toString(), item]));
    for (const item of cached) {
      const current = byId.get(item.id);
      if (
        !current ||
        current.status !== 'publicada' ||
        current.visibilidade !== 'publico' ||
        Boolean(current.votos_projecao_pendente) ||
        Boolean(current.votos_operacoes_pendentes?.length) ||
        Boolean(current.salvamentos_projecao_pendente) ||
        Boolean(current.salvamentos_operacoes_pendentes?.length) ||
        (current.contadores?.salvamentos ?? 0) !==
          item.contadores.salvamentos ||
        current.autor_id.toString() !== item.autor.id ||
        (authorId && current.autor_id.toString() !== authorId) ||
        current.publicada_em?.getTime() !== item.publicadaEm.getTime() ||
        current.atualizada_em.getTime() !== item.atualizadaEm.getTime()
      )
        return null;
    }
    const authorIds = [...new Set(cached.map((item) => item.autor.id))];
    const authors = await this.usuarios
      .find({ _id: { $in: authorIds }, status: 'ativo' })
      .select('nome username biografia avatar_url visibilidade_perfil')
      .lean()
      .exec();
    if (authors.length !== authorIds.length) return null;
    const byAuthor = new Map(
      authors.map((author) => [author._id.toString(), author]),
    );
    const valid = cached.every((item) => {
      const author = byAuthor.get(item.autor.id);
      return (
        author?.nome === item.autor.nome &&
        author.username === item.autor.username &&
        (author.visibilidade_perfil === 'privado'
          ? null
          : (author.biografia ?? null)) === item.autor.biografia &&
        (author.avatar_url ?? null) === item.autor.avatarUrl
      );
    });
    return valid ? byAuthor : null;
  }

  private toPublicationMedia(
    media: VerifiedMedia,
    ordem: number,
  ): PublicacaoMidia {
    return {
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
    };
  }

  async update(id: string, authorId: string, body: UpdatePublicacaoDto) {
    const filter = {
      _id: id,
      autor_id: new Types.ObjectId(authorId),
      status: 'publicada' as const,
    };
    const changes: Record<string, unknown> = {};
    if (body.conteudo !== undefined) changes.conteudo = body.conteudo;
    if (body.visibilidade !== undefined)
      changes.visibilidade = body.visibilidade;
    if (
      body.conteudo !== undefined ||
      body.stackIds !== undefined ||
      body.midias !== undefined
    )
      changes.editada_em = new Date();
    if (body.stackIds !== undefined)
      changes.stacks = await this.resolveStacks(body.stackIds);

    const references =
      body.midias?.flatMap((item) =>
        'referencia' in item ? [item.referencia] : [],
      ) ?? [];
    const publicationId = id.toLowerCase();
    let previousMediaIds: Types.ObjectId[] | undefined;
    let reservedReferences: string[] = [];
    let writeStarted = false;
    let publication: PublicacaoDocument | null;
    try {
      if (body.midias) {
        const current = await this.publicacoes.findOne(filter).exec();
        if (!current) throw new ApiException('PUBLICACAO_NOT_FOUND');
        previousMediaIds = current.midias.map((item) => item._id);
        const existing = new Map(
          current.midias.map((item) => [item._id.toString(), item]),
        );
        if (body.midias.some((item) => 'id' in item && !existing.has(item.id)))
          throw new ApiException('MEDIA_INVALID');

        const uploads = references.length
          ? await this.mediaVerifier.resolveForPublication(
              authorId,
              references,
              publicationId,
              true,
            )
          : [];
        reservedReferences = uploads.map((item) => item.referencia);
        const uploaded = new Map(
          uploads.map((item) => [item.referencia, item]),
        );
        const midias = body.midias.map((item, order) => {
          if ('referencia' in item) {
            const upload = uploaded.get(item.referencia);
            if (!upload) throw new ApiException('MEDIA_INVALID');
            return this.toPublicationMedia(upload, order);
          }
          const media = existing.get(item.id)!;
          return {
            _id: media._id,
            tipo: media.tipo,
            url: media.url,
            chave_storage: media.chave_storage,
            mime_type: media.mime_type,
            tamanho_bytes: media.tamanho_bytes,
            largura: media.largura,
            altura: media.altura,
            duracao_segundos: media.duracao_segundos,
            texto_alternativo: media.texto_alternativo,
            ordem: order,
          };
        });
        if (!validPublicationMedia(midias))
          throw new ApiException('MEDIA_INVALID');
        changes.midias = midias;
        if (references.length)
          await this.mediaVerifier.confirmForPublication(
            publicationId,
            references,
          );
      }

      writeStarted = true;
      publication = await this.publicacoes
        .findOneAndUpdate(
          {
            ...filter,
            ...(previousMediaIds
              ? { $expr: { $eq: ['$midias._id', previousMediaIds] } }
              : {}),
          },
          { $set: changes },
          { new: true, runValidators: true },
        )
        .exec();
      if (!publication) {
        writeStarted = false;
        throw new ApiException(
          previousMediaIds ? 'MEDIA_INVALID' : 'PUBLICACAO_NOT_FOUND',
        );
      }
    } catch (error) {
      if (!writeStarted && reservedReferences.length) {
        await this.mediaVerifier
          .releaseForPublication(publicationId, reservedReferences, true)
          .catch(() => undefined);
      }
      throw error;
    }

    if (references.length) {
      await this.mediaVerifier
        .finalizeForPublication(publicationId, references)
        .catch(() => undefined);
    }
    await this.cache.invalidate(id, authorId);
    if (body.visibilidade !== undefined) {
      await this.creatorStats?.refresh(authorId).catch(() => undefined);
      await this.votosStream
        ?.publishAccessChange({
          publicationId: id,
          authorId,
          visibility: publication.visibilidade,
        })
        .catch(() => undefined);
    }
    const author = await this.usuarios
      .findById(authorId)
      .select('nome username biografia avatar_url visibilidade_perfil')
      .exec();
    if (!author) throw new ApiException('PUBLICACAO_NOT_FOUND');
    return this.toResponse(publication, author, authorId);
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
    await this.cache.invalidate(id, authorId);
    await this.creatorStats?.refresh(authorId).catch(() => undefined);
    await this.votosStream
      ?.publishAccessChange({
        publicationId: id,
        authorId,
        visibility: 'removida',
      })
      .catch(() => undefined);
    return null;
  }

  private forViewer(
    item: CachedPublicacao,
    viewerId: string | undefined,
    authors: Map<string, AuthorSnapshot>,
  ): CachedPublicacao {
    const author = authors.get(item.autor.id);
    if (
      !author ||
      author.visibilidade_perfil !== 'privado' ||
      item.autor.id.toLowerCase() !== viewerId?.toLowerCase()
    )
      return item;
    return {
      ...item,
      autor: { ...item.autor, biografia: author.biografia ?? null },
    };
  }

  toResponse(
    publication: PublicacaoDocument,
    author: UsuarioDocument,
    viewerId?: string,
  ) {
    return {
      id: publication._id.toString(),
      slug: publication.slug,
      autor: {
        id: author._id.toString(),
        nome: author.nome,
        username: author.username,
        biografia:
          author.visibilidade_perfil === 'privado' &&
          author._id.toString().toLowerCase() !== viewerId?.toLowerCase()
            ? null
            : (author.biografia ?? null),
        avatarUrl: author.avatar_url ?? null,
      },
      conteudo: publication.conteudo,
      stacks: (publication.stacks ?? []).map(
        ({ id, slug, nome, categoria, iconeUrl }) => ({
          id,
          slug,
          nome,
          categoria,
          iconeUrl,
        }),
      ),
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
