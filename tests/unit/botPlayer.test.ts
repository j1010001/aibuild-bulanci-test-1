// M2 task 3: the headless bot player. It plays through any Session with the same view
// model and InputSender the UI uses, so a room of bots exercises the real client path.
// Here the bots share one in-memory Room (InProcessSession) and time is ticked by hand.

import { beforeAll, describe, expect, it } from 'vitest';
import { BotPlayer } from '../../src/client/botPlayer';
import { InProcessSession } from '../../src/client/inProcessSession';
import { ensureRapierReady } from '../../src/physics/rapier';
import { Room } from '../../src/session/room';
import type { ClientMessage, DynamicState, ServerMessage } from '../../src/session/protocol';
import type { Session } from '../../src/client/session';
import { DEFAULT_CONFIG, DEFAULT_MAP } from '../../src/sim';
import type { Direction } from '../../src/sim';

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

describe('InProcessSession: joining and leaving', () => {
  it('refuses a join whose code is not this room, and reports the close once', () => {
    const room = new Room({ code: 'ABCDE', seed: 1 });
    const s = new InProcessSession(room, { kind: 'join', code: 'ZZZZZ' }, 'Bo');
    const inbox: ServerMessage[] = [];
    const closes: string[] = [];
    s.onMessage((m) => inbox.push(m));
    s.onClose((r) => closes.push(r));
    s.connect();
    s.close();
    expect(inbox).toEqual([{ type: 'joinRejected', reason: 'notFound' }]);
    expect(closes).toHaveLength(1);
  });

  it('applies the server name rules', () => {
    const room = new Room({ code: 'ABCDE', seed: 1 });
    const s = new InProcessSession(room, { kind: 'create' }, '\u202EAnn');
    const inbox: ServerMessage[] = [];
    s.onMessage((m) => inbox.push(m));
    s.connect();
    expect((inbox.find((m) => m.type === 'lobby') as Extract<ServerMessage, { type: 'lobby' }>).players[0]!.name).toBe('Ann');
  });

  it('rejoins by token, and the replaced session is told and ends', () => {
    const room = new Room({ code: 'ABCDE', seed: 1 });
    const first = new InProcessSession(room, { kind: 'create' }, 'Ann');
    const inbox: ServerMessage[] = [];
    const closes: string[] = [];
    first.onMessage((m) => inbox.push(m));
    first.onClose((r) => closes.push(r));
    first.connect();
    const token = (inbox[0] as Extract<ServerMessage, { type: 'roomJoined' }>).reconnectToken;

    const second = new InProcessSession(room, { kind: 'rejoin', code: 'ABCDE', reconnectToken: token }, 'Ann');
    const inbox2: ServerMessage[] = [];
    second.onMessage((m) => inbox2.push(m));
    second.connect();
    expect(inbox2[0]).toMatchObject({ type: 'roomJoined', playerId: 'p0' });
    expect(inbox.at(-1)).toEqual({ type: 'replaced' });
    expect(closes).toHaveLength(1);
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

  // Test change, with justification (review finding 1): bots now return to the lobby after
  // a match instead of sitting on the match-end screen, so finished matches are read from
  // `results` rather than from the current screen.
  it('two hunting bots play a match to a winner, and both see the same result', async () => {
    const room = new Room({ code: 'ABCDE', seed: 3 });
    const a = new BotPlayer(new InProcessSession(room, { kind: 'create' }, 'Ann'), { host: { mapId: 'open', targetScore: 2 } });
    const b = new BotPlayer(new InProcessSession(room, { kind: 'join', code: 'ABCDE' }, 'Bo'));
    a.connect();
    b.connect();
    await play(room, [a, b], () => a.results.length >= 1 && b.results.length >= 1);
    expect(a.results[0]!.winnerId).not.toBeNull();
    expect(b.results[0]).toEqual(a.results[0]);
    expect(Math.max(...Object.values(a.results[0]!.scores))).toBe(2);
  });

  it('after a match the bots go back to the lobby, ready up again, and the owner starts a rematch', async () => {
    const room = new Room({ code: 'ABCDE', seed: 3 });
    const a = new BotPlayer(new InProcessSession(room, { kind: 'create' }, 'Ann'), { host: { mapId: 'open', targetScore: 1 } });
    const b = new BotPlayer(new InProcessSession(room, { kind: 'join', code: 'ABCDE' }, 'Bo'));
    a.connect();
    b.connect();
    await play(room, [a, b], () => a.results.length >= 2);
    expect(b.results.length).toBeGreaterThanOrEqual(2);
  });

  // Regression (review finding 4): on the default map, bots lined up across a wall and fired
  // into it for whole rounds; every earlier test used the empty map. Across several seeds,
  // the first round must be decided by a kill well before the 60 s round timeout.
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('on the default map, two hunting bots settle the first round by a kill (seed %i)', async (seed) => {
    const room = new Room({ code: 'ABCDE', seed });
    const a = new BotPlayer(new InProcessSession(room, { kind: 'create' }, 'Ann'), { host: { mapId: 'default', targetScore: 1 } });
    const b = new BotPlayer(new InProcessSession(room, { kind: 'join', code: 'ABCDE' }, 'Bo'));
    a.connect();
    b.connect();
    await play(room, [a, b], () => a.view.screen === 'match', 60);
    const kill = () => room.gameApi?.getEvents().some((e) => e.kind === 'playerKilled') ?? a.results.length > 0;
    await play(room, [a, b], kill, 45 * 60); // 45 s of simulated time
  });

  // Regression: identical bots fired on the same tick and traded kills forever (every
  // round a draw). A per-bot reaction delay, drawn from a seeded generator, breaks the tie.
  it('draws its reaction delays from its own seeded generator: reproducible, within range', () => {
    const bot = (seed: number) =>
      new BotPlayer(new InProcessSession(new Room({ code: 'ZZZZZ' }), { kind: 'create' }, 'X'), { seed, reactionMs: [100, 300] });
    const a = bot(1);
    const b = bot(1);
    const c = bot(2);
    const seqA = [a.nextReactionMs(), a.nextReactionMs(), a.nextReactionMs()];
    expect([b.nextReactionMs(), b.nextReactionMs(), b.nextReactionMs()]).toEqual(seqA);
    expect([c.nextReactionMs(), c.nextReactionMs(), c.nextReactionMs()]).not.toEqual(seqA);
    for (const d of seqA) {
      expect(d).toBeGreaterThanOrEqual(100);
      expect(d).toBeLessThanOrEqual(300);
    }
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

  it('two bots hunting each other stay under the rate limit too, counting the join', async () => {
    const room = new Room({ code: 'ABCDE', seed: 5 });
    const sent: number[] = [];
    let clock = 0;
    const counted = (name: string, target: 'create' | 'join') => {
      const session = new InProcessSession(room, target === 'create' ? { kind: 'create' } : { kind: 'join', code: 'ABCDE' }, name);
      const realSend = session.send.bind(session);
      session.send = (m: ClientMessage) => {
        sent.push(clock);
        return realSend(m);
      };
      return session;
    };
    const a = new BotPlayer(counted('Ann', 'create'), { host: { mapId: 'default', targetScore: 10 } });
    const b = new BotPlayer(counted('Bo', 'join'));
    sent.push(0, 0); // each socket's join request also spends a token
    a.connect();
    b.connect();
    for (let t = 0; t < 1200; t++) {
      clock = (t * 1000) / 60;
      a.step(clock);
      b.step(clock);
      if (a.view.screen === 'lobby' || b.view.screen === 'lobby') await settle();
      room.tick(1 / 60);
    }
    // A single bot's messages, per any one-second window (the server limits per socket).
    for (let second = 0; second < 20; second++) {
      const inWindow = sent.filter((ms) => ms >= second * 1000 && ms < (second + 1) * 1000).length;
      expect(inWindow).toBeLessThanOrEqual(60); // two sockets' worth of 30/s
    }
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

/** A Session the test scripts directly: it records what the bot sends and feeds it messages. */
class ScriptedSession implements Session {
  sent: ClientMessage[] = [];
  private listeners: ((m: ServerMessage) => void)[] = [];
  private closers: ((r: string) => void)[] = [];
  send(msg: ClientMessage): void {
    this.sent.push(msg);
  }
  onMessage(l: (m: ServerMessage) => void) {
    this.listeners.push(l);
    return () => {};
  }
  onClose(l: (r: string) => void) {
    this.closers.push(l);
    return () => {};
  }
  close(): void {
    for (const c of this.closers) c('closed');
  }
  push(msg: ServerMessage): void {
    for (const l of this.listeners) l(msg);
  }
  drop(reason: string): void {
    for (const c of this.closers) c(reason);
  }
  moves(): (Direction | null)[] {
    return this.sent.flatMap((m) => (m.type === 'input' ? [m.moveDir] : []));
  }
}

function matchWith(session: ScriptedSession, me: { x: number; y: number; facing: Direction }, target: { x: number; y: number }, obstacles = DEFAULT_MAP.obstacles) {
  session.push({ type: 'roomJoined', code: 'ABCDE', playerId: 'a', reconnectToken: 't' });
  session.push({ type: 'matchStart', map: { ...DEFAULT_MAP, obstacles }, config: DEFAULT_CONFIG, players: [], seed: 1 });
  let seq = 0;
  return (meAt = me, alive = true) => {
    const state: DynamicState = {
      phase: 'round',
      roundNumber: 1,
      scores: { a: 0, b: 0 },
      players: [
        { id: 'a', name: 'A', skinId: 'crimson', pos: { x: meAt.x, y: meAt.y }, facing: meAt.facing, lastShotAt: 0, alive, connected: true },
        { id: 'b', name: 'B', skinId: 'gold', pos: target, facing: '+X', lastShotAt: 0, alive: true, connected: true },
      ],
      bullets: [],
      time: 0,
      roundStartedAt: 0,
      winnerId: null,
    };
    session.push({ type: 'snapshot', seq: seq++, state });
  };
}

describe('BotPlayer: getting unstuck', () => {
  // Regression (review finding 3): backing off toward a board edge (or an obstacle) makes no
  // progress, so the bot stood pinned forever. After ~1.5 s without progress it breaks out
  // with a move in another direction.
  it('a bot that is trying to move but not getting anywhere breaks out in another direction', () => {
    const session = new ScriptedSession();
    const bot = new BotPlayer(session, { seed: 1 });
    const snap = matchWith(session, { x: 0.9, y: 20, facing: '-X' }, { x: 2.2, y: 20 }, []); // too close to turn: backs off into the edge
    for (let t = 0; t <= 2500; t += 50) {
      snap(); // the server keeps reporting the same pinned position
      bot.step(t);
    }
    const moves = session.moves();
    expect(moves).toContain('-X'); // it did try to back off
    expect(moves.some((d) => d !== '-X' && d !== null)).toBe(true); // …and then broke out
  });

  it('a bot lined up on a target behind a wall does not fire into it, and moves off the line', () => {
    const session = new ScriptedSession();
    const bot = new BotPlayer(session, { seed: 1, reactionMs: [0, 0] });
    const snap = matchWith(session, { x: 8, y: 4, facing: '+Y' }, { x: 8, y: 12 }); // tall wall between
    for (let t = 0; t <= 1000; t += 50) {
      snap();
      bot.step(t);
    }
    expect(session.sent.some((m) => m.type === 'input' && m.shoot)).toBe(false);
    expect(session.moves().some((d) => d !== null)).toBe(true);
  });

  it('stops right away (no throttle) when it dies', () => {
    const session = new ScriptedSession();
    const bot = new BotPlayer(session, { seed: 1 });
    const snap = matchWith(session, { x: 5, y: 5, facing: '+Y' }, { x: 20, y: 30 }, []);
    snap();
    bot.step(0); // starts moving toward the target
    expect(session.moves().at(-1)).not.toBeNull();
    snap({ x: 5.1, y: 5, facing: '+X' }, false);
    bot.step(10); // within the 50 ms movement throttle
    expect(session.moves().at(-1)).toBeNull();
  });

  it('records why its session closed', () => {
    const session = new ScriptedSession();
    const bot = new BotPlayer(session);
    session.drop('connection lost');
    expect(bot.closedReason).toBe('connection lost');
  });
});
