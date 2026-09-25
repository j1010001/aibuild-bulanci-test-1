// Pure camera geometry — no canvas, no WebGL, safe to unit-test in Node. This is the
// single source of truth for the fixed camera's orientation (spec §11) and for which
// screen direction each world movement direction appears as (spec §8's input mapping
// must match this, not be hand-maintained separately — see input.ts).
//
// Regression note: the camera azimuth used to be 45° (a diagonal "corner" view), which
// meant no world axis projected to a pure screen direction — every arrow-key press
// looked like it was drifting sideways. Fixed by requiring a cardinal azimuth (a
// multiple of 90°) and deriving the keyboard mapping from this module instead of a
// second hand-written table that could silently drift out of sync with it.

import * as THREE from 'three';
import type { Direction } from './sim';
import { DIR_VECTOR, DIRECTIONS } from './sim';

/** World azimuth around the vertical axis. Must be a multiple of 90° — see classifyScreenDirection. */
export const AZIMUTH = Math.PI / 2;
/** Tilt from straight overhead (0°) toward eye-level (90°). */
export const POLAR_FROM_VERTICAL = THREE.MathUtils.degToRad(58);

export type CameraBasis = { forward: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 };

/** The camera's fixed orientation basis. Independent of distance/target — see render.ts. */
export function computeCameraBasis(azimuth: number = AZIMUTH, polar: number = POLAR_FROM_VERTICAL): CameraBasis {
  const forward = new THREE.Vector3(
    -Math.sin(polar) * Math.cos(azimuth),
    -Math.cos(polar),
    -Math.sin(polar) * Math.sin(azimuth),
  ).normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  let right = new THREE.Vector3().crossVectors(forward, worldUp);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  return { forward, right, up };
}

export type ScreenDir = 'up' | 'down' | 'left' | 'right';

const ALIGNED_THRESHOLD = 0.999;

/**
 * Which screen-relative direction a world movement direction (§2 Direction) appears as
 * under this fixed camera. Ground-projected `forward` is "up" on screen (moving away
 * from the camera moves toward the vanishing point, which is up-screen for a
 * downward-tilted camera); `right` is screen-right.
 *
 * Throws if the azimuth isn't cardinal: with a diagonal azimuth, a world direction has
 * no single screen direction (it's part up, part sideways), which is exactly the bug
 * this function exists to prevent from recurring.
 */
export function classifyScreenDirection(
  dir: Direction,
  azimuth: number = AZIMUTH,
  polar: number = POLAR_FROM_VERTICAL,
): ScreenDir {
  const { forward, right } = computeCameraBasis(azimuth, polar);
  const groundForward = new THREE.Vector2(forward.x, forward.z).normalize();
  const groundRight = new THREE.Vector2(right.x, right.z).normalize();

  const v = DIR_VECTOR[dir];
  const world = new THREE.Vector2(v.x, v.y);

  const alongForward = world.dot(groundForward);
  const alongRight = world.dot(groundRight);

  if (Math.abs(alongForward) > ALIGNED_THRESHOLD) return alongForward > 0 ? 'up' : 'down';
  if (Math.abs(alongRight) > ALIGNED_THRESHOLD) return alongRight > 0 ? 'right' : 'left';
  throw new Error(
    `classifyScreenDirection: camera azimuth ${THREE.MathUtils.radToDeg(azimuth).toFixed(1)}° is not cardinal — ` +
      `world direction ${dir} has no single screen direction (spec §11 requires a multiple of 90°)`,
  );
}

/** The world Direction that appears as `target` on screen under this fixed camera. */
export function directionForScreen(
  target: ScreenDir,
  azimuth: number = AZIMUTH,
  polar: number = POLAR_FROM_VERTICAL,
): Direction {
  for (const dir of DIRECTIONS) {
    if (classifyScreenDirection(dir, azimuth, polar) === target) return dir;
  }
  throw new Error(`directionForScreen: no world direction maps to screen '${target}'`);
}
