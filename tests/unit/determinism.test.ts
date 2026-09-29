// M0 task 1 (spec/2026-09-29-v1-milestones.md): seeded randomness. Spawns used
// Math.random() inside step() (a round transition re-runs assignSpawns), so a replay that
// crossed a round boundary was not deterministic — contradicting spec §4. These tests pin
// the fix: all sim randomness comes from a seed carried in State, and a run is
// reproducible from its recorded seed.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GameApi } from '../../src/api';
import { ensureRapierReady, type Rapier } from '../../src/physics/rapier';
import { nextRandom, rngStateFromSeed } from '../../src/sim/rng';
import { createGame, DEFAULT_MAP, step, toSnapshot } from '../../src/sim';
import type { Config, PlayerInput, PublicState, State } from '../../src/sim';

let RAPIER: Rapier;

beforeAll(async () => {
  RAPIER = await ensureRapierReady();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ROSTER = [
  { id: 'p0', name: 'A', skinId: 'crimson' },
  { id: 'p1', name: 'B', skinId: 'gold' },
];

// A short roundTime makes every round end in a draw quickly, so a few seconds of sim
// time crosses several round boundaries — each one re-runs spawn placement.
const SHORT_ROUNDS: Partial<Config> = { roundTime: 0.2 };

function newGame(seed: number): State {
  return createGame(RAPIER, SHORT_ROUNDS, DEFAULT_MAP, ROSTER, seed).state;
}

function idle(state: State): Record<string, PlayerInput> {
  const inputs: Record<string, PlayerInput> = {};
  for (const p of state.players) inputs[p.id] = { moveDir: null, shoot: false };
  return inputs;
}

function runTicks(state: State, ticks: number): State {
  let s = state;
  for (let i = 0; i < ticks; i++) s = step(s, idle(s), 1 / 60).state;
  return s;
}

function spawns(state: State | PublicState) {
  return state.players.map((p) => ({ id: p.id, pos: p.pos, facing: p.facing }));
}

describe('rng', () => {
  function sequence(seed: number, n: number): number[] {
    const holder = { rngState: rngStateFromSeed(seed) };
    return Array.from({ length: n }, () => nextRandom(holder));
  }

  it('produces the same sequence for the same seed', () => {
    expect(sequence(1234, 50)).toEqual(sequence(1234, 50));
  });

  it('produces different sequences for different seeds', () => {
    expect(sequence(1, 20)).not.toEqual(sequence(2, 20));
  });

  it('returns values in [0, 1)', () => {
    for (const v of sequence(99, 1000)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('advances the state it is given (so the sequence continues across calls and clones)', () => {
    const holder = { rngState: rngStateFromSeed(7) };
    const first = nextRandom(holder);
    const copy = { ...holder };
    expect(nextRandom(holder)).toBe(nextRandom(copy));
    expect(nextRandom(holder)).not.toBe(first);
  });
});

describe('seeded sim (spec §4 determinism)', () => {
  it('the same seed gives identical initial spawns; a different seed gives different ones', () => {
    expect(spawns(newGame(42))).toEqual(spawns(newGame(42)));
    expect(spawns(newGame(42))).not.toEqual(spawns(newGame(43)));
  });

  it('records the seed on State so any run can be reproduced from it', () => {
    expect(newGame(42).seed).toBe(42);
  });

  it('rejects a seed it could not replay (NaN, Infinity, non-integer) instead of recording it', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => newGame(bad)).toThrow(/seed/);
    }
  });

  it('records the seed actually used, so an out-of-range seed still replays from state.seed', () => {
    const game = newGame(-1);
    expect(game.seed).toBe(2 ** 32 - 1);
    expect(spawns(newGame(game.seed))).toEqual(spawns(game));
  });

  // Covers all load-time state, not just spawns, while tolerating three.js's internal
  // Math.random use for geometry UUIDs (see the step() test below).
  it('no load-time state depends on Math.random', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const low = toSnapshot(newGame(42));
    vi.restoreAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const high = toSnapshot(newGame(42));
    expect(low).toEqual(high);
  });

  it('replays identically across round boundaries (each boundary re-runs spawn placement)', () => {
    const a = runTicks(newGame(7), 120);
    const b = runTicks(newGame(7), 120);
    expect(a.roundNumber).toBeGreaterThan(3); // proves several respawns actually happened
    expect(toSnapshot(a)).toEqual(toSnapshot(b));
  });

  // Scoped to step(): createGame builds the donut's three.js BufferGeometry, whose
  // constructor calls Math.random for an object UUID — a label, not game state. Initial
  // spawns are covered by the same-seed-identical-spawns test above.
  it('never calls Math.random while stepping — round-transition respawns come from the seed', () => {
    const game = newGame(7);
    const spy = vi.spyOn(Math, 'random');
    const end = runTicks(game, 120);
    expect(end.roundNumber).toBeGreaterThan(3);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('GameApi seed', () => {
  async function started(seed?: number): Promise<GameApi> {
    const api = new GameApi();
    api.setRoster([{ name: 'A' }, { name: 'B' }]);
    await api.start(SHORT_ROUNDS, DEFAULT_MAP, seed === undefined ? {} : { seed });
    return api;
  }

  it('start({ seed }) makes a whole run reproducible, including across rounds', async () => {
    const a = await started(99);
    const b = await started(99);
    a.runTicks(120);
    b.runTicks(120);
    expect(a.getState().roundNumber).toBeGreaterThan(3);
    expect(a.getState()).toEqual(b.getState());
  });

  it('picks a fresh seed for each unseeded start (not a fixed default)', async () => {
    const a = await started();
    const b = await started();
    expect(a.getState().seed).not.toBe(b.getState().seed); // 1-in-2^32 false failure
  });

  it('without a seed, one is chosen and exposed, and replaying with it reproduces the run', async () => {
    const original = await started();
    const seed = original.getState().seed;
    expect(Number.isInteger(seed)).toBe(true);

    const replay = await started(seed);
    original.runTicks(120);
    replay.runTicks(120);
    expect(replay.getState()).toEqual(original.getState());
  });
});
