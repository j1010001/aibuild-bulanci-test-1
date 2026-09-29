// M1 task 2: the client's two input-side pieces that don't need a DOM — the InputSender
// (key state -> sequenced input messages) and LocalSession (practice: a Room in-process,
// with every message JSON round-tripped exactly as it would be over the network).

import { beforeAll, describe, expect, it } from 'vitest';
import { InputSender } from '../../src/client/inputSender';
import { LocalSession } from '../../src/client/localSession';
import { ensureRapierReady } from '../../src/physics/rapier';
import type { ClientMessage, ServerMessage } from '../../src/session/protocol';

beforeAll(async () => {
  await ensureRapierReady();
});

describe('InputSender', () => {
  it('sends a movement change once, not on every repeated call', () => {
    const sent: ClientMessage[] = [];
    const input = new InputSender((m) => sent.push(m));
    input.setMoveDir('+X');
    input.setMoveDir('+X');
    input.setMoveDir(null);
    expect(sent).toEqual([
      { type: 'input', seq: 0, moveDir: '+X', shoot: false },
      { type: 'input', seq: 1, moveDir: null, shoot: false },
    ]);
  });

  it('a shot carries the current movement, and every message has a strictly increasing seq', () => {
    const sent: ClientMessage[] = [];
    const input = new InputSender((m) => sent.push(m));
    input.setMoveDir('-Y');
    input.pressShoot();
    input.pressShoot();
    expect(sent.at(-2)).toEqual({ type: 'input', seq: 1, moveDir: '-Y', shoot: true });
    expect(sent.at(-1)).toEqual({ type: 'input', seq: 2, moveDir: '-Y', shoot: true });
  });
});

describe('LocalSession (practice)', () => {
  function started(): { session: LocalSession; inbox: ServerMessage[] } {
    const session = new LocalSession({ seed: 5 });
    const inbox: ServerMessage[] = [];
    session.onMessage((m) => inbox.push(m));
    session.start('Solo');
    return { session, inbox };
  }

  it('joins a one-player practice room', () => {
    const { inbox } = started();
    expect(inbox[0]).toMatchObject({ type: 'roomJoined' });
    const lobby = inbox.find((m) => m.type === 'lobby');
    expect(lobby).toMatchObject({ practice: true, canStart: true });
  });

  it('starts a match and delivers snapshots as the page loop ticks it', async () => {
    const { session, inbox } = started();
    await session.send({ type: 'startMatch' });
    expect(inbox.some((m) => m.type === 'matchStart')).toBe(true);
    const before = inbox.filter((m) => m.type === 'snapshot').length;
    session.tick(1 / 60);
    session.tick(1 / 60);
    expect(inbox.filter((m) => m.type === 'snapshot').length).toBe(before + 1);
  });

  it('delivers exactly what the network would: every message survives a JSON round trip unchanged', async () => {
    const { session, inbox } = started();
    await session.send({ type: 'startMatch' });
    session.tick(1 / 60);
    session.tick(1 / 60);
    for (const m of inbox) expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it('drops malformed client messages instead of passing them to the room', async () => {
    const { session, inbox } = started();
    const count = inbox.length;
    await session.send({ type: 'hack' } as unknown as ClientMessage);
    await session.send({ type: 'setReady', ready: 'yes' } as unknown as ClientMessage);
    expect(inbox.length).toBe(count);
  });

  it('input sent through the session moves the player', async () => {
    const { session, inbox } = started();
    await session.send({ type: 'startMatch' });
    const snap = () => [...inbox].reverse().find((m) => m.type === 'snapshot') as Extract<ServerMessage, { type: 'snapshot' }>;
    const x0 = snap().state.players[0]!.pos.x;
    const input = new InputSender((m) => void session.send(m));
    input.setMoveDir(x0 > 20 ? '-X' : '+X');
    for (let i = 0; i < 20; i++) session.tick(1 / 60);
    expect(snap().state.players[0]!.pos.x).not.toBeCloseTo(x0, 3);
  });

  it('close() stops delivery', async () => {
    const { session, inbox } = started();
    await session.send({ type: 'startMatch' });
    session.close();
    const count = inbox.length;
    session.tick(1 / 60);
    session.tick(1 / 60);
    expect(inbox.length).toBe(count);
  });
});
