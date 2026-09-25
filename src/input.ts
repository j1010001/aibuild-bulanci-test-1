// Keyboard -> GameApi. This is the only special-cased input path: it just calls the
// same setMoveDir/pressShoot methods an AI test script would call directly (spec §8:
// arrows or IJKL to move, Space to shoot as an edge).

import type { GameApi } from './api';
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

/** Wires keyboard events to drive `playerId` through `api`. Returns a cleanup function. */
export function bindKeyboard(api: GameApi, playerId: string): () => void {
  const held: Direction[] = []; // most-recent-first priority stack

  function publish() {
    api.setMoveDir(playerId, held[0] ?? null);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.code === 'Space') {
      if (!e.repeat) api.pressShoot(playerId);
      e.preventDefault();
      return;
    }
    const dir = KEY_TO_DIR[e.code];
    if (!dir) return;
    e.preventDefault();
    const idx = held.indexOf(dir);
    if (idx !== -1) held.splice(idx, 1);
    held.unshift(dir);
    publish();
  }

  function onKeyUp(e: KeyboardEvent) {
    const dir = KEY_TO_DIR[e.code];
    if (!dir) return;
    const idx = held.indexOf(dir);
    if (idx !== -1) held.splice(idx, 1);
    publish();
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  };
}
