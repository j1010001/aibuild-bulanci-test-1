// M2 task 1: the real server over real sockets — started in-process on an ephemeral
// port, driven by Node's built-in WebSocket client.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../server/server';
import type { ServerMessage } from '../../src/session/protocol';

let server: RunningServer;

beforeAll(async () => {
  server = await startServer({ port: 0 });
});

afterAll(async () => {
  await server.close();
});

type Peer = { ws: WebSocket; inbox: ServerMessage[]; closeCode: () => number | null };

async function peer(port = server.port): Promise<Peer> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: ServerMessage[] = [];
  let closeCode: number | null = null;
  ws.addEventListener('message', (e) => inbox.push(JSON.parse(String(e.data)) as ServerMessage));
  ws.addEventListener('close', (e) => {
    closeCode = e.code;
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('socket error')), { once: true });
  });
  return { ws, inbox, closeCode: () => closeCode };
}

async function until<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function find<T extends ServerMessage['type']>(p: Peer, type: T): Extract<ServerMessage, { type: T }> | undefined {
  return [...p.inbox].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
}

describe('game server over WebSocket', () => {
  it('answers a health check', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
  });

  it('runs create → join → ready → start, then streams snapshots at about 30 Hz', async () => {
    const a = await peer();
    a.ws.send(JSON.stringify({ type: 'createRoom', name: 'Ann' }));
    const { code } = await until(() => find(a, 'roomJoined'));

    const b = await peer();
    b.ws.send(JSON.stringify({ type: 'joinRoom', code, name: 'Bo' }));
    await until(() => find(b, 'roomJoined'));
    b.ws.send(JSON.stringify({ type: 'setReady', ready: true }));
    await until(() => (find(a, 'lobby')?.canStart ? true : undefined));

    a.ws.send(JSON.stringify({ type: 'startMatch' }));
    await until(() => find(b, 'matchStart'));

    const first = b.inbox.filter((m) => m.type === 'snapshot').length;
    await new Promise((r) => setTimeout(r, 500));
    const received = b.inbox.filter((m) => m.type === 'snapshot').length - first;
    expect(received).toBeGreaterThanOrEqual(10); // ~15 expected in 0.5 s; generous for CI jitter
    expect(received).toBeLessThanOrEqual(20);

    a.ws.close();
    b.ws.close();
  });

  it('a dropped socket is reported to the others', async () => {
    const a = await peer();
    a.ws.send(JSON.stringify({ type: 'createRoom', name: 'Ann' }));
    const { code } = await until(() => find(a, 'roomJoined'));
    const b = await peer();
    b.ws.send(JSON.stringify({ type: 'joinRoom', code, name: 'Bo' }));
    const { playerId } = await until(() => find(b, 'roomJoined'));
    b.ws.close();
    await until(() => a.inbox.find((m) => m.type === 'event' && m.event.kind === 'playerLeft' && m.event.playerId === playerId));
    a.ws.close();
  });
});

describe('game server over WebSocket: protection and lifecycle', () => {
  it('a rejoin from a new socket replaces the old one, which is closed with 4000', async () => {
    const a = await peer();
    a.ws.send(JSON.stringify({ type: 'createRoom', name: 'Ann' }));
    const { code, reconnectToken, playerId } = await until(() => find(a, 'roomJoined'));
    const a2 = await peer();
    a2.ws.send(JSON.stringify({ type: 'rejoin', code, reconnectToken }));
    expect((await until(() => find(a2, 'roomJoined'))).playerId).toBe(playerId);
    expect(await until(() => a.closeCode() ?? undefined)).toBe(4000);
    a2.ws.close();
  });

  it('closes a socket that sends a frame over 4 KB (1009) or a binary frame (1003)', async () => {
    const big = await peer();
    big.ws.send('x'.repeat(5000));
    expect(await until(() => big.closeCode() ?? undefined)).toBe(1009);
    const bin = await peer();
    bin.ws.send(new Uint8Array([1, 2, 3]));
    expect(await until(() => bin.closeCode() ?? undefined)).toBe(1003);
  });

  it('refuses connections beyond maxConnections (1013) and a port already in use', async () => {
    const small = await startServer({ port: 0, maxConnections: 2 });
    try {
      const p1 = await peer(small.port);
      const p2 = await peer(small.port);
      const p3 = await peer(small.port);
      expect(await until(() => p3.closeCode() ?? undefined)).toBe(1013);
      expect(p1.closeCode()).toBeNull();
      expect(p2.closeCode()).toBeNull();
      await expect(startServer({ port: small.port })).rejects.toThrow(/EADDRINUSE|in use/);
      p1.ws.close();
      p2.ws.close();
    } finally {
      await small.close();
    }
  });

  it('the heartbeat keeps a healthy client connected', async () => {
    const hb = await startServer({ port: 0, heartbeatMs: 50 });
    try {
      const p = await peer(hb.port);
      await new Promise((r) => setTimeout(r, 300)); // several heartbeat rounds; Node's client answers pings
      expect(p.closeCode()).toBeNull();
      p.ws.close();
    } finally {
      await hb.close();
    }
  });

  it('close() shuts every client connection', async () => {
    const tmp = await startServer({ port: 0 });
    const p = await peer(tmp.port);
    await tmp.close();
    expect(await until(() => p.closeCode() ?? undefined)).not.toBeUndefined();
  });

  it('GET /health only; other methods are not allowed', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
