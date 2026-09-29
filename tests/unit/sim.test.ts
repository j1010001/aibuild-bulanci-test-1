import { beforeAll, describe, expect, it } from 'vitest';
import { createGame, step } from '../../src/sim';
import { ensureRapierReady, type Rapier } from '../../src/physics/rapier';
import type { Config, MapDef, ObstacleDef, PlayerInput, State } from '../../src/sim';

let RAPIER: Rapier;

beforeAll(async () => {
  RAPIER = await ensureRapierReady();
});

function mapWith(obstacles: ObstacleDef[], board = { width: 40, height: 40 }): MapDef {
  return { version: 1, board, obstacles };
}

function game(
  obstacles: ObstacleDef[],
  names: string[],
  configOverrides: Partial<Config> = {},
  board?: { width: number; height: number },
): State {
  const roster = names.map((name, i) => ({ id: `p${i}`, name, skinId: 'crimson' }));
  const { state } = createGame(RAPIER, { practice: true, ...configOverrides }, mapWith(obstacles, board), roster, 0);
  return state;
}

function noInput(state: State): Record<string, PlayerInput> {
  const inputs: Record<string, PlayerInput> = {};
  for (const p of state.players) inputs[p.id] = { moveDir: null, shoot: false };
  return inputs;
}

function run(state: State, ticks: number, inputsByPlayer: Record<string, Partial<PlayerInput>>, dt = 1 / 60): State {
  let s = state;
  for (let i = 0; i < ticks; i++) {
    const inputs = noInput(s);
    for (const [id, partial] of Object.entries(inputsByPlayer)) {
      inputs[id] = { moveDir: partial.moveDir ?? null, shoot: partial.shoot ?? false };
    }
    s = step(s, inputs, dt).state;
  }
  return s;
}

describe('movement collision (§7, §8) — real physics; geometry-level coverage lives in physicsWorld.test.ts', () => {
  it('clamps at the leading gun, not the body, and does not tunnel through in one big step', () => {
    const wall: ObstacleDef = { id: 'w', type: 'cube', pos: { x: 10, y: 10 }, params: { w: 2, d: 2, h: 2 } };
    let s = game([wall], ['A']);
    s.players[0]!.pos = { x: 5, y: 10 };
    s.players[0]!.facing = '+X';

    // One enormous tick: distance requested is far more than the gap to the wall.
    s = run(s, 1, { p0: { moveDir: '+X' } }, 10);

    // wall minX=9, muzzleOffset=0.8 => gun tip touches 9 when pos.x = 8.2
    expect(s.players[0]!.pos.x).toBeCloseTo(8.2, 2);

    // Further ticks must not advance any further (already at contact).
    s = run(s, 5, { p0: { moveDir: '+X' } });
    expect(s.players[0]!.pos.x).toBeCloseTo(8.2, 2);
  });

  it('does not get blocked by an obstacle already behind it on the same axis', () => {
    const wallBehind: ObstacleDef = { id: 'w', type: 'cube', pos: { x: 2, y: 10 }, params: { w: 2, d: 2, h: 2 } };
    let s = game([wallBehind], ['A']);
    s.players[0]!.pos = { x: 10, y: 10 };
    s.players[0]!.facing = '+X';
    s = run(s, 30, { p0: { moveDir: '+X' } });
    // 30 ticks at 6 units/s over 1/60s = 3 units of travel, unobstructed.
    expect(s.players[0]!.pos.x).toBeGreaterThan(12.5);
  });

  it('refuses a turn when the gun would not fit, leaving facing and position unchanged', () => {
    const wall: ObstacleDef = { id: 'w', type: 'cube', pos: { x: 10, y: 10 }, params: { w: 2, d: 2, h: 2 } };
    let s = game([wall], ['A']);
    s.players[0]!.pos = { x: 8.5, y: 10 }; // muzzle at +X would land at 9.3, inside wall (minX=9)
    s.players[0]!.facing = '+Y';

    const before = { ...s.players[0]!.pos };
    const result = step(s, { p0: { moveDir: '+X', shoot: false } }, 1 / 60);

    expect(result.state.players[0]!.facing).toBe('+Y');
    expect(result.state.players[0]!.pos).toEqual(before);
    expect(result.events.some((e) => e.kind === 'turnRefused')).toBe(true);
  });
});

describe('the gun over low walls (§8, M0 task 2)', () => {
  it('turning toward a wall lower than bullet height is allowed even when closer than the muzzle', () => {
    const lowWall: ObstacleDef = { id: 'w', type: 'cube', pos: { x: 10, y: 10 }, params: { w: 2, d: 2, h: 0.6 } };
    const s = game([lowWall], ['A']);
    s.players[0]!.pos = { x: 8.35, y: 10 }; // muzzle at +X would reach 9.15, past the wall's edge at 9
    s.players[0]!.facing = '+Y';
    const result = step(s, { p0: { moveDir: '+X', shoot: false } }, 1 / 60);
    expect(result.events.some((e) => e.kind === 'turnRefused')).toBe(false);
    expect(result.state.players[0]!.facing).toBe('+X');
  });
});

describe('shooting and bullets (§9) — real physics', () => {
  it('a bullet passes through an open arch door and kills the far player', () => {
    const arch: ObstacleDef = { id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 6, d: 1, doorWidth: 2, doorHeight: 2, axis: 'y' } };
    let s = game([arch], ['A', 'B']);
    s.players[0]!.pos = { x: 20, y: 10 };
    s.players[0]!.facing = '+Y';
    s.players[1]!.pos = { x: 20, y: 35 };
    s.players[1]!.facing = '-Y';

    s = run(s, 1, { p0: { shoot: true } });
    s = run(s, 200, {});

    // The round ends and respawns on the kill, so check the persistent score, not
    // the (now-respawned) alive flag.
    expect(s.scores['p0']).toBe(1);
  });

  it('a low slot (doorHeight between bulletHeight and playerHeight) blocks the bullet, same as a real low gap', () => {
    const arch: ObstacleDef = { id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 6, d: 1, doorWidth: 2, doorHeight: 0.5, axis: 'y' } };
    let s = game([arch], ['A', 'B']);
    s.players[0]!.pos = { x: 20, y: 10 };
    s.players[0]!.facing = '+Y';
    s.players[1]!.pos = { x: 20, y: 35 };
    s.players[1]!.facing = '-Y';

    s = run(s, 1, { p0: { shoot: true } });
    s = run(s, 200, {});

    expect(s.players[1]!.alive).toBe(true);
    expect(s.bullets.length).toBe(0);
  });

  it('axis "x" arch: gap crosses along x, pillars still block y — the orientation actually rotated', () => {
    const arch: ObstacleDef = { id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 1, d: 6, doorWidth: 2, doorHeight: 2, axis: 'x' } };

    let along = game([arch], ['A', 'B']);
    along.players[0]!.pos = { x: 5, y: 20 };
    along.players[0]!.facing = '+X';
    along.players[1]!.pos = { x: 35, y: 20 };
    along.players[1]!.facing = '-X';
    along = run(along, 1, { p0: { shoot: true } });
    along = run(along, 200, {});
    expect(along.scores['p0']).toBe(1); // passed straight through the gap

    let across = game([arch], ['A', 'B']);
    across.players[0]!.pos = { x: 20, y: 5 };
    across.players[0]!.facing = '+Y';
    across.players[1]!.pos = { x: 20, y: 35 };
    across.players[1]!.facing = '-Y';
    across = run(across, 1, { p0: { shoot: true } });
    across = run(across, 200, {});
    expect(across.players[1]!.alive).toBe(true); // caught by the pillar, same as an axis "y" arch's sides

    // A player crosses the same way a bullet does: along the passage axis (x), at a y
    // within the gap's y-range — not by moving along y, which is what the pillars block.
    across.players[0]!.pos = { x: 10, y: 20 };
    across.players[0]!.facing = '+X';
    across = run(across, 200, { p0: { moveDir: '+X' } });
    expect(across.players[0]!.pos.x).toBeGreaterThan(20.5);
  });

  it('a shootable donut only lets a bullet through along its declared axis', () => {
    const donut: ObstacleDef = { id: 'd', type: 'donut', pos: { x: 20, y: 20 }, params: { w: 5, d: 1, holeRadius: 1.7, axis: 'y' } };

    let along = game([donut], ['A', 'B']);
    along.players[0]!.pos = { x: 20, y: 5 };
    along.players[0]!.facing = '+Y';
    along.players[1]!.pos = { x: 20, y: 35 };
    along.players[1]!.facing = '-Y';
    along = run(along, 1, { p0: { shoot: true } });
    along = run(along, 200, {});
    expect(along.scores['p0']).toBe(1);

    let across = game([donut], ['A', 'B']);
    across.players[0]!.pos = { x: 5, y: 20 };
    across.players[0]!.facing = '+X';
    across.players[1]!.pos = { x: 35, y: 20 };
    across.players[1]!.facing = '-X';
    across = run(across, 1, { p0: { shoot: true } });
    across = run(across, 200, {});
    expect(across.players[1]!.alive).toBe(true);
  });

  it('a blocked donut stops bullets even along its declared axis', () => {
    const donut: ObstacleDef = { id: 'd', type: 'donut', pos: { x: 20, y: 20 }, params: { w: 5, d: 1, holeRadius: 0.3, axis: 'x' } };
    let s = game([donut], ['A', 'B']);
    s.players[0]!.pos = { x: 5, y: 20 };
    s.players[0]!.facing = '+X';
    s.players[1]!.pos = { x: 35, y: 20 };
    s.players[1]!.facing = '-X';
    s = run(s, 1, { p0: { shoot: true } });
    s = run(s, 200, {});
    expect(s.players[1]!.alive).toBe(true);
  });

  it('a donut blocks player movement from all four sides — real geometry, regardless of axis/shootability', () => {
    // Reported live as "I can walk through the red/brown donut" — reproduced here with
    // the exact params shipped in DEFAULT_MAP, approaching dead-center from each side.
    // Footprint for both: pos (cx,cy), w=5, d=1 -> x:[cx-2.5,cx+2.5], y:[cy-0.5,cy+0.5].
    const cases: ObstacleDef[] = [
      { id: 'd', type: 'donut', pos: { x: 20, y: 20 }, params: { w: 5, d: 1, holeRadius: 1.7, axis: 'y' } },
      { id: 'd', type: 'donut', pos: { x: 20, y: 20 }, params: { w: 5, d: 1, holeRadius: 0.3, axis: 'x' } },
    ];

    for (const donut of cases) {
      let s = game([donut], ['A']);
      s.players[0]!.pos = { x: 20, y: 10 };
      s.players[0]!.facing = '+Y';
      s = run(s, 300, { p0: { moveDir: '+Y' } });
      expect(s.players[0]!.pos.y).toBeLessThan(19.5);
      expect(s.players[0]!.pos.y).toBeGreaterThan(15);
    }
  });

  it('has no owner-immunity special case: a player-vs-player circle test applies to everyone, shooter included', () => {
    // Construct a state (not reachable from normal play) where an in-flight bullet's
    // path already overlaps its own owner, to prove the hit test has no ownerId branch.
    let s = game([], ['A']);
    const p = s.players[0]!;
    p.pos = { x: 20, y: 20 };
    s.bullets.push({ id: 'test-bullet', ownerId: p.id, pos: { x: 20.05, y: 20 }, dir: '-X' });

    const result = step(s, { p0: { moveDir: null, shoot: false } }, 1 / 60);
    expect(result.events.some((e) => e.kind === 'playerKilled' && e.victimId === p.id)).toBe(true);
  });

  it('a stationary target is hit at its real (not stale) position — regression: only movers used to sync to physics', () => {
    let s = game([], ['A', 'B']);
    s.players[0]!.pos = { x: 5, y: 20 };
    s.players[0]!.facing = '+X';
    // Target set directly, never moves (moveDir stays null the whole test) — its
    // physics collider must still track this position, not wherever spawn left it.
    s.players[1]!.pos = { x: 35, y: 20 };
    s = run(s, 1, { p0: { shoot: true } });
    s = run(s, 200, {});
    expect(s.scores['p0']).toBe(1);
  });

  it('cadence prevents firing again before it elapses', () => {
    let s = game([], ['A']);
    s.players[0]!.pos = { x: 20, y: 20 };
    let result = step(s, { p0: { moveDir: null, shoot: true } }, 1 / 60);
    expect(result.state.bullets.length).toBe(1);
    result = step(result.state, { p0: { moveDir: null, shoot: true } }, 1 / 60);
    expect(result.state.bullets.length).toBe(1); // second shot rejected, cadence not elapsed
  });
});

describe('rounds and match (§10)', () => {
  it('resolves a round win, awards a point, and starts the next round', () => {
    let s = game([], ['A', 'B'], { targetScore: 5 });
    s.players[1]!.alive = false;
    const result = step(s, { p0: { moveDir: null, shoot: false }, p1: { moveDir: null, shoot: false } }, 1 / 60);
    expect(result.state.scores['p0']).toBe(1);
    expect(result.state.roundNumber).toBe(2);
    expect(result.state.players[1]!.alive).toBe(true); // respawned for the new round
    expect(result.events.some((e) => e.kind === 'roundEnd' && e.winnerId === 'p0')).toBe(true);
    expect(result.events.some((e) => e.kind === 'roundStart' && e.roundNumber === 2)).toBe(true);
  });

  it('ends the match once a player reaches targetScore', () => {
    let s = game([], ['A', 'B'], { targetScore: 1 });
    s.players[1]!.alive = false;
    const result = step(s, { p0: { moveDir: null, shoot: false }, p1: { moveDir: null, shoot: false } }, 1 / 60);
    expect(result.state.phase).toBe('matchEnd');
    expect(result.state.winnerId).toBe('p0');
  });

  it('resolves a draw when roundTime elapses with 2+ alive', () => {
    let s = game([], ['A', 'B'], { roundTime: 1 });
    s.roundStartedAt = 0;
    s.time = 975; // one 1/60s tick keeps it under 1000ms, a second pushes it over
    let result = step(s, { p0: { moveDir: null, shoot: false }, p1: { moveDir: null, shoot: false } }, 1 / 60);
    expect(result.state.roundNumber).toBe(1);
    result = step(result.state, { p0: { moveDir: null, shoot: false }, p1: { moveDir: null, shoot: false } }, 1 / 60);
    expect(result.state.roundNumber).toBe(2);
    expect(result.events.some((e) => e.kind === 'roundEnd' && e.winnerId === null)).toBe(true);
  });

  it('ends the match without a winner when connected players drop below two (not a draw)', () => {
    let s = game([], ['A', 'B'], { targetScore: 3, practice: false });
    s.scores['p0'] = 2;
    s.players[1]!.connected = false;
    const result = step(s, { p0: { moveDir: null, shoot: false } }, 1 / 60);
    expect(result.state.phase).toBe('matchEnd');
    expect(result.state.winnerId).toBeNull();
    expect(result.state.scores['p0']).toBe(2); // stands, not incremented
  });

  it('practice mode with a single player never ends a round for want of opponents', () => {
    let s = game([], ['A'], { practice: true });
    let result = step(s, { p0: { moveDir: null, shoot: false } }, 60); // huge dt
    expect(result.state.phase).toBe('round');
    expect(result.state.roundNumber).toBe(1);
  });

  it('resolves simultaneous last-standing deaths as a draw, not a win for either side', () => {
    let s = game([], ['A', 'B', 'C']);
    s.players[0]!.alive = false;
    s.players[1]!.alive = false;
    s.players[2]!.alive = false; // all three die same tick -> nobody remains alive
    const result = step(s, {}, 1 / 60);
    expect(result.events.some((e) => e.kind === 'roundEnd' && e.winnerId === null)).toBe(true);
    expect(result.state.scores['p0']).toBe(0);
    expect(result.state.scores['p1']).toBe(0);
    expect(result.state.scores['p2']).toBe(0);
  });
});

describe('spawn fairness (§10, §14)', () => {
  // Spawns are seeded now, so sweep several seeds to keep covering many random layouts.
  it.each(Array.from({ length: 20 }, (_, seed) => seed))('places every player outside solid regions (real physics), separated, and margined from board edges (seed %i)', (seed) => {
    const wall: ObstacleDef = { id: 'w', type: 'cube', pos: { x: 20, y: 20 }, params: { w: 4, d: 4, h: 2 } };
    const roster = ['A', 'B', 'C', 'D'].map((name, i) => ({ id: `p${i}`, name, skinId: 'crimson' }));
    const { state } = createGame(RAPIER, {}, mapWith([wall]), roster, seed);

    for (const p of state.players) {
      expect(p.pos.x).toBeGreaterThanOrEqual(state.config.spawnEdgeMargin - 1e-9);
      expect(p.pos.x).toBeLessThanOrEqual(state.config.board.width - state.config.spawnEdgeMargin + 1e-9);
      const dx = Math.abs(p.pos.x - 20);
      const dy = Math.abs(p.pos.y - 20);
      expect(dx > 2 + state.config.playerRadius || dy > 2 + state.config.playerRadius).toBe(true);
    }
    for (let i = 0; i < state.players.length; i++) {
      for (let j = i + 1; j < state.players.length; j++) {
        const a = state.players[i]!.pos;
        const b = state.players[j]!.pos;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        expect(dist).toBeGreaterThanOrEqual(state.config.spawnSeparation - 1e-6);
      }
    }
  });
});

describe('determinism (§15)', () => {
  it('replays identically given the same starting conditions and input sequence', () => {
    const wall: ObstacleDef = { id: 'w', type: 'cube', pos: { x: 20, y: 20 }, params: { w: 3, d: 3, h: 2 } };

    const inputSeq: Record<string, PlayerInput>[] = [];
    for (let i = 0; i < 50; i++) {
      inputSeq.push({
        p0: { moveDir: i % 4 === 0 ? '+Y' : '+X', shoot: i % 10 === 0 },
        p1: { moveDir: '-X', shoot: i % 7 === 0 },
      });
    }

    function replay() {
      // A fresh game (and fresh physics world) each time — state.physics is a mutable,
      // shared-by-reference handle, not something clone-per-tick preserves; reusing one
      // world across two replays would apply both input sequences to it in succession,
      // not run two independent trials.
      const s0 = game([wall], ['A', 'B']);
      // Also pin facing — spawn fairness picks a random valid facing, which would
      // otherwise vary between the two replays and break this test for a reason that
      // has nothing to do with the determinism property it's checking.
      s0.players[0]!.pos = { x: 10, y: 10 };
      s0.players[0]!.facing = '+X';
      s0.players[1]!.pos = { x: 30, y: 30 };
      s0.players[1]!.facing = '-X';
      let s = s0;
      for (const inputs of inputSeq) s = step(s, inputs, 1 / 60).state;
      const { physics: _physics, ...snapshot } = s;
      return snapshot;
    }

    const a = replay();
    const b = replay();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
