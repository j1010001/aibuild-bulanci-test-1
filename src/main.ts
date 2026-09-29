// Page bootstrap: the App (screens + session), the renderer, the keyboard, and the
// fixed-timestep loop that ticks practice mode (a multiplayer match is ticked by the
// server). Everything a human does here goes through the same ClientMessages an AI
// harness can send via window.GameClient.

import { renderStateAt } from './client/interpolate';
import { renderStateOf } from './client/model';
import type { ClientView } from './client/model';
import type { GameApi } from './api';
import { ensureRapierReady } from './physics/rapier';
import { Renderer } from './render';
import type { ClientMessage } from './session/protocol';
import { NetSession } from './net/client';
import { serverUrl } from './net/serverUrl';
import { App } from './ui/app';

const SERVER_URL = serverUrl(import.meta.env.VITE_SERVER_URL as string | undefined, location);

const FIXED_DT = 1 / 60;
const MAX_CATCHUP_STEPS = 8; // guards against a huge dt after a tab was backgrounded

const canvas = document.getElementById('app') as HTMLCanvasElement;
const root = document.getElementById('ui') as HTMLElement;

async function main(): Promise<void> {
  await ensureRapierReady(); // practice runs the physics in the page
  const app = new App(root, canvas, (name, target) => new NetSession(SERVER_URL, target, name));
  const renderer = new Renderer(canvas);

  let paused = false;
  let lastTime = performance.now();
  let accumulator = 0;

  function frame(now: number): void {
    const elapsed = Math.min((now - lastTime) / 1000, MAX_CATCHUP_STEPS * FIXED_DT);
    lastTime = now;
    // Paused through either harness surface: GameClient.pause() or the practice GameApi's pause().
    const hold = paused || app.local?.room.gameApi?.isPaused() === true;
    if (app.local && !hold) {
      accumulator += elapsed;
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_CATCHUP_STEPS) {
        app.local.tick(FIXED_DT);
        accumulator -= FIXED_DT;
        steps += 1;
      }
    } else {
      accumulator = 0; // no burst catch-up after a pause
    }

    // Interpolate on the same clock that stamped the snapshots (performance.now(), not the
    // frame timestamp, which is earlier). A paused practice harness steps time itself, so
    // show exactly the latest state rather than a blend toward it.
    const rs = hold ? renderStateOf(app.view) : renderStateAt(app.view, performance.now());
    if (rs && (app.view.screen === 'match' || app.view.screen === 'matchEnd')) renderer.render(rs);
    app.frame(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.GameClient = {
    view: () => app.view,
    send: (msg) => app.send(msg),
    startPractice: (name) => app.startPractice(name),
    leave: () => app.leave(),
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    isPaused: () => paused,
    runTicks: (n, dt = FIXED_DT) => {
      for (let i = 0; i < n; i++) app.local?.tick(dt);
    },
  };
  Object.defineProperty(window, 'GameAPI', { get: () => app.local?.room.gameApi ?? null, configurable: true });
}

void main();

// window.GameClient drives the game exactly as the UI does (ClientMessages in, ClientView
// out). window.GameAPI is the practice room's GameApi, for direct sim introspection; it
// is null outside practice, since in multiplayer the simulation runs on the server.
declare global {
  interface Window {
    GameClient: {
      view(): ClientView;
      send(msg: ClientMessage): void;
      startPractice(name?: string): void;
      leave(): void;
      /** Practice only: stop the page loop from ticking, so runTicks() is the only clock. */
      pause(): void;
      resume(): void;
      isPaused(): boolean;
      runTicks(n: number, dt?: number): void;
    };
    readonly GameAPI: GameApi | null;
  }
}
