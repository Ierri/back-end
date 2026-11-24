import type { ConfigService } from '@nestjs/config';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { PublicacoesCursor } from './publicacoes.cursor.js';

describe('PublicacoesCursor', () => {
  const codec = new PublicacoesCursor({
    getOrThrow: () => 'unit-test-secret-for-publication-cursors',
  } as unknown as ConfigService);
  const position = {
    publishedAt: new Date('2026-11-09T12:00:00.000Z'),
    id: new Types.ObjectId('00000000000000000000000a'),
  };
  const scope = { authorId: '00000000000000000000000b', owner: true };

  it('round-trips an opaque cursor tied to author and access scope', () => {
    const encoded = codec.encode(position, scope);
    expect(encoded).not.toContain(position.id.toString());
    expect(encoded).not.toContain(scope.authorId);
    expect(codec.decode(encoded, scope)).toEqual(position);
  });

  it('rejects tampering, malformed data and a changed access scope', () => {
    const encoded = codec.encode(position, scope);
    expect(() => codec.decode(`${encoded.slice(0, -1)}!`, scope)).toThrow();
    expect(() => codec.decode('invalid', scope)).toThrow();
    expect(() => codec.decode(encoded, { ...scope, owner: false })).toThrow();
    expect(() =>
      codec.decode(encoded, { authorId: null, owner: false }),
    ).toThrow();
  });

  it('binds a restricted list cursor to the authenticated viewer', () => {
    const viewerId = new Types.ObjectId().toString();
    const encoded = codec.encode(position, { authorId: null, owner: false, viewerId });
    expect(codec.decode(encoded, { authorId: null, owner: false, viewerId })).toEqual(position);
    expect(() => codec.decode(encoded, { authorId: null, owner: false, viewerId: new Types.ObjectId().toString() })).toThrow();
    expect(() => codec.decode(encoded, { authorId: null, owner: false })).toThrow();
  });

  it('isolates Following cursors from general and other viewers', () => {
    const viewerId = new Types.ObjectId().toString();
    const following = { authorId: null, owner: false, viewerId, feed: 'seguindo' as const };
    const general = { authorId: null, owner: false, viewerId };
    const cursor = codec.encode(position, following);
    expect(codec.decode(cursor, following)).toEqual(position);
    expect(() => codec.decode(cursor, general)).toThrow();
    expect(() => codec.decode(cursor, { ...following, viewerId: new Types.ObjectId().toString() })).toThrow();
    expect(() => codec.decode(codec.encode(position, general), following)).toThrow();
  });

  it('rejects a legacy general cursor in the Following feed', () => {
    const viewerId = new Types.ObjectId().toString();
    const iv = randomBytes(12);
    const key = createHash('sha256').update('unit-test-secret-for-publication-cursors').digest();
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const payload = Buffer.from(JSON.stringify({
      v: 2, s: 'publicada_em_desc_id_desc', t: position.publishedAt.getTime(),
      i: position.id.toString(), a: null, o: false,
    }));
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    expect(codec.decode(legacy, { authorId: null, owner: false })).toEqual(position);
    expect(() => codec.decode(legacy, { authorId: null, owner: false, viewerId, feed: 'seguindo' })).toThrow();
    expect(() => codec.decode(legacy, { authorId: null, owner: false, order: 'score' })).toThrow();
  });

  it.each([-2, 0, 3])('round-trips score %i and binds ranking to the viewer and feed', (score) => {
    const viewerId = new Types.ObjectId().toString();
    const scope = { authorId: null, owner: false, viewerId, feed: 'seguindo' as const, order: 'score' as const };
    const ranked = codec.encode({ ...position, score }, scope);
    expect(codec.decode(ranked, scope)).toEqual({ ...position, score });
    expect(() => codec.decode(ranked, { ...scope, viewerId: new Types.ObjectId().toString() })).toThrow();
    expect(() => codec.decode(ranked, { ...scope, feed: 'geral' })).toThrow();
    expect(() => codec.decode(ranked, { ...scope, order: 'cronologica' })).toThrow();
  });

  it('keeps chronological cursors valid only in chronological requests', () => {
    const general = { authorId: null, owner: false };
    const chronological = codec.encode(position, general);
    expect(codec.decode(chronological, general)).toEqual(position);
    expect(() => codec.decode(chronological, { ...general, order: 'score' })).toThrow();
    const ranked = codec.encode({ ...position, score: 0 }, { ...general, order: 'score' });
    expect(() => codec.decode(ranked, general)).toThrow();
  });
});
