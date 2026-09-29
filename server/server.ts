// The game server: HTTP (health check) + WebSocket on one port, one ConnectionHandler per
// socket, and one 60 Hz loop ticking every room. The only module that touches Node's
// networking; everything it runs is the shared, environment-free core (spec §4).

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { ensureRapierReady } from '../src/physics/rapier';
import { ConnectionHandler } from './connection';
import { startTickLoop } from './loop';
import { RoomRegistry } from './rooms';

export type ServerOptions = { port?: number; registry?: RoomRegistry };

export type RunningServer = {
  port: number;
  registry: RoomRegistry;
  close(): Promise<void>;
};

const MAX_PAYLOAD_BYTES = 4096;

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  await ensureRapierReady();
  const registry = opts.registry ?? new RoomRegistry();

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD_BYTES });
  wss.on('connection', (socket: WebSocket) => {
    const handler = new ConnectionHandler(registry, {
      send: (text) => {
        if (socket.readyState === socket.OPEN) socket.send(text);
      },
      close: (code, reason) => socket.close(code, reason),
    });
    socket.on('message', (data, isBinary) => {
      if (!isBinary) handler.onMessage(data.toString());
    });
    socket.on('close', () => handler.onClose());
    socket.on('error', () => handler.onClose());
  });

  const loop = startTickLoop((dt) => registry.tickAll(dt));

  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 8787, resolve));
  const port = (httpServer.address() as AddressInfo).port;

  return {
    port,
    registry,
    async close() {
      loop.stop();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      registry.disposeAll();
    },
  };
}
