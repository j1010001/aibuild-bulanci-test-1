// HUD model: what the in-match overlay shows, derived purely from the ClientView.

import type { PlayerId } from '../sim';
import { playerName, type ClientView } from './model';

export type HudRow = { id: PlayerId; name: string; skinId: string; score: number; you: boolean; alive: boolean; connected: boolean };

export type HudModel = {
  round: number;
  secondsLeft: number;
  scores: HudRow[];
  banner: string | null;
};

const BANNER_MS = 2000;

export function hudModel(view: ClientView, now: number): HudModel {
  const snap = view.snapshot;
  const roundTime = view.match?.config.roundTime ?? 0;
  const elapsed = snap ? (snap.time - snap.roundStartedAt) / 1000 : 0;

  const scores: HudRow[] = (snap?.players ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    skinId: p.skinId,
    score: snap?.scores[p.id] ?? 0,
    you: p.id === view.playerId,
    alive: p.alive,
    connected: p.connected,
  }));
  scores.sort((a, b) => b.score - a.score); // stable: ties keep join order

  let banner: string | null = null;
  const end = view.lastRoundEnd;
  if (end && now - end.at < BANNER_MS) {
    banner = end.winnerId === null ? `Round ${end.roundNumber}: draw` : `${playerName(view, end.winnerId)} wins round ${end.roundNumber}`;
  }

  return {
    round: snap?.roundNumber ?? 0,
    secondsLeft: Math.max(0, Math.ceil(roundTime - elapsed)),
    scores,
    banner,
  };
}
