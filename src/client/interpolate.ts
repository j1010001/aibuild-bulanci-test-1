// Rendering between snapshots (spec §12). Snapshots arrive at 30 Hz; the renderer draws
// from the previous snapshot toward the latest over one snapshot interval after the
// latest arrives — one interval of added display delay, in exchange for smooth motion.

import type { DynamicState } from '../session/protocol';
import type { ClientView, RenderState } from './model';

export const SNAPSHOT_INTERVAL_MS = 1000 / 30;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** `alpha` 0 = `prev`, 1 = `next`; everything but positions comes from `next`. */
export function interpolate(prev: DynamicState | null, next: DynamicState, alpha: number): DynamicState {
  if (!prev || prev.roundNumber !== next.roundNumber) return next; // a new round respawns everyone: snap
  const t = Math.min(1, Math.max(0, alpha));
  return {
    ...next,
    players: next.players.map((p) => {
      const q = prev.players.find((x) => x.id === p.id);
      if (!q || !q.alive || !p.alive) return p;
      return { ...p, pos: { x: lerp(q.pos.x, p.pos.x, t), y: lerp(q.pos.y, p.pos.y, t) } };
    }),
    bullets: next.bullets.map((b) => {
      const c = prev.bullets.find((x) => x.id === b.id);
      if (!c) return b;
      return { ...b, pos: { x: lerp(c.pos.x, b.pos.x, t), y: lerp(c.pos.y, b.pos.y, t) } };
    }),
  };
}

/** What to draw at client time `now` (ms, same clock as the view's snapshotReceivedAt). */
export function renderStateAt(view: ClientView, now: number, intervalMs = SNAPSHOT_INTERVAL_MS): RenderState | null {
  if (!view.match || !view.snapshot) return null;
  const alpha = (now - view.snapshotReceivedAt) / intervalMs;
  const state = interpolate(view.previous, view.snapshot, alpha);
  return { ...state, config: view.match.config, obstacles: view.match.map.obstacles };
}
