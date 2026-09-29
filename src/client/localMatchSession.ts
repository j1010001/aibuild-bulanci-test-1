// Play vs bots (M2.5): a normal Room running in the page — the human plus N bots, no
// server. Every bot is a BotPlayer on its own InProcessSession, so bots join, ready up and
// play through exactly the messages a remote player would send. tick() is the only clock:
// it steps the bots on simulated time, then ticks the room, so a seeded local match is
// reproducible whether the page loop, window.GameClient.runTicks or a test drives it.

import { CONFIG_LIMITS, type ClientMessage, type LobbyMessage, type ServerMessage } from '../session/protocol';
import { Room } from '../session/room';
import { DEFAULT_CONFIG } from '../sim';
import { BotPlayer } from './botPlayer';
import { DIFFICULTY_LABEL, type Difficulty } from './bots/difficulty';
import { InProcessSession } from './inProcessSession';
import type { Session } from './session';

export const LOCAL_MATCH_CODE = 'LOCAL';

export type LocalMatchOptions = {
  /** Computer opponents: 1 to maxPlayers − 1 (7). */
  bots: number;
  /** One level for every bot in the game. */
  difficulty: Difficulty;
  mapId?: string;
  targetScore?: number;
  roundTime?: number;
  /** Fixes every match's spawns and every bot's choices (tests, replays). */
  seed?: number;
};

export const MAX_BOTS = DEFAULT_CONFIG.maxPlayers - 1;

export function botName(index: number, difficulty: Difficulty): string {
  return `Bot ${index + 2} (${DIFFICULTY_LABEL[difficulty]})`; // the human is player 1
}

export class LocalMatchSession implements Session {
  readonly room: Room;
  readonly bots: BotPlayer[] = [];
  private inner: InProcessSession | null = null;
  private listeners = new Set<(msg: ServerMessage) => void>();
  private closeListeners = new Set<(reason: string) => void>();
  private closed = false;
  private simNow = 0; // ms of simulated time, the bots' clock
  private lobby: LobbyMessage | null = null; // the human's latest view of the lobby
  private startArmed = true; // start as soon as everyone is ready; re-armed by playAgain()

  constructor(private readonly opts: LocalMatchOptions) {
    if (!Number.isInteger(opts.bots) || opts.bots < 1 || opts.bots > MAX_BOTS) {
      throw new RangeError(`LocalMatchSession: bots must be an integer from 1 to ${MAX_BOTS}, got ${opts.bots}`);
    }
    for (const key of ['targetScore', 'roundTime'] as const) {
      const value = opts[key];
      const { min, max } = CONFIG_LIMITS[key];
      if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
        throw new RangeError(`LocalMatchSession: ${key} must be an integer from ${min} to ${max}, got ${value}`);
      }
    }
    this.room = new Room({ code: LOCAL_MATCH_CODE, maxPlayers: opts.bots + 1, mapId: opts.mapId, seed: opts.seed });
  }

  /** Joins the human (the room owner) and the bots; subscribe with onMessage first. */
  start(name: string): void {
    if (this.closed || this.inner) return;
    const inner = new InProcessSession(this.room, { kind: 'create' }, name);
    this.inner = inner;
    inner.onMessage((m) => this.deliver(m));
    inner.onClose((reason) => this.finish(reason));
    inner.connect();
    const { targetScore, roundTime } = this.opts;
    if (targetScore !== undefined || roundTime !== undefined) {
      void inner.send({ type: 'setConfig', config: JSON.parse(JSON.stringify({ targetScore, roundTime })) });
    }
    const base = this.opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    for (let i = 0; i < this.opts.bots; i++) {
      const session = new InProcessSession(this.room, { kind: 'join', code: LOCAL_MATCH_CODE }, botName(i, this.opts.difficulty));
      const bot = new BotPlayer(session, { difficulty: this.opts.difficulty, seed: base * 100 + i + 1 });
      this.bots.push(bot);
      bot.connect();
    }
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

  /** One fixed step: the bots decide, then the room advances. */
  tick(dt: number): void {
    if (this.closed) return;
    for (const bot of this.bots) bot.step(this.simNow);
    if (this.startArmed && this.lobby?.canStart && this.room.phase === 'lobby') {
      this.startArmed = false;
      void this.inner?.send({ type: 'startMatch' });
    }
    this.room.tick(dt);
    this.simNow += dt * 1000;
  }

  /** After a match: start the next one as soon as the bots are ready again. Ignored while
   * a match is running (it would skip that match's results). */
  playAgain(): void {
    if (!this.closed && this.room.phase === 'lobby') this.startArmed = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; // nothing from the teardown reaches the listeners
    for (const bot of this.bots) bot.close();
    this.inner?.close();
    this.room.dispose();
    this.closed = false;
    this.finish('closed');
  }

  private deliver(msg: ServerMessage): void {
    if (this.closed) return;
    if (msg.type === 'lobby') this.lobby = msg;
    for (const l of this.listeners) l(msg);
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    for (const l of this.closeListeners) l(reason);
    this.closeListeners.clear();
  }
}
