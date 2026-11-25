import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model, PipelineStage } from 'mongoose';
import { PublicacaoAccessService } from '../publicacoes/publicacao-access.service.js';
import { PublicacoesService } from '../publicacoes/publicacoes.service.js';
import { Publicacao } from '../publicacoes/schemas/publicacao.schema.js';
import { Seguidor } from '../usuarios/schemas/seguidor.schema.js';
import { Tecnologia } from '../usuarios/schemas/tecnologia.schema.js';
import { Usuario } from '../usuarios/schemas/usuario.schema.js';
import { BuscaCacheService } from './busca-cache.service.js';
import type { CachedSearchPost } from './busca-cache.service.js';
import { normalizeSearchInput } from './busca-pattern.js';
import type { NormalizedSearchInput } from './busca-pattern.js';
import { BuscaCursor } from './busca.cursor.js';
import type {
  BuscaGeralDto,
  BuscaOrder,
  BuscaPublicacoesDto,
  BuscaUsuariosDto,
} from './dto/busca.dto.js';

const QUERY_TIMEOUT_MS = 2_000;
const MAX_CATALOG_TECHS = 500;
const MAX_TECH_SIGNALS = 10;
const MAX_DIRECT_AUTHORS = 30;
const MAX_SEED_PUBLIC_USERS = 3;
const MAX_SEED_STACKS = 25;
const MAX_SEED_CONNECTIONS = 40;
const MAX_RELATED_USERS = 20;
const PUBLICATION_PRELIMIT_MULTIPLIER = 4;

export type BuscaTecnologiaItem = {
  id: string;
  nome: string;
  slug: string;
  categoria: string | null;
  iconeUrl: string | null;
};

export type BuscaUsuarioItem = {
  id: string;
  nome: string;
  username: string;
  avatarUrl: string | null;
  biografia: string | null;
  visibilidadePerfil: 'publico' | 'privado';
  stacks: BuscaTecnologiaItem[];
  score: number | null;
  relacionado: boolean;
};

type ViewerSnapshot = {
  _id: Types.ObjectId;
  nome: string;
  username: string;
  biografia?: string;
  visibilidade_perfil?: 'publico' | 'privado';
  stack_ids?: Types.ObjectId[];
};

type ResolvedViewer = {
  effectiveViewerId: string | undefined;
  viewerDoc: ViewerSnapshot | null;
};

type LiveUserSnapshot = {
  _id: Types.ObjectId;
  nome: string;
  username: string;
  biografia?: string;
  avatar_url?: string;
  visibilidade_perfil?: 'publico' | 'privado';
  stack_ids?: Types.ObjectId[];
  contadores?: { score?: number };
};

type DirectUserSeedRow = {
  _id: Types.ObjectId;
  visibilidade_perfil?: 'publico' | 'privado';
  stack_ids?: Types.ObjectId[];
};

type UserSearchRow = {
  _id: Types.ObjectId;
  nome: string;
  username: string;
  biografia?: string;
  avatar_url?: string;
  visibilidade_perfil?: 'publico' | 'privado';
  stack_ids?: Types.ObjectId[];
  contadores?: { score?: number };
  relevancia: number;
  scoreOrdenacao: number;
};

type RawPublicationLookupRow = Publicacao & {
  _id: Types.ObjectId;
  tier: 0 | 1;
  scoreOrdenacao: number;
  dataOrdenacao: Date;
  author:
    | Array<Usuario & { _id: Types.ObjectId }>
    | (Usuario & { _id: Types.ObjectId });
};

type PublicationSearchRow = Publicacao & {
  _id: Types.ObjectId;
  tier: 0 | 1;
  scoreOrdenacao: number;
  dataOrdenacao: Date;
  author: Usuario & { _id: Types.ObjectId };
};

type SearchSignals = {
  parsed: NormalizedSearchInput;
  effectiveViewerId: string | undefined;
  viewerObjectId: Types.ObjectId | null;
  techById: Map<string, BuscaTecnologiaItem>;
  matchedTechnologies: BuscaTecnologiaItem[];
  matchedTechIds: Types.ObjectId[];
  directAuthorIds: Types.ObjectId[];
  relatedPublicUserIds: Types.ObjectId[];
};

@Injectable()
export class BuscaService {
  constructor(
    @InjectModel(Usuario.name) private readonly usuarios: Model<Usuario>,
    @InjectModel(Publicacao.name)
    private readonly publicacoes: Model<Publicacao>,
    @InjectModel(Tecnologia.name)
    private readonly tecnologias: Model<Tecnologia>,
    @InjectModel(Seguidor.name) private readonly seguidores: Model<Seguidor>,
    @Inject(PublicacaoAccessService)
    private readonly access: PublicacaoAccessService,
    @Inject(PublicacoesService)
    private readonly publicationResponses: PublicacoesService,
    @Inject(BuscaCursor) private readonly cursor: BuscaCursor,
    @Optional()
    @Inject(BuscaCacheService)
    private readonly cache?: BuscaCacheService,
  ) {}

  async searchAll(query: BuscaGeralDto, viewerId?: string) {
    const parsed = normalizeSearchInput(query.q);
    const viewer = await this.resolveActiveViewer(viewerId);

    if (!viewer.effectiveViewerId && this.cache?.enabled) {
      const address = await this.cache.overviewAddress(
        parsed.queryHash,
        query.limite,
        query.ordem,
      );
      if (address) {
        const cached = await this.cache.readOverview(address);
        if (cached) {
          const usersOk = await this.verifyUsersCurrent(
            cached.usuarios.items,
            cached.publicacoes.items,
          );
          if (!usersOk) {
            this.cache.countStaleMiss();
            await this.cache.evict(address);
          } else if (await this.cache.isCurrent(address)) {
            this.cache.countPageHit();
            return cached;
          } else {
            this.cache.countStaleMiss();
          }
        }
        return this.cache.coalesce(address.key, async () => {
          const computed = await this.computeOverview(parsed, query, viewer);
          if (computed.cacheable) {
            await this.cache!.writeOverview(address, computed.response);
          }
          return computed.response;
        });
      }
    }
    return (await this.computeOverview(parsed, query, viewer)).response;
  }

  async searchUsers(query: BuscaUsuariosDto, viewerId?: string) {
    const parsed = normalizeSearchInput(query.q);
    const viewer = await this.resolveActiveViewer(viewerId);
    const position = query.cursor
      ? this.cursor.decodeUsers(query.cursor, {
          queryHash: parsed.queryHash,
          viewerId: viewer.effectiveViewerId ?? null,
        })
      : null;

    if (!viewer.effectiveViewerId && this.cache?.enabled) {
      const address = await this.cache.usersPageAddress(
        parsed.queryHash,
        query.limite,
        position,
      );
      if (address) {
        const cached = await this.cache.readUsersPage(address);
        if (cached) {
          const usersOk = await this.verifyUsersCurrent(cached.items, []);
          if (!usersOk) {
            this.cache.countStaleMiss();
            await this.cache.evict(address);
          } else if (await this.cache.isCurrent(address)) {
            this.cache.countPageHit();
            return cached;
          } else {
            this.cache.countStaleMiss();
          }
        }
        return this.cache.coalesce(address.key, async () => {
          const signals = await this.resolveSignals(parsed, viewer);
          const page = await this.executeUserSearch(
            signals,
            query.limite,
            position,
          );
          await this.cache!.writeUsersPage(address, page);
          return page;
        });
      }
    }

    const signals = await this.resolveSignals(parsed, viewer);
    return this.executeUserSearch(signals, query.limite, position);
  }

  async searchPublications(query: BuscaPublicacoesDto, viewerId?: string) {
    const parsed = normalizeSearchInput(query.q);
    const viewer = await this.resolveActiveViewer(viewerId);
    const position = query.cursor
      ? this.cursor.decodePublications(query.cursor, {
          queryHash: parsed.queryHash,
          viewerId: viewer.effectiveViewerId ?? null,
          order: query.ordem,
        })
      : null;

    if (!viewer.effectiveViewerId && this.cache?.enabled) {
      const address = await this.cache.publicationsPageAddress(
        parsed.queryHash,
        query.limite,
        query.ordem,
        position,
      );
      if (address) {
        const cached = await this.cache.readPublicationsPage(address);
        if (cached) {
          const usersOk = await this.verifyUsersCurrent([], cached.items);
          if (!usersOk) {
            this.cache.countStaleMiss();
            await this.cache.evict(address);
          } else if (await this.cache.isCurrent(address)) {
            this.cache.countPageHit();
            return cached;
          } else {
            this.cache.countStaleMiss();
          }
        }
        return this.cache.coalesce(address.key, async () => {
          const signals = await this.resolveSignals(parsed, viewer);
          const computed = await this.executePublicationSearch(
            signals,
            query.limite,
            query.ordem,
            position,
          );
          if (computed.cacheable) {
            await this.cache!.writePublicationsPage(address, computed.page);
          }
          return computed.page;
        });
      }
    }

    const signals = await this.resolveSignals(parsed, viewer);
    return (
      await this.executePublicationSearch(
        signals,
        query.limite,
        query.ordem,
        position,
      )
    ).page;
  }

  private async computeOverview(
    parsed: NormalizedSearchInput,
    query: BuscaGeralDto,
    viewer: ResolvedViewer,
  ) {
    const signals = await this.resolveSignals(parsed, viewer);
    const [usuarios, pubResult] = await Promise.all([
      this.executeUserSearch(signals, query.limite, null),
      this.executePublicationSearch(signals, query.limite, query.ordem, null),
    ]);
    const hasMoreTech = signals.matchedTechnologies.length > query.limite;
    const techSlice = signals.matchedTechnologies.slice(0, query.limite);

    return {
      cacheable: !signals.effectiveViewerId && pubResult.cacheable,
      response: {
        usuarios,
        publicacoes: pubResult.page,
        tecnologias: {
          items: techSlice,
          hasMore: hasMoreTech,
        },
      },
    };
  }

  private async resolveActiveViewer(
    viewerId?: string,
  ): Promise<ResolvedViewer> {
    if (!viewerId || !/^[a-f\d]{24}$/i.test(viewerId)) {
      return { effectiveViewerId: undefined, viewerDoc: null };
    }
    const viewerObjectId = new Types.ObjectId(viewerId);
    const viewerDoc = await this.usuarios
      .findOne({ _id: viewerObjectId, status: 'ativo' })
      .select('_id nome username biografia visibilidade_perfil stack_ids')
      .maxTimeMS(QUERY_TIMEOUT_MS)
      .lean<ViewerSnapshot>()
      .exec();
    if (!viewerDoc) {
      return { effectiveViewerId: undefined, viewerDoc: null };
    }
    return {
      effectiveViewerId: viewerDoc._id.toString(),
      viewerDoc,
    };
  }

  private async loadActiveTechCatalog(): Promise<BuscaTecnologiaItem[]> {
    const address = await this.cache?.techCatalogAddress();
    if (address && this.cache) {
      const cached = await this.cache.readTechCatalog(address);
      if (cached) {
        this.cache.countTechHit();
        return cached;
      }
      return this.cache.coalesce(address.key, async () => {
        const fresh = await this.fetchActiveTechCatalogFromMongo();
        await this.cache!.writeTechCatalog(address, fresh);
        return fresh;
      });
    }
    return this.fetchActiveTechCatalogFromMongo();
  }

  private async fetchActiveTechCatalogFromMongo(): Promise<
    BuscaTecnologiaItem[]
  > {
    const docs = await this.tecnologias
      .find({ ativo: true })
      .select('_id nome slug categoria icone_url')
      .sort({ nome: 1, _id: 1 })
      .limit(MAX_CATALOG_TECHS)
      .maxTimeMS(QUERY_TIMEOUT_MS)
      .lean()
      .exec();
    return docs.map((tech) => this.toTechItem(tech));
  }

  private async resolveSignals(
    parsed: NormalizedSearchInput,
    viewer: ResolvedViewer,
  ): Promise<SearchSignals> {
    const catalog = await this.loadActiveTechCatalog();
    const { effectiveViewerId, viewerDoc } = viewer;

    const techById = new Map<string, BuscaTecnologiaItem>();
    for (const tech of catalog) {
      techById.set(tech.id, tech);
    }

    const tokenRegexes = parsed.tokenSources.map(
      (source) => new RegExp(source, 'i'),
    );
    const matchedTechnologies = catalog.filter((tech) =>
      tokenRegexes.every(
        (re) =>
          re.test(tech.nome) ||
          re.test(tech.slug) ||
          (tech.categoria !== null && re.test(tech.categoria)),
      ),
    );
    const matchedTechIds = matchedTechnologies
      .slice(0, MAX_TECH_SIGNALS)
      .map((tech) => new Types.ObjectId(tech.id));

    const publicSignals = await this.resolvePublicSignals(
      parsed,
      matchedTechIds,
    );

    let directAuthorIds = publicSignals.directAuthorIds;
    if (
      viewerDoc &&
      (viewerDoc.visibilidade_perfil ?? 'publico') === 'privado' &&
      !directAuthorIds.some((id) => id.equals(viewerDoc._id)) &&
      this.viewerMatchesExtendedSearch(viewerDoc, tokenRegexes, matchedTechIds)
    ) {
      directAuthorIds = [viewerDoc._id, ...directAuthorIds].slice(
        0,
        MAX_DIRECT_AUTHORS,
      );
    }

    return {
      parsed,
      effectiveViewerId,
      viewerObjectId: viewerDoc?._id ?? null,
      techById,
      matchedTechnologies,
      matchedTechIds,
      directAuthorIds,
      relatedPublicUserIds: publicSignals.relatedPublicUserIds,
    };
  }

  private viewerMatchesExtendedSearch(
    viewerDoc: ViewerSnapshot,
    tokenRegexes: RegExp[],
    matchedTechIds: Types.ObjectId[],
  ): boolean {
    const bio = viewerDoc.biografia ?? '';
    if (bio && tokenRegexes.every((re) => re.test(bio))) {
      return true;
    }
    if (!matchedTechIds.length || !viewerDoc.stack_ids?.length) {
      return false;
    }
    const techSet = new Set(matchedTechIds.map((id) => id.toString()));
    return viewerDoc.stack_ids.some((id) => techSet.has(id.toString()));
  }

  private async resolvePublicSignals(
    parsed: NormalizedSearchInput,
    matchedTechIds: Types.ObjectId[],
  ): Promise<{
    directAuthorIds: Types.ObjectId[];
    relatedPublicUserIds: Types.ObjectId[];
  }> {
    const address = await this.cache?.signalsAddress(parsed.queryHash);
    if (address && this.cache) {
      const cached = await this.cache.readSignals(address);
      if (cached) {
        this.cache.countSignalsHit();
        return {
          directAuthorIds: cached.publicDirectAuthorIds.map(
            (id) => new Types.ObjectId(id),
          ),
          relatedPublicUserIds: cached.relatedPublicUserIds.map(
            (id) => new Types.ObjectId(id),
          ),
        };
      }
      const persisted = await this.cache.coalesce(address.key, async () => {
        const fresh = await this.computePublicSignalsFromMongo(
          parsed,
          matchedTechIds,
        );
        const dto = {
          matchedTechIds: matchedTechIds.map((id) => id.toString()),
          publicDirectAuthorIds: fresh.directAuthorIds.map((id) =>
            id.toString(),
          ),
          relatedPublicUserIds: fresh.relatedPublicUserIds.map((id) =>
            id.toString(),
          ),
        };
        await this.cache!.writeSignals(address, dto);
        return dto;
      });
      return {
        directAuthorIds: persisted.publicDirectAuthorIds.map(
          (id) => new Types.ObjectId(id),
        ),
        relatedPublicUserIds: persisted.relatedPublicUserIds.map(
          (id) => new Types.ObjectId(id),
        ),
      };
    }
    return this.computePublicSignalsFromMongo(parsed, matchedTechIds);
  }

  private async computePublicSignalsFromMongo(
    parsed: NormalizedSearchInput,
    matchedTechIds: Types.ObjectId[],
  ): Promise<{
    directAuthorIds: Types.ObjectId[];
    relatedPublicUserIds: Types.ObjectId[];
  }> {
    const publicDirectMatch = this.buildDirectUserMatch(
      parsed,
      matchedTechIds,
      null,
    );

    const directSeeds = await this.usuarios
      .aggregate<DirectUserSeedRow>([
        { $match: publicDirectMatch },
        {
          $addFields: {
            relevancia: this.buildUserRelevanceExpr(
              parsed,
              matchedTechIds,
              null,
              [],
            ),
            scoreOrdenacao: this.buildUserScoreSortExpr(null),
          },
        },
        { $sort: { relevancia: 1, scoreOrdenacao: -1, _id: -1 } },
        { $limit: MAX_DIRECT_AUTHORS },
        {
          $project: {
            _id: 1,
            visibilidade_perfil: 1,
            stack_ids: 1,
          },
        },
      ])
      .option({ maxTimeMS: QUERY_TIMEOUT_MS })
      .exec();

    const directAuthorIds = directSeeds.map((seed) => seed._id);
    const publicSeeds = directSeeds
      .filter((seed) => (seed.visibilidade_perfil ?? 'publico') !== 'privado')
      .slice(0, MAX_SEED_PUBLIC_USERS);

    const relatedPublicUserIds = await this.findRelatedPublicUsers(
      publicSeeds,
      directAuthorIds,
    );

    return { directAuthorIds, relatedPublicUserIds };
  }

  private async verifyUsersCurrent(
    users: BuscaUsuarioItem[],
    posts: CachedSearchPost[],
  ): Promise<boolean> {
    const idSet = new Set<string>();
    for (const user of users) idSet.add(user.id.toLowerCase());
    for (const post of posts) idSet.add(post.autor.id.toLowerCase());
    if (idSet.size === 0) return true;

    const needActiveTechSet = users.some(
      (user) => user.visibilidadePerfil === 'publico',
    );
    const objectIds = [...idSet].map((id) => new Types.ObjectId(id));

    const [liveUsers, activeCatalog] = await Promise.all([
      this.usuarios
        .find({ _id: { $in: objectIds }, status: 'ativo' })
        .select(
          '_id nome username biografia avatar_url visibilidade_perfil stack_ids contadores.score',
        )
        .maxTimeMS(QUERY_TIMEOUT_MS)
        .lean<LiveUserSnapshot[]>()
        .exec(),
      needActiveTechSet
        ? this.loadActiveTechCatalog()
        : Promise.resolve<BuscaTecnologiaItem[]>([]),
    ]);

    if (liveUsers.length !== idSet.size) return false;

    const activeTechIds = new Set(
      activeCatalog.map((tech) => tech.id.toLowerCase()),
    );
    const byId = new Map<string, LiveUserSnapshot>();
    for (const live of liveUsers) {
      byId.set(live._id.toString().toLowerCase(), live);
    }

    for (const cachedUser of users) {
      const live = byId.get(cachedUser.id.toLowerCase());
      if (!live) return false;
      const liveVis = live.visibilidade_perfil ?? 'publico';
      if (
        live.nome !== cachedUser.nome ||
        live.username !== cachedUser.username ||
        (live.avatar_url ?? null) !== cachedUser.avatarUrl ||
        liveVis !== cachedUser.visibilidadePerfil
      ) {
        return false;
      }
      if (liveVis === 'publico') {
        if ((live.biografia ?? null) !== cachedUser.biografia) return false;
        if ((live.contadores?.score ?? 0) !== cachedUser.score) return false;
        const liveActiveStacks = (live.stack_ids ?? [])
          .map((id) => id.toString().toLowerCase())
          .filter((id) => activeTechIds.has(id));
        const cachedStacks = cachedUser.stacks.map((stack) =>
          stack.id.toLowerCase(),
        );
        if (
          liveActiveStacks.length !== cachedStacks.length ||
          liveActiveStacks.some((id, idx) => id !== cachedStacks[idx])
        ) {
          return false;
        }
      }
    }

    for (const cachedPost of posts) {
      const live = byId.get(cachedPost.autor.id.toLowerCase());
      if (!live) return false;
      const liveVis = live.visibilidade_perfil ?? 'publico';
      const expectedBio =
        liveVis === 'privado' ? null : (live.biografia ?? null);
      if (
        live.nome !== cachedPost.autor.nome ||
        live.username !== cachedPost.autor.username ||
        (live.avatar_url ?? null) !== cachedPost.autor.avatarUrl ||
        expectedBio !== cachedPost.autor.biografia
      ) {
        return false;
      }
    }

    return true;
  }

  private async findRelatedPublicUsers(
    publicSeeds: DirectUserSeedRow[],
    excludeIds: Types.ObjectId[],
  ): Promise<Types.ObjectId[]> {
    if (!publicSeeds.length) return [];

    const publicSeedIds = publicSeeds.map((seed) => seed._id);
    const seedStackSet = new Map<string, Types.ObjectId>();
    for (const seed of publicSeeds) {
      for (const stackId of seed.stack_ids ?? []) {
        const key = stackId.toString();
        if (!seedStackSet.has(key)) {
          seedStackSet.set(key, stackId);
          if (seedStackSet.size >= MAX_SEED_STACKS) break;
        }
      }
      if (seedStackSet.size >= MAX_SEED_STACKS) break;
    }
    const seedStackIds = [...seedStackSet.values()];

    const relations = await this.seguidores
      .find({
        status: 'aceito',
        $or: [
          { seguidor_id: { $in: publicSeedIds } },
          { seguido_id: { $in: publicSeedIds } },
        ],
      })
      .sort({ aceito_em: -1, _id: -1 })
      .limit(MAX_SEED_CONNECTIONS)
      .select('seguidor_id seguido_id')
      .maxTimeMS(QUERY_TIMEOUT_MS)
      .lean()
      .exec();

    const seedIdStrings = new Set(publicSeedIds.map((id) => id.toString()));
    const excludeStrings = new Set(excludeIds.map((id) => id.toString()));
    const connectedMap = new Map<string, Types.ObjectId>();
    for (const rel of relations) {
      for (const candidate of [rel.seguidor_id, rel.seguido_id]) {
        const key = candidate.toString();
        if (!seedIdStrings.has(key) && !excludeStrings.has(key)) {
          connectedMap.set(key, candidate);
        }
      }
    }
    const connectedIds = [...connectedMap.values()];

    const relatedBranches: Array<Record<string, unknown>> = [];
    if (seedStackIds.length) {
      relatedBranches.push({ stack_ids: { $in: seedStackIds } });
    }
    if (connectedIds.length) {
      relatedBranches.push({ _id: { $in: connectedIds } });
    }
    if (!relatedBranches.length) return [];

    const relatedUsers = await this.usuarios
      .find({
        status: 'ativo',
        visibilidade_perfil: { $ne: 'privado' },
        ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {}),
        $or: relatedBranches,
      })
      .sort({ 'contadores.score': -1, _id: -1 })
      .limit(MAX_RELATED_USERS)
      .select('_id')
      .maxTimeMS(QUERY_TIMEOUT_MS)
      .lean()
      .exec();

    return relatedUsers.map((user) => user._id);
  }

  private buildDirectUserMatch(
    parsed: NormalizedSearchInput,
    matchedTechIds: Types.ObjectId[],
    viewerObjectId: Types.ObjectId | null,
  ): Record<string, unknown> {
    const canSearchExtendedProfile = viewerObjectId
      ? {
          $or: [
            { visibilidade_perfil: { $ne: 'privado' } },
            { _id: viewerObjectId },
          ],
        }
      : { visibilidade_perfil: { $ne: 'privado' } };

    const identityMatch = {
      $and: parsed.tokenSources.map((src) => ({
        $or: [
          { username: { $regex: src, $options: 'i' } },
          { nome: { $regex: src, $options: 'i' } },
        ],
      })),
    };

    const bioMatch = {
      $and: [
        canSearchExtendedProfile,
        ...parsed.tokenSources.map((src) => ({
          biografia: { $regex: src, $options: 'i' },
        })),
      ],
    };

    const branches: Array<Record<string, unknown>> = [identityMatch, bioMatch];
    if (matchedTechIds.length) {
      branches.push({
        $and: [
          canSearchExtendedProfile,
          { stack_ids: { $in: matchedTechIds } },
        ],
      });
    }

    return {
      status: 'ativo',
      $or: branches,
    };
  }

  private buildUserScoreSortExpr(
    viewerObjectId: Types.ObjectId | null,
  ): Record<string, unknown> {
    const isPrivateForViewer = viewerObjectId
      ? {
          $and: [
            { $eq: ['$visibilidade_perfil', 'privado'] },
            { $ne: ['$_id', viewerObjectId] },
          ],
        }
      : { $eq: ['$visibilidade_perfil', 'privado'] };

    return {
      $cond: [isPrivateForViewer, 0, { $ifNull: ['$contadores.score', 0] }],
    };
  }

  private buildUserRelevanceExpr(
    parsed: NormalizedSearchInput,
    matchedTechIds: Types.ObjectId[],
    viewerObjectId: Types.ObjectId | null,
    relatedPublicUserIds: Types.ObjectId[],
  ): Record<string, unknown> {
    let fallback: number | Record<string, unknown> = 4;
    if (relatedPublicUserIds.length) {
      const canUseExtended = viewerObjectId
        ? {
            $or: [
              { $ne: ['$visibilidade_perfil', 'privado'] },
              { $eq: ['$_id', viewerObjectId] },
            ],
          }
        : { $ne: ['$visibilidade_perfil', 'privado'] };

      const bioMatchExpr = {
        $and: parsed.tokenSources.map((src) => ({
          $regexMatch: {
            input: { $ifNull: ['$biografia', ''] },
            regex: src,
            options: 'i',
          },
        })),
      };

      const extendedBranches: Array<Record<string, unknown>> = [bioMatchExpr];
      if (matchedTechIds.length) {
        extendedBranches.push({
          $gt: [
            {
              $size: {
                $setIntersection: [
                  { $ifNull: ['$stack_ids', []] },
                  matchedTechIds,
                ],
              },
            },
            0,
          ],
        });
      }

      const isDirectExtended = {
        $and: [canUseExtended, { $or: extendedBranches }],
      };
      fallback = { $cond: [isDirectExtended, 4, 5] };
    }

    const tokensMatchExpr = {
      $and: parsed.tokenSources.map((src) => ({
        $or: [
          {
            $regexMatch: {
              input: { $ifNull: ['$username', ''] },
              regex: src,
              options: 'i',
            },
          },
          {
            $regexMatch: {
              input: { $ifNull: ['$nome', ''] },
              regex: src,
              options: 'i',
            },
          },
        ],
      })),
    };

    const fromTokens: Record<string, unknown> = {
      $cond: [tokensMatchExpr, 3, fallback],
    };
    const fromNamePrefix: Record<string, unknown> = {
      $cond: [
        {
          $regexMatch: {
            input: { $ifNull: ['$nome', ''] },
            regex: parsed.prefixSource,
            options: 'i',
          },
        },
        2,
        fromTokens,
      ],
    };
    const fromUserPrefix: Record<string, unknown> = {
      $cond: [
        {
          $regexMatch: {
            input: { $ifNull: ['$username', ''] },
            regex: parsed.prefixSource,
            options: 'i',
          },
        },
        1,
        fromNamePrefix,
      ],
    };

    if (!parsed.handleCandidate) return fromUserPrefix;
    return {
      $cond: [
        { $eq: ['$username', parsed.handleCandidate] },
        0,
        fromUserPrefix,
      ],
    };
  }

  private async executeUserSearch(
    signals: SearchSignals,
    limit: number,
    position: { relevancia: number; score: number; id: Types.ObjectId } | null,
  ) {
    const directMatch = this.buildDirectUserMatch(
      signals.parsed,
      signals.matchedTechIds,
      signals.viewerObjectId,
    );

    const matchCondition = signals.relatedPublicUserIds.length
      ? {
          status: 'ativo',
          $or: [
            directMatch,
            {
              visibilidade_perfil: { $ne: 'privado' },
              _id: { $in: signals.relatedPublicUserIds },
            },
          ],
        }
      : directMatch;

    const pipeline: PipelineStage[] = [
      { $match: matchCondition },
      {
        $addFields: {
          relevancia: this.buildUserRelevanceExpr(
            signals.parsed,
            signals.matchedTechIds,
            signals.viewerObjectId,
            signals.relatedPublicUserIds,
          ),
          scoreOrdenacao: this.buildUserScoreSortExpr(signals.viewerObjectId),
        },
      },
      ...(position
        ? [
            {
              $match: {
                $or: [
                  { relevancia: { $gt: position.relevancia } },
                  {
                    relevancia: position.relevancia,
                    scoreOrdenacao: { $lt: position.score },
                  },
                  {
                    relevancia: position.relevancia,
                    scoreOrdenacao: position.score,
                    _id: { $lt: position.id },
                  },
                ],
              },
            },
          ]
        : []),
      { $sort: { relevancia: 1, scoreOrdenacao: -1, _id: -1 } },
      { $limit: limit + 1 },
      {
        $project: {
          _id: 1,
          nome: 1,
          username: 1,
          biografia: 1,
          avatar_url: 1,
          visibilidade_perfil: 1,
          stack_ids: 1,
          'contadores.score': 1,
          relevancia: 1,
          scoreOrdenacao: 1,
        },
      },
    ];

    const found = await this.usuarios
      .aggregate<UserSearchRow>(pipeline)
      .option({ maxTimeMS: QUERY_TIMEOUT_MS })
      .exec();

    const hasMore = found.length > limit;
    const page = found.slice(0, limit);
    const last = page.at(-1);
    const items = this.formatUserItems(
      page,
      signals.viewerObjectId,
      signals.techById,
    );

    return {
      items,
      nextCursor:
        hasMore && last
          ? this.cursor.encodeUsers(
              {
                relevancia: last.relevancia,
                score: last.scoreOrdenacao,
                id: last._id,
              },
              {
                queryHash: signals.parsed.queryHash,
                viewerId: signals.effectiveViewerId ?? null,
              },
            )
          : null,
      hasMore,
    };
  }

  private formatUserItems(
    rows: UserSearchRow[],
    viewerObjectId: Types.ObjectId | null,
    techById: Map<string, BuscaTecnologiaItem>,
  ): BuscaUsuarioItem[] {
    return rows.map((row) => {
      const visibility = row.visibilidade_perfil ?? 'publico';
      const isPrivateForViewer =
        visibility === 'privado' &&
        (!viewerObjectId || !row._id.equals(viewerObjectId));

      if (isPrivateForViewer) {
        return {
          id: row._id.toString(),
          nome: row.nome,
          username: row.username,
          avatarUrl: row.avatar_url ?? null,
          biografia: null,
          visibilidadePerfil: 'privado',
          stacks: [],
          score: null,
          relacionado: false,
        };
      }

      return {
        id: row._id.toString(),
        nome: row.nome,
        username: row.username,
        avatarUrl: row.avatar_url ?? null,
        biografia: row.biografia ?? null,
        visibilidadePerfil: visibility,
        stacks: (row.stack_ids ?? [])
          .map((id) => techById.get(id.toString()))
          .filter((tech): tech is BuscaTecnologiaItem => tech !== undefined),
        score: row.contadores?.score ?? 0,
        relacionado: row.relevancia === 5,
      };
    });
  }

  private async executePublicationSearch(
    signals: SearchSignals,
    limit: number,
    order: BuscaOrder,
    position: {
      tier: 0 | 1;
      publishedAt: Date;
      score?: number;
      id: Types.ObjectId;
    } | null,
  ) {
    const visibility = await this.access.listVisibility(
      signals.effectiveViewerId,
    );

    const contentMatch = {
      $and: signals.parsed.tokenSources.map((src) => ({
        conteudo: { $regex: src, $options: 'i' },
      })),
    };

    const contentMatchExpr = {
      $and: signals.parsed.tokenSources.map((src) => ({
        $regexMatch: {
          input: { $ifNull: ['$conteudo', ''] },
          regex: src,
          options: 'i',
        },
      })),
    };

    const orBranches: Array<Record<string, unknown>> = [contentMatch];
    if (signals.directAuthorIds.length) {
      orBranches.push({ autor_id: { $in: signals.directAuthorIds } });
    }
    if (signals.relatedPublicUserIds.length) {
      orBranches.push({ autor_id: { $in: signals.relatedPublicUserIds } });
    }

    const directPostExprBranches: Array<Record<string, unknown>> = [
      contentMatchExpr,
    ];
    if (signals.directAuthorIds.length) {
      directPostExprBranches.push({
        $in: ['$autor_id', signals.directAuthorIds],
      });
    }

    const ranked = order === 'score';
    const cursorMatch: Record<string, unknown> | null = position
      ? ranked
        ? {
            $or: [
              { tier: { $gt: position.tier } },
              {
                tier: position.tier,
                scoreOrdenacao: { $lt: position.score! },
              },
              {
                tier: position.tier,
                scoreOrdenacao: position.score!,
                dataOrdenacao: { $lt: position.publishedAt },
              },
              {
                tier: position.tier,
                scoreOrdenacao: position.score!,
                dataOrdenacao: position.publishedAt,
                _id: { $lt: position.id },
              },
            ],
          }
        : {
            $or: [
              { tier: { $gt: position.tier } },
              {
                tier: position.tier,
                dataOrdenacao: { $lt: position.publishedAt },
              },
              {
                tier: position.tier,
                dataOrdenacao: position.publishedAt,
                _id: { $lt: position.id },
              },
            ],
          }
      : null;

    const baseStages: PipelineStage[] = [
      {
        $match: {
          $and: [
            { status: 'publicada' },
            visibility as Record<string, unknown>,
            { $or: orBranches },
          ],
        },
      },
      {
        $addFields: {
          tier: {
            $cond: [{ $or: directPostExprBranches }, 0, 1],
          },
          scoreOrdenacao: { $ifNull: ['$contadores.score', 0] },
          dataOrdenacao: { $ifNull: ['$publicada_em', '$criada_em'] },
        },
      },
      ...(cursorMatch ? [{ $match: cursorMatch }] : []),
      {
        $sort: ranked
          ? { tier: 1, scoreOrdenacao: -1, dataOrdenacao: -1, _id: -1 }
          : { tier: 1, dataOrdenacao: -1, _id: -1 },
      },
    ];

    const authorLookupStage: PipelineStage = {
      $lookup: {
        from: 'usuarios',
        localField: 'autor_id',
        foreignField: '_id',
        pipeline: [
          { $match: { status: 'ativo' } },
          {
            $project: {
              _id: 1,
              nome: 1,
              username: 1,
              biografia: 1,
              avatar_url: 1,
              visibilidade_perfil: 1,
            },
          },
        ],
        as: 'author',
      },
    };

    const preLimit = (limit + 1) * PUBLICATION_PRELIMIT_MULTIPLIER;
    const rawFound = await this.publicacoes
      .aggregate<RawPublicationLookupRow>([
        ...baseStages,
        { $limit: preLimit },
        authorLookupStage,
      ])
      .option({ maxTimeMS: QUERY_TIMEOUT_MS })
      .exec();

    let found: PublicationSearchRow[] = this.extractActivePublicationRows(
      rawFound,
    ).slice(0, limit + 1);

    if (rawFound.length >= preLimit && found.length <= limit) {
      const fallbackFound = await this.publicacoes
        .aggregate<PublicationSearchRow>([
          ...baseStages,
          authorLookupStage,
          { $unwind: '$author' },
          { $limit: limit + 1 },
        ])
        .option({ maxTimeMS: QUERY_TIMEOUT_MS })
        .exec();
      found = this.extractActivePublicationRows(fallbackFound);
    }

    const hasMore = found.length > limit;
    const page = found.slice(0, limit);
    const last = page.at(-1);

    const cacheable = page.every(
      (row) =>
        row.visibilidade === 'publico' &&
        !row.votos_projecao_pendente &&
        !row.votos_operacoes_pendentes?.length &&
        !row.salvamentos_projecao_pendente &&
        !row.salvamentos_operacoes_pendentes?.length,
    );

    return {
      cacheable,
      page: {
        items: page.map((row) =>
          this.publicationResponses.toResponse(
            this.publicacoes.hydrate(row),
            this.usuarios.hydrate(row.author),
            signals.effectiveViewerId,
          ),
        ),
        nextCursor:
          hasMore && last
            ? this.cursor.encodePublications(
                {
                  tier: last.tier,
                  publishedAt:
                    last.dataOrdenacao ?? last.publicada_em ?? last.criada_em,
                  ...(ranked ? { score: last.scoreOrdenacao } : {}),
                  id: last._id,
                },
                {
                  queryHash: signals.parsed.queryHash,
                  viewerId: signals.effectiveViewerId ?? null,
                  order,
                },
              )
            : null,
        hasMore,
      },
    };
  }

  private extractActivePublicationRows(
    rows: RawPublicationLookupRow[],
  ): PublicationSearchRow[] {
    const out: PublicationSearchRow[] = [];
    for (const row of rows) {
      const author = Array.isArray(row.author) ? row.author[0] : row.author;
      if (!author) continue;
      out.push(
        Object.assign({}, row, {
          dataOrdenacao: row.dataOrdenacao ?? row.publicada_em ?? row.criada_em,
          author,
        }),
      );
    }
    return out;
  }

  private toTechItem(
    tech: Pick<Tecnologia, 'nome' | 'slug' | 'categoria' | 'icone_url'> & {
      _id: Types.ObjectId;
    },
  ): BuscaTecnologiaItem {
    return {
      id: tech._id.toString(),
      nome: tech.nome,
      slug: tech.slug,
      categoria: tech.categoria ?? null,
      iconeUrl: tech.icone_url ?? null,
    };
  }
}
