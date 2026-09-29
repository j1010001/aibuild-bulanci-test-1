// M1 task 1: parseClientMessage is the trust boundary — every message a client sends
// (over the network, or in-process for practice) goes through it before a Room sees it.
// Anything malformed must come back null, never a half-valid object.

import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../src/session/protocol';

describe('parseClientMessage', () => {
  it('accepts every well-formed message type', () => {
    expect(parseClientMessage({ type: 'createRoom', name: 'Ann' })).toEqual({ type: 'createRoom', name: 'Ann' });
    expect(parseClientMessage({ type: 'joinRoom', code: 'ABCDE', name: 'Bo' })).toEqual({ type: 'joinRoom', code: 'ABCDE', name: 'Bo' });
    expect(parseClientMessage({ type: 'rejoin', code: 'ABCDE', reconnectToken: 't-1' })).toEqual({ type: 'rejoin', code: 'ABCDE', reconnectToken: 't-1' });
    expect(parseClientMessage({ type: 'setSkin', skinId: 'gold' })).toEqual({ type: 'setSkin', skinId: 'gold' });
    expect(parseClientMessage({ type: 'setReady', ready: true })).toEqual({ type: 'setReady', ready: true });
    expect(parseClientMessage({ type: 'setMap', mapId: 'open' })).toEqual({ type: 'setMap', mapId: 'open' });
    expect(parseClientMessage({ type: 'setConfig', config: { targetScore: 5, roundTime: 30 } })).toEqual({
      type: 'setConfig',
      config: { targetScore: 5, roundTime: 30 },
    });
    expect(parseClientMessage({ type: 'startMatch' })).toEqual({ type: 'startMatch' });
    expect(parseClientMessage({ type: 'input', seq: 3, moveDir: '+X', shoot: false })).toEqual({ type: 'input', seq: 3, moveDir: '+X', shoot: false });
    expect(parseClientMessage({ type: 'input', seq: 0, moveDir: null, shoot: true })).toEqual({ type: 'input', seq: 0, moveDir: null, shoot: true });
    expect(parseClientMessage({ type: 'leave' })).toEqual({ type: 'leave' });
  });

  it('rejects non-objects and unknown types', () => {
    for (const raw of [null, undefined, 42, 'createRoom', [], { type: 'hack' }, { name: 'x' }]) {
      expect(parseClientMessage(raw)).toBeNull();
    }
  });

  it('rejects wrong field types', () => {
    expect(parseClientMessage({ type: 'setReady', ready: 'yes' })).toBeNull();
    expect(parseClientMessage({ type: 'input', seq: 1, moveDir: 'up', shoot: false })).toBeNull();
    expect(parseClientMessage({ type: 'input', seq: -1, moveDir: null, shoot: false })).toBeNull();
    expect(parseClientMessage({ type: 'input', seq: 1.5, moveDir: null, shoot: false })).toBeNull();
    expect(parseClientMessage({ type: 'input', seq: 1, moveDir: null })).toBeNull();
    expect(parseClientMessage({ type: 'setMap', mapId: 7 })).toBeNull();
    expect(parseClientMessage({ type: 'setConfig', config: { targetScore: '3' } })).toBeNull();
    expect(parseClientMessage({ type: 'setConfig', config: null })).toBeNull();
  });

  it('trims player names and requires 1–20 characters', () => {
    expect(parseClientMessage({ type: 'createRoom', name: '  Ann  ' })).toEqual({ type: 'createRoom', name: 'Ann' });
    expect(parseClientMessage({ type: 'createRoom', name: '   ' })).toBeNull();
    expect(parseClientMessage({ type: 'createRoom', name: 'x'.repeat(21) })).toBeNull();
    expect(parseClientMessage({ type: 'joinRoom', code: 'ABCDE', name: '' })).toBeNull();
  });

  it('normalizes room codes to upper case and requires 5–6 characters', () => {
    expect(parseClientMessage({ type: 'joinRoom', code: 'abcde', name: 'Bo' })).toEqual({ type: 'joinRoom', code: 'ABCDE', name: 'Bo' });
    expect(parseClientMessage({ type: 'joinRoom', code: 'ABC', name: 'Bo' })).toBeNull();
    expect(parseClientMessage({ type: 'joinRoom', code: 'ABCDEFG', name: 'Bo' })).toBeNull();
  });

  it('only passes through the config fields a client may set (never physics tuning)', () => {
    expect(parseClientMessage({ type: 'setConfig', config: { targetScore: 2, playerSpeed: 999 } })).toEqual({
      type: 'setConfig',
      config: { targetScore: 2 },
    });
  });

  it('strips unexpected extra fields', () => {
    expect(parseClientMessage({ type: 'startMatch', admin: true })).toEqual({ type: 'startMatch' });
  });
});
