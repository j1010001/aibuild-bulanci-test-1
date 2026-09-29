// The DOM screens (spec §12 flow): Home → Practice / Create / Join → Lobby → Match →
// Match end → Lobby or Home. Every decision about which screen shows comes from the
// ClientView (src/client/model.ts); this file only draws it and forwards clicks as
// ClientMessages to the current Session.

import { hudModel } from '../client/hud';
import { lastRoomAfter, parseLastRoom, type LastRoom } from '../client/lastRoom';
import { InputSender } from '../client/inputSender';
import { LocalMatchSession, type LocalMatchOptions } from '../client/localMatchSession';
import { LocalSession } from '../client/localSession';
import { backToLobby, initialView, playerName, reduce, type ClientView } from '../client/model';
import type { JoinTarget, Session } from '../client/session';
import { bindKeyboard, type InputTarget, type KeyboardBinding } from '../input';
import { CONFIG_LIMITS, NAME_MAX_LENGTH, type ClientMessage, type JoinRejectReason, type ServerMessage } from '../session/protocol';
import { SKIN_PALETTE } from '../session/skins';
import { h, option } from './dom';


/** Opens a multiplayer session to the game server; null disables Create/Join (no server configured). */
export type Connect = (name: string, target: JoinTarget) => Session;

const NAME_KEY = 'bps.name';
const LAST_ROOM_KEY = 'bps.lastRoom'; // per tab: a reload or a dropped connection can rejoin
const ERROR_MS = 3000;

const REJECT_TEXT: Record<JoinRejectReason, string> = {
  notFound: 'No room with that code.',
  full: 'That room is full.',
  inProgress: 'That room is already playing a match.',
  badToken: 'Could not rejoin that room.',
  serverFull: 'The server is full right now. Try again in a moment.',
};

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? 'Player';
  } catch {
    return 'Player';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // storage unavailable (private mode): the name just isn't remembered
  }
}

/** Colors come from the server; only palette names are ever applied to a style. */
function skinColor(skinId: string): string {
  return SKIN_PALETTE.includes(skinId) ? skinId : '#888';
}

function loadLastRoom(): LastRoom | null {
  try {
    return parseLastRoom(sessionStorage.getItem(LAST_ROOM_KEY));
  } catch {
    return null;
  }
}

function saveLastRoom(room: LastRoom | null): void {
  try {
    if (room) sessionStorage.setItem(LAST_ROOM_KEY, JSON.stringify(room));
    else sessionStorage.removeItem(LAST_ROOM_KEY);
  } catch {
    // storage unavailable: rejoin after a reload just isn't offered
  }
}

function formatTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export class App {
  view: ClientView = initialView();
  /** A game running in this page (practice or vs bots), ticked by the page loop. */
  local: LocalSession | LocalMatchSession | null = null;
  private session: Session | null = null;
  private input: InputSender | null = null;
  private unsubscribers: (() => void)[] = [];
  private name = loadName();
  private errorShownAt = 0;
  private hudEl: HTMLElement | null = null;
  private hudKey = '';
  private autoStartSent = false;
  private readonly keyboard: KeyboardBinding;
  private target: JoinTarget | null = null; // how the current multiplayer session entered its room
  private connecting = false; // a multiplayer session is open but not yet in a room

  constructor(
    private readonly root: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly connect: Connect | null,
  ) {
    this.keyboard = bindKeyboard(() => this.inputTarget());
    this.draw();
  }

  // ---- Session lifecycle ----

  startPractice(name = this.name): void {
    const local = new LocalSession();
    this.attach(local);
    this.local = local;
    local.start(name);
  }

  /** Play vs bots: a local match that starts by itself (no lobby to click through). */
  startLocalMatch(opts: LocalMatchOptions, name = this.name): void {
    const local = new LocalMatchSession(opts);
    this.attach(local);
    this.local = local;
    local.start(name);
    this.draw();
  }

  /** After a local match vs bots: the next one, same bots and settings. */
  playAgain(): void {
    if (!(this.local instanceof LocalMatchSession)) return;
    this.local.playAgain();
    this.backToLobby();
  }

  startMultiplayer(target: JoinTarget, name = this.name): void {
    if (!this.connect) return;
    this.attach(this.connect(name, target));
    this.target = target;
    this.connecting = true;
    this.draw();
  }

  leave(): void {
    void this.session?.send({ type: 'leave' });
    if (this.session && !this.local) saveLastRoom(null); // leaving on purpose: nothing to rejoin
    this.detach();
    this.view = initialView();
    this.draw();
  }

  send(msg: ClientMessage): void {
    void this.session?.send(msg);
  }

  /** What the keyboard drives: only the local player, and only during a match. */
  inputTarget(): InputTarget | null {
    return this.view.screen === 'match' ? this.input : null;
  }

  private attach(session: Session): void {
    this.detach();
    this.view = initialView(); // nothing from a previous session may leak into this one
    this.autoStartSent = false;
    this.session = session;
    this.input = new InputSender((m) => void session.send(m));
    this.unsubscribers = [
      session.onMessage((m) => this.onMessage(m)),
      session.onClose((reason) => this.onSessionClosed(session, reason)),
    ];
  }

  private detach(): void {
    for (const off of this.unsubscribers) off(); // unsubscribe first: our own close() is not an event
    this.unsubscribers = [];
    this.session?.close();
    this.session = null;
    this.local = null;
    this.input = null;
    this.target = null;
    this.connecting = false;
  }

  private onSessionClosed(session: Session, reason: string): void {
    if (session !== this.session) return;
    this.detach();
    this.view = { ...initialView(), error: `Disconnected: ${reason}` };
    this.errorShownAt = performance.now();
    this.draw();
  }

  private onMessage(msg: ServerMessage): void {
    const before = this.view;
    this.view = reduce(this.view, msg, performance.now());
    if (msg.type === 'error' || msg.type === 'joinRejected' || msg.type === 'replaced') this.errorShownAt = performance.now();
    // Practice has no lobby to show: start once, as soon as the practice room is ready.
    // (Once only: a failing start answers with error + lobby, which must not loop.)
    if (msg.type === 'lobby' && msg.practice && msg.canStart && !this.autoStartSent) {
      this.autoStartSent = true;
      this.send({ type: 'startMatch' });
    }
    if (msg.type === 'matchStart') {
      this.input?.reset(); // the new match's game starts with nobody moving
      this.keyboard.resync(); // …so re-send whatever direction is held right now
    }
    if (!this.local && (msg.type === 'roomJoined' || msg.type === 'replaced' || msg.type === 'joinRejected')) {
      saveLastRoom(lastRoomAfter(loadLastRoom(), msg, false));
    }
    if (msg.type === 'roomJoined') this.connecting = false;
    if (msg.type === 'replaced') {
      // Detach now, so the "opened in another tab" notice isn't overwritten by the
      // generic "Disconnected" that the server's close would otherwise produce.
      this.detach();
      this.view = { ...initialView(), error: this.view.error };
      this.draw();
      return;
    }
    if (msg.type === 'joinRejected') {
      const target = this.target;
      this.detach(); // the view keeps `rejected` for the home screen; attach() resets the rest
      // The seat is gone (the player left the lobby, or the match ended without them) but
      // the room may still exist: join it afresh instead of giving up.
      if (msg.reason === 'badToken' && target?.kind === 'rejoin') return this.startMultiplayer({ kind: 'join', code: target.code });
      this.draw();
      return;
    }
    if (this.needsRedraw(before)) this.draw();
  }

  private needsRedraw(before: ClientView): boolean {
    const v = this.view;
    return before.screen !== v.screen || before.lobby !== v.lobby || before.result !== v.result || before.error !== v.error || before.rejected !== v.rejected;
  }

  // ---- Per-frame (HUD) ----

  frame(now: number): void {
    if (this.hudEl && this.view.screen === 'match') this.fillHud(this.hudEl, now);
    const toast = this.root.querySelector<HTMLElement>('.toast');
    if (toast) toast.hidden = !(this.view.error && now - this.errorShownAt < ERROR_MS);
  }

  // ---- Drawing ----

  private draw(): void {
    const v = this.view;
    if (this.connecting && v.screen === 'home') {
      this.canvas.style.visibility = 'hidden';
      this.root.replaceChildren(
        h('div', { class: 'panel' }, ['Connecting to the game server…', h('button', { on: { click: () => this.leave() } }, ['Cancel'])]),
      );
      this.root.dataset.screen = 'home';
      return;
    }
    // Keep the focus (and caret) in a settings field across a redraw triggered by someone else.
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.key : undefined;
    this.canvas.style.visibility = v.screen === 'match' || v.screen === 'matchEnd' ? 'visible' : 'hidden';
    this.hudEl = null;
    const screen =
      v.screen === 'home' ? this.homeScreen() : v.screen === 'lobby' ? this.lobbyScreen() : v.screen === 'match' ? this.matchScreen() : this.matchEndScreen();
    this.root.replaceChildren(screen, h('div', { class: 'toast' }, [v.error ?? '']));
    this.root.dataset.screen = v.screen;
    if (focused) this.root.querySelector<HTMLElement>(`[data-key="${focused}"]`)?.focus();
  }

  private homeScreen(): HTMLElement {
    const nameInput = h('input', { class: 'name', value: this.name, maxLength: NAME_MAX_LENGTH, placeholder: 'Your name' }) as HTMLInputElement;
    const codeInput = h('input', { class: 'code', maxLength: 6, placeholder: 'CODE' }) as HTMLInputElement;
    const currentName = () => {
      const n = nameInput.value.trim() || 'Player';
      this.name = n;
      saveName(n);
      return n;
    };
    const noServer = this.connect ? undefined : 'No game server is configured.';
    const join = () => {
      const code = codeInput.value.trim().toUpperCase();
      if (code.length >= 5) this.startMultiplayer({ kind: 'join', code }, currentName());
    };
    codeInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') join();
    });

    const lastRoom = this.connect ? loadLastRoom() : null;
    return h('div', { class: 'panel home' }, [
      h('h1', {}, ['Browser Party Shooter']),
      h('label', {}, ['Name', nameInput]),
      lastRoom
        ? h('button', { class: 'primary', on: { click: () => this.startMultiplayer({ kind: 'rejoin', ...lastRoom }, currentName()) } }, [
            `Rejoin room ${lastRoom.code}`,
          ])
        : null,
      h('button', { class: lastRoom ? '' : 'primary', on: { click: () => this.startPractice(currentName()) } }, ['Practice']),
      h('button', { disabled: !this.connect, title: noServer, on: { click: () => this.startMultiplayer({ kind: 'create' }, currentName()) } }, ['Create game']),
      h('div', { class: 'row' }, [codeInput, h('button', { disabled: !this.connect, title: noServer, on: { click: join } }, ['Join'])]),
      h('button', { disabled: true, title: 'The level editor arrives in milestone M3.' }, ['Level editor']),
      this.view.rejected ? h('p', { class: 'warn' }, [REJECT_TEXT[this.view.rejected]]) : null,
      h('p', { class: 'hint' }, ['Arrows or I J K L move · Space shoots']),
    ]);
  }

  private lobbyScreen(): HTMLElement {
    const v = this.view;
    const lobby = v.lobby;
    if (!lobby) return h('div', { class: 'panel' }, ['Joining…']);
    if (lobby.practice) return h('div', { class: 'panel' }, ['Starting practice…']);
    if (this.local instanceof LocalMatchSession) return h('div', { class: 'panel' }, ['Starting the match…']);
    const me = lobby.players.find((p) => p.id === v.playerId);
    const isOwner = lobby.ownerId === v.playerId;
    const taken = new Set(lobby.players.filter((p) => p.id !== v.playerId).map((p) => p.skinId));

    const players = h(
      'ul',
      { class: 'players' },
      lobby.players.map((p) =>
        h('li', {}, [
          h('span', { class: 'swatch', style: { background: skinColor(p.skinId) } }),
          h('span', { class: 'pname' }, [p.name]),
          p.id === lobby.ownerId ? h('span', { class: 'tag' }, ['owner']) : null,
          p.id === v.playerId ? h('span', { class: 'tag you' }, ['you']) : null,
          h('span', { class: `status ${p.ready || p.id === lobby.ownerId ? 'ready' : ''}` }, [p.id === lobby.ownerId ? '' : p.ready ? 'ready' : 'not ready']),
        ]),
      ),
    );

    const skins = h(
      'div',
      { class: 'skins' },
      SKIN_PALETTE.map((s) =>
        h('button', {
          class: `skin ${me?.skinId === s ? 'mine' : ''}`,
          style: { background: s },
          title: s,
          disabled: taken.has(s),
          on: { click: () => this.send({ type: 'setSkin', skinId: s }) },
        }),
      ),
    );

    const mapSelect = document.createElement('select');
    for (const m of lobby.maps) mapSelect.append(option(m.id, m.name, m.id === lobby.settings.mapId));
    mapSelect.disabled = !isOwner;
    mapSelect.dataset.key = 'mapId';
    mapSelect.addEventListener('change', () => this.send({ type: 'setMap', mapId: mapSelect.value }));

    const numberInput = (key: 'targetScore' | 'roundTime') => {
      const limits = CONFIG_LIMITS[key];
      const input = h('input', {
        type: 'number',
        value: String(lobby.settings[key]),
        min: limits.min,
        max: limits.max,
        disabled: !isOwner,
        data: { key },
      }) as HTMLInputElement;
      input.addEventListener('change', () => this.send({ type: 'setConfig', config: { [key]: Number(input.value) } }));
      return input;
    };

    return h('div', { class: 'panel lobby' }, [
      h('div', { class: 'code-big', title: 'Share this code' }, ['Room ', h('strong', {}, [lobby.code])]),
      players,
      h('h3', {}, ['Your color']),
      skins,
      h('h3', {}, ['Match']),
      h('label', {}, ['Map', mapSelect]),
      h('label', {}, ['Round wins to win', numberInput('targetScore')]),
      h('label', {}, ['Round time (s)', numberInput('roundTime')]),
      h('div', { class: 'row' }, [
        isOwner
          ? h('button', { class: 'primary', disabled: !lobby.canStart, on: { click: () => this.send({ type: 'startMatch' }) } }, [
              lobby.canStart ? 'Start match' : 'Waiting for players…',
            ])
          : h('button', { class: 'primary', on: { click: () => this.send({ type: 'setReady', ready: !me?.ready }) } }, [me?.ready ? 'Not ready' : 'Ready']),
        h('button', { on: { click: () => this.leave() } }, ['Leave']),
      ]),
    ]);
  }

  private matchScreen(): HTMLElement {
    const hud = h('div', { class: 'hud' });
    this.hudEl = hud;
    this.hudKey = '';
    this.fillHud(hud, performance.now());
    return h('div', { class: 'match' }, [hud, h('button', { class: 'leave', on: { click: () => this.leave() } }, ['Leave'])]);
  }

  private fillHud(el: HTMLElement, now: number): void {
    const m = hudModel(this.view, now);
    const key = JSON.stringify(m);
    if (key === this.hudKey) return; // rebuild only when something shown actually changed
    this.hudKey = key;
    const parts: (HTMLElement | null)[] = [
      h('div', { class: 'clock' }, [`Round ${m.round} · ${formatTime(m.secondsLeft)}`]),
      h(
        'ul',
        { class: 'scores' },
        m.scores.map((r) =>
          h('li', { class: `${r.alive ? '' : 'dead'} ${r.connected ? '' : 'gone'}` }, [
            h('span', { class: 'swatch', style: { background: skinColor(r.skinId) } }),
            h('span', { class: 'pname' }, [r.you ? `${r.name} (you)` : r.name]),
            h('span', { class: 'score' }, [r.score]),
          ]),
        ),
      ),
      m.banner ? h('div', { class: 'banner' }, [m.banner]) : null,
    ];
    el.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
  }

  private matchEndScreen(): HTMLElement {
    const v = this.view;
    const result = v.result;
    const winner = result?.winnerId ? playerName(v, result.winnerId) : null;
    const rows = Object.entries(result?.scores ?? {}).sort((a, b) => b[1] - a[1]);
    return h('div', { class: 'panel matchend' }, [
      h('h2', {}, [winner ? `${winner} wins the match` : 'Match over — no winner']),
      h(
        'ul',
        { class: 'players' },
        rows.map(([id, score]) => h('li', {}, [h('span', { class: 'pname' }, [playerName(v, id)]), h('span', { class: 'score' }, [score])])),
      ),
      h('div', { class: 'row' }, [
        this.local instanceof LocalMatchSession
          ? h('button', { class: 'primary', on: { click: () => this.playAgain() } }, ['Play again'])
          : v.lobby?.practice
            ? null
            : h('button', { class: 'primary', on: { click: () => this.backToLobby() } }, ['Back to lobby']),
        h('button', { on: { click: () => this.leave() } }, [this.local ? 'Home' : 'Leave']),
      ]),
    ]);
  }

  private backToLobby(): void {
    this.view = backToLobby(this.view);
    this.draw();
  }
}
