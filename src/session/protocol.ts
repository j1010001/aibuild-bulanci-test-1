// Message types shared by client and server (spec §12), plus parseClientMessage — the
// trust boundary every client message crosses before a Room acts on it. Environment-free.

import type { Config, Direction, GameEvent, MapDef, PlayerId, PublicState } from '../sim';
import { DIRECTIONS } from '../sim';

// ---- Client -> server ----

/** The only config fields a client may set; everything else (physics tuning) stays server-side. */
export type SettableConfig = { targetScore?: number; roundTime?: number };

export type ClientMessage =
  | { type: 'createRoom'; name: string }
  | { type: 'joinRoom'; code: string; name: string }
  | { type: 'rejoin'; code: string; reconnectToken: string }
  | { type: 'setSkin'; skinId: string }
  | { type: 'setReady'; ready: boolean }
  | { type: 'setMap'; mapId: string }
  | { type: 'setConfig'; config: SettableConfig }
  | { type: 'startMatch' }
  | { type: 'input'; seq: number; moveDir: Direction | null; shoot: boolean }
  | { type: 'leave' };

// ---- Server -> client ----

export type JoinRejectReason = 'notFound' | 'full' | 'inProgress' | 'badToken';

export type LobbyPlayer = { id: PlayerId; name: string; skinId: string; ready: boolean; connected: boolean };

export type MatchSettings = { mapId: string; targetScore: number; roundTime: number };

export type SessionEvent =
  | { kind: 'playerJoined'; playerId: PlayerId }
  | { kind: 'playerLeft'; playerId: PlayerId }
  | { kind: 'ownerChanged'; ownerId: PlayerId };

/** The per-tick part of State. Static data (map, config) is sent once, in matchStart. */
export type DynamicState = Pick<
  PublicState,
  'phase' | 'roundNumber' | 'scores' | 'players' | 'bullets' | 'time' | 'roundStartedAt' | 'winnerId'
>;

export type LobbyMessage = {
  type: 'lobby';
  code: string;
  ownerId: PlayerId | null;
  players: LobbyPlayer[];
  settings: MatchSettings;
  maps: { id: string; name: string }[];
  canStart: boolean;
  practice: boolean;
};

export type ServerMessage =
  | { type: 'roomJoined'; code: string; playerId: PlayerId; reconnectToken: string }
  | { type: 'joinRejected'; reason: JoinRejectReason }
  | LobbyMessage
  | { type: 'matchStart'; map: MapDef; config: Config; players: { id: PlayerId; name: string; skinId: string }[]; seed: number }
  | { type: 'snapshot'; seq: number; state: DynamicState }
  | { type: 'event'; event: GameEvent | SessionEvent }
  | { type: 'error'; message: string };

// ---- Limits (validated by the Room; names and codes by the parser) ----

export const NAME_MAX_LENGTH = 20;
export const CONFIG_LIMITS = {
  targetScore: { min: 1, max: 10 },
  roundTime: { min: 10, max: 300 },
} as const;

// ---- Parsing ----

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseName(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > NAME_MAX_LENGTH * 8) return null;
  // Control (Cc) and format (Cf: zero-width, bidirectional overrides) characters are
  // stripped so a name can't be invisible or reorder the text around it.
  const name = v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  const length = [...name].length; // characters, not UTF-16 code units
  return length >= 1 && length <= NAME_MAX_LENGTH ? name : null;
}

function parseCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const code = v.trim().toUpperCase();
  return /^[A-Z0-9]{5,6}$/.test(code) ? code : null;
}

function parseShortString(v: unknown, max = 64): string | null {
  return typeof v === 'string' && v.length >= 1 && v.length <= max ? v : null;
}

function parseSettableConfig(v: unknown): SettableConfig | null {
  if (!isObj(v)) return null;
  const out: SettableConfig = {};
  for (const key of ['targetScore', 'roundTime'] as const) {
    if (!(key in v)) continue;
    const n = v[key];
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    out[key] = n;
  }
  return out;
}

/** Returns a well-formed ClientMessage (extra fields stripped), or null for anything malformed. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isObj(raw)) return null;
  switch (raw.type) {
    case 'createRoom': {
      const name = parseName(raw.name);
      return name === null ? null : { type: 'createRoom', name };
    }
    case 'joinRoom': {
      const code = parseCode(raw.code);
      const name = parseName(raw.name);
      return code === null || name === null ? null : { type: 'joinRoom', code, name };
    }
    case 'rejoin': {
      const code = parseCode(raw.code);
      const reconnectToken = parseShortString(raw.reconnectToken, 128);
      return code === null || reconnectToken === null ? null : { type: 'rejoin', code, reconnectToken };
    }
    case 'setSkin': {
      const skinId = parseShortString(raw.skinId);
      return skinId === null ? null : { type: 'setSkin', skinId };
    }
    case 'setReady':
      return typeof raw.ready === 'boolean' ? { type: 'setReady', ready: raw.ready } : null;
    case 'setMap': {
      const mapId = parseShortString(raw.mapId);
      return mapId === null ? null : { type: 'setMap', mapId };
    }
    case 'setConfig': {
      const config = parseSettableConfig(raw.config);
      return config === null ? null : { type: 'setConfig', config };
    }
    case 'startMatch':
      return { type: 'startMatch' };
    case 'input': {
      const { seq, moveDir, shoot } = raw;
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
      if (moveDir !== null && !(DIRECTIONS as readonly unknown[]).includes(moveDir)) return null;
      if (typeof shoot !== 'boolean') return null;
      return { type: 'input', seq, moveDir: moveDir as Direction | null, shoot };
    }
    case 'leave':
      return { type: 'leave' };
    default:
      return null;
  }
}
