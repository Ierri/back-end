import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { z } from 'zod';
import { PublicacoesCacheClient } from './publicacoes-cache.client.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const cachedDate = z.iso.datetime().transform((value) => new Date(value));
const mediaUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
});
const media = z.strictObject({
  id: objectId,
  tipo: z.enum(['imagem', 'video']),
  url: mediaUrl,
  mimeType: z.string(),
  tamanhoBytes: z.number().int().positive(),
  largura: z.number().int().positive().nullable(),
  altura: z.number().int().positive().nullable(),
  duracaoSegundos: z.number().positive().nullable(),
  textoAlternativo: z.string().nullable(),
  ordem: z.number().int().nonnegative(),
});
const post = z.strictObject({
  id: objectId,
  slug: z.string(),
  autor: z.strictObject({
    id: objectId,
    nome: z.string(),
    username: z.string(),
    biografia: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  conteudo: z.string(),
  midias: z.array(media).min(1).max(10),
  visibilidade: z.literal('publico'),
  status: z.literal('publicada'),
  contadores: z.strictObject({
    upvotes: z.number(),
    downvotes: z.number(),
    score: z.number(),
    comentarios: z.number(),
    salvamentos: z.number(),
  }),
  publicadaEm: cachedDate,
  editadaEm: cachedDate.nullable(),
  criadaEm: cachedDate,
  atualizadaEm: cachedDate,
});
const page = z.strictObject({
  items: z.array(post).max(50),
  nextCursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{40,512}$/)
    .nullable(),
  hasMore: z.boolean(),
});

export type CachedPublicacao = z.infer<typeof post>;
export type CachedPublicacoesPage = z.infer<typeof page>;

type CacheAddress = {
  key: string;
  generationKey: string;
  generation: string;
  ttl: number;
};

@Injectable()
export class PublicacoesCacheService {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly counters = {
    hit: 0,
    miss: 0,
    error: 0,
    invalidation: 0,
    mongoAfterMiss: 0,
  };

  constructor(
    @Inject(PublicacoesCacheClient)
    private readonly client: PublicacoesCacheClient,
  ) {}

  metrics() {
    return { ...this.counters };
  }

  countMongoAfterMiss() {
    this.counters.mongoAfterMiss++;
  }

  countHit() {
    this.counters.hit++;
  }

  countStaleMiss() {
    this.counters.miss++;
  }

  async pageAddress(
    limit: number,
    authorId: string | null,
    position: { publishedAt: Date; id: Types.ObjectId } | null,
    owner: boolean,
  ): Promise<CacheAddress | null> {
    if (owner || !this.client.enabled) return null;
    const generationKey = authorId
      ? `${this.client.prefix}generation:author:${this.hash(authorId)}`
      : `${this.client.prefix}generation:feed`;
    const generation = await this.generation(generationKey);
    if (generation === null) return null;
    const filter = this.hash(
      JSON.stringify({
        limit,
        authorId,
        position: position
          ? [position.publishedAt.getTime(), position.id.toString()]
          : null,
      }),
    );
    return {
      key: `${this.client.prefix}${authorId ? 'author' : 'feed'}:${filter}:${generation}`,
      generationKey,
      generation,
      ttl: authorId ? this.client.authorTtl : this.client.feedTtl,
    };
  }

  async postAddress(id: string): Promise<CacheAddress | null> {
    if (!this.client.enabled) return null;
    const digest = this.hash(id.toLowerCase());
    const generationKey = `${this.client.prefix}generation:post:${digest}`;
    const generation = await this.generation(generationKey);
    if (generation === null) return null;
    return {
      key: `${this.client.prefix}post:${digest}:${generation}`,
      generationKey,
      generation,
      ttl: this.client.postTtl,
    };
  }

  async readPage(address: CacheAddress): Promise<CachedPublicacoesPage | null> {
    return this.read(address, page);
  }

  async readPost(address: CacheAddress): Promise<CachedPublicacao | null> {
    return this.read(address, post);
  }

  async writePage(address: CacheAddress, value: unknown) {
    await this.write(address, value, page);
  }

  async writePost(address: CacheAddress, value: unknown) {
    await this.write(address, value, post);
  }

  async isCurrent(address: CacheAddress) {
    const generation = await this.generation(address.generationKey);
    return generation !== null && generation === address.generation;
  }

  async invalidate(id: string, authorId: string) {
    if (!this.client.enabled) return;
    const keys = [
      `${this.client.prefix}generation:feed`,
      `${this.client.prefix}generation:author:${this.hash(authorId.toLowerCase())}`,
      `${this.client.prefix}generation:post:${this.hash(id.toLowerCase())}`,
    ];
    if (await this.client.invalidate(keys)) this.counters.invalidation++;
    else this.counters.error++;
  }

  async coalesce<T>(key: string, load: () => Promise<T>): Promise<T> {
    const current = this.pending.get(key);
    if (current) return current as Promise<T>;
    const loading = Promise.resolve().then(load);
    this.pending.set(key, loading);
    try {
      return await loading;
    } finally {
      if (this.pending.get(key) === loading) this.pending.delete(key);
    }
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
    address: CacheAddress,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    const raw = await this.client.get(address.key);
    if (raw === undefined) {
      this.counters.error++;
      this.counters.miss++;
      return null;
    }
    if (raw === null) {
      this.counters.miss++;
      return null;
    }
    try {
      const parsed = schema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {}
    this.counters.error++;
    this.counters.miss++;
    await this.client.del(address.key);
    return null;
  }

  private async write<T>(
    address: CacheAddress,
    value: unknown,
    schema: z.ZodType<T>,
  ) {
    try {
      const serialized = JSON.stringify(value);
      if (
        Buffer.byteLength(serialized) > 262_144 ||
        !schema.safeParse(JSON.parse(serialized)).success
      ) {
        this.counters.error++;
        return;
      }
      if (!(await this.isCurrent(address))) return;
      if (!(await this.client.set(address.key, serialized, address.ttl)))
        this.counters.error++;
    } catch {
      this.counters.error++;
    }
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
