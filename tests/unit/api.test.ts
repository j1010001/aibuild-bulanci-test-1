// GameApi.pause()/resume(): regression coverage for the runTicks()-vs-live-render-loop
// double-advance issue found while playtesting through the browser. pause() must only
// stop main.ts's *automatic* loop from calling tick() on its own — it must never gate
// tick()/runTicks() themselves, since an AI harness calling them explicitly (paused or
// not) is exactly the deterministic path this exists to support.

import { beforeEach, describe, expect, it } from 'vitest';
import { GameApi } from '../../src/api';

describe('GameApi pause/resume', () => {
  let api: GameApi;

  beforeEach(async () => {
    api = new GameApi();
    api.setRoster([{ name: 'A' }, { name: 'B' }]);
    await api.start({ practice: true });
  });

  it('starts unpaused', () => {
    expect(api.isPaused()).toBe(false);
  });

  it('pause()/resume() toggle isPaused()', () => {
    api.pause();
    expect(api.isPaused()).toBe(true);
    api.resume();
    expect(api.isPaused()).toBe(false);
  });

  it('tick() advances the sim identically whether paused or not', () => {
    const before = api.getTickCount();
    api.pause();
    api.tick();
    api.tick();
    expect(api.getTickCount()).toBe(before + 2);
  });

  it('runTicks() advances the sim identically whether paused or not', () => {
    const roster = api.getRoster();
    api.pause();
    api.setMoveDir(roster[0]!.id, '+X');
    api.runTicks(30);
    expect(api.getTickCount()).toBe(30);
    expect(api.getPlayer(roster[0]!.id)!.pos.x).toBeGreaterThan(0);
  });

  it('start() resets paused to false', async () => {
    api.pause();
    api.setRoster([{ name: 'A' }]);
    await api.start({ practice: true });
    expect(api.isPaused()).toBe(false);
  });

  it('reset() resets paused to false', () => {
    api.pause();
    api.reset();
    expect(api.isPaused()).toBe(false);
  });
});
