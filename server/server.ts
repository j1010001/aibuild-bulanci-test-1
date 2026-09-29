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

export type ServerOptions = {
  port?: number;
  registry?: RoomRegistry;
  maxConnections?: number;
  /** Ping interval; a socket that misses a pong by the next ping is terminated (half-open TCP). */
  heartbeatMs?: number;
};

export type RunningServer = {
  port: number;
  registry: RoomRegistry;
  close(): Promise<void>;
};

const MAX_PAYLOAD_BYTES = 4096;
const CLOSE_TRY_AGAIN_LATER = 1013;

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  await ensureRapierReady();
  const registry = opts.registry ?? new RoomRegistry();
  const maxConnections = opts.maxConnections ?? 500;

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // Listen first: attaching the WebSocket server before a successful listen would make it
  // re-emit a listen error (EADDRINUSE) as an unhandled 'error' event.
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 8787, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (socket: WebSocket) => {
    if (wss.clients.size > maxConnections) {
      socket.close(CLOSE_TRY_AGAIN_LATER, 'server full');
      return;
    }
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));

    const handler = new ConnectionHandler(registry, {
      send: (text) => {
        if (socket.readyState === socket.OPEN) socket.send(text);
      },
      close: (code, reason) => socket.close(code, reason),
    });
    socket.on('message', (data, isBinary) => {
      try {
        if (isBinary) handler.onBinary();
        else handler.onMessage(data.toString());
      } catch (err) {
        console.error('connection handler failed:', err);
        socket.close(1011, 'internal error');
      }
    });
    socket.on('close', () => handler.onClose());
    socket.on('error', () => handler.onClose());
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, opts.heartbeatMs ?? 30_000);

  const loop = startTickLoop((dt) => registry.tickAll(dt)); // only once we're actually listening
  const port = (httpServer.address() as AddressInfo).port;

  return {
    port,
    registry,
    async close() {
      loop.stop();
      clearInterval(heartbeat);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      registry.disposeAll();
    },
  };
}
