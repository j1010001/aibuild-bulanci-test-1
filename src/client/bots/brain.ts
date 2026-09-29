// The bot brain: decides one input (move direction, fire or not) from what a player can
// see — the snapshot, the map, the config — never from hidden state. Standard game-AI
// structure (no learning, no language model):
//
//   perception   who's alive, who is lined up with whom (with a clear line of fire),
//                which bullets are heading this way and how soon they arrive
//   navigation   a NavGrid path (A*) around obstacles to wherever it's going
//   decisions    utility scores pick one behavior every `thinkMs`:
//                  dodge 1.0 · evade 0.95 · attack 0.9 · chase 0.5 · wander 0.1
//
// Difficulty (BotProfile) changes the settings, not the logic. Randomness (reaction
// delays, dodge/evade rolls, wander goals, escapes) comes from a seeded generator, so a
// bot match is reproducible.

import { lineOfFireClear } from '../bot';
import type { BotInput } from '../bot';
import type { DynamicState } from '../../session/protocol';
import type { Bullet, Config, Direction, MapDef, PlayerId, Vec2 } from '../../sim';
import { DIR_VECTOR, DIRECTIONS } from '../../sim';
import { nextRandom, rngStateFromSeed } from '../../sim/rng';
import type { BotProfile } from './difficulty';
import { NavGrid } from './navigation';

type P = DynamicState['players'][number];
type Behavior = 'dodge' | 'evade' | 'attack' | 'chase' | 'wander';

const UTILITY: Record<Behavior, number> = { dodge: 1.0, evade: 0.95, attack: 0.9, chase: 0.5, wander: 0.1 };

/** A turn toward a lined-up target is refused while the gun would enter its body (spec §8). */
const TURN_CLEARANCE_EXTRA = 0.15;
const DODGE_HORIZON_S = 0.7; // react to bullets arriving within this time
const REACHED = 0.1; // a waypoint counts as reached this close (or once passed)
const OFF_LINE = 0.2; // drifted this far off a run's line: step back onto it first
const STUCK_MS = 1200;
const REPLAN_MS = 1500;
const RETRY_PLAN_MS = 500; // after a failed or empty plan, move directly before searching again
const DODGE_CLEARANCE = 0.2; // sidestep until this far beyond a body radius off the bullet's line
const GRID_CACHE_SIZE = 8;

// One navigation grid per map and player shape, shared by every bot (each receives its own
// JSON copy of the map, so the cache is keyed by content, not identity).
const grids = new Map<string, NavGrid>();

function gridFor(map: MapDef, config: Config): NavGrid {
  const { playerRadius, playerHeight, bulletHeight, muzzleOffset } = config;
  const key = JSON.stringify([map, playerRadius, playerHeight, bulletHeight, muzzleOffset]);
  let grid = grids.get(key);
  if (!grid) {
    grid = NavGrid.build(map, config);
    if (grids.size >= GRID_CACHE_SIZE) grids.delete(grids.keys().next().value!);
    grids.set(key, grid);
  }
  return grid;
}

type Maneuver = { kind: 'dodge' | 'evade' | 'escape'; dir: Direction; until: number; bulletId?: string };

function sign(d: Direction): { axis: 'x' | 'y'; s: number } {
  const v = DIR_VECTOR[d];
  return v.x !== 0 ? { axis: 'x', s: v.x } : { axis: 'y', s: v.y };
}

function toward(axis: 'x' | 'y', delta: number): Direction {
  return axis === 'x' ? (delta > 0 ? '+X' : '-X') : delta > 0 ? '+Y' : '-Y';
}

function perpendicular(d: Direction): [Direction, Direction] {
  return sign(d).axis === 'x' ? ['+Y', '-Y'] : ['+X', '-X'];
}

export class BotBrain {
  /** The enemy it is currently going after (for tests and debugging). */
  targetId: PlayerId | null = null;

  private readonly rng: { rngState: number };
  private map: MapDef | null = null;
  private config: Config | null = null;
  private grid: NavGrid | null = null;

  private lastThink = -Infinity;
  private behavior: Behavior = 'wander';
  private attackTarget: PlayerId | null = null;
  private maneuver: Maneuver | null = null;
  private path: { points: Vec2[]; runs: Direction[]; index: number; goal: Vec2; plannedAt: number } | null = null;
  private aimedSince: number | null = null;
  private reaction = 0;
  private lastShotAt = -Infinity; // when it last pressed fire (the snapshot confirms a shot a little later)
  private dodgeRolls = new Map<string, Direction | false>(); // per bullet: the side it steps to, or no dodge
  private planFailedAt = -Infinity;
  private round = -1;
  private evadeRolledAt = -Infinity;
  private anchor: { pos: Vec2; at: number } | null = null;

  constructor(
    private readonly profile: BotProfile,
    seed: number,
  ) {
    this.rng = { rngState: rngStateFromSeed(seed) };
  }

  reseed(seed: number): void {
    this.rng.rngState = rngStateFromSeed(seed);
  }

  /** What it is doing right now (for tests and debugging). */
  get doing(): Behavior | Maneuver['kind'] {
    return this.maneuver ? this.maneuver.kind : this.behavior;
  }

  /** Call once per match: picks up the (shared) navigation grid for the map. */
  setMatch(map: MapDef, config: Config): void {
    this.grid = gridFor(map, config);
    this.map = map;
    this.config = config;
    this.dodgeRolls.clear(); // bullet ids restart every match
    this.round = -1;
    this.reset();
  }

  nextReactionMs(): number {
    const [min, max] = this.profile.reactionMs;
    return min + nextRandom(this.rng) * (max - min);
  }

  decide(state: DynamicState, meId: PlayerId, now: number): BotInput {
    const me = state.players.find((p) => p.id === meId);
    if (!me || !me.alive || !this.grid || !this.config || !this.map) {
      this.reset();
      return { moveDir: null, shoot: false };
    }
    if (state.roundNumber !== this.round) {
      this.round = state.roundNumber; // a new round: new positions, nothing planned still holds
      this.reset();
    }
    const enemies = state.players.filter((p) => p.id !== meId && p.alive && p.connected);

    // A dodge ends as soon as that bullet can no longer hit.
    if (this.maneuver?.kind === 'dodge' && this.incoming(state.bullets, me)?.id !== this.maneuver.bulletId) this.maneuver = null;

    if (now - this.lastThink >= this.profile.thinkMs) {
      this.lastThink = now;
      this.think(state, me, enemies, now);
    }

    if (this.maneuver && now < this.maneuver.until) return this.moving(me, this.maneuver.dir, now);
    this.maneuver = null;

    if (this.behavior === 'attack') {
      const target = enemies.find((p) => p.id === this.attackTarget);
      if (target) {
        const decision = this.attack(state, me, target, now);
        if (decision) return decision;
      }
      this.behavior = 'chase'; // the shot is gone (target moved or died): back to chasing
    }
    this.aimedSince = null;

    if (this.behavior === 'chase') {
      const target = enemies.find((p) => p.id === this.targetId);
      if (target) {
        const dir = this.follow(me, target.pos, now);
        return this.moving(me, dir, now);
      }
      this.behavior = 'wander';
    }
    return this.moving(me, this.wander(me, now), now);
  }

  // ---- decisions ----

  private think(state: DynamicState, me: P, enemies: P[], now: number): void {
    const { dodgeChance, evadeChance } = this.profile;
    const options: { behavior: Behavior; score: number; apply: () => void }[] = [];

    // Dodge: the soonest bullet heading at me, rolled once per bullet (and one side per bullet).
    for (const id of this.dodgeRolls.keys()) if (!state.bullets.some((b) => b.id === id)) this.dodgeRolls.delete(id);
    const bullet = this.incoming(state.bullets, me);
    if (bullet) {
      let side = this.dodgeRolls.get(bullet.id);
      if (side === undefined) {
        side = nextRandom(this.rng) < dodgeChance ? this.sideToStep(me, bullet.dir) : false;
        this.dodgeRolls.set(bullet.id, side);
      }
      if (side) {
        const dodging = this.maneuver?.kind === 'dodge' && this.maneuver.bulletId === bullet.id;
        const perp = sign(bullet.dir).axis === 'x' ? 'y' : 'x';
        const clear = Math.max(0, this.config!.playerRadius + DODGE_CLEARANCE - Math.abs(bullet.pos[perp] - me.pos[perp]));
        const ms = (clear / this.config!.playerSpeed) * 1000 + 50;
        options.push({
          behavior: 'dodge',
          score: UTILITY.dodge,
          apply: () => {
            if (!dodging) this.startManeuver({ kind: 'dodge', dir: side, until: now + ms, bulletId: bullet.id });
          },
        });
      }
    }

    // Evade: an enemy has me in its sights and I can't fire first.
    const threat = enemies.find((e) => this.hasShot(e, me) && !this.canFireFirst(me, e));
    if (threat && now - this.evadeRolledAt > 1000) {
      this.evadeRolledAt = now;
      if (nextRandom(this.rng) < evadeChance) {
        const line = this.lineDir(threat, me)!;
        options.push({
          behavior: 'evade',
          score: UTILITY.evade,
          apply: () => this.startManeuver({ kind: 'evade', dir: this.sideToStep(me, line), until: now + 350 }),
        });
      }
    }

    // Target choice and attack.
    const target = this.chooseTarget(me, enemies);
    this.targetId = target?.id ?? null;
    const shootable = (this.profile.targeting === 'nearest' ? (target ? [target] : []) : enemies).filter((e) => this.lineUp(me, e) !== null);
    if (shootable.length > 0) {
      const best = shootable.reduce((a, b) => (dist(me, a) <= dist(me, b) ? a : b));
      options.push({
        behavior: 'attack',
        score: UTILITY.attack,
        apply: () => {
          if (this.attackTarget !== best.id) this.aimedSince = null;
          this.attackTarget = best.id;
          this.targetId = best.id;
        },
      });
    }
    if (target) options.push({ behavior: 'chase', score: UTILITY.chase, apply: () => {} });
    options.push({ behavior: 'wander', score: UTILITY.wander, apply: () => {} });

    const choice = options.reduce((a, b) => (b.score > a.score ? b : a));
    choice.apply();
    this.behavior = choice.behavior === 'dodge' || choice.behavior === 'evade' ? 'chase' : choice.behavior;
  }

  private chooseTarget(me: P, enemies: P[]): P | null {
    if (enemies.length === 0) return null;
    const nearest = () => enemies.reduce((a, b) => (dist(me, a) <= dist(me, b) ? a : b));
    switch (this.profile.targeting) {
      case 'nearest':
        return nearest();
      case 'shootable':
        return enemies.find((e) => this.lineUp(me, e) !== null) ?? nearest();
      case 'exposed': {
        // Whoever it can line up on soonest: the smallest offset from a shared row/column.
        const offset = (e: P) => Math.min(Math.abs(e.pos.x - me.pos.x), Math.abs(e.pos.y - me.pos.y));
        return enemies.reduce((a, b) => {
          const d = offset(a) - offset(b);
          return d < -1e-9 || (Math.abs(d) <= 1e-9 && dist(me, a) <= dist(me, b)) ? a : b;
        });
      }
    }
  }

  // ---- behaviors ----

  /** Face and fire at a lined-up target; null once it is no longer lined up. */
  private attack(state: DynamicState, me: P, target: P, now: number): BotInput | null {
    const want = this.lineUp(me, target);
    if (want === null) return null;
    const cfg = this.config!;
    if (me.facing !== want) {
      this.aimedSince = null;
      const range = sign(want).axis === 'x' ? Math.abs(target.pos.x - me.pos.x) : Math.abs(target.pos.y - me.pos.y);
      const clearance = cfg.muzzleOffset + cfg.playerRadius + TURN_CLEARANCE_EXTRA;
      const away = toward(sign(want).axis, -sign(want).s);
      return this.moving(me, range < clearance ? away : want, now);
    }
    if (this.aimedSince === null) {
      this.aimedSince = now;
      this.reaction = this.nextReactionMs();
    }
    // The gun's readiness by the authoritative clock: its own last shot in the snapshot
    // (−Infinity, sent as null, means never). The local guard stops a second press before
    // the snapshot has caught up with the first.
    const lastShot = typeof me.lastShotAt === 'number' ? me.lastShotAt : -Infinity;
    const ready = now - this.aimedSince >= this.reaction && state.time - lastShot >= cfg.cadence && now - this.lastShotAt >= 150;
    if (ready) {
      this.lastShotAt = now;
      this.aimedSince = null;
    }
    return { moveDir: null, shoot: ready };
  }

  private startManeuver(m: Maneuver): void {
    this.maneuver = m;
    this.path = null;
  }

  /** Which way to step off a line: toward the side with more room (a coin flip on a tie). */
  private sideToStep(me: P, lineDir: Direction): Direction {
    const grid = this.grid!;
    const [a, b] = perpendicular(lineDir);
    const room = (d: Direction) => {
      const v = DIR_VECTOR[d];
      let free = 0;
      for (let k = 1; k <= 3; k++) if (grid.walkable({ x: me.pos.x + v.x * k * 0.5, y: me.pos.y + v.y * k * 0.5 })) free = k;
      return free;
    };
    const ra = room(a);
    const rb = room(b);
    return ra === rb ? (nextRandom(this.rng) < 0.5 ? a : b) : ra > rb ? a : b;
  }

  private wander(me: P, now: number): Direction | null {
    if ((!this.path || this.path.index >= this.path.points.length) && now - this.planFailedAt >= RETRY_PLAN_MS) {
      for (let tries = 0; tries < 5; tries++) {
        const goal = { x: nextRandom(this.rng) * this.map!.board.width, y: nextRandom(this.rng) * this.map!.board.height };
        if (this.grid!.walkable(goal) && this.plan(me, goal, now)) break;
      }
    }
    return this.path ? this.advance(me) : null;
  }

  /**
   * Follow a path to `goal` (or the reachable place nearest it), replanning when the goal
   * moved or the plan went stale. With no usable path — already as close as paths get, or
   * none at all — it heads straight for the goal's row or column, and doesn't search again
   * for a while (a failed search expands everything reachable: too slow for every frame).
   */
  private follow(me: P, goal: Vec2, now: number): Direction | null {
    const p = this.path;
    const stale = !p || p.index >= p.points.length || now - p.plannedAt > REPLAN_MS || Math.hypot(p.goal.x - goal.x, p.goal.y - goal.y) > 1.5;
    if (stale && (now - this.planFailedAt < RETRY_PLAN_MS || !this.plan(me, goal, now, true))) return direct(me, goal);
    return this.advance(me) ?? direct(me, goal);
  }

  private plan(me: P, goal: Vec2, now: number, orNearest = false): boolean {
    const grid = this.grid!;
    const points = grid.findPath(me.pos, goal, me.facing, orNearest);
    if (!points || points.length === 0) {
      this.path = null;
      this.planFailedAt = now;
      return false;
    }
    const runs: Direction[] = [];
    let prev = me.pos; // a path starts from where the bot actually is
    for (const pt of points) {
      runs.push(Math.abs(pt.x - prev.x) > Math.abs(pt.y - prev.y) ? toward('x', pt.x - prev.x) : toward('y', pt.y - prev.y));
      prev = pt;
    }
    this.path = { points, runs, index: 0, goal: { ...goal }, plannedAt: now };
    return true;
  }

  /** The move that makes progress along the current run, stepping back onto its line first if drifted. */
  private advance(me: P): Direction | null {
    const p = this.path!;
    while (p.index < p.points.length) {
      const wp = p.points[p.index]!;
      const { axis, s } = sign(p.runs[p.index]!);
      const remaining = (wp[axis] - me.pos[axis]) * s;
      if (remaining <= REACHED) {
        p.index++;
        continue;
      }
      const perp = axis === 'x' ? 'y' : 'x';
      const off = wp[perp] - me.pos[perp];
      if (Math.abs(off) > OFF_LINE) return toward(perp, off);
      return p.runs[p.index]!;
    }
    return null;
  }

  /** Emit a move, with stuck detection: trying to move but going nowhere starts an escape. */
  private moving(me: P, dir: Direction | null, now: number): BotInput {
    if (!this.anchor || Math.hypot(me.pos.x - this.anchor.pos.x, me.pos.y - this.anchor.pos.y) > 0.3) this.anchor = { pos: { ...me.pos }, at: now };
    if (dir !== null && now - this.anchor.at > STUCK_MS && !this.maneuver) {
      const options = DIRECTIONS.filter((d) => d !== dir);
      const escape = options[Math.floor(nextRandom(this.rng) * options.length)]!;
      this.startManeuver({ kind: 'escape', dir: escape, until: now + 500 + nextRandom(this.rng) * 300 });
      this.anchor = null;
      dir = escape;
    }
    return { moveDir: dir, shoot: false };
  }

  // ---- perception ----

  /** If `me` is lined up on `target` (within its aim) with a clear line, the direction to face. */
  private lineUp(me: P, target: P): Direction | null {
    const tol = this.profile.alignTolerance;
    const dx = target.pos.x - me.pos.x;
    const dy = target.pos.y - me.pos.y;
    let want: Direction | null = null;
    if (Math.abs(dy) <= tol && Math.abs(dx) > tol) want = dx > 0 ? '+X' : '-X';
    else if (Math.abs(dx) <= tol && Math.abs(dy) > tol) want = dy > 0 ? '+Y' : '-Y';
    if (want === null) return null;
    return lineOfFireClear(me.pos, target.pos, this.map!.obstacles, this.config!.bulletHeight) ? want : null;
  }

  /** Does `shooter`, as it faces now, have a clear shot that would hit `victim`? */
  private hasShot(shooter: P, victim: P): boolean {
    const dir = this.lineDir(shooter, victim);
    return dir !== null && shooter.facing === dir && lineOfFireClear(shooter.pos, victim.pos, this.map!.obstacles, this.config!.bulletHeight);
  }

  /** Would `me` fire at `enemy` right now — lined up within its own aim, and facing it? */
  private canFireFirst(me: P, enemy: P): boolean {
    const want = this.lineUp(me, enemy);
    return want !== null && me.facing === want;
  }

  /** The direction from `from` to `to` if they share a row/column within a body radius (a bullet's hit width). */
  private lineDir(from: P, to: P): Direction | null {
    const R = this.config!.playerRadius;
    const dx = to.pos.x - from.pos.x;
    const dy = to.pos.y - from.pos.y;
    if (Math.abs(dy) < R && Math.abs(dx) >= R) return dx > 0 ? '+X' : '-X';
    if (Math.abs(dx) < R && Math.abs(dy) >= R) return dy > 0 ? '+Y' : '-Y';
    return null;
  }

  /** The soonest bullet that will pass through `me` within the dodge horizon. */
  private incoming(bullets: Bullet[], me: P): (Bullet & { tti: number }) | null {
    const cfg = this.config!;
    let best: (Bullet & { tti: number }) | null = null;
    for (const b of bullets) {
      const { axis, s } = sign(b.dir);
      const perp = axis === 'x' ? 'y' : 'x';
      if (Math.abs(b.pos[perp] - me.pos[perp]) >= cfg.playerRadius + 0.1) continue; // passes beside me
      const ahead = (me.pos[axis] - b.pos[axis]) * s;
      if (ahead <= 0) continue; // moving away, or already past
      const tti = ahead / cfg.bulletSpeed;
      if (tti > DODGE_HORIZON_S) continue;
      if (!lineOfFireClear(b.pos, me.pos, this.map!.obstacles, cfg.bulletHeight)) continue; // a wall takes it first
      if (!best || tti < best.tti) best = { ...b, tti };
    }
    return best;
  }

  private reset(): void {
    this.behavior = 'wander';
    this.attackTarget = null;
    this.targetId = null;
    this.maneuver = null;
    this.path = null;
    this.aimedSince = null;
    this.anchor = null;
    this.lastThink = -Infinity;
    this.planFailedAt = -Infinity;
  }
}

/** Straight for the goal's row or column (whichever is nearer), to line up on it. */
function direct(me: P, goal: Vec2): Direction | null {
  const dx = goal.x - me.pos.x;
  const dy = goal.y - me.pos.y;
  if (Math.abs(dx) < REACHED && Math.abs(dy) < REACHED) return null;
  if (Math.abs(dx) < REACHED) return toward('y', dy);
  if (Math.abs(dy) < REACHED) return toward('x', dx);
  return Math.abs(dx) <= Math.abs(dy) ? toward('x', dx) : toward('y', dy);
}

function dist(a: P, b: P): number {
  return Math.abs(a.pos.x - b.pos.x) + Math.abs(a.pos.y - b.pos.y);
}
