// M2.5 task 1: bot navigation — a grid of where a player fits, planned from the same
// obstacle geometry the physics world uses, and A* over it. The decisive check is the
// last one: paths the grid plans are actually walkable in the real physics world.

import { beforeAll, describe, expect, it } from 'vitest';
import { MIN_BOT_DOOR_WIDTH, NavGrid } from '../../src/client/bots/navigation';
import { ensureRapierReady, type Rapier } from '../../src/physics/rapier';
import { PhysicsWorld } from '../../src/physics/world';
import { nextRandom, rngStateFromSeed } from '../../src/sim/rng';
import { DEFAULT_MAP } from '../../src/sim';
import type { Direction, MapDef, ObstacleDef, Vec2 } from '../../src/sim';

const CONFIG = { playerRadius: 0.5, playerHeight: 1.2, muzzleOffset: 0.8, bulletHeight: 0.9 };

let RAPIER: Rapier;
beforeAll(async () => {
  RAPIER = await ensureRapierReady();
});

function mapOf(obstacles: ObstacleDef[]): MapDef {
  return { version: 1, board: { width: 40, height: 40 }, obstacles };
}

function isAxisAligned(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9;
}

describe('NavGrid: where a player fits', () => {
  it('on an open map, a path is a straight run to the goal', () => {
    const grid = NavGrid.build(mapOf([]), CONFIG);
    const path = grid.findPath({ x: 5, y: 5 }, { x: 30, y: 5 })!;
    expect(path).toHaveLength(1);
    expect(Math.abs(path[0]!.x - 30)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(path[0]!.y - 5)).toBeLessThanOrEqual(0.5);
  });

  it('routes around a wall, in axis-aligned runs', () => {
    const wall: ObstacleDef = { id: 'w', type: 'cube', pos: { x: 15, y: 20 }, params: { w: 30, d: 1, h: 2 } }; // x 0..30
    const grid = NavGrid.build(mapOf([wall]), CONFIG);
    const path = grid.findPath({ x: 10, y: 10 }, { x: 10, y: 30 })!;
    expect(path).not.toBeNull();
    expect(path.some((p) => p.x > 30.5)).toBe(true); // goes round the open east end
    let prev = grid.snapToPath({ x: 10, y: 10 });
    for (const p of path) {
      expect(isAxisAligned(prev, p)).toBe(true);
      prev = p;
    }
  });

  it('goes through an open arch door, but not under a low slot (the player is too tall to fit)', () => {
    const arch = (doorHeight: number): ObstacleDef => ({ id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 38, d: 1, doorWidth: 2, doorHeight, axis: 'y' } });
    const open = NavGrid.build(mapOf([arch(2)]), CONFIG).findPath({ x: 20, y: 10 }, { x: 20, y: 30 })!;
    expect(open).not.toBeNull();
    expect(open.every((p) => Math.abs(p.x - 20) <= 1)).toBe(true);
    // The arch spans x 1..39 and a player needs more than the 1-unit gaps at the ends.
    expect(NavGrid.build(mapOf([arch(1)]), CONFIG).findPath({ x: 20, y: 10 }, { x: 20, y: 30 })).toBeNull();
  });

  it('keeps the gun clear too: a tall wall is approached no closer than the muzzle, a low one closer', () => {
    const wall = (h: number): ObstacleDef => ({ id: 'w', type: 'cube', pos: { x: 20, y: 20 }, params: { w: 2, d: 40, h } }); // face at x 19
    const closest = (h: number) => {
      const grid = NavGrid.build(mapOf([wall(h)]), CONFIG);
      const path = grid.findPath({ x: 5, y: 20 }, { x: 18.9, y: 20 })!;
      return path.at(-1)!.x;
    };
    expect(closest(2)).toBeLessThanOrEqual(19 - CONFIG.muzzleOffset);
    expect(closest(0.6)).toBeGreaterThan(19 - CONFIG.muzzleOffset);
    expect(closest(0.6)).toBeLessThanOrEqual(19 - CONFIG.playerRadius);
  });

  it('an unreachable goal (inside an obstacle) snaps to the nearest place a player fits', () => {
    const block: ObstacleDef = { id: 'b', type: 'cube', pos: { x: 20, y: 20 }, params: { w: 6, d: 6, h: 2 } };
    const path = NavGrid.build(mapOf([block]), CONFIG).findPath({ x: 5, y: 20 }, { x: 20, y: 20 })!;
    expect(path).not.toBeNull();
    const end = path.at(-1)!;
    expect(Math.abs(end.x - 20) > 3 || Math.abs(end.y - 20) > 3).toBe(true);
    expect(Math.hypot(end.x - 20, end.y - 20)).toBeLessThan(5);
  });

  it('knows whether a position is somewhere a player fits', () => {
    const block: ObstacleDef = { id: 'b', type: 'cube', pos: { x: 20, y: 20 }, params: { w: 6, d: 6, h: 2 } };
    const grid = NavGrid.build(mapOf([block]), CONFIG);
    expect(grid.walkable({ x: 20, y: 20 })).toBe(false);
    expect(grid.walkable({ x: 5, y: 5 })).toBe(true);
    expect(grid.walkable({ x: 0.1, y: 5 })).toBe(false); // too close to the board edge
  });
});

// Follow each planned path with the physics engine's own movement (including the gun
// leading, and turning), and require every waypoint to be reached.
function follow(world: PhysicsWorld, start: Vec2, path: Vec2[]): { reached: boolean; at: Vec2 } {
  world.setPlayerPosition('p', start);
  let pos = { ...start };
  for (const wp of path) {
    // every leg is along a single axis from the previous point (the start included)
    if (Math.abs(wp.x - pos.x) > 1e-6 && Math.abs(wp.y - pos.y) > 1e-6) return { reached: false, at: pos };
    for (const axis of ['x', 'y'] as const) {
      const delta = wp[axis] - pos[axis];
      if (Math.abs(delta) < 1e-6) continue;
      const dir: Direction = axis === 'x' ? (delta > 0 ? '+X' : '-X') : delta > 0 ? '+Y' : '-Y';
      if (!world.gunFits('p', pos, dir)) return { reached: false, at: pos };
      world.setPlayerFacing('p', dir);
      const advance = world.moveDistance('p', dir, Math.abs(delta));
      world.applyMove('p', dir, advance);
      pos = world.getPlayerPosition('p');
      if (Math.abs(advance - Math.abs(delta)) > 0.01) return { reached: false, at: pos };
    }
  }
  return { reached: true, at: pos };
}


describe('NavGrid paths are walkable in the real physics world', () => {
  it('on the default map, 60 random paths between walkable points are all walkable by the real physics', () => {
    const grid = NavGrid.build(DEFAULT_MAP, CONFIG);
    const world = new PhysicsWorld(RAPIER, DEFAULT_MAP, CONFIG);
    world.addPlayer('p', { x: 1, y: 1 });
    const rng = { rngState: rngStateFromSeed(42) };
    const randomPoint = (): Vec2 => {
      for (;;) {
        const p = { x: 1 + nextRandom(rng) * 38, y: 1 + nextRandom(rng) * 38 };
        if (grid.walkable(p)) return grid.snapToPath(p);
      }
    };
    let planned = 0;
    for (let i = 0; i < 60; i++) {
      const from = randomPoint();
      const to = randomPoint();
      const path = grid.findPath(from, to);
      if (!path) continue;
      planned++;
      const result = follow(world, from, path);
      expect(result.reached, `path ${i} from ${JSON.stringify(from)} to ${JSON.stringify(to)} stuck at ${JSON.stringify(result.at)}`).toBe(true);
    }
    expect(planned).toBeGreaterThan(50); // the default map is well connected
  });
});

describe('NavGrid: review follow-ups', () => {
  it('a lintel exactly at player height blocks the body (touching is contact)', () => {
    for (const axis of ['x', 'y'] as const) {
      const arch: ObstacleDef = axis === 'y'
        ? { id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 38, d: 1, doorWidth: 2, doorHeight: CONFIG.playerHeight, axis } }
        : { id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 1, d: 38, doorWidth: 2, doorHeight: CONFIG.playerHeight, axis } };
      const grid = NavGrid.build(mapOf([arch]), CONFIG);
      const [from, to] = axis === 'y' ? [{ x: 20, y: 10 }, { x: 20, y: 30 }] : [{ x: 10, y: 20 }, { x: 30, y: 20 }];
      expect(grid.findPath(from, to), `axis ${axis}`).toBeNull();
    }
  });

  it(`passes doors at least MIN_BOT_DOOR_WIDTH (${MIN_BOT_DOOR_WIDTH}) wide wherever they sit on the grid`, () => {
    for (const shift of [0, 0.1, 0.2, 0.3, 0.4]) {
      const arch: ObstacleDef = { id: 'a', type: 'arch', pos: { x: 20 + shift, y: 20 }, params: { w: 38, d: 1, doorWidth: MIN_BOT_DOOR_WIDTH, doorHeight: 2, axis: 'y' } };
      expect(NavGrid.build(mapOf([arch]), CONFIG).findPath({ x: 20, y: 10 }, { x: 20, y: 30 }), `shift ${shift}`).not.toBeNull();
    }
  });

  it('an axis-x arch, both default donuts and the cone are routed around or through as their shapes allow', () => {
    const grid = NavGrid.build(DEFAULT_MAP, CONFIG);
    // through the axis-x arch's door (at 32, 20): move along x
    expect(grid.findPath({ x: 28, y: 20 }, { x: 36, y: 20 })!.every((p) => Math.abs(p.y - 20) <= 1)).toBe(true);
    // the donuts' and cone's footprints are never walkable
    for (const p of [{ x: 32, y: 32 }, { x: 8, y: 20 }, { x: 32, y: 8 }]) expect(grid.walkable(p)).toBe(false);
  });

  it('a start off the cell center, or in a cell too tight to fit, still gives a path the physics can walk', () => {
    const grid = NavGrid.build(DEFAULT_MAP, CONFIG);
    const world = new PhysicsWorld(RAPIER, DEFAULT_MAP, CONFIG);
    world.addPlayer('p', { x: 1, y: 1 });
    const rng = { rngState: rngStateFromSeed(7) };
    let tried = 0;
    for (let i = 0; tried < 80 && i < 2000; i++) {
      // a random position the body really fits at (physics), anywhere — not snapped
      const from = { x: 1 + nextRandom(rng) * 38, y: 1 + nextRandom(rng) * 38 };
      if (!world.isFreeOfObstacles(from) || from.x < 0.5 || from.y < 0.5 || from.x > 39.5 || from.y > 39.5) continue;
      const to = { x: 1 + nextRandom(rng) * 38, y: 1 + nextRandom(rng) * 38 };
      if (!grid.walkable(to)) continue;
      const path = grid.findPath(from, to);
      if (!path) continue;
      tried++;
      const result = follow(world, from, path);
      expect(result.reached, `from ${JSON.stringify(from)} to ${JSON.stringify(to)} stuck at ${JSON.stringify(result.at)}`).toBe(true);
    }
    expect(tried).toBe(80);
  });

  it('a bot resting against a low wall (closer than a cell allows) can still leave', () => {
    const low: ObstacleDef = { id: 'w', type: 'cube', pos: { x: 20, y: 20 }, params: { w: 2, d: 10, h: 0.6 } }; // face at x 19
    const grid = NavGrid.build(mapOf([low]), CONFIG);
    const world = new PhysicsWorld(RAPIER, mapOf([low]), CONFIG);
    world.addPlayer('p', { x: 1, y: 1 });
    const from = { x: 19 - CONFIG.playerRadius - 0.001, y: 20 };
    const path = grid.findPath(from, { x: 5, y: 5 })!;
    expect(path).not.toBeNull();
    expect(follow(world, from, path).reached).toBe(true);
  });

  it('start equal to the goal gives an empty path; a start outside the board is snapped inside', () => {
    const grid = NavGrid.build(mapOf([]), CONFIG);
    expect(grid.findPath({ x: 5.25, y: 5.25 }, { x: 5.3, y: 5.2 })).toEqual([]);
    const fromOutside = grid.findPath({ x: -5, y: 20 }, { x: 10, y: 20 });
    expect(fromOutside).not.toBeNull();
  });

  it('a board-edge cell reachable only along the edge is reached', () => {
    const grid = NavGrid.build(mapOf([]), CONFIG);
    const path = grid.findPath({ x: 39.25, y: 5.25 }, { x: 39.25, y: 30.25 })!;
    expect(path).toEqual([{ x: 39.25, y: 30.25 }]);
  });

  it('when the nearest cell a player fits is sealed off, the nearest reachable one wins', () => {
    // a closed box of tall walls around (20, 20): its inside fits a player but can't be reached
    const walls: ObstacleDef[] = [
      { id: 'n', type: 'cube', pos: { x: 20, y: 23 }, params: { w: 7, d: 1, h: 2 } },
      { id: 's', type: 'cube', pos: { x: 20, y: 17 }, params: { w: 7, d: 1, h: 2 } },
      { id: 'e', type: 'cube', pos: { x: 23, y: 20 }, params: { w: 1, d: 5, h: 2 } },
      { id: 'w', type: 'cube', pos: { x: 17, y: 20 }, params: { w: 1, d: 5, h: 2 } },
      { id: 'c', type: 'cube', pos: { x: 20, y: 20 }, params: { w: 0.5, d: 0.5, h: 2 } }, // the goal itself is unfittable
    ];
    const path = NavGrid.build(mapOf(walls), CONFIG).findPath({ x: 5, y: 20 }, { x: 20, y: 20 })!;
    expect(path).not.toBeNull();
    const end = path.at(-1)!;
    expect(end.x < 16.5 || end.x > 23.5 || end.y < 16.5 || end.y > 23.5).toBe(true); // outside the box
  });

  it('is fast enough for 8 bots replanning several times a second', () => {
    const grid = NavGrid.build(DEFAULT_MAP, CONFIG);
    const start = performance.now();
    for (let i = 0; i < 200; i++) grid.findPath({ x: 2 + (i % 30), y: 2 }, { x: 36, y: 36 - (i % 30) });
    for (let i = 0; i < 20; i++) grid.findPath({ x: 2, y: 2 }, { x: 32, y: 32 }); // an unfittable goal (a donut)
    expect((performance.now() - start) / 220).toBeLessThan(2); // ms per path
    const big: MapDef = { version: 1, board: { width: 200, height: 200 }, obstacles: Array.from({ length: 150 }, (_, i) => ({ id: `c${i}`, type: 'cube' as const, pos: { x: 10 + (i % 15) * 12, y: 10 + Math.floor(i / 15) * 18 }, params: { w: 3, d: 1, h: 2 } })) };
    const t0 = performance.now();
    NavGrid.build(big, CONFIG);
    expect(performance.now() - t0).toBeLessThan(400);
  });

  it('a first turn away from the current facing costs like any other turn (optional facing)', () => {
    const grid = NavGrid.build(mapOf([]), CONFIG);
    // facing +Y: going to a point up-right, it prefers to go up first (no extra turn)
    const up = grid.findPath({ x: 5.25, y: 5.25 }, { x: 15.25, y: 15.25 }, '+Y')!;
    expect(up[0]!.x).toBeCloseTo(5.25);
    const right = grid.findPath({ x: 5.25, y: 5.25 }, { x: 15.25, y: 15.25 }, '+X')!;
    expect(right[0]!.y).toBeCloseTo(5.25);
  });
});
