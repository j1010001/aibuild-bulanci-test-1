// M1 task 1: the Room's lobby rules (spec §12 "Lobby", §14 owner/start gate). Driven
// headlessly: each fake client is just a message sink, exactly as the server's
// WebSocket adapter and the browser's practice mode will plug in.

import { describe, expect, it } from 'vitest';
import { Room, type RoomOptions } from '../../src/session/room';
import type { ServerMessage } from '../../src/session/protocol';
import { SKIN_PALETTE } from '../../src/session/skins';

type Client = { inbox: ServerMessage[]; playerId: string; reconnectToken: string };

function newRoom(opts: Partial<RoomOptions> = {}): Room {
  let n = 0;
  return new Room({ code: 'ABCDE', newToken: () => `tok-${n++}`, ...opts });
}

function join(room: Room, name: string): Client {
  const inbox: ServerMessage[] = [];
  const result = room.join(name, (m) => inbox.push(m));
  if (!result.ok) throw new Error(`join rejected: ${result.reason}`);
  return { inbox, playerId: result.playerId, reconnectToken: result.reconnectToken };
}

function last<T extends ServerMessage['type']>(c: Client, type: T): Extract<ServerMessage, { type: T }> {
  const found = [...c.inbox].reverse().find((m) => m.type === type);
  if (!found) throw new Error(`no ${type} message received`);
  return found as Extract<ServerMessage, { type: T }>;
}

function errors(c: Client): string[] {
  return c.inbox.filter((m) => m.type === 'error').map((m) => (m as { message: string }).message);
}

describe('Room lobby: joining', () => {
  it('makes the first joiner the owner and confirms each join with id and reconnect token', () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');

    expect(last(a, 'roomJoined')).toMatchObject({ type: 'roomJoined', code: 'ABCDE', playerId: a.playerId, reconnectToken: a.reconnectToken });
    expect(a.playerId).not.toBe(b.playerId);
    expect(a.reconnectToken).not.toBe(b.reconnectToken);

    const lobby = last(a, 'lobby');
    expect(lobby.ownerId).toBe(a.playerId);
    expect(lobby.players.map((p) => p.name)).toEqual(['Ann', 'Bo']);
    expect(last(b, 'lobby')).toEqual(lobby); // everyone sees the same lobby
  });

  it('broadcasts playerJoined to the players already in the room', () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    expect(a.inbox).toContainEqual({ type: 'event', event: { kind: 'playerJoined', playerId: b.playerId } });
  });

  it('rejects a join once the room holds maxPlayers', () => {
    const room = newRoom({ maxPlayers: 2 });
    join(room, 'Ann');
    join(room, 'Bo');
    expect(room.join('Cy', () => {})).toEqual({ ok: false, reason: 'full' });
  });

  it('exposes the built-in map catalog and default settings', () => {
    const room = newRoom();
    const lobby = last(join(room, 'Ann'), 'lobby');
    expect(lobby.maps.map((m) => m.id)).toEqual(expect.arrayContaining(['default', 'open']));
    expect(lobby.settings).toEqual({ mapId: 'default', targetScore: 3, roundTime: 60 });
  });
});

describe('Room lobby: skins', () => {
  it('gives each joiner a distinct palette skin', () => {
    const room = newRoom();
    const clients = ['A', 'B', 'C', 'D'].map((n) => join(room, n));
    const skins = last(clients[0]!, 'lobby').players.map((p) => p.skinId);
    expect(new Set(skins).size).toBe(4);
    for (const s of skins) expect(SKIN_PALETTE).toContain(s);
  });

  it('refuses a skin another player already has, and accepts a free one', async () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    const aSkin = last(a, 'lobby').players.find((p) => p.id === a.playerId)!.skinId;

    await room.handle(b.playerId, { type: 'setSkin', skinId: aSkin });
    expect(errors(b)).toHaveLength(1);
    expect(last(b, 'lobby').players.find((p) => p.id === b.playerId)!.skinId).not.toBe(aSkin);

    const free = SKIN_PALETTE.find((s) => !last(a, 'lobby').players.some((p) => p.skinId === s))!;
    await room.handle(b.playerId, { type: 'setSkin', skinId: free });
    expect(last(a, 'lobby').players.find((p) => p.id === b.playerId)!.skinId).toBe(free);
  });

  it('refuses a skin outside the palette', async () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    await room.handle(a.playerId, { type: 'setSkin', skinId: 'plaid' });
    expect(errors(a)).toHaveLength(1);
  });
});

describe('Room lobby: owner-only settings', () => {
  it('lets the owner change map and config, and broadcasts it', async () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    await room.handle(a.playerId, { type: 'setMap', mapId: 'open' });
    await room.handle(a.playerId, { type: 'setConfig', config: { targetScore: 5, roundTime: 30 } });
    expect(last(b, 'lobby').settings).toEqual({ mapId: 'open', targetScore: 5, roundTime: 30 });
  });

  it('refuses settings changes from a non-owner', async () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    await room.handle(b.playerId, { type: 'setMap', mapId: 'open' });
    await room.handle(b.playerId, { type: 'setConfig', config: { targetScore: 5 } });
    expect(errors(b)).toHaveLength(2);
    expect(last(a, 'lobby').settings.mapId).toBe('default');
    expect(last(a, 'lobby').settings.targetScore).toBe(3);
  });

  it('refuses an unknown map id and out-of-range config, leaving settings unchanged', async () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    await room.handle(a.playerId, { type: 'setMap', mapId: 'nope' });
    await room.handle(a.playerId, { type: 'setConfig', config: { targetScore: 0 } });
    await room.handle(a.playerId, { type: 'setConfig', config: { targetScore: 11 } });
    await room.handle(a.playerId, { type: 'setConfig', config: { roundTime: 5 } });
    await room.handle(a.playerId, { type: 'setConfig', config: { roundTime: 301 } });
    await room.handle(a.playerId, { type: 'setConfig', config: { targetScore: 2.5 } });
    expect(errors(a)).toHaveLength(6);
    expect(last(a, 'lobby').settings).toEqual({ mapId: 'default', targetScore: 3, roundTime: 60 });
  });
});

describe('Room lobby: start gate (spec §14)', () => {
  it('cannot start with fewer than two players', async () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    expect(last(a, 'lobby').canStart).toBe(false);
    await room.handle(a.playerId, { type: 'startMatch' });
    expect(errors(a)).toHaveLength(1);
    expect(room.phase).toBe('lobby');
  });

  it('can start once every non-owner player is ready', async () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    const c = join(room, 'Cy');
    expect(last(a, 'lobby').canStart).toBe(false);
    await room.handle(b.playerId, { type: 'setReady', ready: true });
    expect(last(a, 'lobby').canStart).toBe(false);
    await room.handle(c.playerId, { type: 'setReady', ready: true });
    expect(last(a, 'lobby').canStart).toBe(true);
    await room.handle(c.playerId, { type: 'setReady', ready: false });
    expect(last(a, 'lobby').canStart).toBe(false);
  });

  it('only the owner can start', async () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    await room.handle(b.playerId, { type: 'setReady', ready: true });
    await room.handle(b.playerId, { type: 'startMatch' });
    expect(errors(b)).toHaveLength(1);
    expect(room.phase).toBe('lobby');
    expect(errors(a)).toHaveLength(0);
  });

  it('a practice room starts with its single player and accepts no second one', () => {
    const room = newRoom({ practice: true });
    const a = join(room, 'Ann');
    expect(last(a, 'lobby').canStart).toBe(true);
    expect(room.join('Bo', () => {})).toEqual({ ok: false, reason: 'full' });
  });
});

describe('Room lobby: leaving (spec §14)', () => {
  it('removes a player who leaves the lobby and tells everyone', () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    room.disconnect(b.playerId);
    expect(a.inbox).toContainEqual({ type: 'event', event: { kind: 'playerLeft', playerId: b.playerId } });
    expect(last(a, 'lobby').players.map((p) => p.id)).toEqual([a.playerId]);
  });

  it('passes ownership to the next player in join order when the owner leaves', () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    const c = join(room, 'Cy');
    room.disconnect(a.playerId);
    expect(b.inbox).toContainEqual({ type: 'event', event: { kind: 'ownerChanged', ownerId: b.playerId } });
    expect(last(c, 'lobby').ownerId).toBe(b.playerId);
  });

  it('a leave message behaves like a disconnect', async () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    await room.handle(b.playerId, { type: 'leave' });
    expect(last(a, 'lobby').players.map((p) => p.id)).toEqual([a.playerId]);
  });

  it('when the sole owner leaves, the next joiner becomes owner', () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    room.disconnect(a.playerId);
    expect(room.isEmpty()).toBe(true);
    const b = join(room, 'Bo');
    expect(last(b, 'lobby').ownerId).toBe(b.playerId);
  });

  it('is empty once everyone has left', () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    expect(room.isEmpty()).toBe(false);
    room.disconnect(a.playerId);
    room.disconnect(b.playerId);
    expect(room.isEmpty()).toBe(true);
  });

  it('a token of a player who left the lobby cannot rejoin', () => {
    const room = newRoom();
    join(room, 'Ann');
    const b = join(room, 'Bo');
    room.disconnect(b.playerId);
    expect(room.rejoin(b.reconnectToken, () => {})).toEqual({ ok: false, reason: 'badToken' });
  });
});

describe('Room lobby: no broadcast for a change that changes nothing', () => {
  it('re-sending the same ready flag or skin does not re-broadcast the lobby', async () => {
    const room = newRoom();
    const a = join(room, 'Ann');
    const b = join(room, 'Bo');
    const lobbies = () => a.inbox.filter((m) => m.type === 'lobby').length;
    await room.handle(b.playerId, { type: 'setReady', ready: true });
    const afterFirst = lobbies();
    for (let i = 0; i < 5; i++) await room.handle(b.playerId, { type: 'setReady', ready: true });
    const bSkin = last(a, 'lobby').players.find((p) => p.id === b.playerId)!.skinId;
    await room.handle(b.playerId, { type: 'setSkin', skinId: bSkin });
    expect(lobbies()).toBe(afterFirst);
  });
});
