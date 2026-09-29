// Test change, with justification (M0 task 2): the world now builds the player's shape
// (body and gun) itself from the full player config, so moveDistance no longer takes a
// muzzleOffset argument — a mechanical signature change, no assertion changed.
//
// Validates the real-3D-physics collision layer directly (no sim/game-rules layer
// involved yet) against the exact scenarios this architecture exists to get right:
// a donut's hole is a real hole (emerges from mesh geometry, not a hand-coded axis
// rule), and an arch's doorHeight threshold genuinely depends on real body/bullet
// height rather than a hard-coded "players always pass" exception. See spec §7.

import { beforeAll, describe, expect, it } from 'vitest';
import { ensureRapierReady, type Rapier } from '../../src/physics/rapier';
import { PhysicsWorld } from '../../src/physics/world';
import type { MapDef, ObstacleDef } from '../../src/sim/types';

const PLAYER_RADIUS = 0.5;
const PLAYER_HEIGHT = 1.2;
const BULLET_HEIGHT = 0.9;
const MUZZLE_OFFSET = 0.8;

let RAPIER: Rapier;

function worldWith(obstacles: ObstacleDef[]): PhysicsWorld {
  const map: MapDef = { version: 1, board: { width: 40, height: 40 }, obstacles };
  return new PhysicsWorld(RAPIER, map, { playerRadius: PLAYER_RADIUS, playerHeight: PLAYER_HEIGHT, muzzleOffset: MUZZLE_OFFSET, bulletHeight: BULLET_HEIGHT });
}

beforeAll(async () => {
  RAPIER = await ensureRapierReady();
});

describe('PhysicsWorld: donut', () => {
  // hub = w/2 = 2.5, hole = [hub-holeRadius, hub+holeRadius] = [0.8, 4.2] — comfortably
  // contains bulletHeight (0.9), not exactly on its boundary (a real edge case, tested
  // separately below, not something to trip over here by coincidence).
  const shootable: ObstacleDef = { id: 'd', type: 'donut', pos: { x: 20, y: 20 }, params: { w: 5, d: 1, holeRadius: 1.7, axis: 'y' } };
  const blocked: ObstacleDef = { id: 'd', type: 'donut', pos: { x: 20, y: 20 }, params: { w: 5, d: 1, holeRadius: 0.3, axis: 'x' } };

  it('shootable donut (axis y): a bullet at the hole height passes through along y, blocked across x', () => {
    const world = worldWith([shootable]);
    const along = world.raycastBullet({ x: 20, y: 5 }, '+Y', 30, BULLET_HEIGHT);
    expect(along).toBeNull(); // nothing to hit at all -> passes clean through the real hole

    const across = world.raycastBullet({ x: 5, y: 20 }, '+X', 30, BULLET_HEIGHT);
    expect(across).not.toBeNull();
    expect(across!.distance).toBeLessThan(30);
  });

  it('blocked donut (axis x): a bullet at bulletHeight is stopped by the rim (hole is elsewhere on the height axis)', () => {
    const world = worldWith([blocked]);
    const along = world.raycastBullet({ x: 5, y: 20 }, '+X', 30, BULLET_HEIGHT);
    expect(along).not.toBeNull();
  });

  it('a donut always blocks a ground-standing player at its center (real geometry, no special-cased rule)', () => {
    const world = worldWith([shootable]);
    world.addPlayer('p0', { x: 20, y: 10 });
    const advance = world.moveDistance('p0', '+Y', 30);
    expect(advance).toBeLessThan(30);
    expect(advance).toBeGreaterThan(0);
  });
});

describe('PhysicsWorld: arch', () => {
  const openArch: ObstacleDef = { id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 6, d: 1, doorWidth: 2, doorHeight: 2, axis: 'y' } };
  const lowSlotArch: ObstacleDef = { id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 6, d: 1, doorWidth: 2, doorHeight: 1.0, axis: 'y' } };
  const closedArch: ObstacleDef = { id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 6, d: 1, doorWidth: 2, doorHeight: 0.3, axis: 'y' } };

  it('open door (doorHeight above playerHeight): both a bullet and a player pass through the gap', () => {
    const world = worldWith([openArch]);
    const bullet = world.raycastBullet({ x: 20, y: 10 }, '+Y', 30, BULLET_HEIGHT);
    expect(bullet).toBeNull();

    world.addPlayer('p0', { x: 20, y: 10 });
    const advance = world.moveDistance('p0', '+Y', 30);
    expect(advance).toBeCloseTo(30, 5);
  });

  it('low slot (doorHeight between bulletHeight and playerHeight): bullet passes under, player is too tall to fit', () => {
    const world = worldWith([lowSlotArch]);
    const bullet = world.raycastBullet({ x: 20, y: 10 }, '+Y', 30, BULLET_HEIGHT);
    expect(bullet).toBeNull(); // bulletHeight 0.9 < doorHeight 1.0: passes under the lintel

    world.addPlayer('p0', { x: 20, y: 10 });
    const advance = world.moveDistance('p0', '+Y', 30);
    expect(advance).toBeLessThan(30); // playerHeight 1.2 > doorHeight 1.0: body hits the lintel
  });

  it('closed (doorHeight below bulletHeight): both are blocked', () => {
    const world = worldWith([closedArch]);
    const bullet = world.raycastBullet({ x: 20, y: 10 }, '+Y', 30, BULLET_HEIGHT);
    expect(bullet).not.toBeNull();

    world.addPlayer('p0', { x: 20, y: 10 });
    const advance = world.moveDistance('p0', '+Y', 30);
    expect(advance).toBeLessThan(30);
  });

  it('pillars always block regardless of doorHeight', () => {
    const world = worldWith([openArch]);
    world.addPlayer('p0', { x: 17, y: 10 }); // aligned with the left pillar's x-span
    const advance = world.moveDistance('p0', '+Y', 30);
    expect(advance).toBeLessThan(30);
  });
});

describe('PhysicsWorld: basic obstacle movement blocking', () => {
  it('a cube wall stops a player at the leading gun, not the body (spec §7: the gun always leads)', () => {
    const wall: ObstacleDef = { id: 'w', type: 'cube', pos: { x: 10, y: 10 }, params: { w: 2, d: 2, h: 2 } };
    const world = worldWith([wall]);
    world.addPlayer('p0', { x: 5, y: 10 });
    const advance = world.moveDistance('p0', '+X', 100);
    // wall minX = 9; muzzleOffset (0.8) > playerRadius (0.5), so the gun's tip reaches
    // the wall before the body does: contact when x + muzzleOffset = 9 -> x = 8.2.
    expect(advance).toBeCloseTo(3.2, 2);
  });

  it('does not tunnel through a thin wall even with a huge requested distance', () => {
    const wall: ObstacleDef = { id: 'w', type: 'cube', pos: { x: 10, y: 10 }, params: { w: 0.1, d: 20, h: 2 } };
    const world = worldWith([wall]);
    world.addPlayer('p0', { x: 5, y: 10 });
    const advance = world.moveDistance('p0', '+X', 1000);
    expect(advance).toBeLessThan(10);
  });
});

describe('PhysicsWorld: the gun collides where it is drawn (M0 task 2)', () => {
  // The gun is a thin barrel at bullet height (0.9), not a floor-to-head slab: it passes over
  // a wall lower than that, so the body is what stops against a low wall.
  const lowWall: ObstacleDef = { id: 'w', type: 'cube', pos: { x: 10, y: 10 }, params: { w: 2, d: 2, h: 0.6 } };
  const tallWall: ObstacleDef = { id: 'w', type: 'cube', pos: { x: 10, y: 10 }, params: { w: 2, d: 2, h: 2 } };

  it('moving at a low wall: the gun passes over it, the body stops at the wall', () => {
    const world = worldWith([lowWall]);
    world.addPlayer('p0', { x: 5, y: 10 });
    const advance = world.moveDistance('p0', '+X', 100);
    expect(advance).toBeCloseTo(9 - PLAYER_RADIUS - 5, 2); // wall minX 9 minus the body radius
  });

  it('turning toward a wall closer than the muzzle: allowed over a low wall, refused into a tall one', () => {
    const low = worldWith([lowWall]);
    low.addPlayer('p0', { x: 8.35, y: 10 }); // body edge 8.85 < wall 9 < muzzle 9.15
    expect(low.gunFits('p0', { x: 8.35, y: 10 }, '+X')).toBe(true);
    const tall = worldWith([tallWall]);
    tall.addPlayer('p0', { x: 8.35, y: 10 });
    expect(tall.gunFits('p0', { x: 8.35, y: 10 }, '+X')).toBe(false);
  });

  it("the gun is still blocked by another player's body", () => {
    const world = worldWith([]);
    world.addPlayer('p0', { x: 5, y: 10 });
    world.addPlayer('p1', { x: 6.2, y: 10 }); // body spans 5.7..6.7; p0's muzzle would reach 5.8
    expect(world.gunFits('p0', { x: 5, y: 10 }, '+X')).toBe(false);
    expect(world.moveDistance('p0', '+X', 5)).toBeLessThan(0.5);
  });

  it('a bullet at bullet height hits the body (whichever body part is at that height)', () => {
    const world = worldWith([]);
    world.addPlayer('p1', { x: 20, y: 10 });
    const hit = world.raycastBullet({ x: 5, y: 10 }, '+X', 30, BULLET_HEIGHT);
    expect(hit?.hitPlayerId).toBe('p1');
  });

  it('a disabled (dead) player is inert in every part', () => {
    const world = worldWith([]);
    world.addPlayer('p0', { x: 5, y: 10 });
    world.addPlayer('p1', { x: 6.2, y: 10 });
    world.setPlayerEnabled('p1', false);
    expect(world.gunFits('p0', { x: 5, y: 10 }, '+X')).toBe(true);
    // from just past p0's body edge (5.5): only p1 (5.7..6.7) is on this path
    expect(world.raycastBullet({ x: 5.6, y: 10 }, '+X', 10, BULLET_HEIGHT)).toBeNull();
  });
});
