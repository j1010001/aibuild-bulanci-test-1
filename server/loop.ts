// Fixed-rate tick loop (spec §12: 60 Hz). Drift-corrected: each tick is due at an absolute
// time (start + k·step), so late timer wake-ups catch up instead of slowing the game, and a
// long stall (a frozen process) catches up at most `maxCatchUp` ticks before resyncing.

export type TickLoopOptions = {
  hz?: number;
  maxCatchUp?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
};

export function startTickLoop(tick: (dt: number) => void, opts: TickLoopOptions = {}): { stop(): void } {
  const hz = opts.hz ?? 60;
  const stepMs = 1000 / hz;
  const dt = 1 / hz;
  const maxCatchUp = opts.maxCatchUp ?? 5;
  const now = opts.now ?? (() => performance.now());
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let next = now() + stepMs;
  let stopped = false;
  let pending: unknown;

  function wake(): void {
    if (stopped) return;
    const t = now();
    let steps = 0;
    while (t >= next && steps < maxCatchUp) {
      tick(dt);
      next += stepMs;
      steps += 1;
    }
    if (t >= next) next = t + stepMs; // too far behind: drop the backlog rather than spiral
    pending = schedule(wake, Math.max(0, next - now()));
  }

  pending = schedule(wake, stepMs);
  return {
    stop() {
      stopped = true;
      cancel(pending); // don't leave a timer keeping the process alive
    },
  };
}
