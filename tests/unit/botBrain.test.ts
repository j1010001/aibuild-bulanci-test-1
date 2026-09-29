// M2.5 task 2: the bot brain — perception from what a player can see, utility-scored
// behaviors (dodge, attack, evade, chase, wander) and difficulty profiles. Decisions are
// checked on scripted snapshots; outcomes on whole seeded matches (botMatches.test.ts).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotBrain } from '../../src/client/bots/brain';
import { DIFFICULTY, type BotProfile } from '../../src/client/bots/difficulty';
import { NavGrid } from '../../src/client/bots/navigation';
import type { DynamicState } from '../../src/session/protocol';
import { DEFAULT_CONFIG, DIR_VECTOR } from '../../src/sim';
import type { Bullet, Direction, MapDef, ObstacleDef, Vec2 } from '../../src/sim';

type P = DynamicState['players'][number];
const OPEN: MapDef = { version: 1, board: { width: 40, height: 40 }, obstacles: [] };
const WALL: ObstacleDef = { id: 'w', type: 'cube', pos: { x: 20, y: 20 }, params: { w: 10, d: 1, h: 2 } }; // x 15..25 at y 19.5..20.5
const WALLED: MapDef = { version: 1, board: { width: 40, height: 40 }, obstacles: [WALL] };

function player(id: string, pos: Vec2, facing: Direction = '+X', alive = true): P {
  return { id, name: id, skinId: 'crimson', pos, facing, lastShotAt: -Infinity, alive, connected: true }; // never fired, as the sim starts
}

function state(players: P[], bullets: Bullet[] = [], extra: Partial<DynamicState> = {}): DynamicState {
  return { phase: 'round', roundNumber: 1, scores: {}, players, bullets, time: 0, roundStartedAt: 0, winnerId: null, ...extra };
}

function brainFor(profile: BotProfile, map: MapDef = OPEN, seed = 1): BotBrain {
  const b = new BotBrain(profile, seed);
  b.setMatch(map, DEFAULT_CONFIG);
  return b;
}

describe('difficulty profiles', () => {
  it('are ordered: harder means faster, more precise, and more evasive', () => {
    const [e, n, h] = [DIFFICULTY.easy, DIFFICULTY.normal, DIFFICULTY.hard];
    expect(e.thinkMs).toBeGreaterThan(n.thinkMs);
    expect(n.thinkMs).toBeGreaterThan(h.thinkMs);
    expect(e.reactionMs[0]).toBeGreaterThan(n.reactionMs[0]);
    expect(n.reactionMs[0]).toBeGreaterThan(h.reactionMs[0]);
    expect(e.alignTolerance).toBeGreaterThan(n.alignTolerance);
    expect(n.alignTolerance).toBeGreaterThan(h.alignTolerance);
    expect(h.alignTolerance).toBeGreaterThan(0); // everyone can hit something
    expect(e.alignTolerance).toBeLessThan(DEFAULT_CONFIG.playerRadius); // …but easy still aims within a body width
    expect(e.dodgeChance).toBe(0);
    expect(h.dodgeChance).toBeGreaterThan(n.dodgeChance);
    expect(h.evadeChance).toBeGreaterThan(n.evadeChance);
  });
});

describe('BotBrain: attack', () => {
  it('lined up, facing the target, clear line: fires — but only after its reaction delay', () => {
    const brain = brainFor({ ...DIFFICULTY.normal, reactionMs: [200, 200] });
    const s = state([player('a', { x: 5, y: 10 }, '+X'), player('b', { x: 20, y: 10 })]);
    expect(brain.decide(s, 'a', 0).shoot).toBe(false);
    expect(brain.decide(s, 'a', 100).shoot).toBe(false);
    expect(brain.decide(s, 'a', 250).shoot).toBe(true);
  });

  it('lined up but not facing: turns toward the target first', () => {
    const brain = brainFor(DIFFICULTY.hard);
    const s = state([player('a', { x: 5, y: 10 }, '-Y'), player('b', { x: 20, y: 10 })]);
    expect(brain.decide(s, 'a', 0)).toMatchObject({ moveDir: '+X', shoot: false });
  });

  it('lined up across a wall: does not fire, and heads around the wall instead of into it', () => {
    const brain = brainFor({ ...DIFFICULTY.hard, reactionMs: [0, 0] }, WALLED);
    // On a grid-cell center, so the first move is the route itself (off-center, the bot
    // first steps onto its path's line). Facing along the wall: facing it, walking up to
    // the wall first and then round is an equally cheap route.
    const s = state([player('a', { x: 20.25, y: 10.25 }, '+X'), player('b', { x: 20.25, y: 30.25 })]);
    for (let t = 0; t <= 500; t += 50) expect(brain.decide(s, 'a', t).shoot).toBe(false);
    const first = brain.decide(s, 'a', 600).moveDir;
    expect(first === '+X' || first === '-X').toBe(true); // around an end of the wall, not straight into it
  });

  it("fires only when lined up within its difficulty's aim", () => {
    const offset = (DIFFICULTY.easy.alignTolerance + DIFFICULTY.hard.alignTolerance) / 2;
    const s = state([player('a', { x: 5, y: 10 }, '+X'), player('b', { x: 20, y: 10 + offset })]);
    const shoots = (profile: BotProfile) => {
      const brain = brainFor({ ...profile, reactionMs: [0, 0] });
      return [0, 50, 100, 400].some((t) => brain.decide(s, 'a', t).shoot);
    };
    expect(shoots(DIFFICULTY.easy)).toBe(true); // easy fires at a sloppier line
    expect(shoots(DIFFICULTY.hard)).toBe(false); // hard waits to line up properly
  });
});

describe('BotBrain: dodging and evading', () => {
  const incoming = (dir: Direction, from: Vec2): Bullet => ({ id: 'x1', ownerId: 'b', pos: from, dir });

  it('a bot that dodges steps sideways out of an incoming bullet’s line', () => {
    const brain = brainFor({ ...DIFFICULTY.hard, dodgeChance: 1 });
    const s = state([player('a', { x: 20, y: 20 }, '+Y'), player('b', { x: 5, y: 20 })], [incoming('+X', { x: 14, y: 20 })]);
    const move = brain.decide(s, 'a', 0).moveDir;
    expect(move === '+Y' || move === '-Y').toBe(true);
  });

  it('a bot that never dodges ignores it', () => {
    const brain = brainFor({ ...DIFFICULTY.easy, dodgeChance: 0 });
    const s = state([player('a', { x: 20, y: 20 }, '+Y'), player('b', { x: 5, y: 20 })], [incoming('+X', { x: 14, y: 20 })]);
    const move = brain.decide(s, 'a', 0).moveDir;
    expect(move).toBe('-X'); // it turns to fight b instead
  });

  it('a bullet moving away, or already past, is no threat', () => {
    const brain = brainFor({ ...DIFFICULTY.hard, dodgeChance: 1 });
    const away = state([player('a', { x: 20, y: 20 }, '+Y'), player('b', { x: 5, y: 20 }, '+Y')], [incoming('-X', { x: 14, y: 20 })]);
    const move = brain.decide(away, 'a', 0).moveDir;
    expect(move).toBe('-X'); // no dodge: it turns toward b
  });

  it('when an enemy has it in its sights and it cannot shoot first, an evasive bot steps out of the line', () => {
    const brain = brainFor({ ...DIFFICULTY.hard, evadeChance: 1, alignTolerance: 0.2 });
    // b faces a along X with a clear line; a faces away (-X), so it can't fire back at once
    const s = state([player('a', { x: 20, y: 20 }, '-X'), player('b', { x: 30, y: 20 }, '-X')]);
    const move = brain.decide(s, 'a', 0).moveDir;
    expect(move === '+Y' || move === '-Y').toBe(true);
  });
});

describe('BotBrain: moving', () => {
  /** A tiny kinematic stand-in for the server: applies the bot's input at 6 units/s. */
  function drive(brain: BotBrain, me: P, target: P, map: MapDef, ms: number): { pos: Vec2; changes: number; fired: boolean } {
    const grid = NavGrid.build(map, DEFAULT_CONFIG);
    let pos = { ...me.pos };
    let facing = me.facing;
    let last: Direction | null = null;
    let changes = 0;
    let fired = false;
    for (let t = 0; t < ms; t += 1000 / 60) {
      const input = brain.decide(state([{ ...me, pos, facing }, target]), me.id, t);
      if (input.shoot) fired = true;
      if (input.moveDir !== last) changes++;
      last = input.moveDir;
      if (input.moveDir) {
        facing = input.moveDir;
        const v = DIR_VECTOR[input.moveDir];
        const next = { x: pos.x + v.x * 0.1, y: pos.y + v.y * 0.1 };
        if (grid.walkable(next)) pos = next;
      }
      if (fired) break;
    }
    return { pos, changes, fired };
  }

  it('paths around a wall to a target it cannot see, and gets a shot off', () => {
    const brain = brainFor({ ...DIFFICULTY.normal, reactionMs: [0, 0] }, WALLED);
    const result = drive(brain, player('a', { x: 20, y: 10 }, '+Y'), player('b', { x: 20, y: 30 }), WALLED, 20_000);
    expect(result.fired).toBe(true);
  });

  it('follows its path without dithering (few direction changes)', () => {
    const brain = brainFor({ ...DIFFICULTY.easy, reactionMs: [0, 0] }, WALLED);
    const result = drive(brain, player('a', { x: 20, y: 10 }, '+Y'), player('b', { x: 20, y: 30 }), WALLED, 20_000);
    expect(result.fired).toBe(true);
    expect(result.changes).toBeLessThan(15);
  });

  it('wanders when there is nobody left to hunt', () => {
    const brain = brainFor(DIFFICULTY.normal);
    const s = state([player('a', { x: 20, y: 20 }), player('b', { x: 5, y: 5 }, '+X', false)]);
    const moves = [0, 400, 800, 1200].map((t) => brain.decide(s, 'a', t).moveDir);
    expect(moves.some((m) => m !== null)).toBe(true);
  });

  it('stops when it is dead', () => {
    const brain = brainFor(DIFFICULTY.normal);
    const s = state([player('a', { x: 20, y: 20 }, '+X', false), player('b', { x: 5, y: 5 })]);
    expect(brain.decide(s, 'a', 0)).toEqual({ moveDir: null, shoot: false });
  });
});

describe('BotBrain: target choice', () => {
  it('a bot that picks the most exposed target prefers one it can line up on over a nearer one it cannot', () => {
    const brain = brainFor({ ...DIFFICULTY.hard, targeting: 'exposed', reactionMs: [0, 0] });
    // near but diagonal (no line), far but already on the same row
    const s = state([player('a', { x: 10, y: 10 }, '+X'), player('near', { x: 13, y: 13 }), player('far', { x: 30, y: 10 })]);
    expect(brain.decide(s, 'a', 0).shoot).toBe(true);
    expect(brain.targetId).toBe('far');
  });

  it('a bot that picks the nearest target goes for the nearer one', () => {
    const brain = brainFor({ ...DIFFICULTY.easy, targeting: 'nearest' });
    const s = state([player('a', { x: 10, y: 10 }, '+X'), player('near', { x: 13, y: 13 }), player('far', { x: 30, y: 10 })]);
    brain.decide(s, 'a', 0);
    expect(brain.targetId).toBe('near');
  });
});

// ---- Follow-up to the independent review of the brain (M2.5 task 2) ----

afterEach(() => {
  vi.restoreAllMocks();
});

const R = DEFAULT_CONFIG.playerRadius;
const FRAME = 1000 / 60;

describe('BotBrain: when there is no path (review finding 1)', () => {
  it('a target in an edge cell no path reaches: keeps closing in, without searching every frame', () => {
    const brain = brainFor({ ...DIFFICULTY.normal, reactionMs: [0, 0] });
    const searches = vi.spyOn(NavGrid.prototype, 'findPath');
    let pos = { x: 20.25, y: 10.25 };
    let facing: Direction = '+Y';
    const target = player('b', { x: 0.8, y: 30.1 }); // pressed against the west edge
    let moved = 0;
    const frames = 180;
    for (let k = 0; k < frames; k++) {
      const input = brain.decide(state([player('a', pos, facing), target]), 'a', k * FRAME);
      if (input.moveDir) {
        moved++;
        facing = input.moveDir;
        const v = DIR_VECTOR[input.moveDir];
        pos = { x: pos.x + v.x * 0.1, y: pos.y + v.y * 0.1 };
      }
    }
    expect(moved).toBeGreaterThan(frames * 0.9);
    expect(Math.hypot(pos.x - 20.25, pos.y - 10.25)).toBeGreaterThan(10); // it went somewhere
    expect(searches.mock.calls.length).toBeLessThan(10); // 3 s of play: a few plans, not one per frame
  });
});

describe('BotBrain: dodging (review findings 2, 3)', () => {
  const bulletAt = (x: number): Bullet => ({ id: 'x1', ownerId: 'b', pos: { x, y: 20 }, dir: '+X' });

  it('keeps one direction for the whole dodge (no zig-zag inside the bullet’s path)', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const brain = brainFor({ ...DIFFICULTY.hard, dodgeChance: 1 }, OPEN, seed);
      const dirs = new Set<Direction>();
      for (let k = 0; k < 12; k++) {
        // the bot doesn't get to move here: the bullet keeps coming at it
        const input = brain.decide(state([player('a', { x: 20, y: 20 }, '+X'), player('b', { x: 5, y: 20 }, '+Y')], [bulletAt(12 + k * 0.3)]), 'a', k * FRAME);
        if (brain.doing === 'dodge' && input.moveDir) dirs.add(input.moveDir);
      }
      expect(dirs.size).toBe(1);
    }
  });

  it('stops dodging once it is out of the bullet’s path (a short step, not a long run)', () => {
    const brain = brainFor({ ...DIFFICULTY.hard, dodgeChance: 1 });
    let pos = { x: 20, y: 20 };
    let facing: Direction = '+X';
    let dodgeFrames = 0;
    for (let k = 0; k < 40; k++) {
      const bx = 12 + k * FRAME * (DEFAULT_CONFIG.bulletSpeed / 1000);
      const bullets = bx < pos.x ? [bulletAt(bx)] : [];
      const input = brain.decide(state([player('a', pos, facing), player('b', { x: 5, y: 35 }, '+Y')], bullets), 'a', k * FRAME);
      if (brain.doing === 'dodge') dodgeFrames++;
      if (input.moveDir) {
        facing = input.moveDir;
        const v = DIR_VECTOR[input.moveDir];
        pos = { x: pos.x + v.x * 0.1, y: pos.y + v.y * 0.1 };
      }
    }
    expect(dodgeFrames).toBeGreaterThan(0);
    // clearing the path takes (R + a margin) at 6 units/s ≈ 7 frames; allow a few more
    expect(dodgeFrames).toBeLessThanOrEqual(Math.ceil(((R + 0.2) / DEFAULT_CONFIG.playerSpeed) * 60) + 6);
  });
});

describe('BotBrain: firing cadence from the snapshot (review finding 7)', () => {
  it('waits for its gun to be ready by the authoritative clock, and treats “never fired” (null over the wire) as ready', () => {
    const brain = brainFor({ ...DIFFICULTY.hard, reactionMs: [0, 0] });
    const at = (time: number, lastShotAt: number | null) =>
      state([{ ...player('a', { x: 5, y: 10 }, '+X'), lastShotAt: lastShotAt as number }, player('b', { x: 20, y: 10 })], [], { time });
    expect(brain.decide(at(1000, 500), 'a', 0).shoot).toBe(false); // 500 ms since its last shot: not ready
    expect(brain.decide(at(1350, 500), 'a', 20).shoot).toBe(true); // 850 ms ≥ 800
    const fresh = brainFor({ ...DIFFICULTY.hard, reactionMs: [0, 0] });
    expect(fresh.decide(at(0, null), 'a', 0).shoot).toBe(true);
  });
});

describe('BotBrain: rounds and matches (review findings 8, 9)', () => {
  it('rethinks at once when a new round starts (no stale plan carried over)', () => {
    const brain = brainFor({ ...DIFFICULTY.easy, reactionMs: [0, 0] }); // thinks only every 300 ms
    brain.decide(state([player('a', { x: 10.25, y: 10.25 }, '+Y'), player('b', { x: 30, y: 30 })]), 'a', 0);
    // Round 2: the enemy respawned right beside it, lined up but too close to turn onto.
    const next = state([player('a', { x: 10.25, y: 10.25 }, '+Y'), player('b', { x: 11.25, y: 10.25 })], [], { roundNumber: 2 });
    expect(brain.decide(next, 'a', 50).moveDir).toBe('-X'); // backs off to make room (attack), not chase toward
  });
});

describe('BotBrain: evading when it cannot fire first (review finding 11)', () => {
  it('facing the enemy but outside its own aim, it evades rather than doing nothing', () => {
    const brain = brainFor({ ...DIFFICULTY.hard, evadeChance: 1 });
    const offset = (DIFFICULTY.hard.alignTolerance + R) / 2; // inside the enemy's hit width, outside hard's aim
    const s = state([player('a', { x: 20, y: 20 }, '-X'), player('e', { x: 10, y: 20 + offset }, '+X')]);
    brain.decide(s, 'a', 0);
    expect(brain.doing).toBe('evade');
  });

  it('a normal bot evades some of the time', () => {
    let evaded = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const brain = brainFor(DIFFICULTY.normal, OPEN, seed);
      brain.decide(state([player('a', { x: 20, y: 20 }, '+Y'), player('e', { x: 10, y: 20 }, '+X')]), 'a', 0);
      if (brain.doing === 'evade') evaded++;
    }
    expect(evaded).toBeGreaterThan(40 * DIFFICULTY.normal.evadeChance * 0.4);
    expect(evaded).toBeLessThan(40 * DIFFICULTY.normal.evadeChance * 1.8);
  });
});

describe('BotBrain: more behaviors (review finding 12)', () => {
  it("a 'shootable' bot goes for the enemy it can shoot now over a nearer one it can't", () => {
    const brain = brainFor({ ...DIFFICULTY.normal, reactionMs: [0, 0] });
    const s = state([player('a', { x: 10, y: 10 }, '+X'), player('near', { x: 13, y: 13 }), player('far', { x: 30, y: 10 })]);
    brain.decide(s, 'a', 0);
    expect(brain.targetId).toBe('far');
  });

  it('lined up but too close to turn onto the target: backs off first', () => {
    const brain = brainFor(DIFFICULTY.hard);
    const s = state([player('a', { x: 10.25, y: 10.25 }, '+Y'), player('b', { x: 11.25, y: 10.25 })]);
    expect(brain.decide(s, 'a', 0).moveDir).toBe('-X');
  });

  it('its target dies mid-attack: it stops firing at it and moves on to another', () => {
    const brain = brainFor({ ...DIFFICULTY.hard, reactionMs: [1000, 1000] });
    const a = player('a', { x: 5, y: 10 }, '+X');
    brain.decide(state([a, player('b', { x: 20, y: 10 }), player('c', { x: 30, y: 30 })]), 'a', 0);
    expect(brain.targetId).toBe('b');
    const after = state([a, player('b', { x: 20, y: 10 }, '+X', false), player('c', { x: 30, y: 30 })]);
    let shot = false;
    for (let t = 100; t <= 1500; t += 100) shot ||= brain.decide(after, 'a', t).shoot;
    expect(shot).toBe(false);
    expect(brain.targetId).toBe('c');
  });

  it('trying to move but getting nowhere: escapes in another direction', () => {
    const brain = brainFor(DIFFICULTY.normal);
    const s = state([player('a', { x: 20.25, y: 10.25 }, '+Y'), player('b', { x: 25, y: 35 }, '-X')]); // not lined up; the world never lets it move
    const moves: (Direction | null)[] = [];
    let escaped = false;
    for (let t = 0; t <= 2500; t += FRAME) {
      moves.push(brain.decide(s, 'a', t).moveDir);
      escaped ||= brain.doing === 'escape';
    }
    expect(escaped).toBe(true);
    expect(new Set(moves.filter((m) => m !== null)).size).toBeGreaterThan(1);
  });
});

describe('BotBrain: one navigation grid per map (review finding 10)', () => {
  it('bots on the same map share its grid, even though each received its own copy of the map', () => {
    const build = vi.spyOn(NavGrid, 'build');
    const map: MapDef = { version: 1, board: { width: 40, height: 40 }, obstacles: [{ ...WALL, id: 'shared-grid-test' }] };
    for (let i = 0; i < 4; i++) new BotBrain(DIFFICULTY.normal, i).setMatch(JSON.parse(JSON.stringify(map)) as MapDef, DEFAULT_CONFIG);
    expect(build).toHaveBeenCalledTimes(1);
  });
});
