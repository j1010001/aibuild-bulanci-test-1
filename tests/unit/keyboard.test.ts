// M1 task 2 (review follow-up): the keyboard binding, driven through a plain EventTarget
// so it runs in Node. Spec §8: keys only drive the player when there is an input target
// (the match screen); otherwise they behave normally (Space activates buttons, arrows
// scroll). Modifier chords are never movement. Held keys survive a target change.

import { describe, expect, it } from 'vitest';
import { directionForScreen } from '../../src/camera';
import { bindKeyboard, isTyping, type InputTarget } from '../../src/input';
import type { Direction } from '../../src/sim';

const UP = directionForScreen('up');
const RIGHT = directionForScreen('right');

function key(type: 'keydown' | 'keyup', code: string, extra: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });
  return e;
}

function recorder(): InputTarget & { moves: (Direction | null)[]; shots: number } {
  const r = {
    moves: [] as (Direction | null)[],
    shots: 0,
    setMoveDir: (d: Direction | null) => void r.moves.push(d),
    pressShoot: () => void r.shots++,
  };
  return r;
}

describe('bindKeyboard', () => {
  it('drives the target and swallows the key while there is a target', () => {
    const events = new EventTarget();
    const target = recorder();
    bindKeyboard(() => target, events);
    const e = key('keydown', 'ArrowRight');
    events.dispatchEvent(e);
    expect(target.moves).toEqual([RIGHT]);
    expect(e.defaultPrevented).toBe(true);
  });

  it('leaves keys alone when there is no target (menus: Space presses buttons, arrows scroll)', () => {
    const events = new EventTarget();
    bindKeyboard(() => null, events);
    const space = key('keydown', 'Space');
    const arrow = key('keydown', 'ArrowDown');
    events.dispatchEvent(space);
    events.dispatchEvent(arrow);
    expect(space.defaultPrevented).toBe(false);
    expect(arrow.defaultPrevented).toBe(false);
  });

  it('ignores modifier chords (Cmd/Ctrl/Alt + a movement key)', () => {
    const events = new EventTarget();
    const target = recorder();
    bindKeyboard(() => target, events);
    for (const mod of ['metaKey', 'ctrlKey', 'altKey']) {
      const e = key('keydown', 'KeyJ', { [mod]: true });
      events.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(target.moves).toEqual([]);
  });

  it('keeps a most-recent-first stack of held directions', () => {
    const events = new EventTarget();
    const target = recorder();
    bindKeyboard(() => target, events);
    events.dispatchEvent(key('keydown', 'ArrowRight'));
    events.dispatchEvent(key('keydown', 'ArrowUp'));
    events.dispatchEvent(key('keyup', 'ArrowUp'));
    events.dispatchEvent(key('keyup', 'ArrowRight'));
    expect(target.moves).toEqual([RIGHT, UP, RIGHT, null]);
  });

  it('releases every held direction when the window loses focus', () => {
    const events = new EventTarget();
    const target = recorder();
    bindKeyboard(() => target, events);
    events.dispatchEvent(key('keydown', 'ArrowRight'));
    events.dispatchEvent(new Event('blur'));
    expect(target.moves.at(-1)).toBeNull();
  });

  it('resync() hands a key held before the target existed to the new target', () => {
    const events = new EventTarget();
    let target: ReturnType<typeof recorder> | null = null;
    const keyboard = bindKeyboard(() => target, events);
    events.dispatchEvent(key('keydown', 'ArrowRight')); // held on the lobby screen
    target = recorder(); // the match starts
    keyboard.resync();
    expect(target.moves).toEqual([RIGHT]);
  });

  it('fires one shot per Space press, ignoring auto-repeat', () => {
    const events = new EventTarget();
    const target = recorder();
    bindKeyboard(() => target, events);
    events.dispatchEvent(key('keydown', 'Space'));
    events.dispatchEvent(key('keydown', 'Space', { repeat: true }));
    expect(target.shots).toBe(1);
  });

  it('dispose() unbinds', () => {
    const events = new EventTarget();
    const target = recorder();
    bindKeyboard(() => target, events).dispose();
    events.dispatchEvent(key('keydown', 'ArrowRight'));
    expect(target.moves).toEqual([]);
  });
});

describe('isTyping', () => {
  it('treats keys aimed at a text field as text', () => {
    expect(isTyping({ target: { tagName: 'INPUT' } } as unknown as Event)).toBe(true);
    expect(isTyping({ target: { tagName: 'SELECT' } } as unknown as Event)).toBe(true);
    expect(isTyping({ target: { tagName: 'DIV', isContentEditable: true } } as unknown as Event)).toBe(true);
    expect(isTyping({ target: { tagName: 'BUTTON' } } as unknown as Event)).toBe(false);
    expect(isTyping({ target: null } as unknown as Event)).toBe(false);
  });
});
