// Bot navigation: a grid of where a player fits, and A* pathfinding over it. Planned from
// the same obstacle geometry the physics world collides with (buildObstacleGeometry), and
// for the whole player — the body (at ground to playerHeight) and the gun, which reaches
// muzzleOffset ahead at bullet height. A step from one cell to the next in a direction is
// valid only if the body fits in the next cell and the gun fits when turned that way here,
// along the move, and at the end — so a planned path is one the real physics lets a
// player walk (tests/unit/navigation.test.ts follows paths with the real engine).
//
// Conservative on purpose: footprints are bounding boxes (cones and cylinders as squares,
// the donut as its whole wheel). Other players aren't in the grid; bots handle them.

import { buildObstacleGeometry, type PartSpec } from '../../geometry/obstacleGeometry';
import type { PlayerShapeConfig } from '../../geometry/playerGeometry';
import type { Direction, MapDef, Vec2 } from '../../sim';
import { DIR_VECTOR, DIRECTIONS } from '../../sim';

type Box = { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };

const BODY_MARGIN = 0.05; // extra clearance for the body beyond its radius
const GUN_HALF = 0.04; // the barrel's half-thickness (playerGeometry BARREL / 2)
const GUN_MARGIN = 0.05;
const TURN_PENALTY = 0.3; // prefer straight runs: fewer turns, fewer input changes

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

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly bodyFits: Uint8Array;
  /** step[(cell * 4) + dirIndex] = 1 if a player in `cell` can turn to and move one cell that way. */
  private readonly step: Uint8Array;

  private constructor(
    readonly cellSize: number,
    private readonly board: { width: number; height: number },
    private readonly bodyBlocked: (x: number, z: number) => boolean,
    private readonly gunBlocked: (x: number, z: number) => boolean,
    private readonly muzzleOffset: number,
  ) {
    this.cols = Math.floor(board.width / cellSize);
    this.rows = Math.floor(board.height / cellSize);
    const n = this.cols * this.rows;
    this.bodyFits = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const p = this.centerOfIndex(i);
      this.bodyFits[i] = this.bodyBlocked(p.x, p.y) ? 0 : 1;
    }
    this.step = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      if (!this.bodyFits[i]) continue;
      DIRECTIONS.forEach((dir, d) => {
        const j = this.neighbor(i, dir);
        if (j === null || !this.bodyFits[j]) return;
        const v = DIR_VECTOR[dir];
        const from = this.centerOfIndex(i);
        const m = this.muzzleOffset;
        // the gun turned this way here, halfway along the move, and at the end
        const clear = [m, m + this.cellSize / 2, m + this.cellSize].every((ahead) => !this.gunBlocked(from.x + v.x * ahead, from.y + v.y * ahead));
        this.step[i * 4 + d] = clear ? 1 : 0;
      });
    }
  }

  static build(map: MapDef, player: PlayerShapeConfig, cellSize = 0.5): NavGrid {
    const boxes = map.obstacles.flatMap((o) => buildObstacleGeometry(o).parts.map(partBox));
    const { playerRadius: R, playerHeight, bulletHeight } = player;
    const bodyReach = R + BODY_MARGIN;
    const gunReach = GUN_HALF + GUN_MARGIN;
    const gunLow = bulletHeight - GUN_HALF - 0.01;
    const gunHigh = bulletHeight + GUN_HALF + 0.01;
    const { width, height } = map.board;

    const bodyBlocked = (x: number, z: number): boolean =>
      x < bodyReach ||
      z < bodyReach ||
      x > width - bodyReach ||
      z > height - bodyReach ||
      boxes.some((b) => b.minY < playerHeight && b.maxY > 0 && x > b.minX - bodyReach && x < b.maxX + bodyReach && z > b.minZ - bodyReach && z < b.maxZ + bodyReach);
    const gunBlocked = (x: number, z: number): boolean =>
      x < 0 ||
      z < 0 ||
      x > width ||
      z > height ||
      boxes.some((b) => b.minY < gunHigh && b.maxY > gunLow && x > b.minX - gunReach && x < b.maxX + gunReach && z > b.minZ - gunReach && z < b.maxZ + gunReach);

    return new NavGrid(cellSize, map.board, bodyBlocked, gunBlocked, player.muzzleOffset);
  }

  /** Does a player's body fit at this position (its grid cell)? */
  walkable(p: Vec2): boolean {
    const i = this.indexOf(p);
    return i !== null && this.bodyFits[i] === 1;
  }

  /** The center of the grid cell containing `p` — where paths start and end. */
  snapToPath(p: Vec2): Vec2 {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(p.x / this.cellSize)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(p.y / this.cellSize)));
    return this.centerOfIndex(r * this.cols + c);
  }

  /**
   * Waypoints (the turn points, then the goal) from `from` to `to`, in axis-aligned runs.
   * A goal where a player can't fit is replaced by the nearest cell reachable from `from`;
   * a goal where a player fits but can't be reached returns null.
   */
  findPath(from: Vec2, to: Vec2): Vec2[] | null {
    const start = this.nearestWalkable(this.snapIndex(from));
    const goalIndex = this.snapIndex(to);
    if (start === null) return null;
    const goalFits = this.bodyFits[goalIndex] === 1;
    const goal = this.centerOfIndex(goalIndex);

    // A* over (cell, heading). Heading 4 = "not moving yet" (at the start).
    const n = this.cols * this.rows;
    const states = n * 5;
    const g = new Float64Array(states).fill(Infinity);
    const came = new Int32Array(states).fill(-1);
    const closed = new Uint8Array(states);
    const h = (i: number) => {
      const p = this.centerOfIndex(i);
      return (Math.abs(p.x - goal.x) + Math.abs(p.y - goal.y)) / this.cellSize;
    };
    const open = new MinHeap();
    const s0 = start * 5 + 4;
    g[s0] = 0;
    open.push(s0, h(start));
    let found = -1;
    let bestReached = start;
    let bestDist = Infinity;

    while (open.size > 0) {
      const s = open.pop();
      if (closed[s]) continue;
      closed[s] = 1;
      const cell = Math.floor(s / 5);
      const heading = s % 5;
      const p = this.centerOfIndex(cell);
      const dist = Math.hypot(p.x - goal.x, p.y - goal.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestReached = cell;
      }
      if (cell === goalIndex) {
        found = s;
        break;
      }
      for (let d = 0; d < 4; d++) {
        if (!this.step[cell * 4 + d]) continue;
        const next = this.neighbor(cell, DIRECTIONS[d]!)!;
        const ns = next * 5 + d;
        const cost = g[s]! + 1 + (heading !== 4 && heading !== d ? TURN_PENALTY : 0);
        if (cost < g[ns]!) {
          g[ns] = cost;
          came[ns] = s;
          open.push(ns, cost + h(next));
        }
      }
    }

    if (found < 0) {
      if (goalFits) return null; // a place a player fits, but not reachable from here
      // Snap: the reachable cell nearest the goal (its best-cost state).
      let best = -1;
      for (let hd = 0; hd < 5; hd++) {
        const st = bestReached * 5 + hd;
        if (closed[st] && (best < 0 || g[st]! < g[best]!)) best = st;
      }
      found = best;
    }
    return this.waypoints(found, came);
  }

  // ---- internals ----

  private waypoints(end: number, came: Int32Array): Vec2[] {
    const cells: { cell: number; heading: number }[] = [];
    for (let s = end; s >= 0; s = came[s]!) cells.push({ cell: Math.floor(s / 5), heading: s % 5 });
    cells.reverse();
    const out: Vec2[] = [];
    for (let k = 1; k < cells.length; k++) {
      const last = k === cells.length - 1;
      if (last || cells[k + 1]!.heading !== cells[k]!.heading) out.push(this.centerOfIndex(cells[k]!.cell));
    }
    return out;
  }

  private nearestWalkable(i: number): number | null {
    if (this.bodyFits[i]) return i;
    const p = this.centerOfIndex(i);
    let best: number | null = null;
    let bestD = Infinity;
    for (let j = 0; j < this.bodyFits.length; j++) {
      if (!this.bodyFits[j]) continue;
      const q = this.centerOfIndex(j);
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    return best;
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

  private centerOfIndex(i: number): Vec2 {
    const c = i % this.cols;
    const r = Math.floor(i / this.cols);
    return { x: (c + 0.5) * this.cellSize, y: (r + 0.5) * this.cellSize };
  }

  private neighbor(i: number, dir: Direction): number | null {
    const c = i % this.cols;
    const r = Math.floor(i / this.cols);
    const v = DIR_VECTOR[dir];
    const nc = c + v.x;
    const nr = r + v.y;
    if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) return null;
    return nr * this.cols + nc;
  }
}

/** A small binary min-heap of (item, priority) for A*. */
class MinHeap {
  private items: number[] = [];
  private prios: number[] = [];

  get size(): number {
    return this.items.length;
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
