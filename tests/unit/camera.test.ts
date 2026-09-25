// Regression coverage for the camera/input orientation bug (spec §8, §11): arrow-up
// used to not move the player up on screen because the camera's azimuth was diagonal
// (45°) and the keyboard mapping was a second, independently-hand-written table that
// silently assumed a different orientation. See camera.ts for the fix.

import { describe, expect, it } from 'vitest';
import { AZIMUTH, classifyScreenDirection, directionForScreen, POLAR_FROM_VERTICAL } from '../../src/camera';
import { DIRECTIONS } from '../../src/sim';
import type { Direction } from '../../src/sim';

describe('camera orientation (§11) matches the input mapping (§8)', () => {
  it('classifies every world direction as exactly one screen direction under the live camera constants', () => {
    for (const dir of DIRECTIONS) {
      expect(() => classifyScreenDirection(dir)).not.toThrow();
    }
  });

  it('locks in the current, correct up/down/left/right mapping', () => {
    // If this fails after changing AZIMUTH, input.ts's derived mapping changed too —
    // that's fine as long as it's a deliberate, understood change (update this test
    // and spec §11 to match). If it fails with AZIMUTH unchanged, something regressed.
    expect(classifyScreenDirection('-Y')).toBe('up');
    expect(classifyScreenDirection('+Y')).toBe('down');
    expect(classifyScreenDirection('+X')).toBe('right');
    expect(classifyScreenDirection('-X')).toBe('left');
  });

  it('directionForScreen is the exact inverse of classifyScreenDirection', () => {
    for (const target of ['up', 'down', 'left', 'right'] as const) {
      const dir = directionForScreen(target);
      expect(classifyScreenDirection(dir)).toBe(target);
    }
  });

  it('rejects a diagonal azimuth instead of silently picking a wrong screen direction', () => {
    // This is the exact class of bug that shipped: a 45° azimuth (a classic diagonal
    // "3/4" corner view) leaves every world direction part-up/part-sideways on screen.
    const diagonalAzimuth = Math.PI / 4;
    let sawThrow = false;
    for (const dir of DIRECTIONS) {
      try {
        classifyScreenDirection(dir, diagonalAzimuth, POLAR_FROM_VERTICAL);
      } catch {
        sawThrow = true;
      }
    }
    expect(sawThrow).toBe(true);
  });

  it('requires the shipped azimuth to be cardinal (a multiple of 90°)', () => {
    const normalized = ((AZIMUTH % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    expect(Math.min(normalized, Math.PI / 2 - normalized)).toBeLessThan(1e-9);
  });
});

describe('input.ts derives its key mapping from the camera, not a parallel hardcoded table', () => {
  it('every key-mapped direction matches what the camera says is up/down/left/right', async () => {
    const { bindKeyboard } = await import('../../src/input');
    expect(typeof bindKeyboard).toBe('function');

    // input.ts computes UP/DOWN/LEFT/RIGHT via directionForScreen at module load; the
    // strongest thing we can assert without a DOM is that those helpers agree with
    // classifyScreenDirection for all four screen directions (checked above) — this
    // test exists mainly to document *why* input.ts has no KEY_TO_DIR literal to assert
    // against anymore: there is nothing left to drift out of sync.
    const upDir: Direction = directionForScreen('up');
    const downDir: Direction = directionForScreen('down');
    expect(upDir).not.toBe(downDir);
  });
});
