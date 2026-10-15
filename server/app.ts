/**
 * The game server on one port: static client files, GET /healthz and the
 * WebSocket on /ws (any path ending in /ws, so it also works behind a
 * subpath), with the 30 Hz drift-corrected room loop.
 */
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { NET, PROTOCOL_VERSION } from '../src/net/protocol';
import { ROOM_HZ } from '../src/sim/room';
import { nullSimFactory } from '../src/sim/nullSim';
import type { RoomSimFactory } from '../src/sim/types';
import type { ServerConfig } from './config';
import { ConnLimiter, RATE, clientIp } from './limits';
import { createLog, type Log } from './log';
import { RoomManager } from './roomManager';
import { Session } from './session';
import { serveStatic } from './static';

export interface RunningServer {
  readonly port: number;
  readonly manager: RoomManager;
  readonly sessions: ReadonlySet<Session>;
  /** Room clock (ms since start). */
  now(): number;
  close(): Promise<void>;
}

export interface StartOptions {
  version?: string;
  simFactory?: RoomSimFactory;
  log?: Log;
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

function toText(data: RawData): string {
  const b = toBytes(data);
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('utf8');
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function startServer(cfg: ServerConfig, opts: StartOptions = {}): Promise<RunningServer> {
  const log = opts.log ?? createLog(cfg.logLevel);
  const t0 = performance.now();
  const now = (): number => performance.now() - t0;
  const manager = new RoomManager({
    maxPlayersPerRoom: cfg.maxPlayersPerRoom,
    maxRooms: cfg.maxRooms,
    privateRoomIdleS: cfg.privateRoomIdleS,
    reconnectGraceS: cfg.reconnectGraceS,
    testHooks: cfg.testHooks,
    simFactory: opts.simFactory ?? (cfg.sim === 'null' ? nullSimFactory : undefined),
    log,
  });
  manager.prepareMaps();

  const sessions = new Set<Session>();
  const sockets = new Set<WebSocket>();
  const conns = new ConnLimiter(cfg.maxConnPerIp);
  const version = opts.version ?? '0.0.0';

  const server = http.createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0];
    if (urlPath === '/healthz' || urlPath.endsWith('/healthz')) {
      const body = JSON.stringify({
        ok: true,
        rooms: manager.rooms.size,
        players: manager.playerCount,
        connections: sessions.size,
        uptime: Math.round(now() / 1000),
        version,
        protocol: PROTOCOL_VERSION,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    serveStatic(cfg.staticDir, req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: NET.maxPayload, perMessageDeflate: false, clientTracking: false });

  server.on('upgrade', (req, socket, head) => {
    const urlPath = (req.url ?? '/').split('?')[0];
    if (!(urlPath === '/ws' || urlPath.endsWith('/ws'))) return refuse(socket, 404, 'Not Found');
    const origin = (req.headers.origin ?? '').replace(/\/+$/, '');
    if (cfg.allowedOrigins.length && !cfg.allowedOrigins.includes(origin)) {
      log.warn('origin refused', { origin });
      return refuse(socket, 403, 'Forbidden');
    }
    const ip = clientIp(req, cfg.trustProxy);
    if (!conns.acquire(ip)) {
      log.warn('too many connections', { ip });
      return refuse(socket, 429, 'Too Many Requests');
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const session = new Session(ws, ip, manager, now, { log });
      sessions.add(session);
      sockets.add(ws);
      ws.on('message', (data, isBinary) => session.onMessage(isBinary ? toBytes(data) : toText(data), isBinary));
      ws.on('pong', () => session.onPong());
      ws.on('error', (e) => log.debug('socket error', { ip, err: String(e) }));
      ws.on('close', () => {
        session.onClose();
        sessions.delete(session);
        sockets.delete(ws);
        conns.release(ip);
      });
    });
  });

  // 30 Hz loop, drift corrected: tick n runs at t0 + n·period; a late process
  // catches up at most 5 ticks, then skips ahead.
  const period = 1000 / ROOM_HZ;
  let tick = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const loop = (): void => {
    if (stopped) return;
    const t = now();
    let ran = 0;
    while (tick * period <= t && ran < 5) {
      manager.tick(tick * period);
      tick++;
      ran++;
    }
    if (tick * period <= t) tick = Math.floor(t / period) + 1;
    timer = setTimeout(loop, Math.max(0, tick * period - now()));
  };
  const heartbeat = setInterval(() => {
    for (const s of sessions) s.heartbeat();
  }, RATE.pingIntervalMs);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      server.off('error', reject);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
      log.info('listening', { host: cfg.host, port, static: cfg.staticDir || null, testHooks: cfg.testHooks, sim: cfg.sim });
      loop();
      resolve({
        port,
        manager,
        sessions,
        now,
        close: () =>
          new Promise<void>((done) => {
            stopped = true;
            if (timer) clearTimeout(timer);
            clearInterval(heartbeat);
            manager.shutdown();
            for (const s of sessions) s.detach('shutdown');
            server.close(() => done());
            server.closeAllConnections();
            // Sockets that ignore the close handshake are cut after a second.
            setTimeout(() => {
              for (const c of sockets) c.terminate();
            }, 1000).unref();
          }),
      });
    });
  });
}
