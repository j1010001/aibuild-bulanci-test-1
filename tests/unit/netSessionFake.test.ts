// M2 task 2 (review follow-up): NetSession's buffering and close guards, against a fake
// WebSocket so the exact calls to send() are visible.

import { describe, expect, it } from 'vitest';
import { NetSession } from '../../src/net/client';

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last: FakeSocket;
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  constructor(public url: string) {
    super();
    FakeSocket.last = this;
  }
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '' }));
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
}

const Impl = FakeSocket as unknown as typeof WebSocket;

describe('NetSession buffering and close guards', () => {
  it('caps the pre-open queue, keeping the join request first', () => {
    const session = new NetSession('ws://x', { kind: 'create' }, 'Ann', { WebSocketImpl: Impl, maxQueued: 5 });
    for (let i = 0; i < 20; i++) session.send({ type: 'setReady', ready: i % 2 === 0 });
    FakeSocket.last.open();
    const types = FakeSocket.last.sent.map((t) => (JSON.parse(t) as { type: string }).type);
    expect(types[0]).toBe('createRoom');
    expect(types.length).toBeLessThanOrEqual(5);
  });

  it('a send after close never reaches the socket', () => {
    const session = new NetSession('ws://x', { kind: 'create' }, 'Ann', { WebSocketImpl: Impl });
    FakeSocket.last.open();
    const before = FakeSocket.last.sent.length;
    session.close();
    session.send({ type: 'setReady', ready: true });
    expect(FakeSocket.last.sent.length).toBe(before);
  });

  it('a message arriving after close is not delivered', () => {
    const session = new NetSession('ws://x', { kind: 'create' }, 'Ann', { WebSocketImpl: Impl });
    const got: unknown[] = [];
    session.onMessage((m) => got.push(m));
    FakeSocket.last.open();
    const socket = FakeSocket.last;
    session.close();
    socket.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ type: 'error', message: 'late' }) }));
    expect(got).toHaveLength(0);
  });
});
