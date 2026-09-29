// M2 task 1: the server's fixed-rate tick loop (spec §12 "Authority and timing"),
// driven by a fake clock and scheduler so timing is exact and the test is instant.

import { describe, expect, it } from 'vitest';
import { startTickLoop } from '../../server/loop';

function fakeClock() {
  let now = 0;
  let pending: { at: number; fn: () => void } | null = null;
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      pending = { at: now + ms, fn };
    },
    /** Advance wall time, firing the scheduled wake-up whenever it comes due; `lateBy` delays each wake. */
    advance(ms: number, lateBy = 0) {
      const end = now + ms;
      while (pending && pending.at + lateBy <= end) {
        const p = pending;
        pending = null;
        now = p.at + lateBy;
        p.fn();
      }
      now = end;
    },
  };
}

describe('startTickLoop', () => {
  it('ticks 60 times per second of wall time with the fixed step', () => {
    const clock = fakeClock();
    const dts: number[] = [];
    startTickLoop((dt) => dts.push(dt), { now: clock.now, schedule: clock.schedule });
    clock.advance(1000);
    expect(dts.length).toBeGreaterThanOrEqual(59);
    expect(dts.length).toBeLessThanOrEqual(61);
    expect(new Set(dts)).toEqual(new Set([1 / 60]));
  });

  it('does not drift when every wake-up is late: late wakes catch up', () => {
    const clock = fakeClock();
    let ticks = 0;
    startTickLoop(() => ticks++, { now: clock.now, schedule: clock.schedule });
    clock.advance(10_000, 7); // each timer fires 7 ms late
    expect(ticks).toBeGreaterThanOrEqual(598);
    expect(ticks).toBeLessThanOrEqual(601);
  });

  it('after a long stall, catches up at most maxCatchUp ticks instead of spiralling', () => {
    const clock = fakeClock();
    let ticks = 0;
    startTickLoop(() => ticks++, { now: clock.now, schedule: clock.schedule, maxCatchUp: 5 });
    clock.advance(0);
    const before = ticks;
    clock.advance(5100, 5000); // the process was frozen for 5 s, then the timer finally fires
    expect(ticks - before).toBeGreaterThanOrEqual(1); // the late wake really happened
    expect(ticks - before).toBeLessThanOrEqual(5); // uncapped, this would be ~300 ticks at once
  });

  it('stop() cancels the pending wake-up (no timer left keeping the process alive)', () => {
    const cancelled: unknown[] = [];
    let handle = 0;
    const loop = startTickLoop(() => {}, {
      now: () => 0,
      schedule: () => ++handle,
      cancel: (h) => void cancelled.push(h),
    });
    loop.stop();
    expect(cancelled).toEqual([handle]);
  });

  it('stop() ends the loop', () => {
    const clock = fakeClock();
    let ticks = 0;
    const loop = startTickLoop(() => ticks++, { now: clock.now, schedule: clock.schedule });
    clock.advance(100);
    loop.stop();
    const at = ticks;
    clock.advance(1000);
    expect(ticks).toBe(at);
  });
});
