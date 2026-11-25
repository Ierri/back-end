import { Types } from 'mongoose';
import type { PublicacoesCacheClient } from '../publicacoes/publicacoes-cache.client.js';
import { PublicacoesCacheService } from '../publicacoes/publicacoes-cache.service.js';
import { BuscaCacheService } from './busca-cache.service.js';

const userId = '000000000000000000000011';
const postId = '000000000000000000000022';
const techId = '000000000000000000000033';
const publishedAt = new Date('2026-11-24T12:00:00.000Z');

class FakeCacheClient {
  enabled = true;
  prefix = 'ierri:cache:publicacoes:v1:';
  feedTtl = 20;
  postTtl = 45;
  authorTtl = 30;
  searchTtl = 15;
  techTtl = 300;
  available = true;
  now = 0;
  values = new Map<string, { value: string; expires: number }>();

  async get(key: string) {
    if (!this.available) return undefined;
    const entry = this.values.get(key);
    if (!entry || entry.expires <= this.now) return null;
    return entry.value;
  }

  async set(key: string, value: string, seconds: number) {
    if (!this.available) return false;
    this.values.set(key, { value, expires: this.now + seconds * 1000 });
    return true;
  }

  async del(key: string) {
    this.values.delete(key);
  }

  async invalidate(keys: string[]) {
    if (!this.available) return false;
    for (const key of keys) {
      const old = Number((await this.get(key)) ?? '0');
      await this.set(key, String(old + 1), 86_400);
    }
    return true;
  }
}

function sampleOverview() {
  return {
    usuarios: {
      items: [
        {
          id: userId,
          nome: 'Júlio César',
          username: 'julio',
          avatarUrl: null,
          biografia: 'Interfaces',
          visibilidadePerfil: 'publico' as const,
          stacks: [
            {
              id: techId,
              nome: 'React',
              slug: 'react',
              categoria: 'Frontend',
              iconeUrl: '/brand/react.svg',
            },
          ],
          score: 10,
          relacionado: false,
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
    publicacoes: {
      items: [
        {
          id: postId,
          slug: 'post-busca',
          autor: {
            id: userId,
            nome: 'Júlio César',
            username: 'julio',
            biografia: 'Interfaces',
            avatarUrl: null,
          },
          conteudo: 'Dashboard em React',
          midias: [
            {
              id: '000000000000000000000044',
              tipo: 'imagem' as const,
              url: 'http://127.0.0.1:3001/publicacoes/midias/ref12345678901234',
              mimeType: 'image/png',
              tamanhoBytes: 120,
              largura: 100,
              altura: 100,
              duracaoSegundos: null,
              textoAlternativo: null,
              ordem: 0,
            },
          ],
          visibilidade: 'publico' as const,
          status: 'publicada' as const,
          contadores: {
            upvotes: 5,
            downvotes: 0,
            score: 5,
            comentarios: 1,
            salvamentos: 2,
          },
          publicadaEm: publishedAt,
          editadaEm: null,
          criadaEm: publishedAt,
          atualizadaEm: publishedAt,
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
    tecnologias: {
      items: [
        {
          id: techId,
          nome: 'React',
          slug: 'react',
          categoria: 'Frontend',
          iconeUrl: '/brand/react.svg',
        },
      ],
      hasMore: false,
    },
  };
}

describe('BuscaCacheService', () => {
  function setup() {
    const client = new FakeCacheClient();
    const typedClient = client as unknown as PublicacoesCacheClient;
    return {
      client,
      buscaCache: new BuscaCacheService(typedClient),
      pubCache: new PublicacoesCacheService(typedClient),
    };
  }

  it('armazena, expira e expurga JSON corrompido ou payload privado indevido', async () => {
    const { client, buscaCache } = setup();
    const address = (await buscaCache.overviewAddress(
      'qhash',
      10,
      'recentes',
    ))!;
    expect(await buscaCache.readOverview(address)).toBeNull();

    const overview = sampleOverview();
    await buscaCache.writeOverview(address, overview);
    expect(await buscaCache.readOverview(address)).toEqual(overview);

    // JSON corrompido deve ser apagado e tratado como miss
    client.values.set(address.key, { value: '{corrompido', expires: 30_000 });
    expect(await buscaCache.readOverview(address)).toBeNull();
    expect(client.values.has(address.key)).toBe(false);

    // Perfil privado com biografia/stacks preenchidos deve ser rejeitado pelo schema estrito
    const leaked = sampleOverview();
    leaked.usuarios.items[0] = {
      ...leaked.usuarios.items[0],
      visibilidadePerfil: 'privado' as unknown as 'publico',
      biografia: 'Vazamento proibido',
    };
    await buscaCache.writeOverview(address, leaked);
    expect(await buscaCache.readOverview(address)).toBeNull();

    // Post com visibilidade != publico nunca é gravado
    const followerPost = sampleOverview();
    (
      followerPost.publicacoes.items[0] as unknown as { visibilidade: string }
    ).visibilidade = 'seguidores';
    await buscaCache.writeOverview(address, followerPost);
    expect(await buscaCache.readOverview(address)).toBeNull();

    // Expiração por TTL
    await buscaCache.writeOverview(address, overview);
    client.now = 15_001;
    expect(await buscaCache.readOverview(address)).toBeNull();
  });

  it('invalida sinais e páginas ao incrementar generation:feed ou generation:techs e bloqueia late stale fill', async () => {
    const { client, buscaCache, pubCache } = setup();
    const oldSignals = (await buscaCache.signalsAddress('qhash'))!;
    const oldTechs = (await buscaCache.techCatalogAddress())!;

    await pubCache.invalidate(postId, userId);
    expect(await buscaCache.isCurrent(oldSignals)).toBe(false);
    expect(await buscaCache.isCurrent(oldTechs)).toBe(true);

    // Escrita atrasada após invalidação é descartada
    await buscaCache.writeSignals(oldSignals, {
      matchedTechIds: [techId],
      publicDirectAuthorIds: [userId],
      relatedPublicUserIds: [],
    });
    expect(client.values.has(oldSignals.key)).toBe(false);

    await pubCache.invalidateTechnologies();
    expect(await buscaCache.isCurrent(oldTechs)).toBe(false);
    const newTechs = (await buscaCache.techCatalogAddress())!;
    expect(newTechs.key).not.toBe(oldTechs.key);
  });

  it('isola chaves por página, cursor, limite e ordem, faz coalesce e falha aberto quando indisponível', async () => {
    const { client, buscaCache } = setup();
    const id = new Types.ObjectId(postId);
    const first = (await buscaCache.publicationsPageAddress(
      'qhash',
      20,
      'recentes',
      null,
    ))!;
    const ranked = (await buscaCache.publicationsPageAddress(
      'qhash',
      20,
      'score',
      { tier: 0, publishedAt, score: 10, id },
    ))!;
    expect(first.key).not.toBe(ranked.key);

    let release!: (val: string) => void;
    const loader = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const concurrent = Array.from({ length: 8 }, () =>
      buscaCache.coalesce('k1', loader),
    );
    await Promise.resolve();
    expect(loader).toHaveBeenCalledOnce();
    release('ok');
    expect(await Promise.all(concurrent)).toEqual(Array(8).fill('ok'));

    client.available = false;
    expect(await buscaCache.signalsAddress('qhash')).toBeNull();
    client.enabled = false;
    expect(await buscaCache.techCatalogAddress()).toBeNull();
  });
});
