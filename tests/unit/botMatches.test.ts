// M2.5 tasks 2 and 5: whole seeded bot matches, in-process (a Room, bots through
// InProcessSession, time ticked by hand) — fast and reproducible. These are the checks
// that the brain actually plays: every map and difficulty finishes, and the difficulty
// levels mean something measurable.

import { beforeAll, describe, expect, it } from 'vitest';
import { BotPlayer } from '../../src/client/botPlayer';
import type { Difficulty } from '../../src/client/bots/difficulty';
import { InProcessSession } from '../../src/client/inProcessSession';
import { ensureRapierReady } from '../../src/physics/rapier';
import { BUILT_IN_MAPS } from '../../src/session/maps';
import { Room } from '../../src/session/room';

beforeAll(async () => {
  await ensureRapierReady();
});

/** Plays one bot-only match to the end; returns the winner's name (null = no winner). */
/** Plays one bot-only match to the end; returns the winner's name (null = no winner) and how many rounds ended with nobody winning. */
async function played(opts: { seed: number; mapId: string; targetScore: number; bots: { name: string; difficulty: Difficulty }[] }, maxSeconds = 600): Promise<{ winner: string | null; draws: number }> {
  const room = new Room({ code: 'ABCDE', seed: opts.seed });
  let draws = 0;
  const bots = opts.bots.map((b, i) => {
    const session = new InProcessSession(room, i === 0 ? { kind: 'create' } : { kind: 'join', code: 'ABCDE' }, b.name);
    const bot = new BotPlayer(session, {
      difficulty: b.difficulty,
      seed: opts.seed * 100 + i,
      host: i === 0 ? { mapId: opts.mapId, targetScore: opts.targetScore } : undefined,
    });
    if (i === 0) session.onMessage((m) => {
      if (m.type === 'event' && m.event.kind === 'roundEnd' && m.event.winnerId === null) draws++;
    });
    bot.connect();
    return bot;
  });
  let now = 0;
  for (let t = 0; t < maxSeconds * 60; t++) {
    const host = bots[0]!;
    if (host.results.length > 0) {
      const winner = host.results[0]!.winnerId;
      return { winner: winner === null ? null : (host.view.match?.players.find((p) => p.id === winner)?.name ?? winner), draws };
    }
    for (const b of bots) b.step(now);
    if (bots.some((b) => b.view.screen === 'lobby')) await new Promise((r) => setTimeout(r, 0));
    room.tick(1 / 60);
    now += 1000 / 60;
  }
  throw new Error(`match (seed ${opts.seed}, ${opts.mapId}) did not finish in ${maxSeconds} simulated seconds`);
}

async function match(opts: Parameters<typeof played>[0]): Promise<string | null> {
  return (await played(opts)).winner;
}

describe('bot-only matches finish on every map, at every difficulty', () => {
  const cases = BUILT_IN_MAPS.flatMap((m) => (['easy', 'normal', 'hard'] as const).map((d) => [m.id, d] as const));
  it.each(cases)('%s, %s: three bots play a match to a winner', async (mapId, difficulty) => {
    // Two seeds each; no round may run out the clock (bots that can't reach each other).
    for (const seed of [7, 8]) {
      const { winner, draws } = await played({ seed, mapId, targetScore: 2, bots: ['A', 'B', 'C'].map((name) => ({ name, difficulty })) });
      expect(winner).not.toBeNull();
      expect(draws).toBe(0);
    }
  }, 60_000);
});

describe('difficulty levels mean something', () => {
  /** One-on-one matches on the Arena, seats alternating; how many the first level wins. */
  async function wins(better: Difficulty, worse: Difficulty, seeds: number): Promise<number> {
    let won = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const first = seed % 2 === 1;
      const winner = await match({
        seed,
        mapId: 'default',
        targetScore: 3,
        bots: first
          ? [{ name: 'Better', difficulty: better }, { name: 'Worse', difficulty: worse }]
          : [{ name: 'Worse', difficulty: worse }, { name: 'Better', difficulty: better }],
      });
      if (winner === 'Better') won++;
    }
    return won;
  }

  // Thresholds sit about two standard deviations below rates measured over 60+ seeds, so
  // they catch a level that stopped meaning something without flipping on a reseed.
  it('over 30 seeded matches, a hard bot beats an easy bot in nearly all of them', async () => {
    expect(await wins('hard', 'easy', 30)).toBeGreaterThanOrEqual(25);
  }, 240_000);

  it('a normal bot beats an easy bot in most', async () => {
    expect(await wins('normal', 'easy', 30)).toBeGreaterThanOrEqual(22);
  }, 240_000);

  it('a hard bot beats a normal bot more often than not', async () => {
    expect(await wins('hard', 'normal', 30)).toBeGreaterThanOrEqual(18);
  }, 240_000);
});
