// Practice mode: a one-player Room running in the page, no server (spec §12), reached
// through an InProcessSession so practice behaves exactly like a networked game.

import type { ClientMessage, ServerMessage } from '../session/protocol';
import { Room } from '../session/room';
import { InProcessSession } from './inProcessSession';
import type { Session } from './session';

export type LocalSessionOptions = { seed?: number; mapId?: string };

export class LocalSession implements Session {
  readonly room: Room;
  private inner: InProcessSession | null = null;
  private listeners = new Set<(msg: ServerMessage) => void>();
  private closeListeners = new Set<(reason: string) => void>();
  private closed = false;

  constructor(opts: LocalSessionOptions = {}) {
    this.room = new Room({ code: 'LOCAL', practice: true, ...opts });
  }

  /** Joins the practice room; subscribe with onMessage first to see the join messages. */
  start(name: string): void {
    if (this.closed || this.inner) return;
    const inner = new InProcessSession(this.room, { kind: 'create' }, name);
    this.inner = inner;
    inner.onMessage((m) => {
      for (const l of this.listeners) l(m);
    });
    inner.onClose((reason) => this.finish(reason));
    inner.connect();
  }

  async send(msg: ClientMessage): Promise<void> {
    if (!this.closed) await this.inner?.send(msg);
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
    this.inner?.close();
    this.room.dispose(); // also stops a match that is still starting (Room tracks it)
    this.finish('closed');
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    for (const l of this.closeListeners) l(reason);
    this.closeListeners.clear();
  }
}
