// A headless player: plays through any Session using the same view model and InputSender
// the UI uses, so a room of bots exercises the real client path. Lobby behavior: a guest
// readies itself; an owner with `host` settings applies them and starts a match whenever
// the start gate opens (so after each match it plays another). In a match the BotBrain
// (src/client/bots/brain.ts) decides every move from what a player can see, at the
// chosen difficulty; `idle` stands still instead (a target for tests).

import type { Direction, PlayerId } from '../sim';
import type { ServerMessage } from '../session/protocol';
import { BotBrain } from './bots/brain';
import { DIFFICULTY, type Difficulty } from './bots/difficulty';
import { InputSender } from './inputSender';
import { backToLobby, initialView, reduce, type ClientView } from './model';
import type { Session } from './session';

export type BotOptions = {
  strategy?: 'hunt' | 'idle';
  /** How well it plays (default normal). */
  difficulty?: Difficulty;
  /** As the room owner: settings to apply, then start the match once everyone is ready. */
  host?: { mapId?: string; targetScore?: number; roundTime?: number };
  /** Seeds the bot's own randomness. Default: derived from its player id. */
  seed?: number;
  /** Overrides the difficulty's reaction delay range (ms). */
  reactionMs?: [number, number];
};

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Movement changes are sent at most this often, keeping a bot far below the server's
 * 30 messages/second limit even if its target makes it change its mind every snapshot. */
const MIN_INPUT_INTERVAL_MS = 50;

export type MatchResult = { winnerId: PlayerId | null; scores: Record<PlayerId, number> };

export class BotPlayer {
  view: ClientView = initialView();
  /** Every match this bot has seen finish, oldest first. */
  readonly results: MatchResult[] = [];
  /** Set once the session ends, with the reason it gave. */
  closedReason: string | null = null;
  private readonly input: InputSender;
  private readonly strategy: 'hunt' | 'idle';
  private readonly brain: BotBrain;
  private settingsSent = false;
  private startSent = false;
  private readySent = false;
  private lastInputAt = -Infinity;
  private now = 0;

  constructor(
    private readonly session: Session,
    private readonly opts: BotOptions = {},
  ) {
    this.strategy = opts.strategy ?? 'hunt';
    const profile = DIFFICULTY[opts.difficulty ?? 'normal'];
    this.brain = new BotBrain(opts.reactionMs ? { ...profile, reactionMs: opts.reactionMs } : profile, opts.seed ?? 0);
    this.input = new InputSender((m) => void session.send(m));
    session.onMessage((m) => this.onMessage(m));
    session.onClose((reason) => {
      this.closedReason = reason;
    });
  }

  /** For sessions that join on demand (InProcessSession); a NetSession connects on its own. */
  connect(): void {
    (this.session as Partial<{ connect(): void }>).connect?.();
  }

  close(): void {
    this.session.close();
  }

  /** Decide and act once; call regularly (every tick or every few tens of ms). */
  step(now: number): void {
    this.now = now;
    const v = this.view;
    if (v.screen === 'lobby' && v.lobby && v.playerId) this.lobbyStep(v.playerId);
    else if (v.screen === 'match' && this.strategy === 'hunt') this.huntStep(now);
  }

  /** The next reaction delay (ms), from this bot's seeded generator. */
  nextReactionMs(): number {
    return this.brain.nextReactionMs();
  }

  private onMessage(msg: ServerMessage): void {
    const wasEnded = this.view.screen === 'matchEnd';
    this.view = reduce(this.view, msg, this.now);
    if (msg.type === 'roomJoined' && this.opts.seed === undefined) this.brain.reseed(hashString(msg.playerId));
    if (msg.type === 'matchStart') {
      this.input.reset();
      this.brain.setMatch(msg.map, msg.config);
    }
    if (msg.type === 'snapshot' && this.view.screen === 'matchEnd' && !wasEnded && this.view.result) {
      this.results.push(this.view.result);
    }
    if (msg.type === 'lobby' && this.view.screen === 'matchEnd') {
      // Unlike a person, a bot doesn't linger on the results: straight back to the lobby.
      this.view = backToLobby(this.view);
    }
    if (msg.type === 'lobby' && this.view.screen === 'lobby') {
      // A fresh lobby phase (e.g. after a match): the room reset every ready flag.
      const me = msg.players.find((p) => p.id === this.view.playerId);
      if (me && !me.ready) this.readySent = false;
      if (!msg.canStart) this.startSent = false; // start again once the gate reopens
    }
  }

  private lobbyStep(me: PlayerId): void {
    const lobby = this.view.lobby!;
    if (lobby.ownerId === me) {
      const host = this.opts.host;
      if (!host) return; // a bot owner without host settings leaves starting to a human
      if (!this.settingsSent) {
        this.settingsSent = true;
        if (host.mapId) void this.session.send({ type: 'setMap', mapId: host.mapId });
        const config = { targetScore: host.targetScore, roundTime: host.roundTime };
        if (config.targetScore !== undefined || config.roundTime !== undefined) {
          void this.session.send({ type: 'setConfig', config: JSON.parse(JSON.stringify(config)) });
        }
        return;
      }
      if (lobby.canStart && !this.startSent) {
        this.startSent = true;
        void this.session.send({ type: 'startMatch' });
      }
    } else if (!this.readySent && !lobby.players.find((p) => p.id === me)?.ready) {
      this.readySent = true;
      void this.session.send({ type: 'setReady', ready: true });
    }
  }

  private huntStep(now: number): void {
    const snap = this.view.snapshot;
    const meId = this.view.playerId;
    if (!snap || !meId) return;
    const decision = this.brain.decide(snap, meId, now);
    if (decision.moveDir === null) this.stop();
    else this.move(decision.moveDir, now);
    if (decision.shoot) this.input.pressShoot();
  }

  /** Movement changes are throttled; stopping never is (a late stop means overshooting). */
  private move(dir: Direction, now: number): void {
    if (now - this.lastInputAt < MIN_INPUT_INTERVAL_MS) return;
    // Only an actual send starts the interval: holding a direction must not delay a turn.
    if (this.input.setMoveDir(dir)) this.lastInputAt = now;
  }

  private stop(): void {
    this.input.setMoveDir(null);
  }
}
