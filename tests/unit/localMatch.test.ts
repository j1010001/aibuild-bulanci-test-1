// M2.5 task 3: a local match against bots. LocalMatchSession runs a normal (non-practice)
// Room in the page with the human plus N bots, each bot a BotPlayer on an InProcessSession;
// its tick() is the only clock (the page loop, runTicks, or a test calls it). The human's
// side is an ordinary Session, so the UI and window.GameClient drive it like any game.

import { beforeAll, describe, expect, it } from 'vitest';
import { LocalMatchSession, type LocalMatchOptions } from '../../src/client/localMatchSession';
import { ensureRapierReady } from '../../src/physics/rapier';
import { BUILT_IN_MAPS } from '../../src/session/maps';
import type { ServerMessage } from '../../src/session/protocol';

beforeAll(async () => {
  await ensureRapierReady();
});

const DT = 1 / 60;

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** A started session with every message the human received recorded. */
function open(opts: LocalMatchOptions, name = 'Me'): { session: LocalMatchSession; got: ServerMessage[] } {
  const session = new LocalMatchSession(opts);
  const got: ServerMessage[] = [];
  session.onMessage((m) => got.push(m));
  session.start(name);
  return { session, got };
}

/** Ticks until `done` (yielding while no match runs, so the async match start can finish). */
async function runUntil(session: LocalMatchSession, done: () => boolean, maxSeconds: number): Promise<number> {
  for (let t = 0; t < maxSeconds * 60; t++) {
    if (done()) return t;
    if (session.room.gameApi === null) await settle();
    session.tick(DT);
  }
  throw new Error(`not done within ${maxSeconds} simulated seconds`);
}

const matchStarts = (got: ServerMessage[]) => got.filter((m): m is Extract<ServerMessage, { type: 'matchStart' }> => m.type === 'matchStart');
const myId = (got: ServerMessage[]) => (got.find((m) => m.type === 'roomJoined') as Extract<ServerMessage, { type: 'roomJoined' }>).playerId;
const lastSnapshot = (got: ServerMessage[]) => got.filter((m): m is Extract<ServerMessage, { type: 'snapshot' }> => m.type === 'snapshot').at(-1);

describe('LocalMatchSession: setup', () => {
  it('takes 1 to 7 bots (8 players at most) and refuses anything else', () => {
    for (const bots of [0, 8, 1.5, -1]) expect(() => new LocalMatchSession({ bots, difficulty: 'normal' })).toThrow(RangeError);
    for (const bots of [1, 7]) expect(() => new LocalMatchSession({ bots, difficulty: 'normal' }).close()).not.toThrow();
  });

  it('puts the human (the owner) and the bots in one room, bots named by number and difficulty', async () => {
    const { session, got } = open({ bots: 3, difficulty: 'hard', seed: 1 });
    await runUntil(session, () => matchStarts(got).length > 0, 5);
    const start = matchStarts(got)[0]!;
    expect(start.players.map((p) => p.name)).toEqual(['Me', 'Bot 2 (Hard)', 'Bot 3 (Hard)', 'Bot 4 (Hard)']);
    const lobby = got.filter((m): m is Extract<ServerMessage, { type: 'lobby' }> => m.type === 'lobby').at(-1)!;
    expect(lobby.ownerId).toBe(myId(got));
    expect(lobby.practice).toBe(false); // normal rules: rounds end on the last one alive
    session.close();
  });

  it('starts by itself with the chosen map and settings — no lobby for the human to click through', async () => {
    const mapId = BUILT_IN_MAPS.at(-1)!.id;
    const { session, got } = open({ bots: 2, difficulty: 'easy', mapId, targetScore: 4, roundTime: 45, seed: 2 });
    await runUntil(session, () => matchStarts(got).length > 0, 5);
    const start = matchStarts(got)[0]!;
    expect(start.map).toEqual(BUILT_IN_MAPS.at(-1)!.map);
    expect(start.config.targetScore).toBe(4);
    expect(start.config.roundTime).toBe(45);
    expect(start.config.practice).toBe(false);
    session.close();
  });

  it('refuses an unknown map', () => {
    expect(() => new LocalMatchSession({ bots: 1, difficulty: 'normal', mapId: 'nope' })).toThrow();
  });
});

describe('LocalMatchSession: playing', () => {
  it('the human is a real player: its input moves it', async () => {
    const { session, got } = open({ bots: 1, difficulty: 'easy', seed: 3 });
    await runUntil(session, () => matchStarts(got).length > 0 && lastSnapshot(got) !== undefined, 5);
    const me = myId(got);
    const before = lastSnapshot(got)!.state.players.find((p) => p.id === me)!.pos;
    // Each direction for a second (outlasting any round-start countdown); some way is open.
    let farthest = 0;
    for (const [seq, dir] of (['+X', '-X', '+Y', '-Y'] as const).entries()) {
      await session.send({ type: 'input', seq, moveDir: dir, shoot: false });
      for (let t = 0; t < 60; t++) session.tick(DT);
      const at = lastSnapshot(got)!.state.players.find((p) => p.id === me)!.pos;
      farthest = Math.max(farthest, Math.hypot(at.x - before.x, at.y - before.y));
    }
    expect(farthest).toBeGreaterThan(0.5);
    session.close();
  });

  it('bots fight to the end of the match while the human stands still; then nothing restarts until playAgain()', async () => {
    const { session, got } = open({ bots: 3, difficulty: 'hard', targetScore: 2, seed: 4 });
    await runUntil(session, () => lastSnapshot(got)?.state.phase === 'matchEnd', 600);
    const me = myId(got);
    const final = lastSnapshot(got)!.state;
    expect(final.winnerId).not.toBeNull();
    expect(final.winnerId).not.toBe(me); // an idle human can't win against three hard bots
    for (let t = 0; t < 5 * 60; t++) {
      await settle();
      session.tick(DT);
    }
    expect(matchStarts(got)).toHaveLength(1); // the bots are ready again, but the human decides
    session.playAgain();
    await runUntil(session, () => matchStarts(got).length === 2, 5);
    session.close();
  });

  it('is reproducible: the same seed and options give the same match', async () => {
    const outcome = async () => {
      const { session, got } = open({ bots: 2, difficulty: 'normal', targetScore: 2, seed: 5 });
      await runUntil(session, () => lastSnapshot(got)?.state.phase === 'matchEnd', 600);
      const s = lastSnapshot(got)!.state;
      session.close();
      return { winner: s.winnerId, scores: s.scores, time: s.time };
    };
    expect(await outcome()).toEqual(await outcome());
  }, 60_000);

  it('close() ends everything: the match stops, onClose fires once, and further ticks are harmless', async () => {
    const { session, got } = open({ bots: 2, difficulty: 'normal', seed: 6 });
    await runUntil(session, () => matchStarts(got).length > 0, 5);
    const reasons: string[] = [];
    session.onClose((r) => reasons.push(r));
    session.close();
    session.close();
    expect(reasons).toEqual(['closed']);
    expect(session.room.gameApi).toBeNull();
    const count = got.length;
    session.tick(DT);
    expect(got.length).toBe(count);
  });
});
