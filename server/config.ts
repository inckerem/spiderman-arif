/**
 * Server configuration from the environment, overridable on the command line
 * (`--port=8787`, `--max-players-per-room=4`, `--static=` for no static files,
 * `--test-hooks`), so npm scripts need no shell-specific env syntax.
 */
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface ServerConfig {
  port: number;
  host: string;
  /** Absolute directory served over HTTP, or '' for none (WebSocket and /healthz only). */
  staticDir: string;
  maxPlayersPerRoom: number;
  maxRooms: number;
  maxConnPerIp: number;
  privateRoomIdleS: number;
  reconnectGraceS: number;
  /** Take the client address from the last X-Forwarded-For hop (one trusted proxy, e.g. Nginx). */
  trustProxy: boolean;
  /** Allowed Origin headers for the WebSocket; empty = any. */
  allowedOrigins: string[];
  /** Accept `dbg` messages (tests only). */
  testHooks: boolean;
  /** Room simulation: `combat` (CombatSim, default) or `null` (presence only, for tests). */
  sim: 'combat' | 'null';
  logLevel: LogLevel;
}

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

/** `--max-players-per-room=4` → MAX_PLAYERS_PER_ROOM=4; a bare flag means 1. `--static` is STATIC_DIR. */
export function argsToEnv(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/i.exec(a);
    if (!m) throw new Error(`Unknown argument: ${a}`);
    let key = m[1].toUpperCase().replace(/-/g, '_');
    if (key === 'STATIC') key = 'STATIC_DIR';
    out[key] = m[2] ?? '1';
  }
  return out;
}

function int(env: Record<string, string | undefined>, key: string, def: number, lo: number, hi: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${key} must be an integer in [${lo}, ${hi}] (got "${raw}")`);
  return v;
}

function bool(env: Record<string, string | undefined>, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${key} must be 0 or 1 (got "${raw}")`);
}

function simKind(raw: string | undefined): 'combat' | 'null' {
  if (raw === undefined || raw === '' || raw === 'combat') return 'combat';
  if (raw === 'null') return 'null';
  throw new Error(`SIM must be combat or null (got "${raw}")`);
}

export function loadConfig(env: Record<string, string | undefined> = process.env, argv: readonly string[] = process.argv.slice(2)): ServerConfig {
  const e = { ...env, ...argsToEnv(argv) };
  const level = (e.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
  if (!LEVELS.includes(level)) throw new Error(`LOG_LEVEL must be one of ${LEVELS.join(', ')}`);
  const staticRaw = e.STATIC_DIR === undefined ? 'dist' : e.STATIC_DIR;
  return {
    port: int(e, 'PORT', 8080, 0, 65535),
    host: e.HOST || '0.0.0.0',
    staticDir: staticRaw ? path.resolve(staticRaw) : '',
    maxPlayersPerRoom: int(e, 'MAX_PLAYERS_PER_ROOM', 16, 1, 64),
    maxRooms: int(e, 'MAX_ROOMS', 200, 1, 10000),
    maxConnPerIp: int(e, 'MAX_CONN_PER_IP', 8, 1, 1000),
    privateRoomIdleS: int(e, 'PRIVATE_ROOM_IDLE_S', 60, 0, 86400),
    reconnectGraceS: int(e, 'RECONNECT_GRACE_S', 30, 0, 3600),
    trustProxy: bool(e, 'TRUST_PROXY', false),
    allowedOrigins: (e.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    testHooks: bool(e, 'TEST_HOOKS', false),
    sim: simKind(e.SIM),
    logLevel: level,
  };
}
