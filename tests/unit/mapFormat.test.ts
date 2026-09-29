// M0 task 3: the map loader/validator — the single entry point for every map (built-in,
// a saved preset, an imported file, one received by the server). Anything invalid is
// rejected with messages naming what is wrong; valid maps come back normalized.

import { beforeAll, describe, expect, it } from 'vitest';
import { GameApi } from '../../src/api';
import { ensureRapierReady } from '../../src/physics/rapier';
import { MAP_LIMITS, parseMap, serializeMap } from '../../src/sim/mapFormat';
import { ARCH_HEIGHT } from '../../src/geometry/obstacleGeometry';
import { Room } from '../../src/session/room';
import type { ServerMessage } from '../../src/session/protocol';
import type { MapDef } from '../../src/sim';
import { BUILT_IN_MAPS } from '../../src/session/maps';
import { DEFAULT_MAP } from '../../src/sim';

beforeAll(async () => {
  await ensureRapierReady();
});

function withObstacle(o: unknown) {
  return { version: 1, board: { width: 40, height: 40 }, obstacles: [o] };
}

function errorsOf(raw: unknown): string[] {
  const r = parseMap(raw);
  return r.ok ? [] : r.errors;
}

describe('parseMap: valid maps', () => {
  it('accepts every built-in map unchanged', () => {
    for (const { map } of BUILT_IN_MAPS) expect(parseMap(map)).toEqual({ ok: true, map });
  });

  it('round-trips: serialize then parse gives the same map', () => {
    const r = parseMap(JSON.parse(JSON.stringify(serializeMap(DEFAULT_MAP))));
    expect(r).toEqual({ ok: true, map: DEFAULT_MAP });
  });

  it('defaults a missing axis to "y" for arches and donuts', () => {
    const r = parseMap({
      version: 1,
      board: { width: 40, height: 40 },
      obstacles: [
        { id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 6, d: 1, doorWidth: 2, doorHeight: 2 } },
        { id: 'd', type: 'donut', pos: { x: 10, y: 10 }, params: { w: 5, d: 1, holeRadius: 1 } },
      ],
    });
    expect(r.ok && r.map.obstacles.map((o) => (o.params as { axis: string }).axis)).toEqual(['y', 'y']);
  });

  it('strips unknown fields', () => {
    const r = parseMap({ version: 1, board: { width: 40, height: 40, color: 'red' }, obstacles: [], author: 'x' });
    expect(r).toEqual({ ok: true, map: { version: 1, board: { width: 40, height: 40 }, obstacles: [] } });
    const o = parseMap(withObstacle({ id: 'c', type: 'cube', pos: { x: 5, y: 5 }, params: { w: 1, d: 1, h: 1, glow: true }, extra: 1 }));
    expect(o.ok && o.map.obstacles[0]).toEqual({ id: 'c', type: 'cube', pos: { x: 5, y: 5 }, params: { w: 1, d: 1, h: 1 } });
  });
});

describe('parseMap: rejections', () => {
  it('rejects anything that is not a version-1 map object', () => {
    for (const raw of [null, 'map', [], {}, { version: 2, board: { width: 40, height: 40 }, obstacles: [] }]) {
      expect(parseMap(raw).ok).toBe(false);
    }
  });

  it('rejects a board outside the size limits', () => {
    expect(errorsOf({ version: 1, board: { width: MAP_LIMITS.board.min - 1, height: 40 }, obstacles: [] })).not.toEqual([]);
    expect(errorsOf({ version: 1, board: { width: 40, height: MAP_LIMITS.board.max + 1 }, obstacles: [] })).not.toEqual([]);
    expect(errorsOf({ version: 1, board: { width: Number.NaN, height: 40 }, obstacles: [] })).not.toEqual([]);
  });

  it('rejects an unknown type, non-positive or non-finite sizes, and names the obstacle', () => {
    expect(errorsOf(withObstacle({ id: 'x1', type: 'pyramid', pos: { x: 5, y: 5 }, params: {} }))[0]).toMatch(/x1/);
    expect(errorsOf(withObstacle({ id: 'c1', type: 'cube', pos: { x: 5, y: 5 }, params: { w: 0, d: 1, h: 1 } }))[0]).toMatch(/c1/);
    expect(errorsOf(withObstacle({ id: 'c2', type: 'cube', pos: { x: 5, y: 5 }, params: { w: 1, d: 1, h: Infinity } }))).not.toEqual([]);
    expect(errorsOf(withObstacle({ id: 'k1', type: 'cone', pos: { x: 5, y: 5 }, params: { radius: -1, height: 2 } }))).not.toEqual([]);
    expect(errorsOf(withObstacle({ id: 'c3', type: 'cube', pos: { x: 'a', y: 5 }, params: { w: 1, d: 1, h: 1 } }))).not.toEqual([]);
  });

  it('rejects an obstacle not fully inside the board', () => {
    expect(errorsOf(withObstacle({ id: 'edge', type: 'cube', pos: { x: 39.5, y: 20 }, params: { w: 2, d: 2, h: 1 } }))[0]).toMatch(/edge/);
    expect(errorsOf(withObstacle({ id: 'cone', type: 'cone', pos: { x: 1, y: 20 }, params: { radius: 2, height: 2 } }))).not.toEqual([]);
  });

  it('rejects a donut whose hole is not smaller than the wheel (no rim left)', () => {
    // axis y: the wheel's diameter is w (5), so hubHeight is 2.5
    expect(errorsOf(withObstacle({ id: 'd', type: 'donut', pos: { x: 20, y: 20 }, params: { w: 5, d: 1, holeRadius: 2.5, axis: 'y' } }))).not.toEqual([]);
    expect(errorsOf(withObstacle({ id: 'd', type: 'donut', pos: { x: 20, y: 20 }, params: { w: 5, d: 1, holeRadius: 2.4, axis: 'y' } }))).toEqual([]);
    // axis x: the diameter is d
    expect(errorsOf(withObstacle({ id: 'd', type: 'donut', pos: { x: 20, y: 20 }, params: { w: 1, d: 5, holeRadius: 2.6, axis: 'x' } }))).not.toEqual([]);
  });

  it('rejects an arch whose door is not narrower than its wall', () => {
    expect(errorsOf(withObstacle({ id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 6, d: 1, doorWidth: 6, doorHeight: 2, axis: 'y' } }))).not.toEqual([]);
    expect(errorsOf(withObstacle({ id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 1, d: 6, doorWidth: 7, doorHeight: 2, axis: 'x' } }))).not.toEqual([]);
    expect(errorsOf(withObstacle({ id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 6, d: 1, doorWidth: 2, doorHeight: 2, axis: 'z' } }))).not.toEqual([]);
  });

  it('rejects duplicate ids and too many obstacles', () => {
    const cube = (id: string, x: number) => ({ id, type: 'cube', pos: { x, y: 5 }, params: { w: 1, d: 1, h: 1 } });
    // Test change, with justification (review): /a/ matched almost any message.
    expect(errorsOf({ version: 1, board: { width: 40, height: 40 }, obstacles: [cube('a', 5), cube('a', 10)] })).toContain('obstacle "a": duplicate id');
    const many = Array.from({ length: MAP_LIMITS.maxObstacles + 1 }, (_, i) => cube(`c${i}`, 5));
    expect(errorsOf({ version: 1, board: { width: 40, height: 40 }, obstacles: many })).not.toEqual([]);
  });

  it('reports every problem, not only the first', () => {
    const errs = errorsOf({
      version: 1,
      board: { width: 40, height: 40 },
      obstacles: [
        { id: 'a', type: 'cube', pos: { x: 5, y: 5 }, params: { w: 0, d: 1, h: 1 } },
        { id: 'b', type: 'cone', pos: { x: 0, y: 0 }, params: { radius: 2, height: 2 } },
      ],
    });
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('parseMap: review follow-ups', () => {
  const ok = (o: unknown) => errorsOf(withObstacle(o));

  it('caps every height, including a donut wheel (its height is its diameter) and an arch door (the arch is ARCH_HEIGHT tall)', () => {
    expect(ok({ id: 'c', type: 'cube', pos: { x: 20, y: 20 }, params: { w: 1, d: 1, h: MAP_LIMITS.maxObstacleHeight + 1 } })).not.toEqual([]);
    expect(ok({ id: 'k', type: 'cone', pos: { x: 20, y: 20 }, params: { radius: 1, height: MAP_LIMITS.maxObstacleHeight + 1 } })).not.toEqual([]);
    const tallWheel = { version: 1, board: { width: 200, height: 200 }, obstacles: [{ id: 'd', type: 'donut', pos: { x: 100, y: 100 }, params: { w: 38, d: 1, holeRadius: 5, axis: 'y' } }] };
    expect(errorsOf(tallWheel).join()).toMatch(/"d"/);
    expect(ok({ id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 6, d: 1, doorWidth: 2, doorHeight: ARCH_HEIGHT + 0.1, axis: 'y' } })).not.toEqual([]);
    expect(ok({ id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 6, d: 1, doorWidth: 2, doorHeight: ARCH_HEIGHT, axis: 'y' } })).toEqual([]);
  });

  it('refuses sizes too small to see: every size, arch pillar and donut rim at least MIN_SIZE', () => {
    const m = MAP_LIMITS.minSize;
    expect(ok({ id: 'c', type: 'cube', pos: { x: 20, y: 20 }, params: { w: 1e-9, d: 1, h: 1 } })).not.toEqual([]);
    expect(ok({ id: 'c', type: 'cube', pos: { x: 20, y: 20 }, params: { w: m, d: m, h: m } })).toEqual([]);
    // pillars are (w - doorWidth) / 2 wide
    expect(ok({ id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 6, d: 1, doorWidth: 6 - m, doorHeight: 2, axis: 'y' } })).not.toEqual([]);
    expect(ok({ id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 6, d: 1, doorWidth: 6 - 2 * m, doorHeight: 2, axis: 'y' } })).toEqual([]);
    // the rim is hubHeight - holeRadius thick (hubHeight 2.5 here)
    expect(ok({ id: 'd', type: 'donut', pos: { x: 20, y: 20 }, params: { w: 5, d: 1, holeRadius: 2.5 - m / 2, axis: 'y' } })).not.toEqual([]);
    expect(ok({ id: 'd', type: 'donut', pos: { x: 20, y: 20 }, params: { w: 5, d: 1, holeRadius: 2.5 - m, axis: 'y' } })).toEqual([]);
  });

  it('ids: required, 1–64 characters, no control or format characters', () => {
    const cube = (id: unknown) => ({ id, type: 'cube', pos: { x: 20, y: 20 }, params: { w: 1, d: 1, h: 1 } });
    expect(ok(cube(''))).not.toEqual([]);
    expect(ok(cube('x'.repeat(65)))).not.toEqual([]);
    expect(ok(cube('😀'.repeat(64)))).toEqual([]); // counted in characters
    expect(ok(cube(undefined))).not.toEqual([]);
    expect(ok(cube('bad\u202Eid'))).not.toEqual([]);
  });

  it('params must be an object; a donut axis must be x or y', () => {
    expect(ok({ id: 'c', type: 'cube', pos: { x: 20, y: 20 }, params: 5 })).not.toEqual([]);
    expect(ok({ id: 'd', type: 'donut', pos: { x: 20, y: 20 }, params: { w: 5, d: 1, holeRadius: 1, axis: 'z' } })).not.toEqual([]);
  });

  it('reads only own fields (an inherited param does not count)', () => {
    const params = Object.create({ w: 1, d: 1, h: 1 }) as object;
    expect(ok({ id: 'c', type: 'cube', pos: { x: 20, y: 20 }, params })).not.toEqual([]);
  });

  it('reports problems it used to hide: a duplicate of an invalid obstacle, and obstacles past the count limit', () => {
    const errs = errorsOf({
      version: 1,
      board: { width: 40, height: 40 },
      obstacles: [
        { id: 'a', type: 'cube', pos: { x: 5, y: 5 }, params: { w: -1, d: 1, h: 1 } },
        { id: 'a', type: 'cube', pos: { x: 10, y: 5 }, params: { w: 1, d: 1, h: 1 } },
      ],
    });
    expect(errs).toContain('obstacle "a": duplicate id');
    const many = Array.from({ length: MAP_LIMITS.maxObstacles + 1 }, (_, i) => ({ id: `c${i}`, type: 'cube', pos: { x: 5, y: 5 }, params: { w: i === 0 ? -1 : 1, d: 1, h: 1 } }));
    const manyErrs = errorsOf({ version: 1, board: { width: 40, height: 40 }, obstacles: many });
    expect(manyErrs.some((e) => e.includes('c0'))).toBe(true);
    expect(manyErrs.some((e) => e.includes(`${MAP_LIMITS.maxObstacles}`))).toBe(true);
  });

  it('serializeMap writes a complete map (explicit axis, only known fields) and refuses an invalid one', () => {
    const noAxis = {
      version: 1,
      board: { width: 40, height: 40 },
      obstacles: [{ id: 'a', type: 'arch', pos: { x: 20, y: 20 }, params: { w: 6, d: 1, doorWidth: 2, doorHeight: 2 }, extra: 1 }],
    } as unknown as MapDef;
    const out = serializeMap(noAxis) as { obstacles: { params: { axis: string } }[] };
    expect(out.obstacles[0]!.params.axis).toBe('y');
    expect(JSON.stringify(out)).not.toContain('extra');
    expect(() => serializeMap({ ...DEFAULT_MAP, version: 2 } as unknown as MapDef)).toThrow();
  });
});

describe('every map enters a game through the loader', () => {
  it('GameApi.start refuses an invalid map with the reasons', async () => {
    const api = new GameApi();
    api.setRoster([{ name: 'A' }]);
    await expect(api.start({ practice: true }, withObstacle({ id: 'bad', type: 'cube', pos: { x: 5, y: 5 }, params: { w: -1, d: 1, h: 1 } }) as never)).rejects.toThrow(/bad/);
    await expect(api.start({ practice: true }, DEFAULT_MAP)).resolves.toBeUndefined();
  });
});

describe('games are created only from what the loader approved (review follow-ups)', () => {
  it('the board always comes from the map: a config board override is refused', async () => {
    const api = new GameApi();
    api.setRoster([{ name: 'A' }]);
    await expect(api.start({ practice: true, board: { width: 200, height: 200 } }, DEFAULT_MAP)).rejects.toThrow(/board/);
  });

  it('GameApi refuses a roster of more than 8 players', async () => {
    const api = new GameApi();
    api.setRoster(Array.from({ length: 9 }, (_, i) => ({ name: `P${i}` })));
    await expect(api.start({}, DEFAULT_MAP)).rejects.toThrow(/8/);
  });

  it('a Room with an invalid catalog map reports the failed start to its owner', async () => {
    const bad = { version: 1, board: { width: 40, height: 40 }, obstacles: [{ id: 'x', type: 'cube', pos: { x: 5, y: 5 }, params: { w: -1, d: 1, h: 1 } }] } as unknown as MapDef;
    const room = new Room({ code: 'ABCDE', maps: [{ id: 'bad', name: 'Bad', map: bad }] });
    const inbox: ServerMessage[] = [];
    const a = room.join('Ann', (m) => inbox.push(m));
    const b = room.join('Bo', () => {});
    if (!a.ok || !b.ok) throw new Error('join failed');
    await room.handle(b.playerId, { type: 'setReady', ready: true });
    await room.handle(a.playerId, { type: 'startMatch' });
    expect(room.phase).toBe('lobby');
    expect(inbox.some((m) => m.type === 'error' && /x/.test(m.message))).toBe(true);
  });

  it('when a small board forces fallback spawns, players still never overlap each other or an obstacle', async () => {
    const small: MapDef = { version: 1, board: { width: 10, height: 10 }, obstacles: [{ id: 'corner', type: 'cube', pos: { x: 1.5, y: 1.5 }, params: { w: 3, d: 3, h: 2 } }] };
    const api = new GameApi();
    api.setRoster(Array.from({ length: 8 }, (_, i) => ({ name: `P${i}` })));
    await api.start({}, small, { seed: 3 });
    const players = api.getState().players;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!.pos;
      expect(p.x < 0 || p.x > 3 + 0.5 || p.y < 0 || p.y > 3 + 0.5 || false).toBe(true); // outside the corner cube (+ radius)
      for (let j = i + 1; j < players.length; j++) {
        const q = players[j]!.pos;
        expect(Math.hypot(p.x - q.x, p.y - q.y), `${i} vs ${j}`).toBeGreaterThanOrEqual(1.0); // two radii
      }
    }
  });
});
