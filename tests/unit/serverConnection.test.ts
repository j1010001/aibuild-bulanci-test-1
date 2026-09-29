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

  it('refuses room messages before joining, and any second create/join/rejoin after joining', () => {
    const registry = new RoomRegistry();
    const a = connect(registry);
    a.msg({ type: 'setReady', ready: true });
    expect(a.last('error')).toBeDefined();
    a.msg({ type: 'createRoom', name: 'Ann' });
    const { code, reconnectToken } = a.last('roomJoined');
    a.msg({ type: 'createRoom', name: 'Ann again' });
    a.msg({ type: 'joinRoom', code, name: 'Ann again' });
    a.msg({ type: 'rejoin', code, reconnectToken });
    expect(registry.size).toBe(1);
    expect(a.sent.filter((m) => m.type === 'error')).toHaveLength(4);
  });

  it('refuses to create a room when the server is at its room limit', () => {
    const registry = new RoomRegistry({ maxRooms: 1 });
    connect(registry).msg({ type: 'createRoom', name: 'Ann' });
    const b = connect(registry);
    b.msg({ type: 'createRoom', name: 'Bo' });
    expect(b.last('joinRejected').reason).toBe('serverFull');
    expect(registry.size).toBe(1);
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

  it('closes a connection that sends an oversized message (1009), counting bytes not characters', () => {
    const registry = new RoomRegistry();
    const a = connect(registry, { maxMessageBytes: 1024 });
    a.handler.onMessage(JSON.stringify({ type: 'createRoom', name: 'é'.repeat(600) })); // 600 chars, 1200 bytes
    expect(a.closed?.code).toBe(1009);
  });

  it('closes a connection that sends a binary frame (1003)', () => {
    const registry = new RoomRegistry();
    const a = connect(registry);
    a.handler.onBinary();
    expect(a.closed?.code).toBe(1003);
  });

  it('closes a socket after repeated failed joins, so codes cannot be enumerated from one connection (1008)', () => {
    const registry = new RoomRegistry();
    const a = connect(registry);
    for (let i = 0; i < 5; i++) a.msg({ type: 'joinRoom', code: 'ZZZZZ', name: 'Bo' });
    expect(a.closed).toBeNull();
    a.msg({ type: 'joinRoom', code: 'ZZZZZ', name: 'Bo' });
    expect(a.closed?.code).toBe(1008);
  });

  it('closes a connection that floods messages faster than the rate limit', () => {
    let now = 0;
    const registry = new RoomRegistry();
    const a = connect(registry, { maxMessagesPerSecond: 10, burst: 20, now: () => now });
    a.msg({ type: 'createRoom', name: 'Ann' });
    for (let i = 0; i < 50; i++) a.msg({ type: 'setReady', ready: i % 2 === 0 });
    expect(a.closed?.code).toBe(1008);

    // a steady rate under the limit is fine
    const b = connect(registry, { maxMessagesPerSecond: 10, burst: 20, now: () => now });
    b.msg({ type: 'createRoom', name: 'Bo' });
    for (let i = 0; i < 100; i++) {
      now += 200; // 5 messages per second
      b.msg({ type: 'setReady', ready: i % 2 === 0 });
    }
    expect(b.closed).toBeNull();
  });

  it('enforces the default limits: 4 KB messages and a burst of 60', () => {
    const registry = new RoomRegistry();
    const big = connect(registry);
    big.handler.onMessage(JSON.stringify({ type: 'createRoom', name: 'x'.repeat(4100) }));
    expect(big.closed?.code).toBe(1009);

    let now = 0;
    const a = connect(registry, { now: () => now });
    for (let i = 0; i < 60; i++) a.msg({ type: 'setReady', ready: true });
    expect(a.closed).toBeNull();
    a.msg({ type: 'setReady', ready: true });
    expect(a.closed?.code).toBe(1008);
  });

  it('a clock that steps backwards does not trip the rate limiter', () => {
    let now = 10_000;
    const registry = new RoomRegistry();
    const a = connect(registry, { maxMessagesPerSecond: 10, burst: 20, now: () => now });
    for (let i = 0; i < 10; i++) {
      now -= 1000;
      a.msg({ type: 'setReady', ready: true });
    }
    expect(a.closed).toBeNull();
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
    expect(b.sent.at(-1)).toEqual({ type: 'replaced' });
    expect(b.closed?.code).toBe(4000); // the server closed the replaced socket
    expect(a.last('lobby').players.find((p) => p.id === playerId)!.connected).toBe(true);
    expect(a.sent.some((m) => m.type === 'event' && m.event.kind === 'playerLeft')).toBe(false);

    b2.msg({ type: 'setReady', ready: true });
    await settle();
    expect(a.last('lobby').players.find((p) => p.id === playerId)!.ready).toBe(true);
  });

  it('after a leave, the socket is unbound: its later close cannot drop a rejoined player, and it may join again', async () => {
    const registry = new RoomRegistry();
    const a = connect(registry);
    a.msg({ type: 'createRoom', name: 'Ann' });
    const { code } = a.last('roomJoined');
    const b = connect(registry);
    b.msg({ type: 'joinRoom', code, name: 'Bo' });
    const c = connect(registry);
    c.msg({ type: 'joinRoom', code, name: 'Cy' });
    b.msg({ type: 'setReady', ready: true });
    c.msg({ type: 'setReady', ready: true });
    await settle();
    a.msg({ type: 'startMatch' });
    await settle();

    const { playerId, reconnectToken } = b.last('roomJoined');
    b.msg({ type: 'leave' });
    const b2 = connect(registry);
    b2.msg({ type: 'rejoin', code, reconnectToken });
    expect(b2.last('roomJoined').playerId).toBe(playerId);
    const leftEvents = () => a.sent.filter((m) => m.type === 'event' && m.event.kind === 'playerLeft').length;
    const before = leftEvents();
    b.close(); // the old socket goes away after the leave
    expect(leftEvents()).toBe(before);

    const lobbyLeaver = connect(registry);
    lobbyLeaver.msg({ type: 'createRoom', name: 'Dee' });
    lobbyLeaver.msg({ type: 'leave' });
    lobbyLeaver.msg({ type: 'createRoom', name: 'Dee' });
    expect(lobbyLeaver.sent.filter((m) => m.type === 'roomJoined')).toHaveLength(2);
    expect(lobbyLeaver.sent.some((m) => m.type === 'error')).toBe(false);
  });

  it('closing every socket while a match is starting leaves no game behind', async () => {
    const registry = new RoomRegistry();
    const a = connect(registry);
    a.msg({ type: 'createRoom', name: 'Ann' });
    const { code } = a.last('roomJoined');
    const room = registry.get(code)!;
    const b = connect(registry);
    b.msg({ type: 'joinRoom', code, name: 'Bo' });
    b.msg({ type: 'setReady', ready: true });
    await settle();
    a.msg({ type: 'startMatch' }); // async start begins
    a.close();
    b.close();
    await settle();
    expect(registry.size).toBe(0);
    expect(room.gameApi).toBeNull();
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
