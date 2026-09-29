// M0 task 2: the player's shape comes from one definition (buildPlayerGeometry), which both
// the physics world and the renderer consume — the same rule as obstacles (spec §7, §11).
// What you see of a player (body and gun) is exactly what collides.

import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildPlayerGeometry, orientPart, type PlayerShapeConfig } from '../../src/geometry/playerGeometry';
import type { BoxSpec, CylinderSpec } from '../../src/geometry/obstacleGeometry';
import { bulletMesh, buildPlayerMesh, facingAngle } from '../../src/render';
import { ensureRapierReady, type Rapier } from '../../src/physics/rapier';
import { PhysicsWorld } from '../../src/physics/world';
import { DIRECTIONS, type Direction } from '../../src/sim';

let RAPIER: Rapier;
beforeAll(async () => {
  RAPIER = await ensureRapierReady();
});

/** The world-space bounds of a player drawn at `pos` facing `dir`, exactly as the renderer places it. */
function drawnBounds(object: THREE.Object3D, pos: { x: number; y: number }, dir: Direction): THREE.Box3 {
  const holder = new THREE.Group();
  holder.position.set(pos.x, 0, pos.y);
  holder.rotation.y = facingAngle(dir);
  holder.add(object);
  holder.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object);
}

const CONFIG: PlayerShapeConfig = { playerRadius: 0.5, playerHeight: 1.2, muzzleOffset: 0.8, bulletHeight: 0.9 };
const CONVEX_KINDS = new Set(['box', 'cylinder', 'cone']);

describe('buildPlayerGeometry', () => {
  it('uses only convex parts (a moving shape must be convex to sweep against the donut trimesh)', () => {
    const g = buildPlayerGeometry(CONFIG);
    for (const p of [...g.body, ...g.gun]) expect(CONVEX_KINDS.has(p.part.kind)).toBe(true);
  });

  it('the body is exactly one cylinder of the player radius from the ground to the player height', () => {
    const body = buildPlayerGeometry(CONFIG).body.map((p) => p.part as CylinderSpec);
    for (const c of body) {
      expect(c.kind).toBe('cylinder');
      expect(c.radius).toBe(0.5);
      expect(c.center.x).toBe(0);
      expect(c.center.z).toBe(0);
    }
    const spans = body.map((c) => [c.center.y - c.height / 2, c.center.y + c.height / 2] as const).sort((a, b) => a[0] - b[0]);
    expect(spans[0]![0]).toBeCloseTo(0);
    expect(spans.at(-1)![1]).toBeCloseTo(1.2);
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeCloseTo(spans[i - 1]![1]); // stacked, no gap or overlap
  });

  it('the gun is a thin barrel at bullet height, from the body edge to the muzzle, pointing forward (+Z)', () => {
    const gun = buildPlayerGeometry(CONFIG).gun.map((p) => p.part as BoxSpec);
    expect(gun).toHaveLength(1);
    const g = gun[0]!;
    expect(g.kind).toBe('box');
    expect(g.center.y).toBeCloseTo(0.9);
    expect(g.center.z - g.depth / 2).toBeCloseTo(0.5);
    expect(g.center.z + g.depth / 2).toBeCloseTo(0.8);
    expect(g.width).toBeLessThanOrEqual(0.1);
    expect(g.height).toBeLessThanOrEqual(0.1);
  });

  // Review follow-up: body colliders do not turn with the facing (only the gun does), so a
  // body part must look the same from every side — centered on the vertical axis.
  it('body parts are symmetric about the vertical axis, so they look and collide the same at any facing', () => {
    for (const { part } of buildPlayerGeometry(CONFIG).body) {
      expect(['cylinder', 'cone']).toContain(part.kind);
      expect(part.center.x).toBe(0);
      expect(part.center.z).toBe(0);
    }
  });

  it('follows the config (a different player shape is a config change, not a code change)', () => {
    const big = buildPlayerGeometry({ playerRadius: 0.7, playerHeight: 1.6, muzzleOffset: 1.2, bulletHeight: 1.0 });
    expect((big.body[0]!.part as CylinderSpec).radius).toBe(0.7);
    const gun = big.gun[0]!.part as BoxSpec;
    expect(gun.center.z + gun.depth / 2).toBeCloseTo(1.2);
    expect(gun.center.y).toBeCloseTo(1.0);
  });
});

describe('buildPlayerMesh draws exactly buildPlayerGeometry', () => {
  it('one mesh per part, with the same dimensions and position', () => {
    const g = buildPlayerGeometry(CONFIG);
    const group = buildPlayerMesh(CONFIG);
    const parts = [...g.body, ...g.gun];
    expect(group.children).toHaveLength(parts.length);
    for (const { part } of parts) {
      const match = group.children.find((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.position.x !== part.center.x || mesh.position.y !== part.center.y || mesh.position.z !== part.center.z) return false;
        if (part.kind === 'cylinder') {
          const p = (mesh.geometry as THREE.CylinderGeometry).parameters;
          return p.radiusTop === part.radius && p.radiusBottom === part.radius && p.height === part.height;
        }
        if (part.kind === 'box') {
          const p = (mesh.geometry as THREE.BoxGeometry).parameters;
          return p.width === part.width && p.height === part.height && p.depth === part.depth;
        }
        return false;
      });
      expect(match, `no mesh for ${JSON.stringify(part)}`).toBeTruthy();
    }
  });
});

describe('orientPart: turning a part to a facing matches how the renderer turns the player', () => {
  // Off-center on purpose, so both the forward and the right-hand terms are exercised.
  const part: BoxSpec = { kind: 'box', width: 0.2, height: 0.1, depth: 0.4, center: { x: 0.3, y: 0.9, z: 0.65 } };

  it.each(DIRECTIONS)('facing %s', (dir) => {
    const drawn = drawnBounds(new THREE.Mesh(new THREE.BoxGeometry(part.width, part.height, part.depth)).translateX(part.center.x).translateY(part.center.y).translateZ(part.center.z), { x: 0, y: 0 }, dir);
    const o = orientPart(part, dir);
    const b = o.part as BoxSpec;
    expect(o.offset.x - b.width / 2).toBeCloseTo(drawn.min.x, 6);
    expect(o.offset.x + b.width / 2).toBeCloseTo(drawn.max.x, 6);
    expect(o.offset.z - b.depth / 2).toBeCloseTo(drawn.min.z, 6);
    expect(o.offset.z + b.depth / 2).toBeCloseTo(drawn.max.z, 6);
    expect(o.offset.y).toBeCloseTo(part.center.y, 6);
  });
});

describe('the drawn gun and the colliding gun point the same way, in every direction', () => {
  it.each(DIRECTIONS)('facing %s: an obstacle at the drawn muzzle blocks only that facing', (dir) => {
    const group = buildPlayerMesh(CONFIG);
    const gunMesh = group.children.find((c) => (c as THREE.Mesh).position.z > 0.5)!; // the barrel sits in front of the body
    const gunBox = drawnBounds(gunMesh, { x: 20, y: 20 }, dir);
    const center = gunBox.getCenter(new THREE.Vector3());
    const map = {
      version: 1 as const,
      board: { width: 40, height: 40 },
      obstacles: [{ id: 'post', type: 'cube' as const, pos: { x: center.x, y: center.z }, params: { w: 0.05, d: 0.05, h: 2 } }],
    };
    const world = new PhysicsWorld(RAPIER, map, CONFIG);
    world.addPlayer('p0', { x: 20, y: 20 });
    for (const other of DIRECTIONS) expect(world.gunFits('p0', { x: 20, y: 20 }, other), `${dir} vs ${other}`).toBe(other !== dir);
  });
});

describe('player materials and bullet tracers', () => {
  it("the part tinted with the player's color is the skin part", () => {
    const g = buildPlayerGeometry(CONFIG);
    const group = buildPlayerMesh(CONFIG);
    const skin = g.body.find((p) => p.role === 'skin')!.part;
    const mesh = group.children.find((c) => c.position.y === skin.center.y) as THREE.Mesh;
    expect(mesh.material).toBe(group.userData.skin);
  });

  it.each(DIRECTIONS)('a tracer facing %s has its tip at the bullet and trails back along the path', (dir) => {
    const mesh = bulletMesh(dir);
    mesh.position.set(10, 0.9, 10);
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    const v = { '+X': [1, 0], '-X': [-1, 0], '+Y': [0, 1], '-Y': [0, -1] }[dir]!;
    // the tip: the extreme point in the direction of travel is the bullet's position
    const front = v[0]! !== 0 ? (v[0]! > 0 ? box.max.x : box.min.x) : v[1]! > 0 ? box.max.z : box.min.z;
    expect(front).toBeCloseTo(10, 6);
    const back = v[0]! !== 0 ? (v[0]! > 0 ? box.min.x : box.max.x) : v[1]! > 0 ? box.min.z : box.max.z;
    expect(Math.sign(10 - back)).toBe(v[0]! !== 0 ? v[0]! : v[1]!);
  });
});
