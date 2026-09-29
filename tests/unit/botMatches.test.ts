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
async function match(opts: { seed: number; mapId: string; targetScore: number; bots: { name: string; difficulty: Difficulty }[] }, maxSeconds = 600): Promise<string | null> {
  const room = new Room({ code: 'ABCDE', seed: opts.seed });
  const bots = opts.bots.map((b, i) => {
    const session = new InProcessSession(room, i === 0 ? { kind: 'create' } : { kind: 'join', code: 'ABCDE' }, b.name);
    const bot = new BotPlayer(session, {
      difficulty: b.difficulty,
      seed: opts.seed * 100 + i,
      host: i === 0 ? { mapId: opts.mapId, targetScore: opts.targetScore } : undefined,
    });
    bot.connect();
    return bot;
  });
  let now = 0;
  for (let t = 0; t < maxSeconds * 60; t++) {
    const host = bots[0]!;
    if (host.results.length > 0) {
      const winner = host.results[0]!.winnerId;
      return winner === null ? null : (host.view.match?.players.find((p) => p.id === winner)?.name ?? winner);
    }
    for (const b of bots) b.step(now);
    if (bots.some((b) => b.view.screen === 'lobby')) await new Promise((r) => setTimeout(r, 0));
    room.tick(1 / 60);
    now += 1000 / 60;
  }
  throw new Error(`match (seed ${opts.seed}, ${opts.mapId}) did not finish in ${maxSeconds} simulated seconds`);
}

describe('bot-only matches finish on every map, at every difficulty', () => {
  const cases = BUILT_IN_MAPS.flatMap((m) => (['easy', 'normal', 'hard'] as const).map((d) => [m.id, d] as const));
  it.each(cases)('%s, %s: three bots play a match to a winner', async (mapId, difficulty) => {
    const winner = await match({
      seed: 7,
      mapId,
      targetScore: 2,
      bots: ['A', 'B', 'C'].map((name) => ({ name, difficulty })),
    });
    expect(winner).not.toBeNull();
  }, 60_000);
});

describe('difficulty levels mean something', () => {
  it('over 20 seeded one-on-one matches on the Arena, a hard bot beats an easy bot in most of them', async () => {
    let hardWins = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const winner = await match({
        seed,
        mapId: 'default',
        targetScore: 3,
        bots: [
          { name: seed % 2 ? 'Hard' : 'Easy', difficulty: seed % 2 ? 'hard' : 'easy' },
          { name: seed % 2 ? 'Easy' : 'Hard', difficulty: seed % 2 ? 'easy' : 'hard' },
        ],
      });
      if (winner === 'Hard') hardWins++;
    }
    expect(hardWins).toBeGreaterThanOrEqual(15);
  }, 180_000);

  it('and a normal bot beats an easy bot more often than not', async () => {
    let normalWins = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const winner = await match({
        seed,
        mapId: 'default',
        targetScore: 3,
        bots: [
          { name: 'Normal', difficulty: 'normal' },
          { name: 'Easy', difficulty: 'easy' },
        ],
      });
      if (winner === 'Normal') normalWins++;
    }
    expect(normalWins).toBeGreaterThanOrEqual(6);
  }, 120_000);
});
