// GameApi — the single control surface for the game. Keyboard input (src/input.ts) and
// an AI/test harness both drive the sim through these same calls, so there is no
// UI-only path: anything a human can do, a script can do identically, and faster
// (runTicks advances the simulation without waiting on real time or a render frame).
//
// DOM-free and importable from the browser, from Node test scripts, or from vitest.

import { createGame, DEFAULT_CONFIG, DEFAULT_MAP, step, toSnapshot } from './sim';
import type { Config, Direction, GameEvent, MapDef, Player, PlayerId, PublicState, State } from './sim';
import { ensureRapierReady } from './physics/rapier';

export type RosterSeed = { name: string; skinId?: string };

const SKIN_PALETTE = ['crimson', 'gold', 'teal', 'violet', 'orange', 'lime', 'skyblue', 'hotpink'];

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export class GameApi {
  private state: State | null = null;
  private roster: { id: PlayerId; name: string; skinId: string }[] = [];
  private moveDirs = new Map<PlayerId, Direction | null>();
  private shootEdges = new Set<PlayerId>();
  private eventLog: GameEvent[] = [];
  private tickCount = 0;
  private nextPlayerSeq = 0;
  private paused = false;

  // ---- Roster / lifecycle (spec §12 lobby, simplified — no networking) ----

  setRoster(entries: readonly RosterSeed[]): void {
    this.roster = entries.map((e, i) => ({
      id: `p${this.nextPlayerSeq++}`,
      name: e.name,
      skinId: e.skinId ?? SKIN_PALETTE[i % SKIN_PALETTE.length]!,
    }));
  }

  addPlayer(name: string, skinId?: string): PlayerId {
    const id = `p${this.nextPlayerSeq++}`;
    this.roster.push({ id, name, skinId: skinId ?? SKIN_PALETTE[this.roster.length % SKIN_PALETTE.length]! });
    return id;
  }

  getRoster(): readonly { id: PlayerId; name: string; skinId: string }[] {
    return this.roster;
  }

  /**
   * Creates the running game from the current roster (spec: "the roster is fixed from
   * this moment"). Async only because the physics engine's WASM module needs one
   * await the first time it's used per page/process (src/physics/rapier.ts) — every
   * other call on GameApi, including tick()/runTicks(), is synchronous after that.
   */
  async start(configOverrides: Partial<Config> = {}, map: MapDef = DEFAULT_MAP): Promise<void> {
    if (this.roster.length === 0) {
      throw new Error('GameApi.start: add at least one player to the roster first');
    }
    const RAPIER = await ensureRapierReady();
    this.state?.physics.dispose();
    const { state, events } = createGame(RAPIER, configOverrides, map, this.roster);
    this.state = state;
    this.eventLog = [...events];
    this.tickCount = 0;
    this.moveDirs.clear();
    this.shootEdges.clear();
    this.paused = false;
  }

  reset(): void {
    this.state?.physics.dispose();
    this.state = null;
    this.roster = [];
    this.moveDirs.clear();
    this.shootEdges.clear();
    this.eventLog = [];
    this.tickCount = 0;
    this.nextPlayerSeq = 0;
    this.paused = false;
  }

  isRunning(): boolean {
    return this.state !== null;
  }

  // ---- Pausing the *automatic* loop (main.ts's rAF-driven real-time ticking) ----
  //
  // tick()/runTicks() always run when called explicitly, paused or not — pausing only
  // tells main.ts's render loop to stop calling them on its own. Without this, a script
  // driving runTicks() from the console races the live page's own real-time loop, which
  // keeps ticking between the script's calls and silently double-advances state. See
  // spec §4 and the regression note in the project report this follows up on.

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  // ---- Input: keyboard and AI call these identically ----

  setMoveDir(playerId: PlayerId, dir: Direction | null): void {
    this.moveDirs.set(playerId, dir);
  }

  /** Marks a shoot edge for exactly the next tick() call (mirrors a keydown edge). */
  pressShoot(playerId: PlayerId): void {
    this.shootEdges.add(playerId);
  }

  disconnectPlayer(playerId: PlayerId): void {
    const state = this.requireState();
    const p = state.players.find((pl) => pl.id === playerId);
    if (!p) return;
    p.connected = false;
    state.physics.setPlayerEnabled(playerId, false); // inert (spec §10) — not a target, doesn't block movement
  }

  reconnectPlayer(playerId: PlayerId): void {
    const state = this.requireState();
    const p = state.players.find((pl) => pl.id === playerId);
    if (!p) return;
    p.connected = true;
    if (p.alive) state.physics.setPlayerEnabled(playerId, true);
  }

  // ---- Advancing the simulation ----

  /** Advances one fixed step. Returns events emitted this tick. */
  tick(dtSeconds = 1 / 60): GameEvent[] {
    const state = this.requireState();
    const inputs: Record<PlayerId, { moveDir: Direction | null; shoot: boolean }> = {};
    for (const p of state.players) {
      inputs[p.id] = {
        moveDir: this.moveDirs.get(p.id) ?? null,
        shoot: this.shootEdges.has(p.id),
      };
    }
    this.shootEdges.clear();

    const result = step(state, inputs, dtSeconds);
    this.state = result.state;
    this.tickCount += 1;
    this.eventLog.push(...result.events);
    return result.events;
  }

  /** Advances `n` ticks back-to-back with no rendering — the fast path for AI testing. */
  runTicks(n: number, dtSeconds = 1 / 60): GameEvent[] {
    const events: GameEvent[] = [];
    for (let i = 0; i < n; i++) {
      events.push(...this.tick(dtSeconds));
      if (this.state && this.state.phase === 'matchEnd') break;
    }
    return events;
  }

  // ---- Introspection ----

  /** A deep, JSON-safe snapshot (excludes the live physics handle) — safe to hand to a remote AI harness or log. */
  getState(): PublicState {
    return toSnapshot(this.requireState());
  }

  getPlayer(playerId: PlayerId): Player | undefined {
    return this.requireState().players.find((p) => p.id === playerId);
  }

  getConfig(): Config {
    return clone(this.requireState().config);
  }

  getTickCount(): number {
    return this.tickCount;
  }

  /** Full event log since start(); pass `since` to page from a previously-seen index. */
  getEvents(since = 0): GameEvent[] {
    return this.eventLog.slice(since);
  }

  private requireState(): State {
    if (this.state === null) throw new Error('GameApi: call start() before interacting with the game');
    return this.state;
  }
}

export const api = new GameApi();
export { DEFAULT_MAP, DEFAULT_CONFIG };
