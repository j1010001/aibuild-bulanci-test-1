// One socket's adapter to the rooms (spec §12). Transport-agnostic: the WebSocket layer
// forwards text frames to onMessage, binary frames to onBinary and its close event to
// onClose. Limits message size, message rate and failed joins per connection — the Room
// itself never rate-limits (spec §12).

import { parseClientMessage, type ClientMessage, type ServerMessage } from '../src/session/protocol';
import type { Room } from '../src/session/room';
import type { RoomRegistry } from './rooms';

export interface Connection {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export type ConnectionOptions = {
  maxMessageBytes?: number;
  /** Token-bucket refill rate. Input is sent only on change, so honest clients stay far below. */
  maxMessagesPerSecond?: number;
  burst?: number;
  /** Rejected joins allowed per connection, so room codes can't be enumerated through one socket. */
  maxFailedJoins?: number;
  now?: () => number;
};

const CLOSE_UNSUPPORTED = 1003;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_LARGE = 1009;
const CLOSE_REPLACED = 4000;

export class ConnectionHandler {
  private room: Room | null = null;
  private playerId: string | null = null;
  private replaced = false;
  private closed = false;
  private failedJoins = 0;

  private readonly maxBytes: number;
  private readonly rate: number;
  private readonly burst: number;
  private readonly maxFailedJoins: number;
  private readonly now: () => number;
  private tokens: number;
  private refilledAt: number;

  constructor(
    private readonly registry: RoomRegistry,
    private readonly conn: Connection,
    opts: ConnectionOptions = {},
  ) {
    this.maxBytes = opts.maxMessageBytes ?? 4096;
    this.rate = opts.maxMessagesPerSecond ?? 30;
    this.burst = opts.burst ?? 60;
    this.maxFailedJoins = opts.maxFailedJoins ?? 5;
    this.now = opts.now ?? (() => performance.now());
    this.tokens = this.burst;
    this.refilledAt = this.now();
  }

  onMessage(text: string): void {
    if (this.closed) return;
    if (Buffer.byteLength(text, 'utf8') > this.maxBytes) return this.kill(CLOSE_TOO_LARGE, 'message too large');
    if (!this.takeToken()) return this.kill(CLOSE_POLICY, 'too many messages');

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const msg = parseClientMessage(raw);
    if (!msg) return;

    if (msg.type === 'createRoom' || msg.type === 'joinRoom' || msg.type === 'rejoin') {
      if (this.room) return this.send({ type: 'error', message: 'already in a room' });
      return this.enter(msg);
    }
    if (!this.room || this.playerId === null) return this.send({ type: 'error', message: 'join a room first' });
    const room = this.room;
    const playerId = this.playerId;
    if (msg.type === 'leave') {
      // Unbind first: this socket no longer speaks for that player, so its eventual close
      // must not disconnect them again (they may already have rejoined elsewhere).
      this.room = null;
      this.playerId = null;
    }
    room.handle(playerId, msg).catch((err: unknown) => {
      this.send({ type: 'error', message: err instanceof Error ? err.message : 'internal error' });
    });
    if (msg.type === 'leave') this.registry.removeIfEmpty(room.code);
  }

  onBinary(): void {
    if (!this.closed) this.kill(CLOSE_UNSUPPORTED, 'binary frames are not supported');
  }

  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    // A replaced connection's player lives on in the newer connection.
    if (this.room && this.playerId !== null && !this.replaced) {
      this.room.disconnect(this.playerId);
      this.registry.removeIfEmpty(this.room.code);
    }
  }

  private enter(msg: Extract<ClientMessage, { type: 'createRoom' | 'joinRoom' | 'rejoin' }>): void {
    const room = msg.type === 'createRoom' ? this.registry.create() : this.registry.get(msg.code);
    if (!room) return this.reject(msg.type === 'createRoom' ? 'serverFull' : 'notFound');
    const result = msg.type === 'rejoin' ? room.rejoin(msg.reconnectToken, this.sink) : room.join(msg.name, this.sink);
    if (!result.ok) {
      this.registry.removeIfEmpty(room.code); // a freshly created room nobody got into
      return this.reject(result.reason);
    }
    this.room = room;
    this.playerId = result.playerId;
  }

  private reject(reason: Extract<ServerMessage, { type: 'joinRejected' }>['reason']): void {
    this.send({ type: 'joinRejected', reason });
    this.failedJoins += 1;
    if (this.failedJoins > this.maxFailedJoins) this.kill(CLOSE_POLICY, 'too many failed joins');
  }

  private readonly sink = (msg: ServerMessage): void => {
    this.send(msg);
    if (msg.type === 'replaced') {
      this.replaced = true;
      this.kill(CLOSE_REPLACED, 'replaced by a newer connection');
    }
  };

  private send(msg: ServerMessage): void {
    if (!this.closed) this.conn.send(JSON.stringify(msg));
  }

  private kill(code: number, reason: string): void {
    this.conn.close(code, reason);
    this.onClose(); // idempotent; the socket's own close event may also call it
  }

  private takeToken(): boolean {
    const t = this.now();
    const elapsed = Math.max(0, t - this.refilledAt); // an injected clock may step backwards
    this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.rate);
    this.refilledAt = Math.max(this.refilledAt, t);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
