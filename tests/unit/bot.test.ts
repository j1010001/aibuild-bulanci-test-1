// A pure chase-and-shoot strategy (DynamicState -> one input). Used by room tests to
// produce real kills, and by the headless bot client (M2). Aims only along the
// axis-aligned rules: line up on the target's column, face it along Y, fire.

import { describe, expect, it } from 'vitest';
import { chaseAndShoot, lineOfFireClear } from '../../src/client/bot';
import { DEFAULT_MAP } from '../../src/sim';
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

  // Regression (review): turning also walks 0.1 closer, so a bot that backed off to a fixed
  // range and turned would slip back under it and back off again, forever. Once facing
  // the target it fires at any range; it backs off only when a turn is needed and the
  // gun genuinely can't fit (under gun reach 0.8 + radius 0.5, plus one tick of travel).
  it('fires at any range once facing the target, and only backs off when the turn would be refused', () => {
    expect(chaseAndShoot(state({ x: 13.3, y: 23.6, facing: '+Y' }, { x: 13.2, y: 24.8 }), 'a', 'b')).toEqual({ moveDir: null, shoot: true });
    expect(chaseAndShoot(state({ x: 13.3, y: 23.1, facing: '-Y' }, { x: 13.2, y: 24.8 }), 'a', 'b')).toEqual({ moveDir: '+Y', shoot: false }); // 1.7: turn is allowed
    expect(chaseAndShoot(state({ x: 13.3, y: 23.4, facing: '-Y' }, { x: 13.2, y: 24.8 }), 'a', 'b')).toEqual({ moveDir: '-Y', shoot: false }); // 1.4: too close to turn
  });

  it('does not fire into an obstacle between it and the target', () => {
    // DEFAULT_MAP's tall wall spans x 6..10 at y 7.5..8.5
    const blocked = chaseAndShoot(state({ x: 8, y: 4, facing: '+Y' }, { x: 8, y: 12 }), 'a', 'b', DEFAULT_MAP.obstacles);
    expect(blocked.shoot).toBe(false);
    expect(blocked.blocked).toBe(true);
  });

  it('does nothing when the target is dead or missing', () => {
    expect(chaseAndShoot(state({ x: 5, y: 5, facing: '+Y' }, { x: 20, y: 30 }, false), 'a', 'b')).toEqual({ moveDir: null, shoot: false });
    expect(chaseAndShoot(state({ x: 5, y: 5, facing: '+Y' }, { x: 20, y: 30 }), 'a', 'zz')).toEqual({ moveDir: null, shoot: false });
  });
});

describe('lineOfFireClear', () => {
  it('is blocked by an obstacle footprint between the two points, and clear otherwise', () => {
    expect(lineOfFireClear({ x: 8, y: 4 }, { x: 8, y: 12 }, DEFAULT_MAP.obstacles)).toBe(false); // tall wall
    expect(lineOfFireClear({ x: 2, y: 4 }, { x: 2, y: 12 }, DEFAULT_MAP.obstacles)).toBe(true);
    expect(lineOfFireClear({ x: 29, y: 8 }, { x: 36, y: 8 }, DEFAULT_MAP.obstacles)).toBe(false); // tall cone
  });

  it('a wall lower than bullet height does not block (bullets fly over it)', () => {
    // DEFAULT_MAP's low wall (h 0.6) spans x 6..10 at y 31.5..32.5
    expect(lineOfFireClear({ x: 8, y: 28 }, { x: 8, y: 36 }, DEFAULT_MAP.obstacles, 0.9)).toBe(true);
  });
});
