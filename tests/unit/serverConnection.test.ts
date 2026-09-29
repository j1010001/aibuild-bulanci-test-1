// M2 task 1: the per-connection adapter between a socket and the rooms (spec §12). Tested
// with fake connections: the real WebSocket layer only forwards text and close events to it.

import { beforeAll, describe, expect, it } from 'vitest';
import { ConnectionHandler, type Connection } from '../../server/connection';
import { RoomRegistry } from '../../server/rooms';
import { ensureRapierReady } from '../../src/physics/rapier';
import type { ServerMessage } from '../../src/session/protocol';

beforeAll(async () => {
  await ensureRapierReady();
});

class FakeConn implements Connection {
  sent: ServerMessage[] = [];
  closed: { code?: number; reason?: string } | null = null;
  handler!: ConnectionHandler;
  send(text: string): void {
    this.sent.push(JSON.parse(text) as ServerMessage);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.handler.onClose(); // a real socket reports its own close
  }
  msg(obj: unknown): void {
    this.handler.onMessage(JSON.stringify(obj));
  }
  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> {
    const m = [...this.sent].reverse().find((x) => x.type === type);
    if (!m) throw new Error(`no ${type}`);
    return m as Extract<ServerMessage, { type: T }>;
  }
}

function connect(registry: RoomRegistry, opts: ConstructorParameters<typeof ConnectionHandler>[2] = {}): FakeConn {
  const conn = new FakeConn();
  conn.handler = new ConnectionHandler(registry, conn, opts);
  return conn;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('ConnectionHandler: joining', () => {
  it('createRoom creates a room and joins its creator as owner', () => {
    const registry = new RoomRegistry();
    const a = connect(registry);
    a.msg({ type: 'createRoom', name: 'Ann' });
    const joined = a.last('roomJoined');
    expect(registry.get(joined.code)).toBeDefined();
    expect(a.last('lobby').ownerId).toBe(joined.playerId);
  });

  it('joinRoom joins an existing room by code (case-insensitive)', () => {
    const registry = new RoomRegistry();
    const a = connect(registry);
    a.msg({ type: 'createRoom', name: 'Ann' });
    const code = a.last('roomJoined').code;
    const b = connect(registry);
    b.msg({ type: 'joinRoom', code: code.toLowerCase(), name: 'Bo' });
    expect(b.last('roomJoined').code).toBe(code);
    expect(a.last('lobby').players.map((p) => p.name)).toEqual(['Ann', 'Bo']);
  });

  it('rejects an unknown room code', () => {
    const registry = new RoomRegistry();
    const b = connect(registry);
    b.msg({ type: 'joinRoom', code: 'ZZZZZ', name: 'Bo' });
    expect(b.last('joinRejected').reason).toBe('notFound');
  });

  it('refuses room messages before joining, and a second join after joining', () => {
    const registry = new RoomRegistry();
    const a = connect(registry);
    a.msg({ type: 'setReady', ready: true });
    expect(a.last('error')).toBeDefined();
    a.msg({ type: 'createRoom', name: 'Ann' });
    a.msg({ type: 'createRoom', name: 'Ann again' });
    expect(registry.size).toBe(1);
    expect(a.sent.filter((m) => m.type === 'error')).toHaveLength(2);
  });

  it('forwards room messages from a joined connection to its room', async () => {
    const registry = new RoomRegistry();
    const a = connect(registry);
    a.msg({ type: 'createRoom', name: 'Ann' });
    const b = connect(registry);
    b.msg({ type: 'joinRoom', code: a.last('roomJoined').code, name: 'Bo' });
    b.msg({ type: 'setReady', ready: true });
    await settle();
    expect(a.last('lobby').canStart).toBe(true);
    a.msg({ type: 'startMatch' });
    await settle();
    expect(b.last('matchStart')).toBeDefined();
  });
});

describe('ConnectionHandler: hostile or broken input', () => {
  it('ignores text that is not JSON or not a valid message', () => {
    const registry = new RoomRegistry();
    const a = connect(registry);
    a.handler.onMessage('not json {');
    a.msg({ type: 'hack' });
    expect(a.closed).toBeNull();
    expect(registry.size).toBe(0);
  });

  it('closes a connection that sends an oversized message', () => {
    const registry = new RoomRegistry();
    const a = connect(registry, { maxMessageBytes: 1024 });
    a.handler.onMessage(JSON.stringify({ type: 'createRoom', name: 'x'.repeat(2000) }));
    expect(a.closed).not.toBeNull();
  });

  it('closes a connection that floods messages faster than the rate limit', () => {
    let now = 0;
    const registry = new RoomRegistry();
    const a = connect(registry, { maxMessagesPerSecond: 10, burst: 20, now: () => now });
    a.msg({ type: 'createRoom', name: 'Ann' });
    for (let i = 0; i < 50; i++) a.msg({ type: 'setReady', ready: i % 2 === 0 });
    expect(a.closed).not.toBeNull();

    // a steady rate under the limit is fine
    const b = connect(registry, { maxMessagesPerSecond: 10, burst: 20, now: () => now });
    b.msg({ type: 'createRoom', name: 'Bo' });
    for (let i = 0; i < 100; i++) {
      now += 200; // 5 messages per second
      b.msg({ type: 'setReady', ready: i % 2 === 0 });
    }
    expect(b.closed).toBeNull();
  });
});

describe('ConnectionHandler: leaving and reconnecting', () => {
  it('a closed connection disconnects its player, and the last one discards the room', () => {
    const registry = new RoomRegistry();
    const a = connect(registry);
    a.msg({ type: 'createRoom', name: 'Ann' });
    const code = a.last('roomJoined').code;
    const b = connect(registry);
    b.msg({ type: 'joinRoom', code, name: 'Bo' });
    b.close();
    expect(a.sent).toContainEqual({ type: 'event', event: { kind: 'playerLeft', playerId: b.last('roomJoined').playerId } });
    a.close();
    expect(registry.get(code)).toBeUndefined();
  });

  it('rejoin with a token replaces a still-open old connection; closing the old one does not drop the player', async () => {
    const registry = new RoomRegistry();
    const a = connect(registry);
    a.msg({ type: 'createRoom', name: 'Ann' });
    const { code } = a.last('roomJoined');
    const b = connect(registry);
    b.msg({ type: 'joinRoom', code, name: 'Bo' });
    const { playerId, reconnectToken } = b.last('roomJoined');

    const b2 = connect(registry);
    b2.msg({ type: 'rejoin', code, reconnectToken });
    expect(b2.last('roomJoined').playerId).toBe(playerId);
    expect(b.closed).not.toBeNull(); // the server closed the replaced socket
    expect(a.last('lobby').players.find((p) => p.id === playerId)!.connected).toBe(true);
    expect(a.sent.some((m) => m.type === 'event' && m.event.kind === 'playerLeft')).toBe(false);

    b2.msg({ type: 'setReady', ready: true });
    await settle();
    expect(a.last('lobby').players.find((p) => p.id === playerId)!.ready).toBe(true);
  });

  it('rejects a rejoin to an unknown room or with a bad token', () => {
    const registry = new RoomRegistry();
    const a = connect(registry);
    a.msg({ type: 'createRoom', name: 'Ann' });
    const b = connect(registry);
    b.msg({ type: 'rejoin', code: 'ZZZZZ', reconnectToken: 'x' });
    expect(b.last('joinRejected').reason).toBe('notFound');
    const c = connect(registry);
    c.msg({ type: 'rejoin', code: a.last('roomJoined').code, reconnectToken: 'nope' });
    expect(c.last('joinRejected').reason).toBe('badToken');
  });
});
