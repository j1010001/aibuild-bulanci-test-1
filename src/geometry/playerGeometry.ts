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

import type { BoxSpec, ConeSpec, CylinderSpec } from './obstacleGeometry';

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
