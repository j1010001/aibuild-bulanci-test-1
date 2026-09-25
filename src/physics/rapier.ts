// Rapier3D needs one asynchronous WASM init before any of its synchronous API is usable
// (world creation, stepping, queries). Call `ensureRapierReady()` once at startup (or in
// a test's beforeAll) and await it; every other physics call in this codebase is
// synchronous after that, same as the rest of the sim.
import RAPIER from '@dimforge/rapier3d-compat';

let readyPromise: Promise<typeof RAPIER> | null = null;

export function ensureRapierReady(): Promise<typeof RAPIER> {
  if (!readyPromise) {
    readyPromise = RAPIER.init().then(() => RAPIER);
  }
  return readyPromise;
}

export type Rapier = typeof RAPIER;
export { RAPIER };
