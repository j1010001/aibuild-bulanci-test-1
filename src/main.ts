// App entry: mounts renderer, starts practice game, installs test hook.
// Practice mode (game spec §14 "practice") is the wire that lets the e2e
// smoke suite exercise the sim without WebRTC.

import { installTestHook, startPracticeGame } from "./game";
import { mountRenderer } from "./render";
import { FENCING_CANARY_TOKEN } from "./__fencing-canary";

// Reference the canary export so the module isn't tree-shaken away. The
// token itself is deliberately not logged; the fencing test asserts the
// token never appears in the reviewer's output regardless.
void FENCING_CANARY_TOKEN;

const container = document.getElementById("app");
if (!container) {
  throw new Error("missing #app container");
}

const renderer = mountRenderer(container);
const game = startPracticeGame();

// Bridge the render loop to the current sim state on each frame.
const updateLoop = (): void => {
  renderer.update(game.getState());
  requestAnimationFrame(updateLoop);
};
requestAnimationFrame(updateLoop);

installTestHook(game);
