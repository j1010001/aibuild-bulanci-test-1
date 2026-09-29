// Process entry point: `npm run server` (or `npm run dev`, which also starts Vite).

import { startServer } from './server';

const port = Number(process.env.SERVER_PORT ?? 8787);

const server = await startServer({ port });
console.log(`game server listening on ws://localhost:${server.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
