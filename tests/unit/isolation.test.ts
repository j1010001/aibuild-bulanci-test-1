// Spec §4 isolation rule, the part a compiler can't see: server/ must never import
// browser-side code, even browser code that happens to be DOM-free (src/client, src/ui,
// the renderer, input, camera, page bootstrap). The no-DOM/no-Node type checks live in
// tsconfig.core.json and server/tsconfig.json.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = /from\s+['"][^'"]*src\/(client|ui|render|input|camera|main)\b/;

describe('server isolation', () => {
  it('no server file imports browser-side code', () => {
    const dir = join(__dirname, '../../server');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => FORBIDDEN.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the check itself catches such an import', () => {
    expect(FORBIDDEN.test("import { App } from '../src/ui/app';")).toBe(true);
    expect(FORBIDDEN.test("import { Room } from '../src/session/room';")).toBe(false);
  });
});
