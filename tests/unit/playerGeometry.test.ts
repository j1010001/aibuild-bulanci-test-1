// M0 task 2: the player's shape comes from one definition (buildPlayerGeometry), which both
// the physics world and the renderer consume — the same rule as obstacles (spec §7, §11).
// What you see of a player (body and gun) is exactly what collides.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildPlayerGeometry, type PlayerShapeConfig } from '../../src/geometry/playerGeometry';
import type { BoxSpec, CylinderSpec } from '../../src/geometry/obstacleGeometry';
import { buildPlayerMesh } from '../../src/render';

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
