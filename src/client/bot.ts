// A pure chase-and-shoot strategy: one DynamicState in, one input out. Line up with the
// target on the axis where the gap is smaller (moving along the other axis would run
// into it), face it, fire — unless an obstacle is in the way. Used by tests to produce
// real kills and by the headless bot (which adds unsticking; see botPlayer.ts).

import type { CubeParams, ConeParams, Direction, ObstacleDef, PlayerId, Vec2 } from '../sim';
import type { DynamicState } from '../session/protocol';

export type BotInput = {
  moveDir: Direction | null;
  shoot: boolean;
  /** Lined up and facing the target, but an obstacle is in the line of fire. */
  blocked?: true;
};

/** Lined up once within this distance — inside the 0.5 player radius a bullet must pass
 * within, yet wide enough that two bots closing on each other's column (0.2/tick combined,
 * deciding from 30 Hz snapshots) land in it instead of repeatedly overshooting. */
const ALIGN_TOLERANCE = 0.4;
/** A turn toward the target is refused (spec §8) while the gun, reaching 0.8 from center,
 * would enter the target's 0.5 radius; allow one tick of travel (0.1) plus margin. */
const TURN_CLEARANCE = 0.8 + 0.5 + 0.15;

type Box = { minX: number; maxX: number; minY: number; maxY: number };

/** An obstacle's horizontal footprint, if it stands tall enough to stop a bullet. */
function blockingFootprint(o: ObstacleDef, bulletHeight: number): Box | null {
  if (o.type === 'cone') {
    const r = (o.params as ConeParams).radius;
    return { minX: o.pos.x - r, maxX: o.pos.x + r, minY: o.pos.y - r, maxY: o.pos.y + r };
  }
  if (o.type === 'cube' && (o.params as CubeParams).h <= bulletHeight) return null; // bullets fly over
  // Cube, arch and donut: the full footprint. Conservative for arches and donuts (their
  // openings may let a shot through) — a bot then just finds another line.
  const { w, d } = o.params as { w: number; d: number };
  return { minX: o.pos.x - w / 2, maxX: o.pos.x + w / 2, minY: o.pos.y - d / 2, maxY: o.pos.y + d / 2 };
}

/** Is the axis-aligned segment from → to free of bullet-stopping obstacles? */
export function lineOfFireClear(from: Vec2, to: Vec2, obstacles: readonly ObstacleDef[], bulletHeight = 0.9): boolean {
  const seg: Box = { minX: Math.min(from.x, to.x), maxX: Math.max(from.x, to.x), minY: Math.min(from.y, to.y), maxY: Math.max(from.y, to.y) };
  return obstacles.every((o) => {
    const b = blockingFootprint(o, bulletHeight);
    return !b || seg.maxX < b.minX || seg.minX > b.maxX || seg.maxY < b.minY || seg.minY > b.maxY;
  });
}

export function chaseAndShoot(
  state: DynamicState,
  meId: PlayerId,
  targetId: PlayerId,
  obstacles: readonly ObstacleDef[] = [],
  bulletHeight = 0.9,
): BotInput {
  const me = state.players.find((p) => p.id === meId);
  const target = state.players.find((p) => p.id === targetId);
  if (!me || !target || !me.alive || !target.alive || !target.connected) return { moveDir: null, shoot: false };

  const dx = target.pos.x - me.pos.x;
  const dy = target.pos.y - me.pos.y;

  let want: Direction;
  let away: Direction;
  let range: number;
  if (Math.abs(dx) <= ALIGN_TOLERANCE) {
    want = dy > 0 ? '+Y' : '-Y';
    away = dy > 0 ? '-Y' : '+Y';
    range = Math.abs(dy);
  } else if (Math.abs(dy) <= ALIGN_TOLERANCE) {
    want = dx > 0 ? '+X' : '-X';
    away = dx > 0 ? '-X' : '+X';
    range = Math.abs(dx);
  } else if (Math.abs(dx) <= Math.abs(dy)) return { moveDir: dx > 0 ? '+X' : '-X', shoot: false };
  else return { moveDir: dy > 0 ? '+Y' : '-Y', shoot: false };

  if (me.facing === want) {
    // Facing the target: fire at any range — unless something stops the bullet first.
    return lineOfFireClear(me.pos, target.pos, obstacles, bulletHeight) ? { moveDir: null, shoot: true } : { moveDir: null, shoot: false, blocked: true };
  }
  // Need to turn: only possible once the gun fits between us.
  return range < TURN_CLEARANCE ? { moveDir: away, shoot: false } : { moveDir: want, shoot: false };
}
