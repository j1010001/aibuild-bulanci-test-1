// What a tab remembers so it can offer "Rejoin room CODE" after a drop or a reload
// (spec §14). Pure rules; the UI persists the result in sessionStorage.

import type { ServerMessage } from '../session/protocol';

export type LastRoom = { code: string; reconnectToken: string };

export function lastRoomAfter(current: LastRoom | null, msg: ServerMessage, practice: boolean): LastRoom | null {
  switch (msg.type) {
    case 'roomJoined':
      return practice ? current : { code: msg.code, reconnectToken: msg.reconnectToken };
    case 'replaced':
      return null; // the other tab owns this seat now
    case 'joinRejected':
      return msg.reason === 'badToken' || msg.reason === 'notFound' ? null : current;
    default:
      return current;
  }
}

/** Stored values are read back as untrusted input: only well-formed ones are used. */
export function parseLastRoom(raw: string | null): LastRoom | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LastRoom>;
    if (typeof v.code !== 'string' || !/^[A-Z0-9]{5,6}$/.test(v.code)) return null;
    if (typeof v.reconnectToken !== 'string' || v.reconnectToken.length < 1 || v.reconnectToken.length > 128) return null;
    return { code: v.code, reconnectToken: v.reconnectToken };
  } catch {
    return null;
  }
}
