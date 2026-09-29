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

type Peer = { ws: WebSocket; inbox: ServerMessage[] };

async function peer(): Promise<Peer> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const inbox: ServerMessage[] = [];
  ws.addEventListener('message', (e) => inbox.push(JSON.parse(String(e.data)) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('socket error')), { once: true });
  });
  return { ws, inbox };
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
