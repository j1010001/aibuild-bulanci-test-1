// M2 task 2 (review follow-up): the UI's multiplayer wiring rules, as pure functions —
// where the server is, and what the tab remembers for "Rejoin room CODE".

import { describe, expect, it } from 'vitest';
import { lastRoomAfter, parseLastRoom, type LastRoom } from '../../src/client/lastRoom';
import { serverUrl } from '../../src/net/serverUrl';
import type { ServerMessage } from '../../src/session/protocol';

describe('serverUrl', () => {
  it('uses VITE_SERVER_URL when set', () => {
    expect(serverUrl('wss://game.example.com', { protocol: 'https:', hostname: 'x' })).toBe('wss://game.example.com');
  });

  it('defaults to port 8787 on the page host, ws under http and wss under https', () => {
    expect(serverUrl(undefined, { protocol: 'http:', hostname: '192.168.1.20' })).toBe('ws://192.168.1.20:8787');
    expect(serverUrl('', { protocol: 'https:', hostname: 'play.example.com' })).toBe('wss://play.example.com:8787');
  });
});

describe('remembered room', () => {
  const joined: ServerMessage = { type: 'roomJoined', code: 'ABCDE', playerId: 'p0', reconnectToken: 'tok' };
  const kept: LastRoom = { code: 'ABCDE', reconnectToken: 'tok' };

  it('remembers a multiplayer room on join, never a practice one', () => {
    expect(lastRoomAfter(null, joined, false)).toEqual(kept);
    expect(lastRoomAfter(null, { ...joined, code: 'LOCAL' }, true)).toBeNull();
  });

  it('forgets it when replaced by another tab, or when the server no longer knows it', () => {
    expect(lastRoomAfter(kept, { type: 'replaced' }, false)).toBeNull();
    expect(lastRoomAfter(kept, { type: 'joinRejected', reason: 'badToken' }, false)).toBeNull();
    expect(lastRoomAfter(kept, { type: 'joinRejected', reason: 'notFound' }, false)).toBeNull();
  });

  it('keeps it through everything else (a full or busy server may accept it later)', () => {
    expect(lastRoomAfter(kept, { type: 'joinRejected', reason: 'serverFull' }, false)).toEqual(kept);
    expect(lastRoomAfter(kept, { type: 'error', message: 'x' }, false)).toEqual(kept);
  });

  it('only trusts stored values that look like a room code and a token', () => {
    expect(parseLastRoom(JSON.stringify(kept))).toEqual(kept);
    expect(parseLastRoom(null)).toBeNull();
    expect(parseLastRoom('not json')).toBeNull();
    expect(parseLastRoom(JSON.stringify({ code: '<img src=x>', reconnectToken: 'tok' }))).toBeNull();
    expect(parseLastRoom(JSON.stringify({ code: 'ABCDE', reconnectToken: 'x'.repeat(200) }))).toBeNull();
    expect(parseLastRoom(JSON.stringify({ code: 'ABCDE' }))).toBeNull();
  });
});
