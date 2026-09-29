// Bot navigation: a grid of where a player fits, and A* pathfinding over it. Planned from
// the same obstacle geometry the physics world collides with (buildObstacleGeometry), and
// for the whole player — the body (from the ground to playerHeight) and the gun, which
// reaches muzzleOffset ahead at bullet height. A step from one cell to the next in a
// direction is valid only if the body fits in the next cell and the gun fits when turned
// that way here, along the move, and at the end — so a planned path is one the real
// physics lets a player walk (tests/unit/navigation.test.ts follows paths with the real
// engine, from arbitrary starting positions).
//
// A path starts with one or two single-axis legs from the bot's actual position onto the
// grid, checked with the same body/gun rules but exactly (no cell rounding), so a bot
// resting against a wall — in a cell too tight to count as walkable — can still leave.
//
// Conservative on purpose: footprints are bounding boxes (cones and cylinders as squares,
// the donut as its whole wheel). Other players aren't in the grid; bots handle them.

import { buildObstacleGeometry, type PartSpec } from '../../geometry/obstacleGeometry';
import type { PlayerShapeConfig } from '../../geometry/playerGeometry';
import type { Direction, MapDef, Vec2 } from '../../sim';
import { DIR_VECTOR, DIRECTIONS } from '../../sim';

type Box = { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

/** Extra clearance for the body beyond its radius — more than a tick of travel (0.1 at
 * 6 units/s) of rounding when a bot arrives at a waypoint. */
export const BODY_MARGIN = 0.08;
const GUN_HALF = 0.04; // the barrel's half-thickness (playerGeometry BARREL / 2)
const GUN_MARGIN = 0.05;
const TOUCH = 0.01; // touching counts as contact (a lintel exactly at the player's height blocks)
const TURN_PENALTY = 0.3; // prefer straight runs: fewer turns, fewer input changes
const BUCKET = 2; // spatial hash cell size for obstacle lookups
const SAMPLE = 0.05; // spacing of exact checks along a start leg
const MAX_EXPANSIONS = 60_000;

/** The narrowest arch door bots can plan through wherever it sits on the grid, at the
 * default player shape: 2·radius + 2·BODY_MARGIN + one cell, rounded up. Narrower doors
 * (down to 2·radius) may still be passable for a person; a map editor should warn. */
export const MIN_BOT_DOOR_WIDTH = 1.7;

function partBox(part: PartSpec): Box {
  const c = part.center;
  if (part.kind === 'box') {
    return { minX: c.x - part.width / 2, maxX: c.x + part.width / 2, minZ: c.z - part.depth / 2, maxZ: c.z + part.depth / 2, minY: c.y - part.height / 2, maxY: c.y + part.height / 2 };
  }
  if (part.kind === 'cone' || part.kind === 'cylinder') {
    const r = part.radius;
    return { minX: c.x - r, maxX: c.x + r, minZ: c.z - r, maxZ: c.z + r, minY: c.y - part.height / 2, maxY: c.y + part.height / 2 };
  }
  // trimesh (donut): its bounding box, turned by rotationY (0 or a quarter turn)
  part.geometry.computeBoundingBox();
  const b = part.geometry.boundingBox!;
  const quarter = Math.abs(Math.sin(part.rotationY)) > 0.5;
  const [minX, maxX, minZ, maxZ] = quarter ? [b.min.z, b.max.z, b.min.x, b.max.x] : [b.min.x, b.max.x, b.min.z, b.max.z];
  return { minX: c.x + minX, maxX: c.x + maxX, minZ: c.z + minZ, maxZ: c.z + maxZ, minY: c.y + b.min.y, maxY: c.y + b.max.y };
}

/** Inflated rectangles bucketed by position, so a point test only looks at nearby ones. */
class RectIndex {
  private readonly buckets = new Map<number, Rect[]>();
  constructor(
    rects: Rect[],
    private readonly cols: number,
  ) {
    for (const r of rects) {
      for (let bx = Math.floor(r.minX / BUCKET); bx <= Math.floor(r.maxX / BUCKET); bx++) {
        for (let bz = Math.floor(r.minZ / BUCKET); bz <= Math.floor(r.maxZ / BUCKET); bz++) {
          const key = bz * this.cols + bx;
          const list = this.buckets.get(key);
          if (list) list.push(r);
          else this.buckets.set(key, [r]);
        }
      }
    }
  }
  hits(x: number, z: number): boolean {
    const list = this.buckets.get(Math.floor(z / BUCKET) * this.cols + Math.floor(x / BUCKET));
    return !!list && list.some((r) => x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ);
  }
}

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly cx: Float64Array;
  private readonly cy: Float64Array;
  private readonly fits: Uint8Array;
  /** step[(cell * 4) + dirIndex] = 1 if a player in `cell` can turn to and move one cell that way. */
  private readonly step: Uint8Array;
  // A* scratch, reused between calls (a generation stamp marks what's valid this call)
  private readonly g: Float64Array;
  private readonly came: Int32Array;
  private readonly seen: Uint32Array;
  private readonly done: Uint32Array;
  private generation = 0;
  private readonly heap = new MinHeap();

  private constructor(
    readonly cellSize: number,
    private readonly board: { width: number; height: number },
    private readonly body: RectIndex, // inflated by radius + margin (cells)
    private readonly bodyExact: RectIndex, // inflated by radius only (start legs)
    private readonly gun: RectIndex,
    private readonly radius: number,
    private readonly muzzleOffset: number,
  ) {
    this.cols = Math.floor(board.width / cellSize);
    this.rows = Math.floor(board.height / cellSize);
    const n = this.cols * this.rows;
    this.cx = new Float64Array(n);
    this.cy = new Float64Array(n);
    this.fits = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      this.cx[i] = ((i % this.cols) + 0.5) * cellSize;
      this.cy[i] = (Math.floor(i / this.cols) + 0.5) * cellSize;
      this.fits[i] = this.bodyBlocked(this.cx[i]!, this.cy[i]!, this.body, radius + BODY_MARGIN) ? 0 : 1;
    }
    this.step = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      if (!this.fits[i]) continue;
      DIRECTIONS.forEach((dir, d) => {
        const j = this.neighbor(i, dir);
        if (j === null || !this.fits[j]) return;
        const v = DIR_VECTOR[dir];
        const m = this.muzzleOffset;
        // the gun turned this way here, halfway along the move, and at the end
        const clear = [m, m + cellSize / 2, m + cellSize].every((a) => !this.gunBlocked(this.cx[i]! + v.x * a, this.cy[i]! + v.y * a));
        this.step[i * 4 + d] = clear ? 1 : 0;
      });
    }
    this.g = new Float64Array(n * 5);
    this.came = new Int32Array(n * 5);
    this.seen = new Uint32Array(n * 5);
    this.done = new Uint32Array(n * 5);
  }

  static build(map: MapDef, player: PlayerShapeConfig, cellSize = 0.5): NavGrid {
    const boxes = map.obstacles.flatMap((o) => buildObstacleGeometry(o).parts.map(partBox));
    const { playerRadius: R, playerHeight, bulletHeight } = player;
    const gunLow = bulletHeight - GUN_HALF - TOUCH;
    const gunHigh = bulletHeight + GUN_HALF + TOUCH;
    const inflate = (b: Box, by: number): Rect => ({ minX: b.minX - by, maxX: b.maxX + by, minZ: b.minZ - by, maxZ: b.maxZ + by });
    const bodyParts = boxes.filter((b) => b.minY < playerHeight + TOUCH && b.maxY > -TOUCH);
    const gunParts = boxes.filter((b) => b.minY < gunHigh && b.maxY > gunLow);
    const cols = Math.ceil(map.board.width / BUCKET) + 2;
    return new NavGrid(
      cellSize,
      map.board,
      new RectIndex(bodyParts.map((b) => inflate(b, R + BODY_MARGIN)), cols),
      new RectIndex(bodyParts.map((b) => inflate(b, R)), cols),
      new RectIndex(gunParts.map((b) => inflate(b, GUN_HALF + GUN_MARGIN)), cols),
      R,
      player.muzzleOffset,
    );
  }

  /** Does a player's body fit at this position (its grid cell)? */
  walkable(p: Vec2): boolean {
    const i = this.indexOf(p);
    return i !== null && this.fits[i] === 1;
  }

  /** The center of the grid cell containing `p` (clamped to the board). */
  snapToPath(p: Vec2): Vec2 {
    const i = this.snapIndex(p);
    return { x: this.cx[i]!, y: this.cy[i]! };
  }

  /**
   * Waypoints from `from` to `to`: first one or two single-axis legs onto the grid (if
   * `from` isn't on a cell center), then the grid path's turn points and the goal — every
   * leg along one axis from the previous point. `facing` (optional) makes a first turn
   * cost like any other. An empty list means already there. A goal where a player can't
   * fit is replaced by the nearest place reachable from `from`; a goal where a player fits
   * but can't be reached returns null.
   */
  findPath(from: Vec2, to: Vec2, facing?: Direction): Vec2[] | null {
    const entry = this.entry(from, to);
    if (!entry) return null;
    const goalIndex = this.snapIndex(to);

    let target = goalIndex;
    if (!this.fits[goalIndex]) {
      const nearest = this.nearestFitting(goalIndex);
      if (nearest === null) return null;
      target = nearest;
    }
    const startHeading = facing ? DIRECTIONS.indexOf(facing) : 4;
    let result = this.search(entry.cell, startHeading, target, false);
    if (!result && !this.fits[goalIndex]) result = this.search(entry.cell, startHeading, target, true); // nearest reachable
    if (!result) return null;
    return straighten(from, [...entry.legs, ...result]);
  }

  // ---- search ----

  /** A* from `start` to `goal`; with `nearestFallback`, ends at the reachable cell nearest `goal`. */
  private search(start: number, startHeading: number, goal: number, nearestFallback: boolean): Vec2[] | null {
    const gen = ++this.generation;
    const gx = this.cx[goal]!;
    const gy = this.cy[goal]!;
    const inv = 1 / this.cellSize;
    const h = (i: number) => (Math.abs(this.cx[i]! - gx) + Math.abs(this.cy[i]! - gy)) * inv;
    const heap = this.heap;
    heap.clear();
    const s0 = start * 5 + startHeading;
    this.g[s0] = 0;
    this.seen[s0] = gen;
    this.came[s0] = -1;
    heap.push(s0, nearestFallback ? 0 : h(start));
    let found = -1;
    let best = s0;
    let bestDist = Infinity;
    let expansions = 0;

    while (heap.size > 0 && expansions < MAX_EXPANSIONS) {
      const s = heap.pop();
      if (this.done[s] === gen) continue;
      this.done[s] = gen;
      expansions++;
      const cell = (s / 5) | 0;
      const heading = s % 5;
      if (cell === goal) {
        found = s;
        break;
      }
      if (nearestFallback) {
        const d = Math.hypot(this.cx[cell]! - gx, this.cy[cell]! - gy);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      for (let d = 0; d < 4; d++) {
        if (!this.step[cell * 4 + d]) continue;
        const next = this.neighbor(cell, DIRECTIONS[d]!)!;
        const ns = next * 5 + d;
        const cost = this.g[s]! + 1 + (heading !== 4 && heading !== d ? TURN_PENALTY : 0);
        if (this.seen[ns] !== gen || cost < this.g[ns]!) {
          this.seen[ns] = gen;
          this.g[ns] = cost;
          this.came[ns] = s;
          heap.push(ns, nearestFallback ? cost : cost + h(next));
        }
      }
    }
    if (found < 0) {
      if (!nearestFallback) return null;
      found = best;
    }
    return this.waypoints(found, gen);
  }

  private waypoints(end: number, gen: number): Vec2[] {
    const cells: { cell: number; heading: number }[] = [];
    for (let s = end; s >= 0 && this.seen[s] === gen; s = this.came[s]!) cells.push({ cell: (s / 5) | 0, heading: s % 5 });
    cells.reverse();
    const out: Vec2[] = [];
    for (let k = 1; k < cells.length; k++) {
      const last = k === cells.length - 1;
      if (last || cells[k + 1]!.heading !== cells[k]!.heading) out.push({ x: this.cx[cells[k]!.cell]!, y: this.cy[cells[k]!.cell]! });
    }
    return out;
  }

  // ---- getting onto the grid ----

  /** The nearest walkable cell `from` can reach in at most two exact single-axis legs. */
  private entry(from: Vec2, to: Vec2): { cell: number; legs: Vec2[] } | null {
    const home = this.snapIndex(from);
    const hc = home % this.cols;
    const hr = (home / this.cols) | 0;
    for (const radius of [1, 2]) {
      const found: { cell: number; legs: Vec2[]; cost: number }[] = [];
      for (let r = hr - radius; r <= hr + radius; r++) {
        for (let c = hc - radius; c <= hc + radius; c++) {
          if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue;
          const cell = r * this.cols + c;
          if (!this.fits[cell]) continue;
          const center = { x: this.cx[cell]!, y: this.cy[cell]! };
          if (same(center, from)) return { cell, legs: [] };
          for (const corner of [
            { x: center.x, y: from.y },
            { x: from.x, y: center.y },
          ]) {
            if (!this.legClear(from, corner) || !this.legClear(corner, center)) continue;
            const legs = same(corner, from) || same(corner, center) ? [center] : [corner, center];
            // shortest overall, preferring a last leg along the main way to the goal (no extra turn)
            const last = legs.length === 1 ? from : legs[0]!;
            const lastAlongX = Math.abs(last.y - center.y) < 1e-9;
            const mainX = Math.abs(to.x - center.x) >= Math.abs(to.y - center.y);
            const cost = Math.abs(center.x - from.x) + Math.abs(center.y - from.y) + Math.abs(to.x - center.x) + Math.abs(to.y - center.y) + (lastAlongX === mainX ? 0 : 0.01);
            found.push({ cell, legs, cost });
          }
        }
      }
      if (found.length > 0) {
        const best = found.reduce((a, b) => (b.cost < a.cost ? b : a));
        return { cell: best.cell, legs: best.legs };
      }
    }
    // Nothing reachable exactly (e.g. from outside the board): head for the nearest cell anyway.
    const cell = this.nearestFitting(home);
    if (cell === null) return null;
    const center = { x: this.cx[cell]!, y: this.cy[cell]! };
    return { cell, legs: [{ x: center.x, y: from.y }, center] };
  }

  /** Can a player move straight from p to q (one axis): the body clear all along, the gun clear when turned and while moving? */
  private legClear(p: Vec2, q: Vec2): boolean {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.abs(dx) + Math.abs(dy);
    if (len < 1e-9) return true;
    const v = { x: Math.sign(dx), y: Math.sign(dy) };
    for (let t = SAMPLE; t <= len + 1e-9; t += SAMPLE) {
      if (this.bodyBlocked(p.x + v.x * Math.min(t, len), p.y + v.y * Math.min(t, len), this.bodyExact, this.radius)) return false;
    }
    for (let t = 0; t <= len + 1e-9; t += SAMPLE) {
      const a = this.muzzleOffset + Math.min(t, len);
      if (this.gunBlocked(p.x + v.x * a, p.y + v.y * a)) return false;
    }
    return true;
  }

  // ---- predicates and indexing ----

  private bodyBlocked(x: number, z: number, index: RectIndex, reach: number): boolean {
    return x < reach || z < reach || x > this.board.width - reach || z > this.board.height - reach || index.hits(x, z);
  }

  private gunBlocked(x: number, z: number): boolean {
    return x < 0 || z < 0 || x > this.board.width || z > this.board.height || this.gun.hits(x, z);
  }

  private nearestFitting(i: number): number | null {
    const c0 = i % this.cols;
    const r0 = (i / this.cols) | 0;
    const maxRing = Math.max(this.cols, this.rows);
    for (let ring = 0; ring <= maxRing; ring++) {
      let best: number | null = null;
      let bestD = Infinity;
      for (let r = r0 - ring; r <= r0 + ring; r++) {
        for (let c = c0 - ring; c <= c0 + ring; c++) {
          if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== ring) continue;
          if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue;
          const j = r * this.cols + c;
          if (!this.fits[j]) continue;
          const d = Math.hypot(c - c0, r - r0);
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
      }
      if (best !== null) return best;
    }
    return null;
  }

  private snapIndex(p: Vec2): number {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(p.x / this.cellSize)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(p.y / this.cellSize)));
    return r * this.cols + c;
  }

  private indexOf(p: Vec2): number | null {
    const c = Math.floor(p.x / this.cellSize);
    const r = Math.floor(p.y / this.cellSize);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return null;
    return r * this.cols + c;
  }

  private neighbor(i: number, dir: Direction): number | null {
    const c = i % this.cols;
    const r = (i / this.cols) | 0;
    const v = DIR_VECTOR[dir];
    const nc = c + v.x;
    const nr = r + v.y;
    if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) return null;
    return nr * this.cols + nc;
  }
}

function same(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
}

/** Drops repeated points and points in the middle of a straight run (the entry leg onto
 * the grid often continues straight into the first grid run). */
function straighten(from: Vec2, points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  let prev = from;
  for (const p of points) {
    if (same(p, prev)) continue;
    const before = out.length > 0 ? (out.length > 1 ? out[out.length - 2]! : from) : null;
    if (before) {
      const mid = out[out.length - 1]!;
      const alongX = Math.abs(before.y - mid.y) < 1e-9 && Math.abs(mid.y - p.y) < 1e-9;
      const alongY = Math.abs(before.x - mid.x) < 1e-9 && Math.abs(mid.x - p.x) < 1e-9;
      const onward = (p.x - mid.x) * (mid.x - before.x) + (p.y - mid.y) * (mid.y - before.y) >= 0;
      if ((alongX || alongY) && onward) out.pop();
    }
    out.push(p);
    prev = p;
  }
  return out;
}

/** A small binary min-heap of (item, priority) for A*, reused between searches. */
class MinHeap {
  private items: number[] = [];
  private prios: number[] = [];

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
    this.prios.length = 0;
  }

  push(item: number, prio: number): void {
    this.items.push(item);
    this.prios.push(prio);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prios[parent]! <= this.prios[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0]!;
    const lastItem = this.items.pop()!;
    const lastPrio = this.prios.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.prios[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.prios[l]! < this.prios[m]!) m = l;
        if (r < this.items.length && this.prios[r]! < this.prios[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b]!, this.items[a]!];
    [this.prios[a], this.prios[b]] = [this.prios[b]!, this.prios[a]!];
  }
}
