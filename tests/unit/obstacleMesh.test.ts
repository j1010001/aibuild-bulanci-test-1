// Regression coverage for the core lesson of this rewrite: rendered obstacle geometry
// (render.ts) and physics collider geometry (physics/obstacles.ts) must both come from
// the same buildObstacleGeometry() output (src/geometry) — not two independently-tuned
// representations. This checks that render.ts's buildObstacleMesh faithfully reproduces
// those exact numbers (dimensions, position) rather than recomputing its own; a ground
// decal tracing the "real" hitbox underneath a mismatched mesh was tried and rejected
// earlier in this project's history — a symptom patch, not a fix, and it still left two
// disagreeing sources of truth. three.js geometry/mesh objects are pure JS (no
// canvas/WebGL needed), so this is inspectable directly, without a browser.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildObstacleGeometry } from '../../src/geometry/obstacleGeometry';
import type { BoxSpec, ConeSpec } from '../../src/geometry/obstacleGeometry';
import { buildObstacleMesh } from '../../src/render';
import type { ObstacleDef } from '../../src/sim';

const H = 0.9;

function boxParams(mesh: THREE.Mesh): { width: number; height: number; depth: number } {
  return (mesh.geometry as THREE.BoxGeometry).parameters;
}

describe('buildObstacleMesh matches buildObstacleGeometry exactly', () => {
  it('cube: box mesh dimensions and position equal the shared geometry spec', () => {
    const def: ObstacleDef = { id: 'o', type: 'cube', pos: { x: 12, y: 7 }, params: { w: 3, d: 2, h: 1.5 } };
    const spec = buildObstacleGeometry(def).parts[0] as BoxSpec;
    const mesh = buildObstacleMesh(def, H) as THREE.Mesh;
    const { width, height, depth } = boxParams(mesh);
    expect(width).toBe(spec.width);
    expect(height).toBe(spec.height);
    expect(depth).toBe(spec.depth);
    expect(mesh.position.x).toBe(spec.center.x);
    expect(mesh.position.y).toBe(spec.center.y);
    expect(mesh.position.z).toBe(spec.center.z);
  });

  it('cone: dimensions and position equal the shared geometry spec', () => {
    const def: ObstacleDef = { id: 'o', type: 'cone', pos: { x: 5, y: 5 }, params: { radius: 2.5, height: 3 } };
    const spec = buildObstacleGeometry(def).parts[0] as ConeSpec;
    const mesh = buildObstacleMesh(def, H) as THREE.Mesh;
    const params = (mesh.geometry as THREE.ConeGeometry).parameters;
    expect(params.radius).toBe(spec.radius);
    expect(params.height).toBe(spec.height);
    expect(mesh.position.y).toBe(spec.center.y);
  });

  it('donut (both axes): the rendered mesh has the exact same vertex/index data as buildObstacleGeometry produces for physics', () => {
    for (const axis of ['x', 'y'] as const) {
      const def: ObstacleDef = { id: 'o', type: 'donut', pos: { x: 20, y: 20 }, params: { w: 5, d: 1, holeRadius: 0.3, axis } };
      const specGeometry = (buildObstacleGeometry(def).parts[0] as any).geometry as THREE.BufferGeometry;
      const mesh = buildObstacleMesh(def, H) as THREE.Mesh;
      expect(mesh.geometry.type).toBe('BufferGeometry'); // not a torus/box approximation
      // Not the literal same object (each call regenerates it — buildDonutGeometry is a
      // pure, deterministic function of its params, called once by physics and once by
      // render), but the vertex/index data must be identical, which is what actually
      // guarantees the render and the hitbox agree.
      expect(Array.from(mesh.geometry.attributes.position!.array)).toEqual(Array.from(specGeometry.attributes.position!.array));
      expect(Array.from(mesh.geometry.index!.array)).toEqual(Array.from(specGeometry.index!.array));
    }
  });

  it('arch (both axes): every pillar/lintel box matches its shared geometry spec exactly and renders opaque', () => {
    for (const [axis, w, d] of [
      ['y', 6, 1],
      ['x', 1, 6],
    ] as const) {
      const def: ObstacleDef = { id: 'o', type: 'arch', pos: { x: 20, y: 20 }, params: { w, d, doorWidth: 2, doorHeight: 1, axis } };
      const spec = buildObstacleGeometry(def);
      const group = buildObstacleMesh(def, H) as THREE.Group;
      expect(group.children.length).toBe(spec.parts.length);

      for (const partSpec of spec.parts as BoxSpec[]) {
        const match = group.children.find((child) => {
          const mesh = child as THREE.Mesh;
          const { width, height, depth } = boxParams(mesh);
          return (
            width === partSpec.width &&
            height === partSpec.height &&
            depth === partSpec.depth &&
            mesh.position.x === partSpec.center.x &&
            mesh.position.y === partSpec.center.y &&
            mesh.position.z === partSpec.center.z
          );
        }) as THREE.Mesh | undefined;
        expect(match, `no rendered part matches spec ${JSON.stringify(partSpec)}`).toBeTruthy();

        // Pillar and lintel render identically opaque: a lintel is either genuinely
        // solid to the player's real body (doorHeight < playerHeight) or sits entirely
        // above the player's reach (doorHeight >= playerHeight) — never a "solid to
        // bullets only" ghost wall, since bulletHeight < playerHeight always (spec §7,
        // §11). Nothing here should read as translucent.
        const mat = match!.material as THREE.MeshStandardMaterial;
        expect(mat.transparent).toBe(false);
      }
    }
  });
});
