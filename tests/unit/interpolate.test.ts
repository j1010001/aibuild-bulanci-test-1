// M2 task 2: rendering between snapshots (spec §12: "the client interpolates positions
// between the last two snapshots"). Snapshots arrive at 30 Hz; frames run at 60+ Hz.

import { describe, expect, it } from 'vitest';
import { interpolate, renderStateAt } from '../../src/client/interpolate';
import { initialView, reduce, type ClientView } from '../../src/client/model';
import type { DynamicState, ServerMessage } from '../../src/session/protocol';
import { DEFAULT_CONFIG, DEFAULT_MAP } from '../../src/sim';

type P = DynamicState['players'][number];

function player(id: string, x: number, y: number, extra: Partial<P> = {}): P {
  return { id, name: id, skinId: 'crimson', pos: { x, y }, facing: '+X', lastShotAt: 0, alive: true, connected: true, ...extra };
}

function state(players: P[], bullets: DynamicState['bullets'] = [], extra: Partial<DynamicState> = {}): DynamicState {
  return { phase: 'round', roundNumber: 1, scores: {}, players, bullets, time: 0, roundStartedAt: 0, winnerId: null, ...extra };
}

describe('interpolate', () => {
  const prev = state([player('a', 0, 0), player('b', 10, 10)], [{ id: 'b0', ownerId: 'a', pos: { x: 1, y: 0 }, dir: '+X' }]);
  const next = state([player('a', 2, 0, { facing: '+Y' }), player('b', 10, 14)], [{ id: 'b0', ownerId: 'a', pos: { x: 3, y: 0 }, dir: '+X' }], { time: 33 });

  it('blends positions of players and bullets present in both snapshots', () => {
    const mid = interpolate(prev, next, 0.5);
    expect(mid.players.map((p) => p.pos)).toEqual([
      { x: 1, y: 0 },
      { x: 10, y: 12 },
    ]);
    expect(mid.bullets[0]!.pos).toEqual({ x: 2, y: 0 });
  });

  it('takes everything else (facing, scores, phase) from the newer snapshot', () => {
    const mid = interpolate(prev, next, 0.5);
    expect(mid.players[0]!.facing).toBe('+Y');
    expect(mid.time).toBe(33);
  });

  it('clamps alpha: beyond 1 shows the newer snapshot, below 0 the older one', () => {
    expect(interpolate(prev, next, 5).players[0]!.pos).toEqual({ x: 2, y: 0 });
    expect(interpolate(prev, next, -1).players[0]!.pos).toEqual({ x: 0, y: 0 });
  });

  it('something new (a fresh bullet, a joiner) appears where the newer snapshot has it', () => {
    const withNew = state([...next.players, player('c', 30, 30)], [...next.bullets, { id: 'b1', ownerId: 'b', pos: { x: 10, y: 15 }, dir: '+Y' }]);
    const mid = interpolate(prev, withNew, 0.5);
    expect(mid.players.find((p) => p.id === 'c')!.pos).toEqual({ x: 30, y: 30 });
    expect(mid.bullets.find((b) => b.id === 'b1')!.pos).toEqual({ x: 10, y: 15 });
  });

  it('never slides across a respawn: a new round, or a player not alive in both, snaps', () => {
    const respawned = state([player('a', 30, 30), player('b', 5, 5)], [], { roundNumber: 2 });
    expect(interpolate(prev, respawned, 0.5).players[0]!.pos).toEqual({ x: 30, y: 30 });

    const died = state([player('a', 2, 0), player('b', 10, 14, { alive: false })]);
    expect(interpolate(prev, died, 0.5).players[1]!.pos).toEqual({ x: 10, y: 14 });
  });

  it('with no previous snapshot, shows the newer one as is', () => {
    expect(interpolate(null, next, 0.5)).toEqual(next);
  });
});

describe('renderStateAt', () => {
  const matchStart: ServerMessage = { type: 'matchStart', map: DEFAULT_MAP, config: DEFAULT_CONFIG, players: [], seed: 1 };

  function viewWith(snaps: DynamicState[], receivedAt: number[]): ClientView {
    let v = reduce(initialView(), { type: 'roomJoined', code: 'ABCDE', playerId: 'a', reconnectToken: 't' }, 0);
    v = reduce(v, matchStart, 0);
    snaps.forEach((s, i) => {
      v = reduce(v, { type: 'snapshot', seq: i, state: s }, receivedAt[i]!);
    });
    return v;
  }

  it('advances from the previous snapshot to the latest over one snapshot interval after it arrives', () => {
    const v = viewWith([state([player('a', 0, 0)]), state([player('a', 3, 0)])], [0, 1000]);
    const interval = 1000 / 30;
    expect(renderStateAt(v, 1000)!.players[0]!.pos.x).toBeCloseTo(0);
    expect(renderStateAt(v, 1000 + interval / 3)!.players[0]!.pos.x).toBeCloseTo(1);
    expect(renderStateAt(v, 1000 + interval * 2)!.players[0]!.pos.x).toBeCloseTo(3);
  });

  it('includes the static match data for the renderer, and is null before a match', () => {
    const v = viewWith([state([player('a', 0, 0)])], [0]);
    const rs = renderStateAt(v, 0)!;
    expect(rs.obstacles).toEqual(DEFAULT_MAP.obstacles);
    expect(rs.config).toEqual(DEFAULT_CONFIG);
    expect(renderStateAt(initialView(), 0)).toBeNull();
  });
});
