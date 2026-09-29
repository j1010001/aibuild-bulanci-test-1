// Room: one lobby-then-match session (spec §12). Environment-free — it owns no sockets
// and no timers. Each player is attached through a Sink (a callback that delivers one
// ServerMessage to that player), and time only advances when the caller invokes tick():
// the server's 60 Hz loop, practice mode's page loop, or a test. The same class therefore
// runs on the server, in the browser, and headlessly in tests unchanged (spec §4).

import { GameApi } from '../api';
import { DEFAULT_CONFIG } from '../sim';
import type { PlayerId, PublicState } from '../sim';
import { BUILT_IN_MAPS, type MapCatalogEntry } from './maps';
import {
  CONFIG_LIMITS,
  type ClientMessage,
  type DynamicState,
  type JoinRejectReason,
  type LobbyMessage,
  type MatchSettings,
  type ServerMessage,
  type SettableConfig,
} from './protocol';
import { SKIN_PALETTE } from './skins';

export type Sink = (msg: ServerMessage) => void;

export type JoinResult =
  | { ok: true; playerId: PlayerId; reconnectToken: string }
  | { ok: false; reason: JoinRejectReason };

export type RoomOptions = {
  code: string;
  maps?: readonly MapCatalogEntry[];
  /** Initial map (defaults to the catalog's first entry). */
  mapId?: string;
  /** Solo practice: exactly one player, and the match never ends for want of opponents (§10). */
  practice?: boolean;
  maxPlayers?: number;
  /** Fixed seed for every match (tests, replays). Otherwise GameApi picks and records one. */
  seed?: number;
  /** Reconnect-token generator; must be unguessable in production. */
  newToken?: () => string;
  /** Send a snapshot every N ticks (2 → 30 Hz at the 60 Hz tick rate, spec §12). */
  snapshotEvery?: number;
};

type Member = {
  id: PlayerId;
  name: string;
  skinId: string;
  ready: boolean;
  token: string;
  sink: Sink | null; // null = disconnected (only possible during a match)
  lastInputSeq: number;
};

export function randomToken(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  // randomUUID is missing in insecure browser contexts (plain http on a LAN address).
  const bytes = c.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function toDynamic(state: PublicState): DynamicState {
  const { phase, roundNumber, scores, players, bullets, time, roundStartedAt, winnerId } = state;
  return { phase, roundNumber, scores, players, bullets, time, roundStartedAt, winnerId };
}

export class Room {
  readonly code: string;
  private readonly maps: readonly MapCatalogEntry[];
  private readonly practice: boolean;
  private readonly maxPlayers: number;
  private readonly seed: number | undefined;
  private readonly newToken: () => string;
  private readonly snapshotEvery: number;

  private members: Member[] = []; // join order — also the order ownership passes in
  private ownerId: PlayerId | null = null;
  private settings: MatchSettings;
  private game: GameApi | null = null;
  private starting = false;
  private tickCount = 0;
  private snapshotSeq = 0;
  private nextPlayerSeq = 0;
  private generation = 0; // bumped by dispose(), so a start still awaiting knows to abandon itself

  constructor(opts: RoomOptions) {
    this.code = opts.code;
    this.maps = opts.maps ?? BUILT_IN_MAPS;
    this.practice = opts.practice ?? false;
    this.maxPlayers = this.practice ? 1 : Math.min(opts.maxPlayers ?? DEFAULT_CONFIG.maxPlayers, SKIN_PALETTE.length);
    this.seed = opts.seed;
    this.newToken = opts.newToken ?? randomToken;
    this.snapshotEvery = opts.snapshotEvery ?? 2;
    const mapId = opts.mapId ?? this.maps[0]!.id;
    if (!this.maps.some((m) => m.id === mapId)) throw new Error(`Room: unknown map id "${mapId}"`);
    this.settings = {
      mapId,
      targetScore: DEFAULT_CONFIG.targetScore,
      roundTime: DEFAULT_CONFIG.roundTime,
    };
  }

  get phase(): 'lobby' | 'match' {
    return this.game !== null || this.starting ? 'match' : 'lobby';
  }

  /** The live game while a match runs (for introspection by tests/AI); null in the lobby. */
  get gameApi(): GameApi | null {
    return this.game;
  }

  isEmpty(): boolean {
    return !this.members.some((m) => m.sink !== null);
  }

  // ---- Joining ----

  join(name: string, sink: Sink): JoinResult {
    if (this.phase === 'match') return { ok: false, reason: 'inProgress' };
    if (this.members.length >= this.maxPlayers) return { ok: false, reason: 'full' };

    const taken = new Set(this.members.map((m) => m.skinId));
    const member: Member = {
      id: `p${this.nextPlayerSeq++}`,
      name,
      skinId: SKIN_PALETTE.find((s) => !taken.has(s))!,
      ready: false,
      token: this.newToken(),
      sink,
      lastInputSeq: -1,
    };
    this.members.push(member);
    if (this.ownerId === null) this.ownerId = member.id;

    sink({ type: 'roomJoined', code: this.code, playerId: member.id, reconnectToken: member.token });
    this.broadcast({ type: 'event', event: { kind: 'playerJoined', playerId: member.id } });
    this.broadcastLobby();
    return { ok: true, playerId: member.id, reconnectToken: member.token };
  }

  rejoin(token: string, sink: Sink): JoinResult {
    const member = this.members.find((m) => m.token === token);
    if (!member) return { ok: false, reason: 'badToken' };

    const wasDisconnected = member.sink === null;
    // A second connection with the same token (another tab, a reconnect before the old
    // socket's close was noticed) replaces the first. The adapter closes the old socket.
    if (member.sink !== null) member.sink({ type: 'error', message: 'connection replaced' });
    member.sink = sink;
    member.lastInputSeq = -1; // a reloaded client restarts its input sequence
    if (this.ownerId === null) this.ownerId = member.id;

    sink({ type: 'roomJoined', code: this.code, playerId: member.id, reconnectToken: member.token });
    if (this.game) {
      if (wasDisconnected) {
        this.game.reconnectPlayer(member.id);
        this.broadcast({ type: 'event', event: { kind: 'playerJoined', playerId: member.id } });
      }
      sink(this.matchStartMessage(this.game));
      sink({ type: 'snapshot', seq: this.snapshotSeq++, state: toDynamic(this.game.getState()) });
    } else {
      sink(this.lobbyMessage());
    }
    return { ok: true, playerId: member.id, reconnectToken: member.token };
  }

  disconnect(playerId: PlayerId): void {
    const member = this.members.find((m) => m.id === playerId);
    if (!member || member.sink === null) return;

    const index = this.members.indexOf(member);
    const wasOwner = this.ownerId === playerId;
    if (this.phase === 'match') {
      // Kept, not removed: their score survives and they can rejoin (spec §12). While
      // the match is still starting there's no game yet; startMatch applies it after.
      member.sink = null;
      this.game?.setMoveDir(playerId, null);
      this.game?.disconnectPlayer(playerId);
      this.broadcast({ type: 'event', event: { kind: 'playerLeft', playerId } });
      if (wasOwner) this.passOwnershipFrom(index + 1);
    } else {
      this.members.splice(index, 1);
      this.broadcast({ type: 'event', event: { kind: 'playerLeft', playerId } });
      if (wasOwner) this.passOwnershipFrom(index); // the member after the removed one is now at `index`
      this.broadcastLobby();
    }
  }

  /** Ends any running match and releases everything. Call when the room is discarded. */
  dispose(): void {
    this.generation += 1;
    this.starting = false;
    this.game?.reset(); // disposes the physics world
    this.game = null;
    this.members = [];
    this.ownerId = null;
  }

  // ---- Client messages ----

  async handle(playerId: PlayerId, msg: ClientMessage): Promise<void> {
    const member = this.members.find((m) => m.id === playerId);
    if (!member || member.sink === null) return;

    switch (msg.type) {
      case 'input':
        this.applyInput(member, msg);
        return;
      case 'leave':
        this.disconnect(playerId);
        return;
      case 'setSkin':
      case 'setReady':
      case 'setMap':
      case 'setConfig':
      case 'startMatch':
        if (this.phase === 'match') return this.error(member, 'not available during a match');
        return this.handleLobby(member, msg);
      default:
        return this.error(member, `unexpected message: ${msg.type}`);
    }
  }

  private async handleLobby(member: Member, msg: ClientMessage): Promise<void> {
    const isOwner = member.id === this.ownerId;
    switch (msg.type) {
      case 'setSkin': {
        if (msg.skinId === member.skinId) return; // no change: don't re-broadcast
        if (!SKIN_PALETTE.includes(msg.skinId)) return this.error(member, 'unknown skin');
        if (this.members.some((m) => m !== member && m.skinId === msg.skinId)) return this.error(member, 'skin already taken');
        member.skinId = msg.skinId;
        break;
      }
      case 'setReady':
        if (msg.ready === member.ready) return; // no change: don't re-broadcast
        member.ready = msg.ready;
        break;
      case 'setMap':
        if (!isOwner) return this.error(member, 'only the room owner can change the map');
        if (!this.maps.some((m) => m.id === msg.mapId)) return this.error(member, 'unknown map');
        this.settings = { ...this.settings, mapId: msg.mapId };
        break;
      case 'setConfig': {
        if (!isOwner) return this.error(member, 'only the room owner can change settings');
        const problem = validateConfig(msg.config);
        if (problem) return this.error(member, problem);
        this.settings = { ...this.settings, ...msg.config };
        break;
      }
      case 'startMatch':
        if (!isOwner) return this.error(member, 'only the room owner can start the match');
        if (!this.canStart()) return this.error(member, this.practice ? 'cannot start' : 'need 2+ players, and everyone ready');
        return this.startMatch();
    }
    this.broadcastLobby();
  }

  private applyInput(member: Member, msg: Extract<ClientMessage, { type: 'input' }>): void {
    if (!this.game || msg.seq <= member.lastInputSeq) return;
    member.lastInputSeq = msg.seq;
    this.game.setMoveDir(member.id, msg.moveDir);
    if (msg.shoot) this.game.pressShoot(member.id); // latched by GameApi until the next tick
  }

  // ---- Match lifecycle ----

  private canStart(): boolean {
    const connected = this.members.filter((m) => m.sink !== null);
    if (this.practice) return connected.length === 1;
    return connected.length >= 2 && connected.every((m) => m.id === this.ownerId || m.ready);
  }

  private async startMatch(): Promise<void> {
    const entry = this.maps.find((m) => m.id === this.settings.mapId)!;
    this.starting = true;
    const generation = this.generation;
    const api = new GameApi();
    try {
      api.setRoster(this.members.map((m) => ({ id: m.id, name: m.name, skinId: m.skinId })));
      await api.start(
        { practice: this.practice, targetScore: this.settings.targetScore, roundTime: this.settings.roundTime },
        entry.map,
        this.seed === undefined ? {} : { seed: this.seed },
      );
    } catch (err) {
      if (generation !== this.generation) return api.reset(); // disposed meanwhile: nobody to tell
      // Never reject out of handle(): a server adapter must not crash on one bad start.
      this.starting = false;
      api.reset();
      this.members = this.members.filter((m) => m.sink !== null); // anyone who left meanwhile
      const owner = this.members.find((m) => m.id === this.ownerId);
      if (!owner) this.passOwnershipFrom(0);
      if (owner) this.error(owner, `could not start the match: ${err instanceof Error ? err.message : String(err)}`);
      this.broadcastLobby();
      return;
    }
    if (generation !== this.generation) {
      api.reset(); // the room was disposed while the match was starting
      return;
    }
    this.starting = false;
    this.game = api;
    this.tickCount = 0;
    for (const m of this.members) {
      m.ready = false;
      m.lastInputSeq = -1;
      if (m.sink === null) api.disconnectPlayer(m.id); // dropped while the match was starting
    }
    this.broadcast(this.matchStartMessage(api));
    this.broadcastSnapshot();
  }

  /** Advances the match by one fixed step. A no-op in the lobby. */
  tick(dt = 1 / 60): void {
    if (!this.game) return;
    const events = this.game.tick(dt);
    for (const event of events) this.broadcast({ type: 'event', event });
    this.tickCount += 1;

    if (this.game.getState().phase === 'matchEnd') {
      this.broadcastSnapshot(); // final scores, before the lobby replaces the match
      this.endMatch();
      return;
    }
    if (this.tickCount % this.snapshotEvery === 0) this.broadcastSnapshot();
  }

  private endMatch(): void {
    this.game?.reset(); // disposes the physics world
    this.game = null;
    const owner = this.members.find((m) => m.id === this.ownerId);
    if (owner && owner.sink === null) this.passOwnershipFrom(this.members.indexOf(owner) + 1);
    this.members = this.members.filter((m) => m.sink !== null); // those who left during the match
    this.broadcastLobby();
  }

  /**
   * The owner role goes to the first connected player at or after `start` in join order,
   * wrapping around (spec §14: the next connected player after the owner). Nobody connected
   * → no owner until someone joins or rejoins.
   */
  private passOwnershipFrom(start: number): void {
    const n = this.members.length;
    for (let k = 0; k < n; k++) {
      const m = this.members[(start + k) % n]!;
      if (m.sink !== null && m.id !== this.ownerId) {
        this.ownerId = m.id;
        this.broadcast({ type: 'event', event: { kind: 'ownerChanged', ownerId: m.id } });
        return;
      }
    }
    this.ownerId = null;
  }

  // ---- Outgoing messages ----

  lobbyMessage(): LobbyMessage {
    return {
      type: 'lobby',
      code: this.code,
      ownerId: this.ownerId,
      players: this.members.map((m) => ({ id: m.id, name: m.name, skinId: m.skinId, ready: m.ready, connected: m.sink !== null })),
      settings: { ...this.settings },
      maps: this.maps.map(({ id, name }) => ({ id, name })),
      canStart: this.canStart(),
      practice: this.practice,
    };
  }

  private matchStartMessage(api: GameApi): ServerMessage {
    const state = api.getState();
    return {
      type: 'matchStart',
      map: this.maps.find((m) => m.id === this.settings.mapId)!.map,
      config: state.config,
      players: state.players.map((p) => ({ id: p.id, name: p.name, skinId: p.skinId })),
      seed: state.seed,
    };
  }

  private broadcastLobby(): void {
    this.broadcast(this.lobbyMessage());
  }

  private broadcastSnapshot(): void {
    if (!this.game) return;
    this.broadcast({ type: 'snapshot', seq: this.snapshotSeq++, state: toDynamic(this.game.getState()) });
  }

  private broadcast(msg: ServerMessage): void {
    for (const m of this.members) m.sink?.(msg);
  }

  private error(member: Member, message: string): void {
    member.sink?.({ type: 'error', message });
  }
}

function validateConfig(config: SettableConfig): string | null {
  for (const key of ['targetScore', 'roundTime'] as const) {
    const value = config[key];
    if (value === undefined) continue;
    const { min, max } = CONFIG_LIMITS[key];
    if (!Number.isInteger(value) || value < min || value > max) return `${key} must be an integer from ${min} to ${max}`;
  }
  return null;
}
