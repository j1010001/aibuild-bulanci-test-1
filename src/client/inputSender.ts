// Turns key state into sequenced `input` messages (spec §12: input is sent only when it
// changes; shoot is an edge). The keyboard binding (src/input.ts) drives this.

import type { Direction } from '../sim';
import type { ClientMessage } from '../session/protocol';

export class InputSender {
  private seq = 0;
  private moveDir: Direction | null = null;

  constructor(private readonly send: (msg: ClientMessage) => void) {}

  setMoveDir(dir: Direction | null): void {
    if (dir === this.moveDir) return;
    this.moveDir = dir;
    this.send({ type: 'input', seq: this.seq++, moveDir: dir, shoot: false });
  }

  /** Forget the last direction sent: a new match starts with no movement on the server side. */
  reset(): void {
    this.moveDir = null;
  }

  pressShoot(): void {
    this.send({ type: 'input', seq: this.seq++, moveDir: this.moveDir, shoot: true });
  }
}
