// Game harness that wires the pure `sim` core to the browser: input events,
// the requestAnimationFrame loop, and the `window.__game` test hook.
//
// The test hook (spec §9) is what makes Playwright layer-3 assertions possible.
// Gameplay issues extend `press()` mapping and `getState()` shape.

import { createPracticeState, step, type Input, type MoveDir, type State } from "./sim/state";

export interface GameHandle {
  getState(): State;
  press(key: string): void;
  destroy(): void;
}

const KEY_MOVE_MAP: Record<string, MoveDir> = {
  ArrowUp: "+Y",
  ArrowDown: "-Y",
  ArrowLeft: "-X",
  ArrowRight: "+X",
  KeyI: "+Y",
  KeyK: "-Y",
  KeyJ: "-X",
  KeyL: "+X",
};

const SHOOT_KEY = "Space";
const PRACTICE_PLAYER_ID = "practice-1";
const FIXED_DT = 1 / 60;

export function startPracticeGame(): GameHandle {
  let state: State = createPracticeState();
  let queued: Input[] = [];
  let rafId: number | null = null;
  let running = true;

  const loop = (): void => {
    if (!running) return;
    const inputs = queued;
    queued = [];
    state = step(state, inputs, FIXED_DT).state;
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);

  const press = (key: string): void => {
    const moveDir = KEY_MOVE_MAP[key];
    if (moveDir !== undefined) {
      queued.push({ playerId: PRACTICE_PLAYER_ID, moveDir, shoot: false });
      return;
    }
    if (key === SHOOT_KEY) {
      queued.push({ playerId: PRACTICE_PLAYER_ID, moveDir: "none", shoot: true });
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    press(event.code);
  };
  window.addEventListener("keydown", onKeyDown);

  const destroy = (): void => {
    running = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
    window.removeEventListener("keydown", onKeyDown);
  };

  return {
    getState: () => state,
    press,
    destroy,
  };
}

// Idempotent hook installer: sets `window.__game` in dev builds only.
// Production builds must exclude this (spec §9).
export function installTestHook(handle: GameHandle): void {
  if (!import.meta.env.DEV) return;
  const w = window as unknown as { __game?: GameHandle };
  w.__game = handle;
}
