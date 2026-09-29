// Room registry: issues room codes, finds rooms by code, ticks them all, and discards a
// room once nobody is connected (spec §14 "Everyone leaves").

import { Room, type RoomOptions } from '../src/session/room';

/** No look-alikes (0/O, 1/I/L) so a code read aloud or off a screen can't be mistyped. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomCode(length = 5): string {
  const out: string[] = [];
  const limit = 256 - (256 % CODE_ALPHABET.length); // rejection sampling: no modulo bias
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length))) {
      if (b < limit && out.length < length) out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]!);
    }
  }
  return out.join('');
}

export type RegistryOptions = {
  newCode?: () => string;
  /** Each room with a match holds a physics world; cap them. */
  maxRooms?: number;
  roomOptions?: Omit<RoomOptions, 'code'>;
};

export class RoomRegistry {
  private rooms = new Map<string, Room>();

  constructor(private readonly opts: RegistryOptions = {}) {}

  get size(): number {
    return this.rooms.size;
  }

  /** A new, empty room — or null when the server is at its room limit. */
  create(): Room | null {
    if (this.rooms.size >= (this.opts.maxRooms ?? 200)) return null;
    const newCode = this.opts.newCode ?? randomCode;
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = newCode();
      if (this.rooms.has(code)) continue;
      const room = new Room({ ...this.opts.roomOptions, code });
      this.rooms.set(code, room);
      return room;
    }
    throw new Error('RoomRegistry: could not find a free room code');
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  removeIfEmpty(code: string): void {
    const room = this.rooms.get(code);
    if (room && room.isEmpty()) this.remove(room);
  }

  tickAll(dt: number): void {
    for (const room of [...this.rooms.values()]) {
      try {
        room.tick(dt);
      } catch (err) {
        // One broken room must not take the loop (and every other room) down with it.
        console.error(`room ${room.code} failed and was closed:`, err);
        this.remove(room);
        continue;
      }
      if (room.isEmpty()) this.remove(room);
    }
  }

  disposeAll(): void {
    for (const room of [...this.rooms.values()]) this.remove(room);
  }

  private remove(room: Room): void {
    this.rooms.delete(room.code);
    try {
      room.dispose();
    } catch (err) {
      console.error(`room ${room.code} failed to dispose:`, err);
    }
  }
}
