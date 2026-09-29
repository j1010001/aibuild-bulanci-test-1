// A pure chase-and-shoot strategy: one DynamicState in, one input out. Line up with the
// target on the axis where the gap is smaller (moving along the other axis would run
// into it), face it, fire. Used by tests to produce real kills and by the headless bot.

import type { Direction, PlayerId } from '../sim';
import type { DynamicState } from '../session/protocol';

export type BotInput = { moveDir: Direction | null; shoot: boolean };

/** Lined up once within this distance — inside the 0.5 player radius a bullet must pass
 * within, yet wide enough that two bots closing on each other's column (0.2/tick combined,
 * deciding from 30 Hz snapshots) land in it instead of repeatedly overshooting. */
const ALIGN_TOLERANCE = 0.4;
/** Closer than this along the firing axis, the turn toward the target is refused (spec §8:
 * the gun, reaching 0.8 from center, would enter the target's 0.5 radius), so back off first. */
const MIN_FIRING_RANGE = 0.8 + 0.5 + 0.3;

export function chaseAndShoot(state: DynamicState, meId: PlayerId, targetId: PlayerId): BotInput {
  const me = state.players.find((p) => p.id === meId);
  const target = state.players.find((p) => p.id === targetId);
  if (!me || !target || !me.alive || !target.alive || !target.connected) return { moveDir: null, shoot: false };

  const dx = target.pos.x - me.pos.x;
  const dy = target.pos.y - me.pos.y;

  let want: Direction;
  if (Math.abs(dx) <= ALIGN_TOLERANCE) {
    if (Math.abs(dy) < MIN_FIRING_RANGE) return { moveDir: dy > 0 ? '-Y' : '+Y', shoot: false };
    want = dy > 0 ? '+Y' : '-Y';
  } else if (Math.abs(dy) <= ALIGN_TOLERANCE) {
    if (Math.abs(dx) < MIN_FIRING_RANGE) return { moveDir: dx > 0 ? '-X' : '+X', shoot: false };
    want = dx > 0 ? '+X' : '-X';
  } else if (Math.abs(dx) <= Math.abs(dy)) return { moveDir: dx > 0 ? '+X' : '-X', shoot: false };
  else return { moveDir: dy > 0 ? '+Y' : '-Y', shoot: false };

  return me.facing === want ? { moveDir: null, shoot: true } : { moveDir: want, shoot: false };
}
