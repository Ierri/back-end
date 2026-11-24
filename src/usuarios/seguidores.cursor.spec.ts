import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { SeguidoresCursor } from './seguidores.cursor.js';

describe('SeguidoresCursor', () => {
  const cursor = new SeguidoresCursor({
    getOrThrow: () => 'test-secret-key-with-at-least-32-bytes',
  } as unknown as ConfigService);
  const userId = new Types.ObjectId().toString();
  const position = { date: new Date('2026-11-01T12:00:00.000Z'), id: new Types.ObjectId() };

  it('round-trips the position and binds the cursor to list and profile', () => {
    const value = cursor.encode(position, { kind: 'seguidores', userId });
    expect(cursor.decode(value, { kind: 'seguidores', userId })).toEqual(position);
    expect(() => cursor.decode(value, { kind: 'seguindo', userId })).toThrow();
    expect(() => cursor.decode(value, { kind: 'seguidores', userId: new Types.ObjectId().toString() })).toThrow();
  });

  it('rejects corrupted or malformed cursors', () => {
    const value = cursor.encode(position, { kind: 'solicitacoes', userId });
    expect(() => cursor.decode(`${value.slice(0, -1)}${value.at(-1) === 'A' ? 'B' : 'A'}`, { kind: 'solicitacoes', userId })).toThrow();
    expect(() => cursor.decode('invalid', { kind: 'solicitacoes', userId })).toThrow();
  });
});
