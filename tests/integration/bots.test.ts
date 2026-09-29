// M2 task 3: bots against the real server over real sockets — the headless multiplayer
// path an AI harness uses — and the bot CLI end to end.

import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BotPlayer } from '../../src/client/botPlayer';
import { NetSession } from '../../src/net/client';
import { startServer, type RunningServer } from '../../server/server';
import { RoomRegistry } from '../../server/rooms';

let server: RunningServer;
let url: string;

beforeAll(async () => {
  // Seeded rooms: spawns are reproducible, so a strategy bug shows up every run, not sometimes.
  server = await startServer({ port: 0, registry: new RoomRegistry({ roomOptions: { seed: 11 } }) });
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
      await until(() => bots.every((b) => b.results.length >= 1), 20_000);
    } finally {
      clearInterval(timer);
    }
    const result = host.results[0]!;
    expect(result.winnerId).not.toBeNull();
    for (const b of guests) expect(b.results[0]).toEqual(result);
    for (const b of bots) b.close();
  }, 30_000);

  // Test change, with justification (review finding 1): "matchEnd" is no longer where bots
  // stay after a match; results are read from `results` instead.
  function cli(args: string[]): Promise<{ code: number | null; stdout: string; ms: number }> {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn('npx', ['tsx', 'scripts/bot.ts', ...args], { cwd: process.cwd() });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += String(d)));
      child.stderr.on('data', (d) => (stdout += String(d)));
      child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }));
    });
  }

  it('the bot CLI creates a room, fills it and reports the winner', async () => {
    const out = await cli(['--server', url, '--create', '--count', '2', '--map', 'open', '--target-score', '1', '--once']);
    expect(out.stdout).toMatch(/room [A-Z0-9]{5}/);
    expect(out.stdout).toMatch(/winner: /);
    expect(out.code).toBe(0);
  }, 45_000);

  it('the bot CLI also finishes on the default map (walls and all)', async () => {
    const out = await cli(['--server', url, '--create', '--count', '2', '--target-score', '1', '--once', '--timeout', '40']);
    expect(out.stdout).toMatch(/winner: /);
    expect(out.code).toBe(0);
  }, 60_000);

  it('the bot CLI fails fast, with the reason, when the server is unreachable', async () => {
    const out = await cli(['--server', 'ws://127.0.0.1:1', '--create', '--once', '--timeout', '30']);
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/reach/);
    expect(out.ms).toBeLessThan(15_000); // not the 30 s timeout
  }, 30_000);

  it('the bot CLI refuses invalid options before connecting', async () => {
    for (const args of [
      ['--target-score', '0'],
      ['--round-time', '5'],
      ['--map', 'nope'],
      ['--strategy', 'dance'],
      ['--count', '2.5'],
    ]) {
      const out = await cli(['--server', 'ws://127.0.0.1:1', '--create', ...args]);
      expect(out.code, args.join(' ')).toBe(1);
      expect(out.stdout, args.join(' ')).not.toMatch(/reach/); // refused before any connection attempt
    }
  }, 60_000);
});
