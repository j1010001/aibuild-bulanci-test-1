// M0 task 3: the map loader/validator — the single entry point for every map (built-in,
// a saved preset, an imported file, one received by the server). Anything invalid is
// rejected with messages naming what is wrong; valid maps come back normalized.

import { beforeAll, describe, expect, it } from 'vitest';
import { GameApi } from '../../src/api';
import { ensureRapierReady } from '../../src/physics/rapier';
import { MAP_LIMITS, parseMap, serializeMap } from '../../src/sim/mapFormat';
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
    expect(errorsOf({ version: 1, board: { width: 40, height: 40 }, obstacles: [cube('a', 5), cube('a', 10)] })[0]).toMatch(/a/);
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

describe('every map enters a game through the loader', () => {
  it('GameApi.start refuses an invalid map with the reasons', async () => {
    const api = new GameApi();
    api.setRoster([{ name: 'A' }]);
    await expect(api.start({ practice: true }, withObstacle({ id: 'bad', type: 'cube', pos: { x: 5, y: 5 }, params: { w: -1, d: 1, h: 1 } }) as never)).rejects.toThrow(/bad/);
    await expect(api.start({ practice: true }, DEFAULT_MAP)).resolves.toBeUndefined();
  });
});
