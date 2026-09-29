// A Session over WebSocket to the game server (spec §12). The same class runs in the
// browser, in the headless bot, and in integration tests (Node has the same global
// WebSocket). Game rules and screen logic stay out of here: this only moves messages.

import type { JoinTarget, Session } from '../client/session';
import type { ClientMessage, ServerMessage } from '../session/protocol';

export class NetSession implements Session {
  private readonly ws: WebSocket;
  private readonly queue: string[] = [];
  private readonly listeners = new Set<(msg: ServerMessage) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private closed = false;

  constructor(url: string, target: JoinTarget, name: string) {
    this.ws = new WebSocket(url);
    // The join request goes first, so anything the UI sends meanwhile follows it.
    this.queue.push(JSON.stringify(joinMessage(target, name)));
    this.ws.addEventListener('open', () => {
      for (const text of this.queue.splice(0)) this.ws.send(text);
    });
    this.ws.addEventListener('message', (e) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string') {
        for (const l of this.listeners) l(msg as ServerMessage);
      }
    });
    this.ws.addEventListener('close', (e) => this.finish(e.reason || closeReason(e.code)));
  }

  send(msg: ClientMessage): void {
    if (this.closed) return;
    const text = JSON.stringify(msg);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(text);
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
    this.ws.close(1000, 'left');
    this.finish('left');
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
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

function closeReason(code: number): string {
  switch (code) {
    case 1006:
      return 'could not reach the game server';
    case 1008:
      return 'too many messages';
    case 1009:
      return 'message too large';
    case 1013:
      return 'the server is full';
    case 4000:
      return 'opened in another tab';
    default:
      return 'connection closed';
  }
}
