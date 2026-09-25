// Core types for the simulation. Pure data — no DOM, no three.js. See spec §6.
//
// State.physics is the one exception to "pure data": it's a live handle to the real 3D
// collision world (spec §7) that every movement/gun/bullet query goes through. It's
// deliberately excluded from the JSON-safe snapshot GameApi.getState() returns — see
// sim/snapshot.ts.

import type { PhysicsWorld } from '../physics/world';

export type Vec2 = { x: number; y: number };

export type Direction = '+X' | '-X' | '+Y' | '-Y';

export const DIRECTIONS: readonly Direction[] = ['+X', '-X', '+Y', '-Y'];

export const DIR_VECTOR: Record<Direction, Vec2> = {
  '+X': { x: 1, y: 0 },
  '-X': { x: -1, y: 0 },
  '+Y': { x: 0, y: 1 },
  '-Y': { x: 0, y: -1 },
};

export type PrimitiveType = 'cube' | 'cone' | 'donut' | 'arch';

export type CubeParams = { w: number; d: number; h: number };
export type ConeParams = { radius: number; height: number };
export type DonutParams = { w: number; d: number; holeRadius: number; axis: 'x' | 'y' };
export type ArchParams = { w: number; d: number; doorWidth: number; doorHeight: number; axis: 'x' | 'y' };

export type ObstacleParams = CubeParams | ConeParams | DonutParams | ArchParams;

export type ObstacleDef = {
  id: string;
  type: PrimitiveType;
  pos: Vec2;
  params: ObstacleParams;
};

export type MapDef = {
  version: 1;
  board: { width: number; height: number };
  obstacles: ObstacleDef[];
};

export type PlayerId = string;

export type Player = {
  id: PlayerId;
  name: string;
  skinId: string;
  pos: Vec2;
  facing: Direction;
  lastShotAt: number; // sim-clock ms of last successful shot
  alive: boolean;
  connected: boolean;
};

export type Bullet = {
  id: string;
  ownerId: PlayerId;
  pos: Vec2;
  dir: Direction;
};

export type Config = {
  playerRadius: number;
  /** Real collision height of the player's body (a cylinder), spec §5 — must be less
   * than bulletHeight for a bullet to ever hit a player (spec: "any bullet reaching a
   * player's circle always kills"), see the note in defaultMap.ts. */
  playerHeight: number;
  muzzleOffset: number;
  bulletHeight: number;
  playerSpeed: number;
  bulletSpeed: number;
  cadence: number; // ms
  targetScore: number;
  roundTime: number; // seconds
  maxPlayers: number;
  practice: boolean;
  spawnSeparation: number;
  spawnEdgeMargin: number;
  board: { width: number; height: number };
};

export type Phase = 'round' | 'matchEnd';

export type State = {
  config: Config;
  phase: Phase;
  roundNumber: number;
  scores: Record<PlayerId, number>;
  players: Player[];
  obstacles: ObstacleDef[];
  bullets: Bullet[];
  time: number; // sim-clock ms, monotonic from game start
  roundStartedAt: number; // sim-clock ms
  winnerId: PlayerId | null; // set only once phase === 'matchEnd'
  nextBulletSeq: number;
  physics: PhysicsWorld;
};

/** The JSON-safe view of State — everything except the live physics handle. */
export type PublicState = Omit<State, 'physics'>;

export type PlayerInput = {
  moveDir: Direction | null;
  shoot: boolean; // edge: true means "shoot was pressed this tick"
};

export type GameEvent =
  | { kind: 'playerKilled'; victimId: PlayerId; killerId: PlayerId; bulletId: string }
  | { kind: 'roundStart'; roundNumber: number }
  | { kind: 'roundEnd'; roundNumber: number; winnerId: PlayerId | null }
  | { kind: 'matchEnd'; winnerId: PlayerId | null }
  | { kind: 'turnRefused'; playerId: PlayerId; attemptedFacing: Direction }
  | { kind: 'spawnFairnessFailed'; playerId: PlayerId };
