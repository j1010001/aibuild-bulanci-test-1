// The main tick: step(state, inputs, dt) -> { state, events } (spec §4, §9, §10).
// Movement, gun-fit, and bullet resolution all go through state.physics (spec §7) — the
// real 3D collision world — never a hand-derived 2D approximation. Deterministic given
// the same (state, inputs, dt) AND the same physics world contents, which never change
// mid-game (obstacles are fixed at load; only kinematic player positions move).

import { assignSpawns } from './spawn';
import type { Bullet, Direction, GameEvent, PlayerId, PlayerInput, State, Vec2 } from './types';
import { DIR_VECTOR } from './types';

function cloneNonPhysics(state: State): State {
  return {
    ...state,
    scores: { ...state.scores },
    players: state.players.map((p) => ({ ...p, pos: { ...p.pos } })),
    bullets: state.bullets.map((b) => ({ ...b, pos: { ...b.pos } })),
    // physics is intentionally NOT cloned — it's the one genuinely stateful, mutated-
    // in-place part of a State (see types.ts).
  };
}

function muzzlePoint(pos: Vec2, dir: Direction, muzzleOffset: number): Vec2 {
  const v = DIR_VECTOR[dir];
  return { x: pos.x + v.x * muzzleOffset, y: pos.y + v.y * muzzleOffset };
}

function muzzleWithinBoard(pos: Vec2, dir: Direction, muzzleOffset: number, board: { width: number; height: number }): boolean {
  const m = muzzlePoint(pos, dir, muzzleOffset);
  return m.x >= 0 && m.x <= board.width && m.y >= 0 && m.y <= board.height;
}

function boardClampAdvance(pos: Vec2, dir: Direction, requested: number, inset: number, board: { width: number; height: number }): number {
  const axis = dir === '+X' || dir === '-X' ? 'x' : 'y';
  const sign = dir === '+X' || dir === '+Y' ? 1 : -1;
  const moving = axis === 'x' ? pos.x : pos.y;
  const limit = axis === 'x' ? board.width : board.height;
  const boundary = sign > 0 ? limit - inset : inset;
  const t = (boundary - moving) * sign;
  if (t <= 0) return 0;
  return Math.min(t, requested);
}

function boardExitDistance(pos: Vec2, dir: Direction, distance: number, board: { width: number; height: number }): number | null {
  const axis = dir === '+X' || dir === '-X' ? 'x' : 'y';
  const sign = dir === '+X' || dir === '+Y' ? 1 : -1;
  const moving = axis === 'x' ? pos.x : pos.y;
  const limit = axis === 'x' ? board.width : board.height;
  const boundary = sign > 0 ? limit : 0;
  const t = (boundary - moving) * sign;
  if (t < 0) return 0;
  if (t > distance) return null;
  return t;
}

function resolvePlayerMovement(state: State, player: State['players'][number], moveDir: Direction | null, dt: number, events: GameEvent[]): void {
  if (!player.alive || !player.connected || moveDir === null) return;
  const physics = state.physics; // already synced to player.pos by the caller (step())

  if (moveDir !== player.facing) {
    const fits = muzzleWithinBoard(player.pos, moveDir, state.config.muzzleOffset, state.config.board) &&
      physics.gunFits(player.id, player.pos, moveDir);
    if (!fits) {
      events.push({ kind: 'turnRefused', playerId: player.id, attemptedFacing: moveDir });
      return;
    }
    player.facing = moveDir;
  }

  const distance = state.config.playerSpeed * dt;
  let advance = physics.moveDistance(player.id, moveDir, distance);
  advance = Math.min(advance, boardClampAdvance(player.pos, moveDir, distance, state.config.playerRadius, state.config.board));
  const muzzleStart = muzzlePoint(player.pos, moveDir, state.config.muzzleOffset);
  advance = Math.min(advance, boardClampAdvance(muzzleStart, moveDir, distance, 0, state.config.board));
  advance = Math.max(0, advance);

  physics.applyMove(player.id, moveDir, advance);
  player.pos = physics.getPlayerPosition(player.id);
}

export function step(state: State, inputs: Record<PlayerId, PlayerInput>, dt: number): { state: State; events: GameEvent[] } {
  const events: GameEvent[] = [];
  if (state.phase === 'matchEnd') return { state, events };

  const next = cloneNonPhysics(state);
  next.time = state.time + dt * 1000;

  const ordered = [...next.players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Every player's physics collider is synced from the logical position FIRST, not just
  // the ones actively moving this tick — otherwise a stationary player whose `.pos` was
  // set externally (spawn placement, a respawn, test setup) would leave their collider
  // wherever it last was, silently missing bullets/gun-fit checks aimed at their real
  // position. resolvePlayerMovement below only needs to push the position it computes
  // back into physics for players who actually move.
  for (const player of ordered) next.physics.setPlayerPosition(player.id, player.pos);

  for (const player of ordered) {
    const moveDir = inputs[player.id]?.moveDir ?? null;
    resolvePlayerMovement(next, player, moveDir, dt, events);
  }

  type Fresh = { bulletId: string; startPos: Vec2; distance: number };
  const fresh: Fresh[] = [];

  for (const player of ordered) {
    if (!player.alive || !player.connected) continue;
    const shoot = inputs[player.id]?.shoot ?? false;
    if (!shoot) continue;
    if (next.time - player.lastShotAt < next.config.cadence) continue;

    player.lastShotAt = next.time;
    const dirVec = DIR_VECTOR[player.facing];
    const muzzle = {
      x: player.pos.x + dirVec.x * next.config.muzzleOffset,
      y: player.pos.y + dirVec.y * next.config.muzzleOffset,
    };
    const bullet: Bullet = { id: `b${next.nextBulletSeq++}`, ownerId: player.id, pos: muzzle, dir: player.facing };
    next.bullets.push(bullet);

    const circleEdge = {
      x: player.pos.x + dirVec.x * next.config.playerRadius,
      y: player.pos.y + dirVec.y * next.config.playerRadius,
    };
    const distance = next.config.muzzleOffset - next.config.playerRadius + next.config.bulletSpeed * dt;
    fresh.push({ bulletId: bullet.id, startPos: circleEdge, distance });
  }

  const toKill = new Set<PlayerId>();
  const surviving: Bullet[] = [];

  for (const bullet of next.bullets) {
    const f = fresh.find((x) => x.bulletId === bullet.id);
    const startPos = f ? f.startPos : bullet.pos;
    const distance = f ? f.distance : next.config.bulletSpeed * dt;

    const hit = next.physics.raycastBullet(startPos, bullet.dir, distance, next.config.bulletHeight);
    const boardDist = boardExitDistance(startPos, bullet.dir, distance, next.config.board);

    let consumeDistance: number | null = null;
    let hitPlayerId: PlayerId | null = null;
    if (hit !== null && (boardDist === null || hit.distance <= boardDist)) {
      consumeDistance = hit.distance;
      hitPlayerId = hit.hitPlayerId;
    } else if (boardDist !== null) {
      consumeDistance = boardDist;
    }

    if (consumeDistance === null) {
      const dirVec = DIR_VECTOR[bullet.dir];
      bullet.pos = { x: startPos.x + dirVec.x * distance, y: startPos.y + dirVec.y * distance };
      surviving.push(bullet);
      continue;
    }

    if (hitPlayerId) {
      toKill.add(hitPlayerId);
      events.push({ kind: 'playerKilled', victimId: hitPlayerId, killerId: bullet.ownerId, bulletId: bullet.id });
    }
    // wall / board exit / player hit: bullet is consumed in every case, dropped from `surviving`.
  }

  for (const p of next.players) {
    if (toKill.has(p.id)) {
      p.alive = false;
      next.physics.setPlayerEnabled(p.id, false); // dead players are inert (spec §10)
    }
  }
  next.bullets = surviving;

  resolveRoundAndMatch(next, events);

  return { state: next, events };
}

function startNextRound(state: State, events: GameEvent[]): void {
  state.roundNumber += 1;
  state.bullets = [];
  for (const p of state.players) {
    if (p.connected) p.alive = true;
  }
  assignSpawns(state, events); // re-enables each connected player's collider as it places them
  state.roundStartedAt = state.time;
  events.push({ kind: 'roundStart', roundNumber: state.roundNumber });
}

function resolveRoundAndMatch(state: State, events: GameEvent[]): void {
  const connected = state.players.filter((p) => p.connected);

  if (connected.length < 2) {
    if (!state.config.practice) {
      state.phase = 'matchEnd';
      state.winnerId = null;
      events.push({ kind: 'matchEnd', winnerId: null });
    }
    return; // practice: pure sandbox, rounds never end for want of opponents
  }

  const aliveConnected = connected.filter((p) => p.alive);

  if (aliveConnected.length === 1) {
    const winner = aliveConnected[0]!;
    state.scores[winner.id] = (state.scores[winner.id] ?? 0) + 1;
    events.push({ kind: 'roundEnd', roundNumber: state.roundNumber, winnerId: winner.id });
    if (state.scores[winner.id]! >= state.config.targetScore) {
      state.phase = 'matchEnd';
      state.winnerId = winner.id;
      events.push({ kind: 'matchEnd', winnerId: winner.id });
    } else {
      startNextRound(state, events);
    }
    return;
  }

  if (aliveConnected.length === 0) {
    // Simultaneous last-standing deaths: nobody met the round-win condition; treat as a draw.
    events.push({ kind: 'roundEnd', roundNumber: state.roundNumber, winnerId: null });
    startNextRound(state, events);
    return;
  }

  if (state.time - state.roundStartedAt >= state.config.roundTime * 1000) {
    events.push({ kind: 'roundEnd', roundNumber: state.roundNumber, winnerId: null });
    startNextRound(state, events);
  }
}
