// M2 task 2: the browser's network Session, run in Node against the real server (Node 25
// has the same global WebSocket the browser does, so this is the exact client code).

import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NetSession } from '../../src/net/client';
import { startServer, type RunningServer } from '../../server/server';
import type { ServerMessage } from '../../src/session/protocol';

let server: RunningServer;
let url: string;

beforeAll(async () => {
  server = await startServer({ port: 0 });
  url = `ws://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

async function until<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function open(target: ConstructorParameters<typeof NetSession>[1], name = 'Ann') {
  const session = new NetSession(url, target, name);
  const inbox: ServerMessage[] = [];
  const closes: string[] = [];
  session.onMessage((m) => inbox.push(m));
  session.onClose((reason) => closes.push(reason));
  const find = <T extends ServerMessage['type']>(type: T) =>
    [...inbox].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
  return { session, inbox, closes, find };
}

describe('NetSession', () => {
  it('creates a room on connect, and a second session joins it by code', async () => {
    const a = open({ kind: 'create' });
    const { code } = await until(() => a.find('roomJoined'));
    const b = open({ kind: 'join', code }, 'Bo');
    await until(() => b.find('roomJoined'));
    const lobby = await until(() => (a.find('lobby')?.players.length === 2 ? a.find('lobby') : undefined));
    expect(lobby.players.map((p) => p.name)).toEqual(['Ann', 'Bo']);
    a.session.close();
    b.session.close();
  });

  // Test change, with justification (review): one queued message could not show ordering.
  // Two whose order is visible in the result can: the last setSkin wins.
  it('delivers messages sent before the socket opened, after the join and in order', async () => {
    const a = open({ kind: 'create' });
    a.session.send({ type: 'setSkin', skinId: 'teal' }); // queued: the socket is still connecting
    a.session.send({ type: 'setSkin', skinId: 'gold' });
    const lobbies = () => a.inbox.filter((m) => m.type === 'lobby') as Extract<ServerMessage, { type: 'lobby' }>[];
    await until(() => (lobbies().at(-1)?.players[0]?.skinId === 'gold' ? true : undefined));
    expect(lobbies().map((l) => l.players[0]!.skinId)).toEqual(['crimson', 'teal', 'gold']);
    a.session.close();
  });

  it('plays a match end to end: ready, start, input, snapshots', async () => {
    const a = open({ kind: 'create' });
    const { code, playerId } = await until(() => a.find('roomJoined'));
    const b = open({ kind: 'join', code }, 'Bo');
    await until(() => b.find('roomJoined'));
    b.session.send({ type: 'setReady', ready: true });
    await until(() => (a.find('lobby')?.canStart ? true : undefined));
    a.session.send({ type: 'setMap', mapId: 'open' });
    a.session.send({ type: 'startMatch' });
    await until(() => b.find('matchStart'));
    const x0 = (await until(() => a.find('snapshot'))).state.players.find((p) => p.id === playerId)!.pos.x;
    a.session.send({ type: 'input', seq: 1, moveDir: x0 > 20 ? '-X' : '+X', shoot: false });
    await until(() => {
      const x = a.find('snapshot')!.state.players.find((p) => p.id === playerId)!.pos.x;
      return Math.abs(x - x0) > 1 ? true : undefined;
    });
    a.session.close();
    b.session.close();
  });

  it('reports a close by the server once, and a rejoin with the token restores the same player', async () => {
    const a = open({ kind: 'create' });
    const { code, playerId, reconnectToken } = await until(() => a.find('roomJoined'));
    const b = open({ kind: 'join', code }, 'Bo'); // keeps the room alive while A is away
    await until(() => b.find('roomJoined'));

    const a2 = open({ kind: 'rejoin', code, reconnectToken });
    expect((await until(() => a2.find('roomJoined'))).playerId).toBe(playerId);
    await until(() => (a.closes.length > 0 ? true : undefined)); // the replaced session is closed by the server
    await new Promise((r) => setTimeout(r, 50));
    expect(a.closes).toHaveLength(1);
    expect(a.find('replaced')).toBeDefined();
    a2.session.close();
    b.session.close();
  });

  it('reports a malformed server address as a close instead of throwing', async () => {
    let session: NetSession | null = null;
    expect(() => {
      session = new NetSession('localhost:8787', { kind: 'create' }, 'Ann'); // no scheme: the WebSocket constructor throws
    }).not.toThrow();
    const closes: string[] = [];
    session!.onClose((r) => closes.push(r));
    await until(() => (closes.length > 0 ? true : undefined));
    expect(closes).toEqual([expect.stringMatching(/address/)]);
  });

  it('gives up on a server that accepts the connection but never answers', async () => {
    const sockets: Socket[] = [];
    const blackHole: TcpServer = createTcpServer((s) => void sockets.push(s)); // never completes the handshake
    await new Promise<void>((r) => blackHole.listen(0, r));
    const port = (blackHole.address() as { port: number }).port;
    try {
      const session = new NetSession(`ws://127.0.0.1:${port}`, { kind: 'create' }, 'Ann', { connectTimeoutMs: 200 });
      const closes: string[] = [];
      session.onClose((r) => closes.push(r));
      await until(() => (closes.length > 0 ? true : undefined), 2000);
      expect(closes).toEqual([expect.stringMatching(/reach/)]);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => blackHole.close(() => r()));
    }
  });

  it('reports a drop after a successful connection as a lost connection, not an unreachable server', async () => {
    const tmp = await startServer({ port: 0 });
    const session = new NetSession(`ws://127.0.0.1:${tmp.port}`, { kind: 'create' }, 'Ann');
    const inbox: ServerMessage[] = [];
    const closes: string[] = [];
    session.onMessage((m) => inbox.push(m));
    session.onClose((r) => closes.push(r));
    await until(() => (inbox.some((m) => m.type === 'roomJoined') ? true : undefined));
    await tmp.close(); // terminates the socket: no close frame, code 1006
    await until(() => (closes.length > 0 ? true : undefined));
    expect(closes).toEqual([expect.stringMatching(/lost/)]);
  });

  it('close() before the socket opens: reported once, and nothing is delivered', async () => {
    const a = open({ kind: 'create' });
    a.session.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(a.closes).toHaveLength(1);
    expect(a.inbox).toHaveLength(0);
  });

  it('reports a failure to connect as a close', async () => {
    const dead = new NetSession('ws://127.0.0.1:1', { kind: 'create' }, 'Ann');
    const closes: string[] = [];
    dead.onClose((r) => closes.push(r));
    await until(() => (closes.length > 0 ? true : undefined));
    expect(closes).toHaveLength(1);
  });

  it('close() from our side is reported once and later sends are ignored', async () => {
    const a = open({ kind: 'create' });
    await until(() => a.find('roomJoined'));
    a.session.close();
    a.session.send({ type: 'setReady', ready: true });
    await until(() => (a.closes.length > 0 ? true : undefined));
    await new Promise((r) => setTimeout(r, 50));
    expect(a.closes).toHaveLength(1);
  });
});
