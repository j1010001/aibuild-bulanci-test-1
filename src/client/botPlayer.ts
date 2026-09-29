// A headless player: plays through any Session using the same view model and InputSender
// the UI uses, so a room of bots exercises the real client path. Lobby behavior: a guest
// readies itself; an owner with `host` settings applies them and starts a match whenever
// the start gate opens (so after each match it plays another). In a match it hunts the
// nearest opponent with chaseAndShoot, or stands still (`idle`, a target for tests).
// When it can't make progress — pinned against an edge or obstacle, or lined up behind a
// wall — it breaks out with a short move in a random (seeded) other direction.

import { DIRECTIONS, type Direction, type PlayerId, type Vec2 } from '../sim';
import { nextRandom, rngStateFromSeed } from '../sim/rng';
import type { ServerMessage } from '../session/protocol';
import { chaseAndShoot } from './bot';
import { InputSender } from './inputSender';
import { backToLobby, initialView, reduce, type ClientView } from './model';
import type { Session } from './session';

export type BotOptions = {
  strategy?: 'hunt' | 'idle';
  /** As the room owner: settings to apply, then start the match once everyone is ready. */
  host?: { mapId?: string; targetScore?: number; roundTime?: number };
  /** Seeds the bot's own randomness (reaction delays). Default: derived from its player id. */
  seed?: number;
  /** After lining up on a target, wait a random delay in this range (ms) before firing.
   * Without it, identical bots fire on the same tick and trade kills every round. */
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
/** Trying to move for this long without getting 0.3 units anywhere counts as stuck. */
const STUCK_MS = 1500;
const ESCAPE_MS: [number, number] = [500, 900];

export type MatchResult = { winnerId: PlayerId | null; scores: Record<PlayerId, number> };

export class BotPlayer {
  view: ClientView = initialView();
  /** Every match this bot has seen finish, oldest first. */
  readonly results: MatchResult[] = [];
  /** Set once the session ends, with the reason it gave. */
  closedReason: string | null = null;
  private readonly input: InputSender;
  private readonly strategy: 'hunt' | 'idle';
  private settingsSent = false;
  private startSent = false;
  private readySent = false;
  private lastInputAt = -Infinity;
  private lastShotAt = -Infinity;
  private aimedSince: number | null = null;
  private reaction = 0;
  private anchor: { pos: Vec2; at: number } | null = null;
  private escape: { dir: Direction; until: number } | null = null;
  private now = 0;
  private readonly rng: { rngState: number };

  constructor(
    private readonly session: Session,
    private readonly opts: BotOptions = {},
  ) {
    this.strategy = opts.strategy ?? 'hunt';
    this.rng = { rngState: rngStateFromSeed(opts.seed ?? 0) };
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
    const [min, max] = this.opts.reactionMs ?? [80, 250];
    return min + nextRandom(this.rng) * (max - min);
  }

  private onMessage(msg: ServerMessage): void {
    const wasEnded = this.view.screen === 'matchEnd';
    this.view = reduce(this.view, msg, this.now);
    if (msg.type === 'roomJoined' && this.opts.seed === undefined) this.rng.rngState = rngStateFromSeed(hashString(msg.playerId));
    if (msg.type === 'matchStart') {
      this.input.reset();
      this.lastShotAt = -Infinity;
      this.anchor = null;
      this.escape = null;
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
    const match = this.view.match;
    if (!snap || !meId || !match) return;
    const me = snap.players.find((p) => p.id === meId);
    if (!me || !me.alive) return this.stop();

    let target: PlayerId | null = null;
    let best = Infinity;
    for (const p of snap.players) {
      if (p.id === meId || !p.alive || !p.connected) continue;
      const d = Math.abs(p.pos.x - me.pos.x) + Math.abs(p.pos.y - me.pos.y);
      if (d < best) {
        best = d;
        target = p.id;
      }
    }
    if (target === null) return this.stop();

    if (this.escape && now < this.escape.until) return this.move(this.escape.dir, now);
    this.escape = null;

    const decision = chaseAndShoot(snap, meId, target, match.map.obstacles, match.config.bulletHeight);

    // Progress check: getting 0.3 units anywhere resets the clock.
    if (!this.anchor || Math.hypot(me.pos.x - this.anchor.pos.x, me.pos.y - this.anchor.pos.y) > 0.3) this.anchor = { pos: { ...me.pos }, at: now };
    const stuck = decision.moveDir !== null && now - this.anchor.at > STUCK_MS;
    if (decision.blocked || stuck) return this.startEscape(decision.moveDir, now);

    if (decision.moveDir === null) this.stop();
    else this.move(decision.moveDir, now);

    if (!decision.shoot) {
      this.aimedSince = null;
      return;
    }
    if (this.aimedSince === null) {
      this.aimedSince = now;
      this.reaction = this.nextReactionMs();
    }
    if (now - this.aimedSince >= this.reaction && now - this.lastShotAt >= match.config.cadence) {
      this.input.pressShoot();
      this.lastShotAt = now;
      this.aimedSince = null;
    }
  }

  /** Movement changes are throttled; stopping never is (a late stop means overshooting). */
  private move(dir: Direction, now: number): void {
    if (now - this.lastInputAt < MIN_INPUT_INTERVAL_MS) return;
    this.input.setMoveDir(dir); // sends only when it changed
    this.lastInputAt = now;
  }

  private stop(): void {
    this.input.setMoveDir(null);
  }

  private startEscape(avoid: Direction | null, now: number): void {
    const options = DIRECTIONS.filter((d) => d !== avoid);
    const dir = options[Math.floor(nextRandom(this.rng) * options.length)]!;
    const [min, max] = ESCAPE_MS;
    this.escape = { dir, until: now + min + nextRandom(this.rng) * (max - min) };
    this.anchor = null;
    this.aimedSince = null;
    this.lastInputAt = -Infinity; // the escape move itself goes out immediately
    this.move(dir, now);
  }
}
