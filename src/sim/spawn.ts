// Spawn fairness (spec §10, §14): non-solid (checked against the real physics world —
// spec §7), mutually separated, edge-margined, and admits at least one facing in which
// the gun fits.

import { nextRandom } from './rng';
import { DIRECTIONS } from './types';
import type { Direction, GameEvent, PlayerId, State, Vec2 } from './types';

const MAX_ATTEMPTS = 300;

function randRange(state: State, lo: number, hi: number): number {
  return lo + nextRandom(state) * (hi - lo);
}

function farEnough(pos: Vec2, chosen: readonly Vec2[], minSep: number): boolean {
  return chosen.every((c) => {
    const dx = pos.x - c.x;
    const dy = pos.y - c.y;
    return dx * dx + dy * dy >= minSep * minSep;
  });
}

function shuffledDirections(state: State): Direction[] {
  const arr = [...DIRECTIONS];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(state) * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

function muzzleWithinBoard(pos: Vec2, dir: Direction, muzzleOffset: number, board: { width: number; height: number }): boolean {
  const v = { '+X': [1, 0], '-X': [-1, 0], '+Y': [0, 1], '-Y': [0, -1] }[dir] as [number, number];
  const mx = pos.x + v[0] * muzzleOffset;
  const my = pos.y + v[1] * muzzleOffset;
  return mx >= 0 && mx <= board.width && my >= 0 && my <= board.height;
}

function pickValidFacing(state: State, playerId: PlayerId, pos: Vec2): Direction | null {
  for (const dir of shuffledDirections(state)) {
    if (!muzzleWithinBoard(pos, dir, state.config.muzzleOffset, state.config.board)) continue;
    if (state.physics.gunFits(playerId, pos, dir)) return dir;
  }
  return null;
}

function findFairSpawn(state: State, playerId: PlayerId, chosen: readonly Vec2[]): { pos: Vec2; facing: Direction } | null {
  const { board, spawnEdgeMargin, spawnSeparation } = state.config;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const pos = {
      x: randRange(state, spawnEdgeMargin, board.width - spawnEdgeMargin),
      y: randRange(state, spawnEdgeMargin, board.height - spawnEdgeMargin),
    };
    if (!state.physics.isFreeOfObstacles(pos)) continue;
    if (!farEnough(pos, chosen, spawnSeparation)) continue;
    state.physics.setPlayerPosition(playerId, pos); // so gunFits below queries from here
    const facing = pickValidFacing(state, playerId, pos);
    if (facing === null) continue;
    return { pos, facing };
  }
  return null;
}

/**
 * Best-effort placement when no fair spot exists (spec §14): scan the board for spots that
 * are clear of obstacles, far enough from every placed player that nobody starts inside
 * another's body or gun, and admit a facing where the gun fits — preferring the spot
 * farthest from everyone already placed. Only if the board has no such spot at all does
 * it fall back to a corner.
 */
function fallbackSpawn(state: State, playerId: PlayerId, chosen: readonly Vec2[], index: number): { pos: Vec2; facing: Direction } {
  const { board, spawnEdgeMargin, playerRadius, muzzleOffset } = state.config;
  const margin = Math.min(spawnEdgeMargin, playerRadius + 0.1);
  const minSeparation = playerRadius + muzzleOffset + 0.1; // clear of each other's gun reach
  let best: { pos: Vec2; facing: Direction; clearance: number } | null = null;
  const step = 0.5;
  for (let x = margin; x <= board.width - margin + 1e-9; x += step) {
    for (let y = margin; y <= board.height - margin + 1e-9; y += step) {
      const pos = { x, y };
      const clearance = chosen.reduce((m, c) => Math.min(m, Math.hypot(c.x - x, c.y - y)), Infinity);
      if (clearance < minSeparation || (best && clearance <= best.clearance)) continue;
      if (!state.physics.isFreeOfObstacles(pos)) continue;
      state.physics.setPlayerPosition(playerId, pos);
      const facing = pickValidFacing(state, playerId, pos);
      if (facing === null) continue;
      best = { pos, facing, clearance };
    }
  }
  if (best) return { pos: best.pos, facing: best.facing };
  const corners: Vec2[] = [
    { x: spawnEdgeMargin, y: spawnEdgeMargin },
    { x: board.width - spawnEdgeMargin, y: spawnEdgeMargin },
    { x: spawnEdgeMargin, y: board.height - spawnEdgeMargin },
    { x: board.width - spawnEdgeMargin, y: board.height - spawnEdgeMargin },
  ];
  const pos = corners[index % corners.length]!;
  state.physics.setPlayerPosition(playerId, pos);
  return { pos, facing: pickValidFacing(state, playerId, pos) ?? '+X' };
}

/** Assigns pos/facing to every connected player, mutating `state.players` in place. */
export function assignSpawns(state: State, events: GameEvent[]): void {
  const connected = state.players.filter((p) => p.connected);
  // Disable every connected player's collider first, so an unplaced player's stale old
  // position (wherever it was left from the previous round) can't interfere with
  // choosing a fair spot for someone else — only already-placed players count.
  for (const p of connected) state.physics.setPlayerEnabled(p.id, false);

  const chosen: Vec2[] = [];
  let fallbackIndex = 0;

  for (const player of connected) {
    const spot = findFairSpawn(state, player.id, chosen);
    if (spot) {
      player.pos = spot.pos;
      player.facing = spot.facing;
    } else {
      events.push({ kind: 'spawnFairnessFailed', playerId: player.id as PlayerId });
      const fb = fallbackSpawn(state, player.id, chosen, fallbackIndex++);
      player.pos = fb.pos;
      player.facing = fb.facing;
    }
    state.physics.setPlayerPosition(player.id, player.pos);
    state.physics.setPlayerFacing(player.id, player.facing);
    state.physics.setPlayerEnabled(player.id, true);
    chosen.push(player.pos);
  }
}
