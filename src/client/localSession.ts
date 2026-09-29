// Practice mode: a one-player Room running in the page, no server (spec §12). Every
// message is JSON round-tripped in both directions and client messages go through the
// same parser the server uses, so practice behaves exactly like a networked game.

import { parseClientMessage, type ClientMessage, type ServerMessage } from '../session/protocol';
import { Room } from '../session/room';
import type { PlayerId } from '../sim';
import type { Session } from './session';

export type LocalSessionOptions = { seed?: number; mapId?: string };

export class LocalSession implements Session {
  readonly room: Room;
  private listeners = new Set<(msg: ServerMessage) => void>();
  private closeListeners = new Set<(reason: string) => void>();
  private playerId: PlayerId | null = null;
  private closed = false;

  constructor(opts: LocalSessionOptions = {}) {
    this.room = new Room({ code: 'LOCAL', practice: true, ...opts });
  }

  /** Joins the practice room; subscribe with onMessage first to see the join messages. */
  start(name: string): void {
    // The same name rules as the server: a name the parser rejects falls back to "Player".
    const parsed = parseClientMessage({ type: 'createRoom', name });
    this.room.join(parsed?.type === 'createRoom' ? parsed.name : 'Player', (msg) => this.deliver(msg));
  }

  async send(msg: ClientMessage): Promise<void> {
    if (this.closed || this.playerId === null) return;
    const parsed = parseClientMessage(JSON.parse(JSON.stringify(msg)));
    if (parsed) await this.room.handle(this.playerId, parsed);
  }

  onMessage(listener: (msg: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Called by the page's fixed-timestep loop (practice has no server tick loop). */
  tick(dt: number): void {
    if (!this.closed) this.room.tick(dt);
  }

  close(): void {
    if (this.closed) return;
    if (this.playerId !== null) this.room.disconnect(this.playerId);
    this.room.dispose(); // also stops a match that is still starting (Room tracks it)
    this.closed = true;
    this.listeners.clear();
    for (const l of this.closeListeners) l('closed');
    this.closeListeners.clear();
  }

  private deliver(msg: ServerMessage): void {
    if (this.closed) return;
    // Learned from the message, not join()'s return value: listeners may send() while
    // join() is still delivering its first messages (practice auto-starts that way).
    if (msg.type === 'roomJoined') this.playerId = msg.playerId;
    const copy = JSON.parse(JSON.stringify(msg)) as ServerMessage;
    for (const l of this.listeners) l(copy);
  }
}
