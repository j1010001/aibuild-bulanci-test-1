// Builds real, static Rapier colliders directly from ObstacleGeometry (src/geometry) —
// the same numbers (and, for the donut, the literal same vertex/index buffers) that
// render.ts uses to build the visual mesh. Box parts use Rapier's native Cuboid, which
// matches THREE.BoxGeometry's half-extents convention exactly; the cone part uses
// Rapier's native Cone, confirmed (see project notes) to share THREE.ConeGeometry's
// apex-up/base-down convention; the donut uses a static trimesh collider built from its
// BufferGeometry's actual position/index arrays — an exact hole, not an approximation.

import * as THREE from 'three';
import type { ColliderDesc, World } from '@dimforge/rapier3d-compat';
import type { Rapier } from './rapier';
import type { ObstacleGeometry, PartSpec } from '../geometry/obstacleGeometry';

export const OBSTACLE_COLLISION_GROUP = 0b0001;
export const PLAYER_COLLISION_GROUP = 0b0010;
export const GUN_COLLISION_GROUP = 0b0100;
export const BULLET_COLLISION_GROUP = 0b1000;

function eulerQuaternion(rotX: number, rotY: number): { x: number; y: number; z: number; w: number } {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, 0, 'XYZ'));
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

export function addObstacleToWorld(RAPIER: Rapier, world: World, geometry: ObstacleGeometry): void {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const part of geometry.parts) {
    const desc = buildColliderDesc(RAPIER, part);
    desc.setCollisionGroups(groupsBitmask(OBSTACLE_COLLISION_GROUP, 0xffff));
    world.createCollider(desc, body);
  }
}

function buildColliderDesc(RAPIER: Rapier, part: PartSpec): ColliderDesc {
  if (part.kind === 'box') {
    return RAPIER.ColliderDesc.cuboid(part.width / 2, part.height / 2, part.depth / 2)
      .setTranslation(part.center.x, part.center.y, part.center.z);
  }
  if (part.kind === 'cone') {
    return RAPIER.ColliderDesc.cone(part.height / 2, part.radius)
      .setTranslation(part.center.x, part.center.y, part.center.z);
  }
  // trimesh (donut)
  const posAttr = part.geometry.attributes.position;
  if (!posAttr) throw new Error('donut geometry must have a position attribute');
  const vertices = new Float32Array(posAttr.array);
  const indexAttr = part.geometry.index;
  if (!indexAttr) throw new Error('donut geometry must be indexed');
  const indices = new Uint32Array(indexAttr.array);
  const rotation = eulerQuaternion(part.rotationX, part.rotationY);
  return RAPIER.ColliderDesc.trimesh(vertices, indices)
    .setTranslation(part.center.x, part.center.y, part.center.z)
    .setRotation(rotation);
}

/** Rapier collision-group bitmask: high 16 bits = membership, low 16 bits = filter. */
export function groupsBitmask(membership: number, filter: number): number {
  return (membership << 16) | filter;
}
