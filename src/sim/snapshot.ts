// State.physics is a live handle into the real 3D collision world (see types.ts) — not
// JSON-safe, and not meant to leave the sim. Everything the API/renderer/tests actually
// need (positions, facing, alive/connected, scores, bullets, phase) is plain data;
// toSnapshot() strips the physics handle and deep-clones the rest.

import type { PublicState, State } from './types';

export function toSnapshot(state: State): PublicState {
  const { physics: _physics, ...rest } = state;
  return JSON.parse(JSON.stringify(rest)) as PublicState;
}
