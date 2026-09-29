// The single definition of a player's shape (spec §7, §11): the physics world builds the
// player's colliders from it and the renderer draws the very same parts, so what you see
// of a player — body and gun — is exactly what collides. Changing how a player looks and
// collides means changing this function; nothing else.
//
// Local frame: origin at the center of the player's footprint on the ground, y up, and
// the player facing local +Z (the gun points along +Z). The renderer turns the whole
// group to the player's facing; the physics world orients the gun per direction.
//
// Every part must be convex (box, cylinder or cone): players move, and a moving shape can
// only be swept against the static donut trimesh if it is convex. A future detailed
// model becomes several convex pieces (or a convex hull), not a triangle mesh.
//
// Body parts must also be symmetric about the vertical axis (a cylinder or cone centered
// on it): the body's colliders don't turn with the facing, so an off-axis part would be
// drawn turned but collide unturned. The gun is the part that turns (orientPart).

import type { BoxSpec, ConeSpec, CylinderSpec, Vec3 } from './obstacleGeometry';
import type { Direction } from '../sim/types';
import { DIR_VECTOR } from '../sim/types';

export type PlayerShapeConfig = { playerRadius: number; playerHeight: number; muzzleOffset: number; bulletHeight: number };

export type ConvexPart = BoxSpec | ConeSpec | CylinderSpec;

/** `role` only picks the material: the skin color, the dress, or the gun. */
export type PlayerPart = { part: ConvexPart; role: 'skin' | 'dress' | 'gun' };

export type PlayerGeometry = {
  /** Always collides (moves with the player, blocks others, takes bullets). */
  body: PlayerPart[];
  /** Points along the facing; swept when moving and tested when turning (spec §8). */
  gun: PlayerPart[];
};

const DRESS_FRACTION = 0.45; // lower share of the body height drawn as the dress
const BARREL = 0.08; // barrel thickness

export function buildPlayerGeometry(c: PlayerShapeConfig): PlayerGeometry {
  const dressH = c.playerHeight * DRESS_FRACTION;
  const skinH = c.playerHeight - dressH;
  const gunLength = c.muzzleOffset - c.playerRadius;
  return {
    // A "tomato in a dress" that is, in outline, exactly one cylinder: two stacked parts.
    body: [
      { role: 'dress', part: { kind: 'cylinder', radius: c.playerRadius, height: dressH, center: { x: 0, y: dressH / 2, z: 0 } } },
      { role: 'skin', part: { kind: 'cylinder', radius: c.playerRadius, height: skinH, center: { x: 0, y: dressH + skinH / 2, z: 0 } } },
    ],
    gun: [
      {
        role: 'gun',
        part: { kind: 'box', width: BARREL, height: BARREL, depth: gunLength, center: { x: 0, y: c.bulletHeight, z: c.playerRadius + gunLength / 2 } },
      },
    ],
  };
}

/**
 * A part turned to face `dir`, as an offset from the player's ground position plus a
 * world-axis-aligned part centered on that offset. Local +Z (forward) becomes the facing
 * and local +X its right-hand side — the same turn the renderer applies (rotation.y =
 * atan2(v.x, v.y)); box extents swap accordingly. Cylinders and cones are vertical.
 */
export function orientPart(part: ConvexPart, dir: Direction): { offset: Vec3; part: ConvexPart } {
  const f = DIR_VECTOR[dir]; // forward, in world (x, z)
  const r = { x: f.y, y: -f.x }; // right-hand side
  const c = part.center;
  const offset = { x: c.x * r.x + c.z * f.x, y: c.y, z: c.x * r.y + c.z * f.y };
  if (part.kind !== 'box') return { offset, part: { ...part, center: offset } };
  const width = Math.abs(r.x) * part.width + Math.abs(f.x) * part.depth;
  const depth = Math.abs(r.y) * part.width + Math.abs(f.y) * part.depth;
  return { offset, part: { ...part, width, depth, center: offset } };
}
