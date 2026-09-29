// M1 task 1 (continued): the Room's match lifecycle (spec §12 "Play", "After the match",
// "Authority and timing"; §10 disconnect; §14 owner leaves). Time is injected: the test
// calls room.tick(dt) exactly like the server's 60 Hz loop or practice mode's page loop.

import { beforeAll, describe, expect, it } from 'vitest';
import { ensureRapierReady } from '../../src/physics/rapier';
import { Room, type RoomOptions } from '../../src/session/room';
import type { DynamicState, ServerMessage } from '../../src/session/protocol';
import { BUILT_IN_MAPS } from '../../src/session/maps';
import { chaseAndShoot } from '../../src/client/bot';

beforeAll(async () => {
  await ensureRapierReady();
});

type Client = { inbox: ServerMessage[]; playerId: string; reconnectToken: string; seq: number };

function newRoom(opts: Partial<RoomOptions> = {}): Room {
  let n = 0;
  return new Room({ code: 'ABCDE', newToken: () => `tok-${n++}`, seed: 1234, ...opts });
}

function join(room: Room, name: string): Client {
  const inbox: ServerMessage[] = [];
  const result = room.join(name, (m) => inbox.push(m));
  if (!result.ok) throw new Error(`join rejected: ${result.reason}`);
  return { inbox, playerId: result.playerId, reconnectToken: result.reconnectToken, seq: 0 };
}

function all<T extends ServerMessage['type']>(c: Client, type: T): Extract<ServerMessage, { type: T }>[] {
  return c.inbox.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
}

function last<T extends ServerMessage['type']>(c: Client, type: T): Extract<ServerMessage, { type: T }> {
  const found = all(c, type).at(-1);
  if (!found) throw new Error(`no ${type} message received`);
  return found;
}

function lastState(c: Client): DynamicState {
  return last(c, 'snapshot').state;
}

function eventKinds(c: Client): string[] {
  return all(c, 'event').map((m) => m.event.kind);
}

/** Owner + (n-1) ready players, match started. */
async function startedRoom(names: string[], opts: Partial<RoomOptions> = {}): Promise<{ room: Room; clients: Client[] }> {
  const room = newRoom(opts);
  const clients = names.map((n) => join(room, n));
  for (const c of clients.slice(1)) await room.handle(c.playerId, { type: 'setReady', ready: true });
  await room.handle(clients[0]!.playerId, { type: 'startMatch' });
  return { room, clients };
}

function ticks(room: Room, n: number, dt = 1 / 60): void {
  for (let i = 0; i < n; i++) room.tick(dt);
}

function kills(c: Client, victimId: string): number {
  return all(c, 'event').filter((m) => m.event.kind === 'playerKilled' && m.event.victimId === victimId).length;
}

/** Drives `attacker` with the chase-and-shoot bot until it kills `victimId` (a real kill, via real input). */
async function hunt(room: Room, attacker: Client, victimId: string, maxTicks = 3000): Promise<void> {
  const before = kills(attacker, victimId);
  for (let i = 0; i < maxTicks; i++) {
    if (kills(attacker, victimId) > before) return;
    const input = chaseAndShoot(lastState(attacker), attacker.playerId, victimId);
    await room.handle(attacker.playerId, { type: 'input', seq: attacker.seq++, ...input });
    room.tick();
  }
  throw new Error(`${attacker.playerId} did not kill ${victimId} within ${maxTicks} ticks`);
}

describe('Room match: start', () => {
  it('sends matchStart (static map + config, once) and an initial snapshot to everyone', async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo']);
    expect(room.phase).toBe('match');
    for (const c of clients) {
      const start = last(c, 'matchStart');
      expect(start.map).toEqual(BUILT_IN_MAPS.find((m) => m.id === 'default')!.map);
      expect(start.config.targetScore).toBe(3);
      expect(start.players.map((p) => p.id)).toEqual(clients.map((x) => x.playerId));
      expect(start.seed).toBe(1234);
      expect(lastState(c).players).toHaveLength(2);
    }
  });

  it('sends matchStart exactly once per match', async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo']);
    ticks(room, 30);
    for (const c of clients) expect(all(c, 'matchStart')).toHaveLength(1);
  });

  it('applies the lobby settings to the match', async () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    await room.handle(a.playerId, { type: 'setMap', mapId: 'open' });
    await room.handle(a.playerId, { type: 'setConfig', config: { targetScore: 1, roundTime: 20 } });
    await room.handle(b.playerId, { type: 'setReady', ready: true });
    await room.handle(a.playerId, { type: 'startMatch' });
    const start = last(b, 'matchStart');
    expect(start.map.obstacles).toEqual([]);
    expect(start.config.targetScore).toBe(1);
    expect(start.config.roundTime).toBe(20);
  });

  it('snapshots carry only dynamic state — no map, config or physics', async () => {
    const { clients } = await startedRoom(['Ann', 'Bo']);
    const state = lastState(clients[0]!) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(['bullets', 'phase', 'players', 'roundNumber', 'roundStartedAt', 'scores', 'time', 'winnerId']);
  });

  it('rejects a join while a match is in progress', async () => {
    const { room } = await startedRoom(['Ann', 'Bo']);
    expect(room.join('Late', () => {})).toEqual({ ok: false, reason: 'inProgress' });
  });
});

describe('Room match: ticking and input', () => {
  it('sends a snapshot every second tick (30 Hz at 60 Hz ticks) with increasing seq', async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo']);
    const before = all(clients[0]!, 'snapshot').length;
    ticks(room, 10);
    const snaps = all(clients[0]!, 'snapshot');
    expect(snaps.length - before).toBe(5);
    const seqs = snaps.map((s) => s.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("moves the sender's player and only theirs", async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo'], { mapId: 'open' });
    const [a, b] = clients as [Client, Client];
    const before = lastState(a).players;
    await room.handle(a.playerId, { type: 'input', seq: 1, moveDir: '+X', shoot: false });
    ticks(room, 10);
    const after = lastState(a).players;
    const ax = (s: typeof before) => s.find((p) => p.id === a.playerId)!.pos;
    const bx = (s: typeof before) => s.find((p) => p.id === b.playerId)!.pos;
    expect(ax(after).x).toBeGreaterThan(ax(before).x);
    expect(bx(after)).toEqual(bx(before));
  });

  it('a shoot edge fires exactly once, even if released before the next tick', async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo'], { mapId: 'open' });
    const a = clients[0]!;
    await room.handle(a.playerId, { type: 'input', seq: 1, moveDir: null, shoot: true });
    await room.handle(a.playerId, { type: 'input', seq: 2, moveDir: null, shoot: false });
    ticks(room, 60); // 1 s: past the 800 ms cadence, so a latch that never cleared would fire again
    const bulletIds = new Set(all(a, 'snapshot').flatMap((m) => m.state.bullets.filter((b) => b.ownerId === a.playerId).map((b) => b.id)));
    expect(bulletIds.size).toBe(1);
  });

  it('ignores stale input (seq not newer than the last one applied, including an equal seq)', async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo'], { mapId: 'open' });
    const a = clients[0]!;
    await room.handle(a.playerId, { type: 'input', seq: 5, moveDir: '+X', shoot: false });
    await room.handle(a.playerId, { type: 'input', seq: 3, moveDir: null, shoot: false });
    await room.handle(a.playerId, { type: 'input', seq: 5, moveDir: null, shoot: false });
    const x0 = lastState(a).players.find((p) => p.id === a.playerId)!.pos.x;
    ticks(room, 10);
    expect(lastState(a).players.find((p) => p.id === a.playerId)!.pos.x).toBeGreaterThan(x0);
  });

  it('forwards sim events (a round draw after roundTime)', async () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    await room.handle(a.playerId, { type: 'setConfig', config: { roundTime: 10 } });
    await room.handle(b.playerId, { type: 'setReady', ready: true });
    await room.handle(a.playerId, { type: 'startMatch' });
    ticks(room, 11, 1); // 11 simulated seconds
    expect(b.inbox).toContainEqual({ type: 'event', event: { kind: 'roundEnd', roundNumber: 1, winnerId: null } });
  });

  it('does nothing when ticked in the lobby', () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const count = a.inbox.length;
    ticks(room, 5);
    expect(a.inbox.length).toBe(count);
  });

  it('is deterministic: same seed and same inputs give identical snapshots', async () => {
    async function run(): Promise<DynamicState> {
      const { room, clients } = await startedRoom(['Ann', 'Bo']);
      await room.handle(clients[0]!.playerId, { type: 'input', seq: 1, moveDir: '+Y', shoot: true });
      ticks(room, 30);
      return lastState(clients[0]!);
    }
    expect(await run()).toEqual(await run());
  });
});

describe('Room match: disconnect, rejoin, owner transfer', () => {
  it('marks a dropped player disconnected (not removed) and the match continues', async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo', 'Cy']);
    const [a, b] = clients as [Client, Client, Client];
    room.disconnect(b.playerId);
    ticks(room, 2);
    expect(a.inbox).toContainEqual({ type: 'event', event: { kind: 'playerLeft', playerId: b.playerId } });
    expect(lastState(a).players.find((p) => p.id === b.playerId)!.connected).toBe(false);
    expect(room.phase).toBe('match');
  });

  it('rejoin with the token restores the same player and resends matchStart + a snapshot', async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo', 'Cy']);
    const b = clients[1]!;
    room.disconnect(b.playerId);
    ticks(room, 2);

    const inbox: ServerMessage[] = [];
    const result = room.rejoin(b.reconnectToken, (m) => inbox.push(m));
    expect(result).toMatchObject({ ok: true, playerId: b.playerId });
    const types = inbox.map((m) => m.type);
    expect(types).toContain('roomJoined');
    expect(types).toContain('matchStart');
    expect(types).toContain('snapshot');
    const snap = inbox.filter((m) => m.type === 'snapshot').at(-1) as Extract<ServerMessage, { type: 'snapshot' }>;
    expect(snap.state.players.find((p) => p.id === b.playerId)!.connected).toBe(true);
  });

  it('a rejoined client may restart its input sequence from 0', async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo', 'Cy'], { mapId: 'open' });
    const b = clients[1]!;
    await room.handle(b.playerId, { type: 'input', seq: 40, moveDir: null, shoot: false });
    room.disconnect(b.playerId);
    const inbox: ServerMessage[] = [];
    room.rejoin(b.reconnectToken, (m) => inbox.push(m));
    const pos = () => (inbox.filter((m) => m.type === 'snapshot').at(-1) as Extract<ServerMessage, { type: 'snapshot' }>).state.players.find((p) => p.id === b.playerId)!.pos;
    const x0 = pos().x;
    await room.handle(b.playerId, { type: 'input', seq: 0, moveDir: x0 > 20 ? '-X' : '+X', shoot: false });
    ticks(room, 10);
    expect(pos().x).not.toBeCloseTo(x0, 3);
  });

  it("a player's score survives a disconnect and rejoin", async () => {
    const room = newRoom({ mapId: 'open' });
    const [a, b, c] = ['Ann', 'Bo', 'Cy'].map((n) => join(room, n)) as [Client, Client, Client];
    await room.handle(b.playerId, { type: 'setReady', ready: true });
    await room.handle(c.playerId, { type: 'setReady', ready: true });
    await room.handle(a.playerId, { type: 'startMatch' });
    await hunt(room, a, b.playerId);
    await hunt(room, a, c.playerId); // last one standing: A wins round 1
    ticks(room, 2);
    expect(lastState(a).scores[a.playerId]).toBe(1);

    room.disconnect(a.playerId);
    ticks(room, 2);
    const inbox: ServerMessage[] = [];
    room.rejoin(a.reconnectToken, (m) => inbox.push(m));
    const snap = inbox.filter((m) => m.type === 'snapshot').at(-1) as Extract<ServerMessage, { type: 'snapshot' }>;
    expect(snap.state.scores[a.playerId]).toBe(1);
  });

  it('rejoining while still connected replaces the old connection and tells it so', async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo']);
    const b = clients[1]!;
    const fresh: ServerMessage[] = [];
    room.rejoin(b.reconnectToken, (m) => fresh.push(m));
    expect(b.inbox.at(-1)).toEqual({ type: 'error', message: 'connection replaced' });
    const oldCount = b.inbox.length;
    ticks(room, 4);
    expect(b.inbox.length).toBe(oldCount); // the replaced sink receives nothing more
    expect(fresh.some((m) => m.type === 'snapshot')).toBe(true);
  });

  it('rejects an unknown token', async () => {
    const { room } = await startedRoom(['Ann', 'Bo']);
    expect(room.rejoin('nope', () => {})).toEqual({ ok: false, reason: 'badToken' });
  });

  it('a disconnect while the match is starting is applied to the match, not the lobby', async () => {
    const room = newRoom();
    const [a, b, c] = ['Ann', 'Bo', 'Cy'].map((n) => join(room, n)) as [Client, Client, Client];
    await room.handle(b.playerId, { type: 'setReady', ready: true });
    await room.handle(c.playerId, { type: 'setReady', ready: true });
    const starting = room.handle(a.playerId, { type: 'startMatch' });
    room.disconnect(b.playerId); // arrives before the async start completes
    await starting;
    expect(lastState(a).players.find((p) => p.id === b.playerId)!.connected).toBe(false);
    expect(room.rejoin(b.reconnectToken, () => {})).toMatchObject({ ok: true, playerId: b.playerId });
  });

  it('passes ownership to the next connected player after the owner in join order', async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo', 'Cy', 'Dee']);
    const [a, b, c] = clients as [Client, Client, Client, Client];
    room.disconnect(a.playerId); // Bo becomes owner
    room.rejoin(a.reconnectToken, () => {});
    room.disconnect(b.playerId); // next after Bo is Cy, not Ann
    expect(c.inbox.filter((m) => m.type === 'event' && m.event.kind === 'ownerChanged').at(-1)).toEqual({
      type: 'event',
      event: { kind: 'ownerChanged', ownerId: c.playerId },
    });
  });

  it('passes ownership on when the owner drops mid-match; the match continues', async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo', 'Cy']);
    const [a, b, c] = clients as [Client, Client, Client];
    room.disconnect(a.playerId);
    expect(c.inbox).toContainEqual({ type: 'event', event: { kind: 'ownerChanged', ownerId: b.playerId } });
    expect(room.phase).toBe('match');
  });
});

describe('Room match: end and rematch', () => {
  it('when fewer than two connected players remain, the match ends and the room returns to the lobby', async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo']);
    const [a, b] = clients as [Client, Client];
    room.disconnect(b.playerId);
    ticks(room, 2);
    expect(eventKinds(a)).toContain('matchEnd');
    expect(room.phase).toBe('lobby');
    // players who left during the match are dropped from the lobby
    expect(last(a, 'lobby').players.map((p) => p.id)).toEqual([a.playerId]);
    expect(room.rejoin(b.reconnectToken, () => {})).toEqual({ ok: false, reason: 'badToken' });
  });

  it('the final snapshot precedes the return to the lobby, so clients can show final scores', async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo']);
    const [a, b] = clients as [Client, Client];
    room.disconnect(b.playerId);
    ticks(room, 1);
    const types = a.inbox.map((m) => m.type);
    const lastSnap = types.lastIndexOf('snapshot');
    const lastLobby = types.lastIndexOf('lobby');
    expect(lastSnap).toBeLessThan(lastLobby);
    expect(last(a, 'snapshot').state.phase).toBe('matchEnd');
  });

  it('a match won by score returns to the lobby with ready flags reset, and a rematch can start', async () => {
    const room = newRoom({ mapId: 'open' });
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    await room.handle(a.playerId, { type: 'setConfig', config: { targetScore: 1 } });
    await room.handle(b.playerId, { type: 'setReady', ready: true });
    await room.handle(a.playerId, { type: 'startMatch' });
    await hunt(room, a, b.playerId);

    expect(last(a, 'snapshot').state).toMatchObject({ phase: 'matchEnd', winnerId: a.playerId });
    expect(room.phase).toBe('lobby');
    const lobby = last(b, 'lobby');
    expect(lobby.players.map((p) => p.id)).toEqual([a.playerId, b.playerId]);
    expect(lobby.players.every((p) => p.ready === false)).toBe(true);
    expect(lobby.canStart).toBe(false);

    await room.handle(b.playerId, { type: 'setReady', ready: true });
    await room.handle(a.playerId, { type: 'startMatch' });
    expect(room.phase).toBe('match');
    expect(all(b, 'matchStart')).toHaveLength(2);
  });

  it('when everyone disconnects mid-match, the match ends and the empty room can be reused', async () => {
    const { room, clients } = await startedRoom(['Ann', 'Bo']);
    for (const c of clients) room.disconnect(c.playerId);
    expect(room.isEmpty()).toBe(true);
    ticks(room, 1);
    expect(room.phase).toBe('lobby');
    const d = join(room, 'Dee');
    expect(last(d, 'lobby')).toMatchObject({ ownerId: d.playerId, players: [expect.objectContaining({ id: d.playerId })] });
  });

  it('a practice match never ends for want of opponents', async () => {
    const { room, clients } = await startedRoom(['Solo'], { practice: true });
    ticks(room, 120);
    expect(room.phase).toBe('match');
    expect(lastState(clients[0]!).phase).toBe('round');
  });
});

describe('Room: resource safety', () => {
  it('dispose() ends a running match and frees it, even an abandoned practice room', async () => {
    const { room, clients } = await startedRoom(['Solo'], { practice: true });
    room.disconnect(clients[0]!.playerId);
    expect(room.phase).toBe('match'); // practice never ends on its own
    room.dispose();
    expect(room.gameApi).toBeNull();
    expect(room.isEmpty()).toBe(true);
    ticks(room, 5); // no-op, no throw
  });

  it('a match that fails to start reports an error to the owner and stays in the lobby', async () => {
    const room = newRoom({ seed: 1.5 }); // createGame rejects a non-integer seed
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    await room.handle(b.playerId, { type: 'setReady', ready: true });
    await expect(room.handle(a.playerId, { type: 'startMatch' })).resolves.toBeUndefined();
    expect(room.phase).toBe('lobby');
    expect(a.inbox.filter((m) => m.type === 'error')).toHaveLength(1);
  });

  it('rejects an initial map id that is not in the catalog', () => {
    expect(() => newRoom({ mapId: 'nope' })).toThrow(/map/);
  });
});
