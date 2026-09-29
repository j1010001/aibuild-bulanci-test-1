// M2.5 task 1: bot navigation — a grid of where a player fits, planned from the same
// obstacle geometry the physics world uses, and A* over it. The decisive check is the
// last one: paths the grid plans are actually walkable in the real physics world.

import { beforeAll, describe, expect, it } from 'vitest';
import { NavGrid } from '../../src/client/bots/navigation';
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

describe('NavGrid paths are walkable in the real physics world', () => {
  // Follow each planned path with the physics engine's own movement (including the gun
  // leading, and turning), and require every waypoint to be reached.
  function follow(world: PhysicsWorld, start: Vec2, path: Vec2[]): { reached: boolean; at: Vec2 } {
    world.setPlayerPosition('p', start);
    let pos = { ...start };
    for (const wp of path) {
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
