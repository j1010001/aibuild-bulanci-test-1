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
//   --timeout S         give up after S seconds in total (default 120)

import { BotPlayer, type BotOptions } from '../src/client/botPlayer';
import { NetSession } from '../src/net/client';
import { BUILT_IN_MAPS } from '../src/session/maps';
import { CONFIG_LIMITS } from '../src/session/protocol';

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

function intIn(args: Map<string, string | true>, key: string, min: number, max: number): number | undefined {
  const n = num(args, key);
  if (n !== undefined && (!Number.isInteger(n) || n < min || n > max)) throw new Error(`--${key} must be an integer from ${min} to ${max}`);
  return n;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  // Everything is validated before connecting: a setting the server would refuse must not
  // silently turn into a match with defaults.
  const server = str(args, 'server') ?? 'ws://localhost:8787';
  const count = intIn(args, 'count', 1, 8) ?? 1;
  const prefix = str(args, 'name') ?? 'Bot';
  const strategy = str(args, 'strategy') ?? 'hunt';
  if (strategy !== 'hunt' && strategy !== 'idle') throw new Error('--strategy must be hunt or idle');
  const mapId = str(args, 'map');
  if (mapId !== undefined && !BUILT_IN_MAPS.some((m) => m.id === mapId)) {
    throw new Error(`--map must be one of: ${BUILT_IN_MAPS.map((m) => m.id).join(', ')}`);
  }
  const targetScore = intIn(args, 'target-score', CONFIG_LIMITS.targetScore.min, CONFIG_LIMITS.targetScore.max);
  const roundTime = intIn(args, 'round-time', CONFIG_LIMITS.roundTime.min, CONFIG_LIMITS.roundTime.max);
  const once = args.has('once');
  const deadline = Date.now() + (num(args, 'timeout') ?? 120) * 1000;
  let code = str(args, 'code')?.toUpperCase();
  if (!args.has('create') && !code) throw new Error('pass --create or --code CODE');

  const bots: BotPlayer[] = [];
  const timer = setInterval(() => {
    for (const b of bots) b.step(performance.now());
  }, 30);

  /** Waits for `ok`, failing at once — with the reason — if a bot the wait depends on loses its connection. */
  const waitFor = async (ok: () => boolean, what: string, watch: () => BotPlayer[] = () => bots) => {
    while (!ok()) {
      const lost = watch().find((b) => b.closedReason !== null);
      if (lost) throw new Error(`${what}: a bot's connection closed (${lost.closedReason})`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  try {
    if (args.has('create')) {
      const host = new BotPlayer(new NetSession(server, { kind: 'create' }, `${prefix}1`), {
        strategy: strategy as BotOptions['strategy'],
        host: { mapId, targetScore, roundTime },
      });
      bots.push(host);
      await waitFor(() => host.view.code !== null || host.view.rejected !== null, 'the room');
      if (!host.view.code) throw new Error(`could not create a room: ${host.view.rejected}`);
      code = host.view.code;
      console.log(`room ${code}`);
    }
    for (let i = bots.length; i < count; i++) {
      bots.push(new BotPlayer(new NetSession(server, { kind: 'join', code: code! }, `${prefix}${i + 1}`), { strategy: strategy as BotOptions['strategy'] }));
    }
    await waitFor(() => bots.every((b) => b.view.playerId !== null || b.view.rejected !== null), 'every bot to join');
    const rejected = bots.find((b) => b.view.rejected !== null);
    if (rejected) throw new Error(`a bot could not join: ${rejected.view.rejected}`);
    console.log(`${bots.length} bot(s) in room ${code}`);

    if (!once) {
      await new Promise(() => {}); // play until killed
      return 0;
    }
    // Wait on the bots that are still connected: one kicked mid-match (the others play on)
    // must not hold the run until the timeout.
    const connected = () => bots.filter((b) => b.closedReason === null);
    await waitFor(
      () => connected().length > 0 && connected().every((b) => b.results.length >= 1),
      'the match to end',
      () => (connected().length === 0 ? bots : []),
    );
    const reporter = connected()[0]!;
    const result = reporter.results[0]!;
    const name = result.winnerId ? (reporter.view.match?.players.find((p) => p.id === result.winnerId)?.name ?? result.winnerId) : 'none';
    console.log(`winner: ${name}  scores: ${JSON.stringify(result.scores)}`);
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
