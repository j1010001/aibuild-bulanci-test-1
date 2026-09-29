// Client view model: a pure fold of ServerMessages into what the UI shows. The DOM layer
// (src/ui) only renders a ClientView; every screen transition is decided here.

import type { Config, ObstacleDef, PlayerId } from '../sim';
import type { DynamicState, JoinRejectReason, LobbyMessage, ServerMessage } from '../session/protocol';

export type Screen = 'home' | 'lobby' | 'match' | 'matchEnd';

export type MatchInfo = Omit<Extract<ServerMessage, { type: 'matchStart' }>, 'type'>;

export type ClientView = {
  screen: Screen;
  playerId: PlayerId | null;
  code: string | null;
  reconnectToken: string | null;
  lobby: LobbyMessage | null;
  match: MatchInfo | null;
  snapshot: DynamicState | null;
  previous: DynamicState | null; // the one before `snapshot`, for interpolation
  snapshotSeq: number;
  snapshotReceivedAt: number;
  lastRoundEnd: { roundNumber: number; winnerId: PlayerId | null; at: number } | null;
  result: { winnerId: PlayerId | null; scores: Record<PlayerId, number> } | null;
  error: string | null;
  rejected: JoinRejectReason | null;
};

/** What the renderer draws: the static match data plus one dynamic snapshot. */
export type RenderState = DynamicState & { config: Config; obstacles: ObstacleDef[] };

export function initialView(): ClientView {
  return {
    screen: 'home',
    playerId: null,
    code: null,
    reconnectToken: null,
    lobby: null,
    match: null,
    snapshot: null,
    previous: null,
    snapshotSeq: -1,
    snapshotReceivedAt: 0,
    lastRoundEnd: null,
    result: null,
    error: null,
    rejected: null,
  };
}

/** `now` is the client's clock (ms); only used to time UI banners and interpolation. */
export function reduce(view: ClientView, msg: ServerMessage, now: number): ClientView {
  switch (msg.type) {
    case 'roomJoined':
      return {
        ...view,
        playerId: msg.playerId,
        code: msg.code,
        reconnectToken: msg.reconnectToken,
        rejected: null,
        error: null,
        snapshotSeq: -1,
        screen: view.screen === 'home' ? 'lobby' : view.screen,
      };
    case 'joinRejected':
      return { ...view, rejected: msg.reason };
    case 'lobby':
      // The match-end screen stays up (showing final scores) until the player dismisses it.
      return { ...view, lobby: msg, screen: view.screen === 'matchEnd' ? 'matchEnd' : 'lobby' };
    case 'matchStart': {
      const { type: _type, ...match } = msg;
      return { ...view, match, snapshot: null, previous: null, result: null, lastRoundEnd: null, screen: 'match' };
    }
    case 'snapshot': {
      if (msg.seq <= view.snapshotSeq) return view;
      const next: ClientView = {
        ...view,
        previous: view.snapshot,
        snapshot: msg.state,
        snapshotSeq: msg.seq,
        snapshotReceivedAt: now,
      };
      if (msg.state.phase === 'matchEnd') {
        return { ...next, screen: 'matchEnd', result: { winnerId: msg.state.winnerId, scores: msg.state.scores } };
      }
      return next;
    }
    case 'event':
      if (msg.event.kind === 'roundEnd') {
        return { ...view, lastRoundEnd: { roundNumber: msg.event.roundNumber, winnerId: msg.event.winnerId, at: now } };
      }
      return view;
    case 'error':
      return { ...view, error: msg.message };
  }
}

export function backToLobby(view: ClientView): ClientView {
  return { ...view, screen: 'lobby', result: null };
}

export function renderStateOf(view: ClientView): RenderState | null {
  if (!view.match || !view.snapshot) return null;
  return { ...view.snapshot, config: view.match.config, obstacles: view.match.map.obstacles };
}

export function playerName(view: ClientView, id: PlayerId | null): string {
  if (id === null) return '';
  return view.match?.players.find((p) => p.id === id)?.name ?? view.lobby?.players.find((p) => p.id === id)?.name ?? id;
}
