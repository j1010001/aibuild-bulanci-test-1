// M1 task 2: the client view model — a pure fold of ServerMessages into what the UI
// shows. The DOM screens only render this; all screen-transition logic lives here.

import { describe, expect, it } from 'vitest';
import { backToLobby, initialView, reduce, renderStateOf, type ClientView } from '../../src/client/model';
import { hudModel } from '../../src/client/hud';
import { DEFAULT_CONFIG, DEFAULT_MAP } from '../../src/sim';
import type { DynamicState, LobbyMessage, ServerMessage } from '../../src/session/protocol';

const lobby: LobbyMessage = {
  type: 'lobby',
  code: 'ABCDE',
  ownerId: 'p0',
  players: [
    { id: 'p0', name: 'Ann', skinId: 'crimson', ready: false, connected: true },
    { id: 'p1', name: 'Bo', skinId: 'gold', ready: true, connected: true },
  ],
  settings: { mapId: 'default', targetScore: 3, roundTime: 60 },
  maps: [{ id: 'default', name: 'Arena' }],
  canStart: true,
  practice: false,
};

const matchStart: ServerMessage = {
  type: 'matchStart',
  map: DEFAULT_MAP,
  config: { ...DEFAULT_CONFIG, roundTime: 60 },
  players: [
    { id: 'p0', name: 'Ann', skinId: 'crimson' },
    { id: 'p1', name: 'Bo', skinId: 'gold' },
  ],
  seed: 7,
};

function dyn(overrides: Partial<DynamicState> = {}): DynamicState {
  return {
    phase: 'round',
    roundNumber: 1,
    scores: { p0: 0, p1: 0 },
    players: [
      { id: 'p0', name: 'Ann', skinId: 'crimson', pos: { x: 5, y: 5 }, facing: '+X', lastShotAt: 0, alive: true, connected: true },
      { id: 'p1', name: 'Bo', skinId: 'gold', pos: { x: 9, y: 9 }, facing: '-X', lastShotAt: 0, alive: true, connected: true },
    ],
    bullets: [],
    time: 0,
    roundStartedAt: 0,
    winnerId: null,
    ...overrides,
  };
}

function fold(msgs: ServerMessage[], now = 0): ClientView {
  return msgs.reduce((v, m) => reduce(v, m, now), initialView());
}

const joined: ServerMessage = { type: 'roomJoined', code: 'ABCDE', playerId: 'p0', reconnectToken: 'tok' };

describe('client view model: screens', () => {
  it('starts on the home screen', () => {
    expect(initialView().screen).toBe('home');
  });

  it('joining moves to the lobby and records identity', () => {
    const v = fold([joined, lobby]);
    expect(v.screen).toBe('lobby');
    expect(v).toMatchObject({ playerId: 'p0', code: 'ABCDE', reconnectToken: 'tok' });
    expect(v.lobby).toEqual(lobby);
  });

  it('a rejected join stays home and records why', () => {
    const v = fold([{ type: 'joinRejected', reason: 'full' }]);
    expect(v.screen).toBe('home');
    expect(v.rejected).toBe('full');
  });

  it('matchStart moves to the match screen', () => {
    const v = fold([joined, lobby, matchStart, { type: 'snapshot', seq: 1, state: dyn() }]);
    expect(v.screen).toBe('match');
    expect(v.match?.seed).toBe(7);
    expect(v.snapshot).toEqual(dyn());
  });

  it('a matchEnd snapshot moves to the match-end screen with the final result, and the lobby that follows does not hide it', () => {
    const final = dyn({ phase: 'matchEnd', winnerId: 'p1', scores: { p0: 1, p1: 3 } });
    const v = fold([joined, lobby, matchStart, { type: 'snapshot', seq: 1, state: dyn() }, { type: 'snapshot', seq: 2, state: final }, lobby]);
    expect(v.screen).toBe('matchEnd');
    expect(v.result).toEqual({ winnerId: 'p1', scores: { p0: 1, p1: 3 } });
    expect(v.lobby).toEqual(lobby); // already updated underneath
  });

  it('backToLobby leaves the match-end screen', () => {
    const final = dyn({ phase: 'matchEnd', winnerId: null });
    const v = backToLobby(fold([joined, lobby, matchStart, { type: 'snapshot', seq: 1, state: final }, lobby]));
    expect(v.screen).toBe('lobby');
  });

  it('a rejoin mid-match lands straight on the match screen', () => {
    const v = fold([joined, matchStart, { type: 'snapshot', seq: 40, state: dyn() }]);
    expect(v.screen).toBe('match');
  });

  it('a new matchStart after a finished match clears the old result', () => {
    const final = dyn({ phase: 'matchEnd', winnerId: 'p1' });
    const v = fold([joined, lobby, matchStart, { type: 'snapshot', seq: 1, state: final }, lobby, matchStart]);
    expect(v.screen).toBe('match');
    expect(v.result).toBeNull();
    expect(v.snapshot).toBeNull();
  });

  it('an error during a match keeps the match screen', () => {
    const v = fold([joined, matchStart, { type: 'snapshot', seq: 1, state: dyn() }, { type: 'error', message: 'nope' }]);
    expect(v.screen).toBe('match');
    expect(v.error).toBe('nope');
  });

  it('a new roomJoined (reconnect) accepts snapshots from seq 0 again', () => {
    const v = fold([
      joined,
      matchStart,
      { type: 'snapshot', seq: 50, state: dyn({ time: 5000 }) },
      joined,
      matchStart,
      { type: 'snapshot', seq: 1, state: dyn({ time: 6000 }) },
    ]);
    expect(v.snapshot?.time).toBe(6000);
  });

  it("a 'replaced' notice explains that the game moved to another tab", () => {
    const v = fold([joined, lobby, { type: 'replaced' }]);
    expect(v.error).toMatch(/another tab|another window/i);
  });

  it('records the latest error message', () => {
    expect(fold([joined, lobby, { type: 'error', message: 'skin already taken' }]).error).toBe('skin already taken');
  });
});

describe('client view model: snapshots', () => {
  it('keeps the previous snapshot for interpolation', () => {
    const a = dyn({ time: 100 });
    const b = dyn({ time: 133 });
    const v = fold([joined, matchStart, { type: 'snapshot', seq: 1, state: a }, { type: 'snapshot', seq: 2, state: b }]);
    expect(v.previous).toEqual(a);
    expect(v.snapshot).toEqual(b);
  });

  it('discards a snapshot older than the latest one received', () => {
    const v = fold([
      joined,
      matchStart,
      { type: 'snapshot', seq: 5, state: dyn({ time: 500 }) },
      { type: 'snapshot', seq: 4, state: dyn({ time: 400 }) },
    ]);
    expect(v.snapshot?.time).toBe(500);
  });

  it('builds the renderer input from the static matchStart data plus the latest snapshot', () => {
    const v = fold([joined, matchStart, { type: 'snapshot', seq: 1, state: dyn() }]);
    const rs = renderStateOf(v)!;
    expect(rs.obstacles).toEqual(DEFAULT_MAP.obstacles);
    expect(rs.config.board).toEqual(DEFAULT_MAP.board);
    expect(rs.players).toEqual(dyn().players);
    expect(renderStateOf(fold([joined, lobby]))).toBeNull();
  });
});

describe('HUD model', () => {
  it('counts the round down from roundTime', () => {
    const v = fold([joined, matchStart, { type: 'snapshot', seq: 1, state: dyn({ time: 12_500, roundStartedAt: 2_000 }) }]);
    expect(hudModel(v, 0).secondsLeft).toBe(50); // 60 - 10.5 → shown as 50 (ceil of 49.5)
    const done = fold([joined, matchStart, { type: 'snapshot', seq: 1, state: dyn({ time: 70_000, roundStartedAt: 0 }) }]);
    expect(hudModel(done, 0).secondsLeft).toBe(0);
  });

  it('lists scores highest first and marks the local player', () => {
    const v = fold([joined, matchStart, { type: 'snapshot', seq: 1, state: dyn({ scores: { p0: 1, p1: 2 } }) }]);
    const rows = hudModel(v, 0).scores;
    expect(rows.map((r) => [r.name, r.score, r.you])).toEqual([
      ['Bo', 2, false],
      ['Ann', 1, true],
    ]);
  });

  it('shows a round-result banner for two seconds after a round ends', () => {
    const v = fold(
      [joined, matchStart, { type: 'snapshot', seq: 1, state: dyn() }, { type: 'event', event: { kind: 'roundEnd', roundNumber: 1, winnerId: 'p1' } }],
      10_000,
    );
    expect(hudModel(v, 10_500).banner).toBe('Bo wins round 1');
    expect(hudModel(v, 12_500).banner).toBeNull();

    const draw = fold([joined, matchStart, { type: 'event', event: { kind: 'roundEnd', roundNumber: 2, winnerId: null } }], 0);
    expect(hudModel(draw, 100).banner).toBe('Round 2: draw');
  });
});
