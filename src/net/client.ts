// A Session over WebSocket to the game server (spec §12). The same class runs in the
// browser, in the headless bot, and in integration tests (Node has the same global
// WebSocket). Game rules and screen logic stay out of here: this only moves messages.

import type { JoinTarget, Session } from '../client/session';
import type { ClientMessage, ServerMessage } from '../session/protocol';

export type NetSessionOptions = {
  /** For tests: a WebSocket-compatible constructor. */
  WebSocketImpl?: typeof WebSocket;
  /** Give up if the socket hasn't opened by then. */
  connectTimeoutMs?: number;
  /** Messages kept while connecting (the join request is always first); later ones are dropped. */
  maxQueued?: number;
};

export class NetSession implements Session {
  private readonly ws: WebSocket | null;
  private readonly Impl: typeof WebSocket;
  private readonly queue: string[] = [];
  private readonly maxQueued: number;
  private readonly listeners = new Set<(msg: ServerMessage) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private opened = false;
  private closed = false;

  constructor(url: string, target: JoinTarget, name: string, opts: NetSessionOptions = {}) {
    this.Impl = opts.WebSocketImpl ?? WebSocket;
    this.maxQueued = opts.maxQueued ?? 64;
    // The join request goes first, so anything the UI sends meanwhile follows it.
    this.queue.push(JSON.stringify(joinMessage(target, name)));

    let ws: WebSocket | null = null;
    try {
      ws = new this.Impl(url);
    } catch {
      // A malformed URL or blocked port throws here; report it like any other failed
      // connection, after the caller has had a chance to subscribe to onClose.
      queueMicrotask(() => this.finish('invalid game server address'));
    }
    this.ws = ws;
    if (!ws) return;

    this.connectTimer = setTimeout(() => {
      if (!this.opened) {
        ws.close();
        this.finish('could not reach the game server');
      }
    }, opts.connectTimeoutMs ?? 5000);

    ws.addEventListener('open', () => {
      this.opened = true;
      this.clearTimer();
      for (const text of this.queue.splice(0)) ws.send(text);
    });
    ws.addEventListener('message', (e) => {
      if (this.closed) return;
      let msg: unknown;
      try {
        msg = JSON.parse(String((e as MessageEvent).data));
      } catch {
        return;
      }
      if (typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string') {
        for (const l of this.listeners) l(msg as ServerMessage);
      }
    });
    ws.addEventListener('close', (e) => {
      const { code, reason } = e as CloseEvent;
      this.finish(reason || closeReason(code, this.opened));
    });
  }

  send(msg: ClientMessage): void {
    if (this.closed || !this.ws) return;
    const text = JSON.stringify(msg);
    if (this.ws.readyState === this.Impl.OPEN) this.ws.send(text);
    else if (this.ws.readyState === this.Impl.CONNECTING && this.queue.length < this.maxQueued) this.queue.push(text);
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
    this.ws?.close(1000, 'left');
    this.finish('left');
  }

  private clearTimer(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.listeners.clear();
    for (const l of this.closeListeners) l(reason);
    this.closeListeners.clear();
  }
}

function joinMessage(target: JoinTarget, name: string): ClientMessage {
  switch (target.kind) {
    case 'create':
      return { type: 'createRoom', name };
    case 'join':
      return { type: 'joinRoom', code: target.code, name };
    case 'rejoin':
      return { type: 'rejoin', code: target.code, reconnectToken: target.reconnectToken };
  }
}

/** For closes without a server-supplied reason (the server sends one for its own closes). */
function closeReason(code: number, opened: boolean): string {
  if (code === 1006) return opened ? 'connection lost' : 'could not reach the game server';
  return opened ? 'connection closed' : 'could not reach the game server';
}
