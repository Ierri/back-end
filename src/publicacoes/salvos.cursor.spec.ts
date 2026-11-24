import type { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { SalvosCursor } from './salvos.cursor.js';

describe('SalvosCursor', () => {
  const cursor = new SalvosCursor({ getOrThrow: () => 'unit-test-secret-for-saved-cursors' } as unknown as ConfigService);
  const userId = new Types.ObjectId().toString();
  const position = { savedAt: new Date('2026-11-24T12:00:00.000Z'), id: new Types.ObjectId() };

  it('round-trips an opaque cursor bound to the owner', () => {
    const encoded = cursor.encode(position, userId);
    expect(encoded).not.toContain(position.id.toString());
    expect(encoded).not.toContain(userId);
    expect(cursor.decode(encoded, userId)).toEqual(position);
  });

  it('rejects another user, tampering and malformed encoding', () => {
    const encoded = cursor.encode(position, userId);
    expect(() => cursor.decode(encoded, new Types.ObjectId().toString())).toThrow();
    expect(() => cursor.decode(`${encoded.slice(0, -1)}!`, userId)).toThrow();
    expect(() => cursor.decode('invalid', userId)).toThrow();
  });
});
