// Seeded PRNG (mulberry32) for all sim randomness. The generator's state lives in
// State.rngState as a plain number, so it is cloned with the rest of State by step() and
// serialized in snapshots. No sim state depends on Math.random (spec §4 determinism).

export function rngStateFromSeed(seed: number): number {
  return seed >>> 0;
}

/** Returns a float in [0, 1) and advances `holder.rngState`. */
export function nextRandom(holder: { rngState: number }): number {
  holder.rngState = (holder.rngState + 0x6d2b79f5) >>> 0;
  let t = holder.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
