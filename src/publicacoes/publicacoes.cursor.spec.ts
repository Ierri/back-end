import type { ConfigService } from '@nestjs/config';
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
});
