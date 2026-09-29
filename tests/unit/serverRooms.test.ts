// M2 task 1: the server's room registry (room codes, lookup, ticking every room, and
// discarding empty rooms — spec §12 "Rooms and flow", §14 "Everyone leaves").

import { beforeAll, describe, expect, it } from 'vitest';
import { CODE_ALPHABET, randomCode, RoomRegistry } from '../../server/rooms';
import { ensureRapierReady } from '../../src/physics/rapier';
import type { ServerMessage } from '../../src/session/protocol';

beforeAll(async () => {
  await ensureRapierReady();
});

describe('randomCode', () => {
  it('is 5 characters from an alphabet without look-alikes (no 0/O, 1/I/L)', () => {
    for (let i = 0; i < 500; i++) {
      const code = randomCode();
      expect(code).toMatch(/^[A-Z0-9]{5}$/);
      for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
    }
    for (const ambiguous of ['0', 'O', '1', 'I', 'L']) expect(CODE_ALPHABET).not.toContain(ambiguous);
  });
});

describe('RoomRegistry', () => {
  it('creates rooms with unique codes, even when the code generator collides', () => {
    const codes = ['AAAAA', 'AAAAA', 'BBBBB'];
    const registry = new RoomRegistry({ newCode: () => codes.shift()! });
    const a = registry.create();
    const b = registry.create();
    expect(a.code).toBe('AAAAA');
    expect(b.code).toBe('BBBBB');
    expect(registry.get('AAAAA')).toBe(a);
    expect(registry.get('ZZZZZ')).toBeUndefined();
  });

  it('ticks every room', async () => {
    const registry = new RoomRegistry();
    const room = registry.create();
    const inbox: ServerMessage[] = [];
    const a = room.join('Ann', (m) => inbox.push(m));
    const b = room.join('Bo', () => {});
    if (!a.ok || !b.ok) throw new Error('join failed');
    await room.handle(b.playerId, { type: 'setReady', ready: true });
    await room.handle(a.playerId, { type: 'startMatch' });
    const before = inbox.filter((m) => m.type === 'snapshot').length;
    for (let i = 0; i < 4; i++) registry.tickAll(1 / 60);
    expect(inbox.filter((m) => m.type === 'snapshot').length).toBe(before + 2);
  });

  it('discards a room once nobody is connected, disposing it', () => {
    const registry = new RoomRegistry();
    const room = registry.create();
    const a = room.join('Ann', () => {});
    if (!a.ok) throw new Error('join failed');
    registry.removeIfEmpty(room.code);
    expect(registry.get(room.code)).toBe(room); // still has a connected player
    room.disconnect(a.playerId);
    registry.removeIfEmpty(room.code);
    expect(registry.get(room.code)).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('tickAll also sweeps rooms that became empty', () => {
    const registry = new RoomRegistry();
    const room = registry.create();
    const a = room.join('Ann', () => {});
    if (!a.ok) throw new Error('join failed');
    room.disconnect(a.playerId);
    registry.tickAll(1 / 60);
    expect(registry.size).toBe(0);
  });
});
