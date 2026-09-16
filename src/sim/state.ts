// Deterministic simulation core skeleton.
//
// Contract (from game spec §4): pure TypeScript. NO DOM imports, NO three.js
// imports, NO WebRTC imports. Deterministic function of its inputs.
// Gameplay issues extend this file (state shape, step function, events).
//
// The walking skeleton has an empty world so verify.sh's e2e smoke can prove
// the `window.__game` hook and practice-mode wiring work end-to-end before
// any gameplay exists.

export type Direction = "+X" | "-X" | "+Y" | "-Y";
export type MoveDir = Direction | "none";

export interface Vec2 {
  x: number;
  y: number;
}

export interface Player {
  id: string;
  pos: Vec2;
  facing: Direction;
  alive: boolean;
}

export interface Bullet {
  id: string;
  ownerId: string;
  pos: Vec2;
  dir: Direction;
}

export type Phase = "lobby" | "round" | "matchEnd" | "practice";

export interface State {
  phase: Phase;
  tick: number;
  players: Player[];
  bullets: Bullet[];
}

export interface Input {
  playerId: string;
  moveDir: MoveDir;
  shoot: boolean;
}

export function createPracticeState(): State {
  return {
    phase: "practice",
    tick: 0,
    players: [],
    bullets: [],
  };
}

// Pure step function. Skeleton version: advances tick, otherwise no-op.
// Gameplay issues will implement movement, shooting, and collision here.
export function step(state: State, _inputs: Input[], _dt: number): { state: State; events: readonly unknown[] } {
  const next: State = {
    ...state,
    tick: state.tick + 1,
    players: state.players.slice(),
    bullets: state.bullets.slice(),
  };
  return { state: next, events: [] };
}
