// A pure chase-and-shoot strategy (DynamicState -> one input). Used by room tests to
// produce real kills, and by the headless bot client (M2). Aims only along the
// axis-aligned rules: line up on the target's column, face it along Y, fire.

import { describe, expect, it } from 'vitest';
import { chaseAndShoot } from '../../src/client/bot';
import type { DynamicState } from '../../src/session/protocol';
import type { Direction } from '../../src/sim';

function state(me: { x: number; y: number; facing: Direction }, target: { x: number; y: number }, targetAlive = true): DynamicState {
  return {
    phase: 'round',
    roundNumber: 1,
    scores: { a: 0, b: 0 },
    players: [
      { id: 'a', name: 'A', skinId: 'crimson', pos: { x: me.x, y: me.y }, facing: me.facing, lastShotAt: 0, alive: true, connected: true },
      { id: 'b', name: 'B', skinId: 'gold', pos: target, facing: '+X', lastShotAt: 0, alive: targetAlive, connected: true },
    ],
    bullets: [],
    time: 0,
    roundStartedAt: 0,
    winnerId: null,
  };
}

describe('chaseAndShoot', () => {
  it('lines up along the axis with the smaller separation first', () => {
    // dx 15 < dy 25: close the X gap to share the target's column
    expect(chaseAndShoot(state({ x: 5, y: 5, facing: '+Y' }, { x: 20, y: 30 }), 'a', 'b')).toEqual({ moveDir: '+X', shoot: false });
    expect(chaseAndShoot(state({ x: 25, y: 5, facing: '+Y' }, { x: 20, y: 30 }), 'a', 'b')).toEqual({ moveDir: '-X', shoot: false });
    // dy 4 < dx 20: close the Y gap to share the target's row (moving along X would run into it)
    expect(chaseAndShoot(state({ x: 5, y: 26, facing: '+X' }, { x: 25, y: 30 }), 'a', 'b')).toEqual({ moveDir: '+Y', shoot: false });
  });

  it('shoots along X when already on the same row', () => {
    expect(chaseAndShoot(state({ x: 5, y: 30.1, facing: '+Y' }, { x: 20, y: 30 }), 'a', 'b')).toEqual({ moveDir: '+X', shoot: false });
    expect(chaseAndShoot(state({ x: 5, y: 30.1, facing: '+X' }, { x: 20, y: 30 }), 'a', 'b')).toEqual({ moveDir: null, shoot: true });
  });

  it('turns toward the target along Y once lined up', () => {
    expect(chaseAndShoot(state({ x: 20.1, y: 5, facing: '+X' }, { x: 20, y: 30 }), 'a', 'b')).toEqual({ moveDir: '+Y', shoot: false });
    expect(chaseAndShoot(state({ x: 20.1, y: 35, facing: '+X' }, { x: 20, y: 30 }), 'a', 'b')).toEqual({ moveDir: '-Y', shoot: false });
  });

  it('stops and fires when lined up and facing the target', () => {
    expect(chaseAndShoot(state({ x: 20.1, y: 5, facing: '+Y' }, { x: 20, y: 30 }), 'a', 'b')).toEqual({ moveDir: null, shoot: true });
  });

  // Regression (found with two hunting bots): lined up but closer than the gun's reach plus
  // the target's radius, the turn toward the target is refused (§8: the gun would enter its
  // body), so both bots danced forever. Back off along the firing axis first.
  it('backs away along the firing axis when too close to turn toward the target', () => {
    expect(chaseAndShoot(state({ x: 13.3, y: 23.6, facing: '-X' }, { x: 13.2, y: 24.8 }), 'a', 'b')).toEqual({ moveDir: '-Y', shoot: false });
    expect(chaseAndShoot(state({ x: 10, y: 5, facing: '+Y' }, { x: 11.2, y: 5.1 }), 'a', 'b')).toEqual({ moveDir: '-X', shoot: false });
    // far enough: turn and fire as usual
    expect(chaseAndShoot(state({ x: 13.3, y: 22.8, facing: '-X' }, { x: 13.2, y: 24.8 }), 'a', 'b')).toEqual({ moveDir: '+Y', shoot: false });
  });

  it('does nothing when the target is dead or missing', () => {
    expect(chaseAndShoot(state({ x: 5, y: 5, facing: '+Y' }, { x: 20, y: 30 }, false), 'a', 'b')).toEqual({ moveDir: null, shoot: false });
    expect(chaseAndShoot(state({ x: 5, y: 5, facing: '+Y' }, { x: 20, y: 30 }), 'a', 'zz')).toEqual({ moveDir: null, shoot: false });
  });
});
