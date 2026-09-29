// A Session attached directly to a Room in the same process — the in-memory counterpart
// of a WebSocket connection. Every message is JSON-copied in both directions and client
// messages go through the server's parser, so behavior matches the network exactly.
// Practice (LocalSession) uses it; so do headless multi-bot tests.

import { parseClientMessage, type ClientMessage, type ServerMessage } from '../session/protocol';
import type { Room } from '../session/room';
import type { PlayerId } from '../sim';
import type { JoinTarget, Session } from './session';

function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export class InProcessSession implements Session {
  private listeners = new Set<(msg: ServerMessage) => void>();
  private closeListeners = new Set<(reason: string) => void>();
  private playerId: PlayerId | null = null;
  private closed = false;

  constructor(
    private readonly room: Room,
    private readonly target: JoinTarget,
    private readonly name: string,
  ) {}

  /** Joins the room; subscribe with onMessage first to see the join messages. */
  connect(): void {
    if (this.closed || this.playerId !== null) return;
    if (this.target.kind !== 'create' && this.target.code !== this.room.code) {
      this.deliver({ type: 'joinRejected', reason: 'notFound' });
      return this.finish('rejected');
    }
    const sink = (msg: ServerMessage) => this.deliver(msg);
    const result =
      this.target.kind === 'rejoin' ? this.room.rejoin(this.target.reconnectToken, sink) : this.room.join(this.parsedName(), sink);
    if (!result.ok) {
      this.deliver({ type: 'joinRejected', reason: result.reason });
      this.finish('rejected');
    }
  }

  async send(msg: ClientMessage): Promise<void> {
    if (this.closed || this.playerId === null) return;
    const parsed = parseClientMessage(copy(msg));
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

  close(): void {
    if (this.closed) return;
    if (this.playerId !== null) this.room.disconnect(this.playerId);
    this.finish('closed');
  }

  private parsedName(): string {
    // The same name rules as the server: a name the parser rejects falls back to "Player".
    const parsed = parseClientMessage({ type: 'createRoom', name: this.name });
    return parsed?.type === 'createRoom' ? parsed.name : 'Player';
  }

  private deliver(msg: ServerMessage): void {
    if (this.closed) return;
    // Learned from the message, not join()'s return value: listeners may send() while
    // join() is still delivering its first messages (practice auto-starts that way).
    if (msg.type === 'roomJoined') this.playerId = msg.playerId;
    const c = copy(msg);
    for (const l of this.listeners) l(c);
    if (msg.type === 'replaced') this.finish('opened in another tab');
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    for (const l of this.closeListeners) l(reason);
    this.closeListeners.clear();
  }
}
