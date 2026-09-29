// A hand-authored default map exercising all four primitives and every emergent case
// from spec §7 (low wall, low slot, shootable donut, blocked donut, both arch axes).
// The built-in "Arena" map (src/session/maps.ts); custom maps come from the level editor (M3).
//
// Heights are chosen relative to bulletHeight (0.9) and playerHeight (1.2) — see
// state.ts's DEFAULT_CONFIG comment for why playerHeight must exceed bulletHeight, and
// why that in turn means a real "low slot" (opposite of the old, pre-real-physics "low
// tunnel": a gap low enough for a bullet, too low for a full-height player) needs a
// doorHeight strictly between the two.

import type { MapDef } from './types';

export const DEFAULT_MAP: MapDef = {
  version: 1,
  board: { width: 40, height: 40 },
  obstacles: [
    {
      id: 'wall-tall',
      type: 'cube',
      pos: { x: 8, y: 8 },
      params: { w: 4, d: 1, h: 2 }, // solid to both
    },
    {
      id: 'wall-low',
      type: 'cube',
      pos: { x: 8, y: 32 },
      params: { w: 4, d: 1, h: 0.6 }, // low wall: blocks players (floor-level body), bullets fly over
    },
    {
      id: 'cone-tall',
      type: 'cone',
      pos: { x: 32, y: 8 },
      params: { radius: 2.5, height: 3 }, // narrows with height; bullets at 0.9 hit a smaller radius than the base
    },
    {
      id: 'arch-open',
      type: 'arch',
      pos: { x: 20, y: 14 },
      params: { w: 6, d: 1, doorWidth: 2, doorHeight: 2, axis: 'y' }, // tall enough for both; walkable and shootable door
    },
    {
      id: 'arch-low-slot',
      type: 'arch',
      pos: { x: 20, y: 26 },
      params: { w: 6, d: 1, doorWidth: 2, doorHeight: 1.0, axis: 'y' }, // between bulletHeight (0.9) and playerHeight (1.2): a bullet passes under, a player is too tall to fit
    },
    {
      id: 'arch-axis-x',
      type: 'arch',
      pos: { x: 32, y: 20 },
      params: { w: 1, d: 6, doorWidth: 2, doorHeight: 2, axis: 'x' }, // same as arch-open, rotated: crossed east-west
    },
    {
      id: 'donut-shootable',
      type: 'donut',
      pos: { x: 32, y: 32 },
      params: { w: 5, d: 1, holeRadius: 1.7, axis: 'y' }, // hub 2.5, hole [0.8, 4.2] comfortably spans bulletHeight 0.9
    },
    {
      id: 'donut-blocked',
      type: 'donut',
      pos: { x: 8, y: 20 },
      params: { w: 5, d: 1, holeRadius: 0.3, axis: 'x' }, // hub 0.5, hole [0.2, 0.8] misses bulletHeight 0.9
    },
  ],
};
