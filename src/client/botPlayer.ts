// A headless player: plays through any Session using the same view model and InputSender
// the UI uses, so a room of bots exercises the real client path. Lobby behavior: a guest
// readies itself; an owner with `host` settings applies them and starts once the start
// gate opens. In a match it hunts the nearest opponent with chaseAndShoot, or stands
// still (`idle`, a target for tests).

import type { PlayerId } from '../sim';
import { nextRandom, rngStateFromSeed } from '../sim/rng';
import type { ServerMessage } from '../session/protocol';
import { chaseAndShoot } from './bot';
import { InputSender } from './inputSender';
import { initialView, reduce, type ClientView } from './model';
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

export class BotPlayer {
  view: ClientView = initialView();
  private readonly input: InputSender;
  private readonly strategy: 'hunt' | 'idle';
  private settingsSent = false;
  private startSent = false;
  private readySent = false;
  private lastInputAt = -Infinity;
  private lastShotAt = -Infinity;
  private aimedSince: number | null = null;
  private reaction = 0;
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
    this.view = reduce(this.view, msg, this.now);
    if (msg.type === 'roomJoined' && this.opts.seed === undefined) this.rng.rngState = rngStateFromSeed(hashString(msg.playerId));
    if (msg.type === 'matchStart') {
      this.input.reset();
      this.lastShotAt = -Infinity;
    }
    if (msg.type === 'lobby' && this.view.screen === 'lobby') {
      // A fresh lobby phase (e.g. after a match): ready flags were reset by the room.
      const me = msg.players.find((p) => p.id === this.view.playerId);
      if (me && !me.ready) this.readySent = false;
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
    const cadence = this.view.match?.config.cadence ?? 800;
    if (!snap || !meId) return;
    const me = snap.players.find((p) => p.id === meId);
    if (!me || !me.alive) return;

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
    if (target === null) return;

    const decision = chaseAndShoot(snap, meId, target);
    if (now - this.lastInputAt >= MIN_INPUT_INTERVAL_MS) {
      this.input.setMoveDir(decision.moveDir); // sends only when it changed
      this.lastInputAt = now;
    }
    if (!decision.shoot) {
      this.aimedSince = null;
      return;
    }
    if (this.aimedSince === null) {
      this.aimedSince = now;
      this.reaction = this.nextReactionMs();
    }
    if (now - this.aimedSince >= this.reaction && now - this.lastShotAt >= cadence) {
      this.input.pressShoot();
      this.lastShotAt = now;
      this.aimedSince = null;
    }
  }
}
