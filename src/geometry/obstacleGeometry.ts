// The single conversion from an obstacle's authoring params to real 3D geometry. Both
// the renderer (src/render.ts) and the physics world (src/physics/obstacles.ts) consume
// this same output — a box spec becomes a THREE.BoxGeometry mesh AND a Rapier Cuboid
// collider with identical dimensions/position; a donut spec carries the literal
// THREE.BufferGeometry used for both the render mesh and the Rapier trimesh collider.
// There is no second, independently-authored representation of any obstacle's shape.
//
// Computed once per obstacle at map load (spec §6: "derived deterministically... at
// load time... never computed per-tick"), same as the old 2D solidToPlayers/
// solidToBullets shapes this replaces.

import * as THREE from 'three';
import { buildDonutGeometry } from './donutMesh';
import type { ArchParams, ConeParams, CubeParams, DonutParams, ObstacleDef } from '../sim/types';

export type Vec3 = { x: number; y: number; z: number };

export type BoxSpec = {
  kind: 'box';
  width: number;
  height: number;
  depth: number;
  center: Vec3;
  /** Arch parts only: pillars are always solid to players; the lintel never is (spec
   * §7) — render.ts uses this to pick an opaque vs. translucent material. Omitted for
   * every other primitive, where "solid" is simply the whole part. */
  role?: 'pillar' | 'lintel';
};
export type ConeSpec = { kind: 'cone'; radius: number; height: number; center: Vec3 };
/** A vertical cylinder (the player's body; available to obstacles too). */
export type CylinderSpec = { kind: 'cylinder'; radius: number; height: number; center: Vec3 };
export type TrimeshSpec = { kind: 'trimesh'; geometry: THREE.BufferGeometry; center: Vec3; rotationY: number; rotationX: number };

export type PartSpec = BoxSpec | ConeSpec | CylinderSpec | TrimeshSpec;

/** An obstacle's full geometry: one or more parts (e.g. an arch's two pillars + lintel). */
export type ObstacleGeometry = { parts: PartSpec[] };

/** Every arch stands this tall; a door at least this high leaves no lintel (spec §7, §13). */
export const ARCH_HEIGHT = 3;

export function buildObstacleGeometry(def: ObstacleDef): ObstacleGeometry {
  switch (def.type) {
    case 'cube':
      return { parts: [buildCubeBox(def.pos, def.params as CubeParams)] };
    case 'cone':
      return { parts: [buildConePart(def.pos, def.params as ConeParams)] };
    case 'arch':
      return { parts: buildArchParts(def.pos, def.params as ArchParams) };
    case 'donut':
      return { parts: [buildDonutPart(def.pos, def.params as DonutParams)] };
  }
}

function buildCubeBox(pos: { x: number; y: number }, p: CubeParams): BoxSpec {
  return { kind: 'box', width: p.w, height: p.h, depth: p.d, center: { x: pos.x, y: p.h / 2, z: pos.y } };
}

function buildConePart(pos: { x: number; y: number }, p: ConeParams): ConeSpec {
  return { kind: 'cone', radius: p.radius, height: p.height, center: { x: pos.x, y: p.height / 2, z: pos.y } };
}

function buildArchParts(pos: { x: number; y: number }, p: ArchParams): PartSpec[] {
  const parts: PartSpec[] = [];
  if (p.axis === 'x') {
    const pillarD = (p.d - p.doorWidth) / 2;
    parts.push({ kind: 'box', role: 'pillar', width: p.w, height: ARCH_HEIGHT, depth: pillarD, center: { x: pos.x, y: ARCH_HEIGHT / 2, z: pos.y - p.d / 2 + pillarD / 2 } });
    parts.push({ kind: 'box', role: 'pillar', width: p.w, height: ARCH_HEIGHT, depth: pillarD, center: { x: pos.x, y: ARCH_HEIGHT / 2, z: pos.y + p.d / 2 - pillarD / 2 } });
    const lintelH = ARCH_HEIGHT - p.doorHeight;
    if (lintelH > 0) {
      parts.push({ kind: 'box', role: 'lintel', width: p.w, height: lintelH, depth: p.doorWidth, center: { x: pos.x, y: p.doorHeight + lintelH / 2, z: pos.y } });
    }
  } else {
    const pillarW = (p.w - p.doorWidth) / 2;
    parts.push({ kind: 'box', role: 'pillar', width: pillarW, height: ARCH_HEIGHT, depth: p.d, center: { x: pos.x - p.w / 2 + pillarW / 2, y: ARCH_HEIGHT / 2, z: pos.y } });
    parts.push({ kind: 'box', role: 'pillar', width: pillarW, height: ARCH_HEIGHT, depth: p.d, center: { x: pos.x + p.w / 2 - pillarW / 2, y: ARCH_HEIGHT / 2, z: pos.y } });
    const lintelH = ARCH_HEIGHT - p.doorHeight;
    if (lintelH > 0) {
      parts.push({ kind: 'box', role: 'lintel', width: p.doorWidth, height: lintelH, depth: p.d, center: { x: pos.x, y: p.doorHeight + lintelH / 2, z: pos.y } });
    }
  }
  return parts;
}

function buildDonutPart(pos: { x: number; y: number }, p: DonutParams): TrimeshSpec {
  const acrossExtent = p.axis === 'x' ? p.d : p.w;
  const alongExtent = p.axis === 'x' ? p.w : p.d;
  const hubHeight = acrossExtent / 2;
  const geometry = buildDonutGeometry(hubHeight, p.holeRadius, alongExtent);
  // The washer's local Z is its hole axis, and it already stands vertically by
  // construction (ring in local XY, resting on the ground) — that's already "wheel
  // facing forward," so axis='y' (hole facing world Z, i.e. game's y_game axis) needs
  // no rotation at all. axis='x' turns that same standing wheel 90° about the vertical
  // (world Y) axis so the hole faces world X instead.
  return {
    kind: 'trimesh',
    geometry,
    center: { x: pos.x, y: hubHeight, z: pos.y },
    rotationX: 0,
    rotationY: p.axis === 'x' ? Math.PI / 2 : 0,
  };
}
