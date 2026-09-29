// A pure chase-and-shoot strategy: one DynamicState in, one input out. Line up with the
// target on the axis where the gap is smaller (moving along the other axis would run
// into it), face it, fire. Used by tests to produce real kills and by the headless bot.

import type { Direction, PlayerId } from '../sim';
import type { DynamicState } from '../session/protocol';

export type BotInput = { moveDir: Direction | null; shoot: boolean };

/** Lined up once within this distance — well inside the player radius (0.5) a bullet must hit. */
const ALIGN_TOLERANCE = 0.25;

export function chaseAndShoot(state: DynamicState, meId: PlayerId, targetId: PlayerId): BotInput {
  const me = state.players.find((p) => p.id === meId);
  const target = state.players.find((p) => p.id === targetId);
  if (!me || !target || !me.alive || !target.alive || !target.connected) return { moveDir: null, shoot: false };

  const dx = target.pos.x - me.pos.x;
  const dy = target.pos.y - me.pos.y;

  let want: Direction;
  if (Math.abs(dx) <= ALIGN_TOLERANCE) want = dy > 0 ? '+Y' : '-Y';
  else if (Math.abs(dy) <= ALIGN_TOLERANCE) want = dx > 0 ? '+X' : '-X';
  else if (Math.abs(dx) <= Math.abs(dy)) return { moveDir: dx > 0 ? '+X' : '-X', shoot: false };
  else return { moveDir: dy > 0 ? '+Y' : '-Y', shoot: false };

  return me.facing === want ? { moveDir: null, shoot: true } : { moveDir: want, shoot: false };
}
