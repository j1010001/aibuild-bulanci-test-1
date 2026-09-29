// M2 task 3: the headless bot player. It plays through any Session with the same view
// model and InputSender the UI uses, so a room of bots exercises the real client path.
// Here the bots share one in-memory Room (InProcessSession) and time is ticked by hand.

import { beforeAll, describe, expect, it } from 'vitest';
import { BotPlayer } from '../../src/client/botPlayer';
import { InProcessSession } from '../../src/client/inProcessSession';
import { ensureRapierReady } from '../../src/physics/rapier';
import { Room } from '../../src/session/room';
import type { ClientMessage } from '../../src/session/protocol';

beforeAll(async () => {
  await ensureRapierReady();
});

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** Ticks the room at 60 Hz and lets each bot act every tick, until `done` or the budget runs out. */
async function play(room: Room, bots: BotPlayer[], done: () => boolean, maxTicks = 20_000): Promise<number> {
  let now = 0;
  for (let t = 0; t < maxTicks; t++) {
    if (done()) return t;
    for (const b of bots) b.step(now);
    // The async match start only happens from the lobby; mid-match every handler is
    // synchronous, so yielding there would only make a long match slow to simulate.
    if (bots.some((b) => b.view.screen === 'lobby')) await settle();
    room.tick(1 / 60);
    now += 1000 / 60;
  }
  throw new Error('bots did not finish in time');
}

describe('InProcessSession', () => {
  it('joins an existing room and routes messages through the parser, as a socket would', async () => {
    const room = new Room({ code: 'ABCDE', seed: 1 });
    const a = new InProcessSession(room, { kind: 'create' }, 'Ann');
    const inbox: unknown[] = [];
    a.onMessage((m) => inbox.push(m));
    a.connect();
    await a.send({ type: 'hack' } as unknown as ClientMessage); // dropped by the parser
    expect(inbox.map((m) => (m as { type: string }).type)).toEqual(['roomJoined', 'event', 'lobby']);
  });
});

describe('BotPlayer', () => {
  it('a non-owner bot readies itself in the lobby', async () => {
    const room = new Room({ code: 'ABCDE', seed: 1 });
    const host = new BotPlayer(new InProcessSession(room, { kind: 'create' }, 'Host'), { strategy: 'idle' });
    const guest = new BotPlayer(new InProcessSession(room, { kind: 'join', code: 'ABCDE' }, 'Guest'), { strategy: 'idle' });
    host.connect();
    guest.connect();
    guest.step(0);
    await settle();
    expect(host.view.lobby?.players.find((p) => p.name === 'Guest')?.ready).toBe(true);
    expect(host.view.lobby?.canStart).toBe(true);
  });

  it('an owner bot applies its host settings and starts once the start gate opens', async () => {
    const room = new Room({ code: 'ABCDE', seed: 1 });
    const host = new BotPlayer(new InProcessSession(room, { kind: 'create' }, 'Host'), {
      strategy: 'idle',
      host: { mapId: 'open', targetScore: 1, roundTime: 20 },
    });
    const guest = new BotPlayer(new InProcessSession(room, { kind: 'join', code: 'ABCDE' }, 'Guest'), { strategy: 'idle' });
    host.connect();
    guest.connect();
    await play(room, [host, guest], () => host.view.screen === 'match', 50);
    expect(host.view.match?.map.obstacles).toEqual([]);
    expect(host.view.match?.config.targetScore).toBe(1);
  });

  it('two hunting bots play a match to a winner, and both see the same result', async () => {
    const room = new Room({ code: 'ABCDE', seed: 3 });
    const a = new BotPlayer(new InProcessSession(room, { kind: 'create' }, 'Ann'), { host: { mapId: 'open', targetScore: 2 } });
    const b = new BotPlayer(new InProcessSession(room, { kind: 'join', code: 'ABCDE' }, 'Bo'));
    a.connect();
    b.connect();
    await play(room, [a, b], () => a.view.screen === 'matchEnd' && b.view.screen === 'matchEnd');
    expect(a.view.result?.winnerId).not.toBeNull();
    expect(b.view.result).toEqual(a.view.result);
    expect(Math.max(...Object.values(a.view.result!.scores))).toBe(2);
  });

  it('an idle bot never sends input (a stationary target)', async () => {
    const room = new Room({ code: 'ABCDE', seed: 3 });
    const sent: ClientMessage[] = [];
    const session = new InProcessSession(room, { kind: 'create' }, 'Target');
    const realSend = session.send.bind(session);
    session.send = (m: ClientMessage) => {
      sent.push(m);
      return realSend(m);
    };
    const target = new BotPlayer(session, { strategy: 'idle', host: { mapId: 'open' } });
    const hunter = new BotPlayer(new InProcessSession(room, { kind: 'join', code: 'ABCDE' }, 'Hunter'));
    target.connect();
    hunter.connect();
    await play(room, [target, hunter], () => target.view.screen === 'match', 50);
    await play(room, [target, hunter], () => false, 120).catch(() => undefined);
    expect(sent.some((m) => m.type === 'input')).toBe(false);
  });

  it('never exceeds the server rate limit (30 messages per second), even while hunting', async () => {
    const room = new Room({ code: 'ABCDE', seed: 3 });
    const sent: number[] = [];
    let clock = 0;
    const session = new InProcessSession(room, { kind: 'create' }, 'Ann');
    const realSend = session.send.bind(session);
    session.send = (m: ClientMessage) => {
      sent.push(clock);
      return realSend(m);
    };
    const a = new BotPlayer(session, { host: { mapId: 'open', targetScore: 5 } });
    const b = new BotPlayer(new InProcessSession(room, { kind: 'join', code: 'ABCDE' }, 'Bo'), { strategy: 'idle' });
    a.connect();
    b.connect();
    for (let t = 0; t < 600; t++) {
      clock = (t * 1000) / 60;
      a.step(clock);
      b.step(clock);
      await settle();
      room.tick(1 / 60);
    }
    for (let second = 0; second < 10; second++) {
      const inWindow = sent.filter((ms) => ms >= second * 1000 && ms < (second + 1) * 1000).length;
      expect(inWindow).toBeLessThanOrEqual(30);
    }
  });
});
