// Map loader and validator (spec §13): the single entry point for every map — built-in,
// a saved preset, an imported file, or one received by the server. Input is untrusted:
// only well-formed maps within the limits come back, normalized (defaults applied,
// unknown fields dropped); anything else yields every problem found, each naming its
// obstacle. GameApi.start runs every map through here before a game is created.

import type { ArchParams, ConeParams, CubeParams, DonutParams, MapDef, ObstacleDef, PrimitiveType, Vec2 } from './types';

export const MAP_LIMITS = {
  board: { min: 10, max: 200 },
  maxObstacles: 200,
  maxObstacleHeight: 20,
  maxIdLength: 64,
} as const;

export type ParseMapResult = { ok: true; map: MapDef } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
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
  const id = typeof raw.id === 'string' && raw.id.length >= 1 && raw.id.length <= MAP_LIMITS.maxIdLength ? raw.id : null;
  const name = id !== null ? `obstacle "${id}"` : `obstacle #${index + 1}`;
  const problems: string[] = [];
  const fail = (msg: string) => problems.push(`${name}: ${msg}`);

  if (id === null) fail(`id must be a string of 1–${MAP_LIMITS.maxIdLength} characters`);
  const type = TYPES.includes(raw.type as PrimitiveType) ? (raw.type as PrimitiveType) : null;
  if (type === null) fail(`unknown type ${JSON.stringify(raw.type)} (expected ${TYPES.join(', ')})`);
  const pos = isObj(raw.pos) && finite(raw.pos.x) && finite(raw.pos.y) ? { x: raw.pos.x, y: raw.pos.y } : null;
  if (pos === null) fail('pos must be { x, y } with finite numbers');
  const p = isObj(raw.params) ? raw.params : null;
  if (p === null) fail('params must be an object');

  const positive = (key: string, max = Infinity): number => {
    const v = p?.[key];
    if (!finite(v) || v <= 0 || v > max) {
      fail(`${key} must be a positive number${max < Infinity ? ` up to ${max}` : ''}`);
      return 0;
    }
    return v;
  };
  const axisOf = (): 'x' | 'y' => {
    const a = p?.axis ?? 'y';
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
      params = { w: positive('w'), d: positive('d'), h: positive('h', H) } satisfies CubeParams;
    } else if (type === 'cone') {
      params = { radius: positive('radius'), height: positive('height', H) } satisfies ConeParams;
    } else if (type === 'arch') {
      const a: ArchParams = { w: positive('w'), d: positive('d'), doorWidth: positive('doorWidth'), doorHeight: positive('doorHeight', H), axis: axisOf() };
      const wall = a.axis === 'x' ? a.d : a.w; // the door is cut across the axis of travel
      if (a.doorWidth > 0 && wall > 0 && a.doorWidth >= wall) fail(`doorWidth (${a.doorWidth}) must be less than the wall length (${wall})`);
      params = a;
    } else {
      const dn: DonutParams = { w: positive('w'), d: positive('d'), holeRadius: positive('holeRadius'), axis: axisOf() };
      const hub = (dn.axis === 'x' ? dn.d : dn.w) / 2; // the wheel's radius (spec §7)
      if (dn.holeRadius > 0 && hub > 0 && dn.holeRadius >= hub) fail(`holeRadius (${dn.holeRadius}) must be less than the wheel's radius (${hub})`);
      params = dn;
    }
  }

  errors.push(...problems);
  if (problems.length > 0 || id === null || type === null || pos === null || params === null) return null;
  return { id, type, pos, params };
}

export function parseMap(raw: unknown): ParseMapResult {
  if (!isObj(raw)) return { ok: false, errors: ['a map must be an object'] };
  if (raw.version !== 1) return { ok: false, errors: [`unsupported map version ${JSON.stringify(raw.version)} (expected 1)`] };
  const errors: string[] = [];

  const { min, max } = MAP_LIMITS.board;
  const b = isObj(raw.board) ? raw.board : null;
  const inRange = (v: unknown) => finite(v) && v >= min && v <= max;
  if (!b || !inRange(b.width) || !inRange(b.height)) errors.push(`board must have width and height from ${min} to ${max}`);
  const board = b && inRange(b.width) && inRange(b.height) ? { width: b.width as number, height: b.height as number } : null;

  if (!Array.isArray(raw.obstacles)) return { ok: false, errors: [...errors, 'obstacles must be a list'] };
  if (raw.obstacles.length > MAP_LIMITS.maxObstacles) {
    return { ok: false, errors: [...errors, `at most ${MAP_LIMITS.maxObstacles} obstacles (got ${raw.obstacles.length})`] };
  }

  const obstacles: ObstacleDef[] = [];
  const seen = new Set<string>();
  raw.obstacles.forEach((o, i) => {
    const parsed = parseObstacle(o, i, errors);
    if (!parsed) return;
    if (seen.has(parsed.id)) {
      errors.push(`obstacle "${parsed.id}": duplicate id`);
      return;
    }
    seen.add(parsed.id);
    if (board) {
      const h = halfExtents(parsed);
      const inside = parsed.pos.x - h.x >= 0 && parsed.pos.x + h.x <= board.width && parsed.pos.y - h.y >= 0 && parsed.pos.y + h.y <= board.height;
      if (!inside) errors.push(`obstacle "${parsed.id}": must lie fully inside the ${board.width}×${board.height} board`);
    }
    obstacles.push(parsed);
  });

  if (errors.length > 0 || !board) return { ok: false, errors };
  return { ok: true, map: { version: 1, board, obstacles } };
}

/** The JSON form of a map (spec §13) — every field explicit, including each `axis`. */
export function serializeMap(map: MapDef): unknown {
  return JSON.parse(JSON.stringify(map));
}
