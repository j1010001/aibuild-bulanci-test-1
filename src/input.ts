// Keyboard -> an input target (spec §8: arrows or IJKL to move, Space to shoot as an
// edge). The target is whatever the local player drives: an InputSender for a session
// (practice or multiplayer), or anything else with the same two methods — an AI harness
// calls the very same methods, so there is no keyboard-only path.

import { directionForScreen } from './camera';
import type { Direction } from './sim';

// Derived from the camera's actual orientation (camera.ts), not hand-duplicated: "up"
// is whichever world direction the fixed camera renders as up-screen. Hardcoding both
// the camera azimuth and this table independently is exactly what caused arrow-up not
// to move up on screen — see camera.ts's regression note and tests/unit/camera.test.ts.
const UP = directionForScreen('up');
const DOWN = directionForScreen('down');
const LEFT = directionForScreen('left');
const RIGHT = directionForScreen('right');

const KEY_TO_DIR: Record<string, Direction> = {
  ArrowUp: UP,
  ArrowDown: DOWN,
  ArrowLeft: LEFT,
  ArrowRight: RIGHT,
  KeyI: UP,
  KeyK: DOWN,
  KeyJ: LEFT,
  KeyL: RIGHT,
};

export type InputTarget = {
  setMoveDir(dir: Direction | null): void;
  pressShoot(): void;
};

/** Keys typed into a form field are text, not movement (a name may contain I, J, K, L). */
export function isTyping(e: Event): boolean {
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable === true);
}

type KeyLike = Event & { code: string; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean };

export type KeyboardBinding = {
  dispose(): void;
  /** Re-sends the currently held direction to the current target (call when the target changes). */
  resync(): void;
};

/**
 * Wires keyboard events on `events` (the window, by default) to `getTarget()`. With no
 * target (menus), keys are only tracked, never swallowed, so Space still presses buttons
 * and arrows still scroll. Modifier chords (Cmd/Ctrl/Alt + key) are never movement:
 * browsers may not deliver the matching keyup, which would leave a direction stuck.
 */
export function bindKeyboard(getTarget: () => InputTarget | null, events: EventTarget = window): KeyboardBinding {
  const held: Direction[] = []; // most-recent-first priority stack

  function publish() {
    getTarget()?.setMoveDir(held[0] ?? null);
  }

  function onKeyDown(event: Event) {
    const e = event as KeyLike;
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = getTarget();
    if (e.code === 'Space') {
      if (!target) return;
      if (!e.repeat) target.pressShoot();
      e.preventDefault();
      return;
    }
    const dir = KEY_TO_DIR[e.code];
    if (!dir) return;
    if (target) e.preventDefault();
    const idx = held.indexOf(dir);
    if (idx !== -1) held.splice(idx, 1);
    held.unshift(dir);
    publish();
  }

  function onKeyUp(event: Event) {
    const e = event as KeyLike;
    const dir = KEY_TO_DIR[e.code];
    if (!dir) return;
    const idx = held.indexOf(dir);
    if (idx === -1) return;
    held.splice(idx, 1);
    publish();
  }

  // Keys released while the window is unfocused never send keyup.
  function onBlur() {
    held.length = 0;
    publish();
  }

  events.addEventListener('keydown', onKeyDown);
  events.addEventListener('keyup', onKeyUp);
  events.addEventListener('blur', onBlur);

  return {
    dispose() {
      events.removeEventListener('keydown', onKeyDown);
      events.removeEventListener('keyup', onKeyUp);
      events.removeEventListener('blur', onBlur);
    },
    resync: publish,
  };
}
