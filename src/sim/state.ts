// createGame(RAPIER, config, map, roster, seed) -> State (spec §4, §6, §10). Builds the real
// physics world (spec §7) once at load time and places the roster into it via spawn
// fairness — the same real-3D queries used every tick, not a separate 2D approximation.

import { PhysicsWorld } from '../physics/world';
import { rngStateFromSeed } from './rng';
import type { Rapier } from '../physics/rapier';
import { assignSpawns } from './spawn';
import type { Config, GameEvent, MapDef, Player, PlayerId, State } from './types';

export const DEFAULT_CONFIG: Config = {
  playerRadius: 0.5,
  // Real capsule/cylinder collision height (spec §5). Must exceed bulletHeight so a
  // bullet reaching a player always kills, and — separately — must leave room between
  // itself and bulletHeight for an arch's doorHeight to meaningfully distinguish
  // "a player fits under this" from "a bullet flies under this" (see defaultMap.ts).
  playerHeight: 1.2,
  muzzleOffset: 0.8,
  bulletHeight: 0.9,
  playerSpeed: 6,
  bulletSpeed: 18,
  cadence: 800,
  targetScore: 3,
  roundTime: 60,
  maxPlayers: 8,
  practice: false,
  spawnSeparation: 5,
  spawnEdgeMargin: 2,
  board: { width: 40, height: 40 },
};

export type RosterEntry = { id: PlayerId; name: string; skinId: string };

export function createGame(
  RAPIER: Rapier,
  configOverrides: Partial<Config>,
  map: MapDef,
  roster: readonly RosterEntry[],
  seed: number,
): { state: State; events: GameEvent[] } {
  // Recorded as the 32-bit value the PRNG actually uses, so state.seed always replays
  // the run; a seed that can't round-trip through JSON (NaN, Infinity) is rejected.
  if (!Number.isInteger(seed)) throw new Error(`createGame: seed must be an integer, got ${seed}`);
  const usedSeed = seed >>> 0;

  const config: Config = {
    ...DEFAULT_CONFIG,
    ...configOverrides,
    board: { ...DEFAULT_CONFIG.board, ...(configOverrides.board ?? map.board) },
  };

  const physics = new PhysicsWorld(RAPIER, map, { playerRadius: config.playerRadius, playerHeight: config.playerHeight });

  const players: Player[] = roster.map((r) => ({
    id: r.id,
    name: r.name,
    skinId: r.skinId,
    pos: { x: 0, y: 0 },
    facing: '+X',
    lastShotAt: -Infinity,
    alive: true,
    connected: true,
  }));
  for (const p of players) physics.addPlayer(p.id, p.pos);

  const scores: Record<PlayerId, number> = {};
  for (const p of players) scores[p.id] = 0;

  const state: State = {
    config,
    phase: 'round',
    roundNumber: 1,
    scores,
    players,
    obstacles: map.obstacles,
    bullets: [],
    time: 0,
    roundStartedAt: 0,
    winnerId: null,
    nextBulletSeq: 0,
    seed: usedSeed,
    rngState: rngStateFromSeed(usedSeed),
    physics,
  };

  const events: GameEvent[] = [];
  assignSpawns(state, events);
  events.push({ kind: 'roundStart', roundNumber: state.roundNumber });

  return { state, events };
}
