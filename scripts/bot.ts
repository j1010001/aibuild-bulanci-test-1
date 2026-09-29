// Headless bots against a running game server — fill a room, or play whole matches with
// no browser at all (the multiplayer counterpart of GameApi.runTicks).
//
//   npm run bot -- --create --count 3 --map open --target-score 1 --once
//   npm run bot -- --code ABCDE --count 2
//
// Options:
//   --server URL        game server (default ws://localhost:8787)
//   --create            create a room; the first bot is its owner and starts the match
//   --code CODE         join an existing room instead
//   --count N           number of bots (default 1)
//   --name PREFIX       bot name prefix (default "Bot")
//   --strategy S        hunt (default) or idle (stand still: target practice)
//   --map ID, --target-score N, --round-time S   owner settings (with --create)
//   --once              exit after the first match ends, printing the winner
//   --timeout S         give up after S seconds (default 120)

import { BotPlayer, type BotOptions } from '../src/client/botPlayer';
import { NetSession } from '../src/net/client';

function parseArgs(argv: string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(key.slice(2), next);
      i++;
    } else {
      args.set(key.slice(2), true);
    }
  }
  return args;
}

function str(args: Map<string, string | true>, key: string): string | undefined {
  const v = args.get(key);
  return typeof v === 'string' ? v : undefined;
}

function num(args: Map<string, string | true>, key: string): number | undefined {
  const v = str(args, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number`);
  return n;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const server = str(args, 'server') ?? 'ws://localhost:8787';
  const count = num(args, 'count') ?? 1;
  const prefix = str(args, 'name') ?? 'Bot';
  const strategy = (str(args, 'strategy') ?? 'hunt') as BotOptions['strategy'];
  const once = args.has('once');
  const timeoutMs = (num(args, 'timeout') ?? 120) * 1000;
  let code = str(args, 'code')?.toUpperCase();
  if (!args.has('create') && !code) throw new Error('pass --create or --code CODE');

  const bots: BotPlayer[] = [];
  const timer = setInterval(() => {
    for (const b of bots) b.step(performance.now());
  }, 30);

  const waitFor = async (ok: () => boolean, what: string) => {
    const end = Date.now() + timeoutMs;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  try {
    if (args.has('create')) {
      const host = new BotPlayer(new NetSession(server, { kind: 'create' }, `${prefix}1`), {
        strategy,
        host: { mapId: str(args, 'map'), targetScore: num(args, 'target-score'), roundTime: num(args, 'round-time') },
      });
      bots.push(host);
      await waitFor(() => host.view.code !== null || host.view.rejected !== null, 'the room');
      if (!host.view.code) throw new Error(`could not create a room: ${host.view.rejected}`);
      code = host.view.code;
      console.log(`room ${code}`);
    }
    for (let i = bots.length; i < count; i++) {
      bots.push(new BotPlayer(new NetSession(server, { kind: 'join', code: code! }, `${prefix}${i + 1}`), { strategy }));
    }
    await waitFor(() => bots.every((b) => b.view.playerId !== null || b.view.rejected !== null), 'every bot to join');
    const rejected = bots.find((b) => b.view.rejected !== null);
    if (rejected) throw new Error(`a bot could not join: ${rejected.view.rejected}`);
    console.log(`${bots.length} bot(s) in room ${code}`);

    if (!once) {
      await new Promise(() => {}); // play until killed
      return 0;
    }
    await waitFor(() => bots.every((b) => b.view.screen === 'matchEnd'), 'the match to end');
    const view = bots[0]!.view;
    const winner = view.result?.winnerId;
    const name = winner ? (view.match?.players.find((p) => p.id === winner)?.name ?? winner) : 'none';
    console.log(`winner: ${name}  scores: ${JSON.stringify(view.result?.scores)}`);
    return 0;
  } finally {
    clearInterval(timer);
    for (const b of bots) b.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
