// Map loader and validator (spec §13): the single entry point for every map — built-in,
// a saved preset, an imported file, or one received by the server. Input is untrusted:
// only well-formed maps within the limits come back, normalized (defaults applied,
// unknown fields dropped, fresh objects); anything else yields every problem found,
// each naming its obstacle. GameApi.start runs every map through here.

import { ARCH_HEIGHT } from '../geometry/obstacleGeometry';
import type { ArchParams, ConeParams, CubeParams, DonutParams, MapDef, ObstacleDef, PrimitiveType, Vec2 } from './types';

export const MAP_LIMITS = {
  board: { min: 10, max: 200 },
  maxObstacles: 200,
  maxObstacleHeight: 20,
  /** Smallest size, arch pillar or donut rim: anything thinner is too small to see. */
  minSize: 0.1,
  maxIdLength: 64,
} as const;

const EPSILON = 1e-9; // tolerance for derived sizes (float subtraction)

export type ParseMapResult = { ok: true; map: MapDef } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Each field read exactly once, and only if it is the object's own property. */
function own(o: Obj, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseId(v: unknown): string | null {
  if (typeof v !== 'string' || /[\p{Cc}\p{Cf}]/u.test(v)) return null;
  const length = [...v].length; // characters, not UTF-16 code units
  return length >= 1 && length <= MAP_LIMITS.maxIdLength ? v : null;
}

const TYPES: readonly PrimitiveType[] = ['cube', 'cone', 'arch', 'donut'];

/** Horizontal extent of an obstacle, for the inside-the-board check. */
function halfExtents(o: ObstacleDef): Vec2 {
  if (o.type === 'cone') {
    const r = (o.params as ConeParams).radius;
    return { x: r, y: r };
  }
  const { w, d } = o.params as { w: number; d: number };
  return { x: w / 2, y: d / 2 };
}

function parseObstacle(raw: unknown, index: number, errors: string[]): ObstacleDef | null {
  if (!isObj(raw)) {
    errors.push(`obstacle #${index + 1}: not an object`);
    return null;
  }
  const id = parseId(own(raw, 'id'));
  const name = id !== null ? `obstacle "${id}"` : `obstacle #${index + 1}`;
  const problems: string[] = [];
  const fail = (msg: string) => problems.push(`${name}: ${msg}`);

  if (id === null) fail(`id must be 1–${MAP_LIMITS.maxIdLength} characters, with no control or formatting characters`);
  const rawType = own(raw, 'type');
  const type = TYPES.includes(rawType as PrimitiveType) ? (rawType as PrimitiveType) : null;
  if (type === null) fail(`unknown type ${JSON.stringify(rawType)} (expected ${TYPES.join(', ')})`);
  const rawPos = own(raw, 'pos');
  const px = isObj(rawPos) ? own(rawPos, 'x') : undefined;
  const py = isObj(rawPos) ? own(rawPos, 'y') : undefined;
  const pos = finite(px) && finite(py) ? { x: px, y: py } : null;
  if (pos === null) fail('pos must be { x, y } with finite numbers');
  const rawParams = own(raw, 'params');
  const p = isObj(rawParams) ? rawParams : null;
  if (p === null) fail('params must be an object');

  const size = (key: string, max = Infinity): number => {
    const v = p ? own(p, key) : undefined;
    if (!finite(v) || v < MAP_LIMITS.minSize || v > max) {
      fail(`${key} must be a number from ${MAP_LIMITS.minSize}${max < Infinity ? ` to ${max}` : ''}`);
      return 0;
    }
    return v;
  };
  const axisOf = (): 'x' | 'y' => {
    const a = (p ? own(p, 'axis') : undefined) ?? 'y';
    if (a !== 'x' && a !== 'y') {
      fail('axis must be "x" or "y"');
      return 'y';
    }
    return a;
  };

  let params: ObstacleDef['params'] | null = null;
  if (type !== null && p !== null) {
    const H = MAP_LIMITS.maxObstacleHeight;
    if (type === 'cube') {
      params = { w: size('w'), d: size('d'), h: size('h', H) } satisfies CubeParams;
    } else if (type === 'cone') {
      params = { radius: size('radius'), height: size('height', H) } satisfies ConeParams;
    } else if (type === 'arch') {
      // An arch is always ARCH_HEIGHT tall; a door that high has no lintel.
      const a: ArchParams = { w: size('w'), d: size('d'), doorWidth: size('doorWidth'), doorHeight: size('doorHeight', ARCH_HEIGHT), axis: axisOf() };
      const wall = a.axis === 'x' ? a.d : a.w; // the door is cut across the axis of travel
      if (a.doorWidth > 0 && wall > 0 && (wall - a.doorWidth) / 2 < MAP_LIMITS.minSize - EPSILON) {
        fail(`doorWidth (${a.doorWidth}) must leave pillars at least ${MAP_LIMITS.minSize} wide in a wall ${wall} long`);
      }
      params = a;
    } else {
      const dn: DonutParams = { w: size('w'), d: size('d'), holeRadius: size('holeRadius'), axis: axisOf() };
      const diameter = dn.axis === 'x' ? dn.d : dn.w; // the wheel stands on the ground: this is its height
      if (diameter > H) fail(`the wheel's diameter (${diameter}) is its height, which must be at most ${H}`);
      const hub = diameter / 2;
      if (dn.holeRadius > 0 && hub > 0 && hub - dn.holeRadius < MAP_LIMITS.minSize - EPSILON) {
        fail(`holeRadius (${dn.holeRadius}) must leave a rim at least ${MAP_LIMITS.minSize} thick on a wheel of radius ${hub}`);
      }
      params = dn;
    }
  }

  errors.push(...problems);
  if (problems.length > 0 || id === null || type === null || pos === null || params === null) return null;
  return { id, type, pos, params };
}

export function parseMap(raw: unknown): ParseMapResult {
  if (!isObj(raw)) return { ok: false, errors: ['a map must be an object'] };
  const version = own(raw, 'version');
  if (version !== 1) return { ok: false, errors: [`unsupported map version ${JSON.stringify(version)} (expected 1)`] };
  const errors: string[] = [];

  const { min, max } = MAP_LIMITS.board;
  const b = own(raw, 'board');
  const bw = isObj(b) ? own(b, 'width') : undefined;
  const bh = isObj(b) ? own(b, 'height') : undefined;
  const inRange = (v: unknown): v is number => finite(v) && v >= min && v <= max;
  const board = inRange(bw) && inRange(bh) ? { width: bw, height: bh } : null;
  if (!board) errors.push(`board must have width and height from ${min} to ${max}`);

  const list = own(raw, 'obstacles');
  if (!Array.isArray(list)) return { ok: false, errors: [...errors, 'obstacles must be a list'] };
  if (list.length > MAP_LIMITS.maxObstacles) errors.push(`at most ${MAP_LIMITS.maxObstacles} obstacles (got ${list.length})`);

  // Duplicate ids are found from the raw ids, so a duplicate of an invalid obstacle counts.
  const seen = new Set<string>();
  const bounds = board ?? { width: max, height: max };
  const obstacles: ObstacleDef[] = [];
  list.forEach((o, i) => {
    const rawId = isObj(o) ? own(o, 'id') : undefined;
    if (typeof rawId === 'string') {
      if (seen.has(rawId)) errors.push(`obstacle "${rawId}": duplicate id`);
      seen.add(rawId);
    }
    const parsed = parseObstacle(o, i, errors);
    if (!parsed) return;
    const h = halfExtents(parsed);
    const inside = parsed.pos.x - h.x >= 0 && parsed.pos.x + h.x <= bounds.width && parsed.pos.y - h.y >= 0 && parsed.pos.y + h.y <= bounds.height;
    if (!inside) errors.push(`obstacle "${parsed.id}": must lie fully inside the ${bounds.width}×${bounds.height} board`);
    obstacles.push(parsed);
  });

  if (errors.length > 0 || !board) return { ok: false, errors };
  return { ok: true, map: { version: 1, board, obstacles } };
}

/** The JSON form of a map (spec §13): validated, every field explicit (each `axis`
 * included), unknown fields dropped. Throws on a map the loader would refuse. */
export function serializeMap(map: MapDef): unknown {
  const parsed = parseMap(map);
  if (!parsed.ok) throw new Error(`serializeMap: invalid map: ${parsed.errors.join('; ')}`);
  return JSON.parse(JSON.stringify(parsed.map));
}
