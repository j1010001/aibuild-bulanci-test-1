// M2 task 3: bots against the real server over real sockets — the headless multiplayer
// path an AI harness uses — and the bot CLI end to end.

import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BotPlayer } from '../../src/client/botPlayer';
import { NetSession } from '../../src/net/client';
import { startServer, type RunningServer } from '../../server/server';

let server: RunningServer;
let url: string;

beforeAll(async () => {
  server = await startServer({ port: 0 });
  url = `ws://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

async function until(fn: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('bots over the real server', () => {
  it('three bots fill a room and play a match to a winner that everyone agrees on', async () => {
    const host = new BotPlayer(new NetSession(url, { kind: 'create' }, 'Host'), { host: { mapId: 'open', targetScore: 1 } });
    host.connect();
    await until(() => host.view.code !== null, 3000);
    const guests = ['Bo', 'Cy'].map((n) => new BotPlayer(new NetSession(url, { kind: 'join', code: host.view.code! }, n)));
    for (const g of guests) g.connect();
    const bots = [host, ...guests];

    const timer = setInterval(() => {
      for (const b of bots) b.step(performance.now());
    }, 30);
    try {
      await until(() => bots.every((b) => b.view.screen === 'matchEnd'), 20_000);
    } finally {
      clearInterval(timer);
    }
    const result = host.view.result!;
    expect(result.winnerId).not.toBeNull();
    for (const b of guests) expect(b.view.result).toEqual(result);
    for (const b of bots) b.close();
  }, 30_000);

  it('the bot CLI creates a room, fills it and reports the winner', async () => {
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn('npx', ['tsx', 'scripts/bot.ts', '--server', url, '--create', '--count', '2', '--map', 'open', '--target-score', '1', '--once'], {
        cwd: process.cwd(),
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += String(d)));
      child.stderr.on('data', (d) => (stdout += String(d)));
      child.on('close', (code) => resolve({ code, stdout }));
    });
    expect(out.stdout).toMatch(/room [A-Z0-9]{5}/);
    expect(out.stdout).toMatch(/winner: /);
    expect(out.code).toBe(0);
  }, 45_000);
});
