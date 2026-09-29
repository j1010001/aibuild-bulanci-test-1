// What the UI talks to: a connection to one Room. Practice (LocalSession, in-process) and
// multiplayer (NetSession, over WebSocket) implement the same interface, so the screens,
// input and rendering never know which one they're using.

import type { ClientMessage, ServerMessage } from '../session/protocol';

/** How a multiplayer session enters its room. */
export type JoinTarget = { kind: 'create' } | { kind: 'join'; code: string } | { kind: 'rejoin'; code: string; reconnectToken: string };

export interface Session {
  send(msg: ClientMessage): void | Promise<void>;
  /** Returns an unsubscribe function. */
  onMessage(listener: (msg: ServerMessage) => void): () => void;
  /** Fires once when the session ends for any reason (closed locally or by the server). */
  onClose(listener: (reason: string) => void): () => void;
  close(): void;
}
