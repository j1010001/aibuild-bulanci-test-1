// Wires GameApi (sim) -> Renderer (three.js) -> keyboard input. The important property:
// this file is a thin adapter. Everything it does through `api` is exactly what an AI
// test script can do too — see window.GameAPI exposed below.

import { api } from './api';
import { bindKeyboard } from './input';
import { Renderer } from './render';

const FIXED_DT = 1 / 60;
const MAX_CATCHUP_STEPS = 8; // guards against a huge dt after a tab was backgrounded

const canvas = document.getElementById('app') as HTMLCanvasElement;
const hud = document.getElementById('hud');

// start() is async only because the physics engine's WASM module needs one await the
// first time it's used (src/physics/rapier.ts) — everything after this is synchronous.
async function main(): Promise<void> {
  api.setRoster([{ name: 'You' }, { name: 'Player 2' }]);
  await api.start();

  const localPlayerId = api.getRoster()[0]!.id;
  bindKeyboard(api, localPlayerId);

  const renderer = new Renderer(canvas, hud);

  let lastTime = performance.now();
  let accumulator = 0;

  function frame(now: number): void {
    if (api.isPaused()) {
      // Don't advance automatically — an AI/test harness is driving tick()/runTicks()
      // explicitly and doesn't want this loop racing it (api.pause()). Keep rendering
      // so its explicit ticks are still visible, and keep resetting the clock so a
      // resume() doesn't see a huge elapsed gap and burst-catch-up.
      lastTime = now;
      accumulator = 0;
      renderer.render(api.getState());
      requestAnimationFrame(frame);
      return;
    }

    const elapsed = Math.min((now - lastTime) / 1000, MAX_CATCHUP_STEPS * FIXED_DT);
    lastTime = now;
    accumulator += elapsed;

    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_CATCHUP_STEPS) {
      api.tick(FIXED_DT);
      accumulator -= FIXED_DT;
      steps += 1;
    }

    renderer.render(api.getState());
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

void main();

// Exposed so a human can play with the keyboard while an AI/test harness drives other
// players (or the same one) from the devtools console or an automated script, at any
// speed — runTicks() advances the sim without waiting on rAF or touching the DOM.
declare global {
  interface Window {
    GameAPI: typeof api;
  }
}
window.GameAPI = api;
