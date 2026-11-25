import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { z } from 'zod';
import { PublicacoesCacheClient } from '../publicacoes/publicacoes-cache.client.js';
import { cachedPublicacaoSchema } from '../publicacoes/publicacoes-cache.service.js';
import type { CachedPublicacao } from '../publicacoes/publicacoes-cache.service.js';
import type { BuscaOrder } from './dto/busca.dto.js';

const MAX_PAYLOAD_BYTES = 262_144;

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const cursorToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{28,512}$/)
  .nullable();

const techItemSchema = z.strictObject({
  id: objectId,
  nome: z.string().min(1).max(80),
  slug: z.string().min(1).max(80),
  categoria: z.string().max(80).nullable(),
  iconeUrl: z.string().nullable(),
});

const cachedTechCatalogSchema = z.array(techItemSchema).max(500);

const cachedSignalsSchema = z.strictObject({
  matchedTechIds: z.array(objectId).max(10),
  publicDirectAuthorIds: z.array(objectId).max(30),
  relatedPublicUserIds: z.array(objectId).max(20),
});

const userItemSchema = z
  .strictObject({
    id: objectId,
    nome: z.string(),
    username: z.string(),
    avatarUrl: z.string().nullable(),
    biografia: z.string().nullable(),
    visibilidadePerfil: z.enum(['publico', 'privado']),
    stacks: z.array(techItemSchema).max(20),
    score: z.number().int().nullable(),
    relacionado: z.boolean(),
  })
  .refine(
    (user) =>
      user.visibilidadePerfil !== 'privado' ||
      (user.biografia === null &&
        user.stacks.length === 0 &&
        user.score === null &&
        user.relacionado === false),
  );

const cachedUsersPageSchema = z.strictObject({
  items: z.array(userItemSchema).max(20),
  nextCursor: cursorToken,
  hasMore: z.boolean(),
});

const cachedPublicationsPageSchema = z.strictObject({
  items: z.array(cachedPublicacaoSchema).max(20),
  nextCursor: cursorToken,
  hasMore: z.boolean(),
});

const cachedOverviewSchema = z.strictObject({
  usuarios: cachedUsersPageSchema,
  publicacoes: cachedPublicationsPageSchema,
  tecnologias: z.strictObject({
    items: z.array(techItemSchema).max(20),
    hasMore: z.boolean(),
  }),
});

export type CachedTechItem = z.infer<typeof techItemSchema>;
export type CachedPublicSignals = z.infer<typeof cachedSignalsSchema>;
export type CachedUsersPage = z.infer<typeof cachedUsersPageSchema>;
export type CachedSearchPost = CachedPublicacao;
export type CachedPublicationsPage = z.infer<
  typeof cachedPublicationsPageSchema
>;
export type CachedSearchOverview = z.infer<typeof cachedOverviewSchema>;

export type BuscaCacheAddress = {
  key: string;
  generations: Array<{ key: string; value: string }>;
  ttl: number;
};

@Injectable()
export class BuscaCacheService {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly counters = {
    techHit: 0,
    techMiss: 0,
    signalsHit: 0,
    signalsMiss: 0,
    pageHit: 0,
    pageMiss: 0,
    staleMiss: 0,
    error: 0,
  };

  constructor(
    @Inject(PublicacoesCacheClient)
    private readonly client: PublicacoesCacheClient,
  ) {}

  get enabled() {
    return this.client.enabled;
  }

  metrics() {
    return { ...this.counters };
  }

  countTechHit() {
    this.counters.techHit++;
  }

  countSignalsHit() {
    this.counters.signalsHit++;
  }

  countPageHit() {
    this.counters.pageHit++;
  }

  countStaleMiss() {
    this.counters.staleMiss++;
  }

  async evict(address: BuscaCacheAddress): Promise<void> {
    await this.client.del(address.key);
  }

  async techCatalogAddress(): Promise<BuscaCacheAddress | null> {
    if (!this.client.enabled) return null;
    const techGenKey = `${this.client.prefix}generation:techs`;
    const techGen = await this.generation(techGenKey);
    if (techGen === null) return null;
    return {
      key: `${this.client.prefix}busca:techs:${techGen}`,
      generations: [{ key: techGenKey, value: techGen }],
      ttl: this.client.techTtl ?? 300,
    };
  }

  async signalsAddress(queryHash: string): Promise<BuscaCacheAddress | null> {
    const gens = await this.searchGenerations();
    if (!gens) return null;
    const baseTtl = this.client.searchTtl ?? 15;
    return {
      key: `${this.client.prefix}busca:signals:${queryHash}:${gens.suffix}`,
      generations: gens.entries,
      ttl: Math.min(3600, baseTtl + 5),
    };
  }

  async overviewAddress(
    queryHash: string,
    limit: number,
    order: BuscaOrder,
  ): Promise<BuscaCacheAddress | null> {
    const gens = await this.searchGenerations();
    if (!gens) return null;
    const filter = this.hash(JSON.stringify({ queryHash, limit, order }));
    return {
      key: `${this.client.prefix}busca:all:${filter}:${gens.suffix}`,
      generations: gens.entries,
      ttl: this.client.searchTtl ?? 15,
    };
  }

  async usersPageAddress(
    queryHash: string,
    limit: number,
    position: { relevancia: number; score: number; id: Types.ObjectId } | null,
  ): Promise<BuscaCacheAddress | null> {
    const gens = await this.searchGenerations();
    if (!gens) return null;
    const filter = this.hash(
      JSON.stringify({
        queryHash,
        limit,
        position: position
          ? [position.relevancia, position.score, position.id.toString()]
          : null,
      }),
    );
    return {
      key: `${this.client.prefix}busca:users:${filter}:${gens.suffix}`,
      generations: gens.entries,
      ttl: this.client.searchTtl ?? 15,
    };
  }

  async publicationsPageAddress(
    queryHash: string,
    limit: number,
    order: BuscaOrder,
    position: {
      tier: 0 | 1;
      publishedAt: Date;
      score?: number;
      id: Types.ObjectId;
    } | null,
  ): Promise<BuscaCacheAddress | null> {
    const gens = await this.searchGenerations();
    if (!gens) return null;
    const filter = this.hash(
      JSON.stringify({
        queryHash,
        limit,
        order,
        position: position
          ? [
              position.tier,
              position.publishedAt.getTime(),
              position.score ?? null,
              position.id.toString(),
            ]
          : null,
      }),
    );
    return {
      key: `${this.client.prefix}busca:pubs:${filter}:${gens.suffix}`,
      generations: gens.entries,
      ttl: this.client.searchTtl ?? 15,
    };
  }

  readTechCatalog(address: BuscaCacheAddress) {
    return this.read(address, cachedTechCatalogSchema, 'techMiss');
  }

  writeTechCatalog(address: BuscaCacheAddress, value: unknown) {
    return this.write(address, value, cachedTechCatalogSchema);
  }

  readSignals(address: BuscaCacheAddress) {
    return this.read(address, cachedSignalsSchema, 'signalsMiss');
  }

  writeSignals(address: BuscaCacheAddress, value: unknown) {
    return this.write(address, value, cachedSignalsSchema);
  }

  readOverview(address: BuscaCacheAddress) {
    return this.read(address, cachedOverviewSchema, 'pageMiss');
  }

  writeOverview(address: BuscaCacheAddress, value: unknown) {
    return this.write(address, value, cachedOverviewSchema);
  }

  readUsersPage(address: BuscaCacheAddress) {
    return this.read(address, cachedUsersPageSchema, 'pageMiss');
  }

  writeUsersPage(address: BuscaCacheAddress, value: unknown) {
    return this.write(address, value, cachedUsersPageSchema);
  }

  readPublicationsPage(address: BuscaCacheAddress) {
    return this.read(address, cachedPublicationsPageSchema, 'pageMiss');
  }

  writePublicationsPage(address: BuscaCacheAddress, value: unknown) {
    return this.write(address, value, cachedPublicationsPageSchema);
  }

  async isCurrent(address: BuscaCacheAddress): Promise<boolean> {
    const values = await Promise.all(
      address.generations.map((entry) => this.generation(entry.key)),
    );
    return values.every(
      (current, index) =>
        current !== null && current === address.generations[index]?.value,
    );
  }

  async coalesce<T>(key: string, load: () => Promise<T>): Promise<T> {
    const current = this.pending.get(key) as Promise<T> | undefined;
    if (current) {
      return structuredClone(await current);
    }
    const loading = Promise.resolve().then(load);
    this.pending.set(key, loading);
    try {
      const resolved = await loading;
      return structuredClone(resolved);
    } finally {
      if (this.pending.get(key) === loading) this.pending.delete(key);
    }
  }

  private async searchGenerations(): Promise<{
    entries: Array<{ key: string; value: string }>;
    suffix: string;
  } | null> {
    if (!this.client.enabled) return null;
    const feedKey = `${this.client.prefix}generation:feed`;
    const techKey = `${this.client.prefix}generation:techs`;
    const [feedGen, techGen] = await Promise.all([
      this.generation(feedKey),
      this.generation(techKey),
    ]);
    if (feedGen === null || techGen === null) return null;
    return {
      entries: [
        { key: feedKey, value: feedGen },
        { key: techKey, value: techGen },
      ],
      suffix: `${feedGen}:${techGen}`,
    };
  }

  private async generation(key: string): Promise<string | null> {
    const value = await this.client.get(key);
    if (value === undefined || (value !== null && !/^\d+$/.test(value))) {
      this.counters.error++;
      return null;
    }
    return value ?? '0';
  }

  private async read<T>(
    address: BuscaCacheAddress,
    schema: z.ZodType<T>,
    missKey: 'techMiss' | 'signalsMiss' | 'pageMiss',
  ): Promise<T | null> {
    const raw = await this.client.get(address.key);
    if (raw === undefined) {
      this.counters.error++;
      this.counters[missKey]++;
      return null;
    }
    if (raw === null) {
      this.counters[missKey]++;
      return null;
    }
    try {
      const parsed = schema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // JSON corrompido é tratado como miss e expurgado abaixo.
    }
    this.counters.error++;
    this.counters[missKey]++;
    await this.client.del(address.key);
    return null;
  }

  private async write<T>(
    address: BuscaCacheAddress,
    value: unknown,
    schema: z.ZodType<T>,
  ): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (
        Buffer.byteLength(serialized) > MAX_PAYLOAD_BYTES ||
        !schema.safeParse(JSON.parse(serialized)).success
      ) {
        this.counters.error++;
        return;
      }
      if (!(await this.isCurrent(address))) return;
      if (!(await this.client.set(address.key, serialized, address.ttl))) {
        this.counters.error++;
      }
    } catch {
      this.counters.error++;
    }
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
