/**
 * Multiplayer protocol, object form (design M12 §2). Text frames carry JSON
 * control messages and combat events; binary frames carry the high-rate state
 * (see codec.ts for the byte layouts). PURE: shared by the browser client, the
 * Node server and the in-process LocalLink.
 */
import type { MapId } from './maps';
import type { CombatEvent, CombatIntent, CrimeEventInfo, DebugOp } from '../sim/types';

export type { MapId } from './maps';
export type { CombatEvent, CombatIntent, CrimeEventInfo, DebugOp } from '../sim/types';

export const PROTOCOL_VERSION = 1;

/**
 * Network rates and limits. They are protocol constants (client and server
 * must agree), so they live here rather than in the live-editable tuning.
 */
export const NET = {
  /** Room / combat sim rate. */
  simHz: 30,
  /** Own hero state upload rate. */
  stateHz: 20,
  /** Enemy snapshots go out every Nth sim step (15 Hz). */
  snapshotEvery: 2,
  snapshotRadius: 300,
  snapshotMax: 30,
  /** Shared clock broadcast interval (s). */
  clockEveryS: 5,
  /** Largest accepted WebSocket message (bytes). */
  maxPayload: 4096,
  /** Hero states may claim a room time at most this far in the past (ms); never in the future. */
  stateTimeWindowMs: 1000,
  /** Events carried in one hero state packet. */
  maxStateEvents: 32,
  // Movement sanity (server and LocalLink alike).
  maxSpeed: 110,
  speedSlack: 2,
  teleportRadius: 80,
  /** The time since the last accepted state counts for at most this long (s) in the speed allowance. */
  maxStateGapS: 2,
  spawnRadius: 6,
  boundsMargin: 400,
  minY: -5,
  maxY: 900,
  /** More than `kickCorrections` corrections within `correctionWindowS` is a kick. */
  correctionWindowS: 10,
  kickCorrections: 5,
  /** A correction the client has not applied after this long is sent (and counted) again. */
  correctionResendS: 1.5,
  /** Slot kept after a disconnect so the player can reconnect with its token. */
  reconnectGraceS: 30,
  /** Room code alphabet: no 0/O, 1/I/L. */
  roomCodeAlphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  roomCodeLength: 6,
} as const;

// ---------------------------------------------------------------------------
// Rooms

export interface RoomInfo {
  id: string;
  map: MapId;
  seed: number;
  public: boolean;
  /** Private rooms only: the 6-character join code. */
  code?: string;
  pvp: boolean;
  /** Public rooms: 1 for "public #1", 2 for the overflow "#2", ... Private rooms: 0. */
  index: number;
}

export type JoinRequest = { kind: 'public' } | { kind: 'code'; code: string } | { kind: 'create'; pvp: boolean };

export interface PlayerInfo {
  pid: number;
  name: string;
  costume: string;
}

// ---------------------------------------------------------------------------
// Messages

export type ClientMsg =
  | { t: 'hello'; v: number; name: string; costume: string; map: MapId; join: JoinRequest; token?: string }
  | { t: 'act'; i: CombatIntent }
  | { t: 'ping'; c: number }
  | { t: 'leave' }
  | { t: 'dbg'; op: DebugOp; a: number[] };

export const REJECT_REASONS = ['version', 'name', 'profanity', 'full', 'notFound', 'rate', 'server'] as const;
export type RejectWhy = (typeof REJECT_REASONS)[number];
export type CorrectWhy = 'speed' | 'teleport' | 'bounds' | 'nan';
/** Reasons in `kick` (and in `left` for the others). */
export const KICK_REASONS = ['cheat', 'rate', 'garbage', 'timeout', 'idle', 'shutdown', 'replaced'] as const;
export type KickWhy = (typeof KICK_REASONS)[number];
export type LeftWhy = 'leave' | 'disconnect' | 'timeout' | KickWhy;

export interface ClockInfo {
  /** Hour of day [0, 24). */
  hour: number;
  /** Real minutes per in-game day. */
  dayLen: number;
}

export type ServerMsg =
  | {
      t: 'welcome';
      v: number;
      pid: number;
      name: string;
      room: RoomInfo;
      token: string;
      /** Room time (ms) when the message was built. */
      now: number;
      players: PlayerInfo[];
      events: CrimeEventInfo[];
      clock: ClockInfo;
      hp: number;
    }
  | { t: 'reject'; why: RejectWhy }
  | { t: 'join'; pid: number; name: string; costume: string }
  | { t: 'left'; pid: number; why: LeftWhy }
  | { t: 'ce'; ev: CombatEvent[] }
  | { t: 'clock'; hour: number; dayLen: number }
  | { t: 'correct'; x: number; y: number; z: number; why: CorrectWhy }
  | { t: 'pong'; c: number; s: number }
  | { t: 'kick'; why: KickWhy };

// ---------------------------------------------------------------------------
// Binary state (layouts in codec.ts)

export const OP_STATE = 0x01; // C→S own hero state
export const OP_STATES = 0x02; // S→C hero states batch
export const OP_ENEMIES = 0x03; // S→C enemy snapshot

/** HeroSample.flags */
export const HF = {
  GROUNDED: 1,
  DIVING: 2,
  ROPE_ATTACHED: 4,
  ROPE_FIRING: 8,
  /** Hand of the active line: set = right. */
  HAND_RIGHT: 16,
  DOWN: 32,
  AFK: 64,
  PAUSED: 128,
} as const;

/** HeroSample.blocks: which optional blocks follow the fixed part. */
export const HB = {
  /** Rope or zip anchor (ax, ay, az). */
  ANCHOR: 1,
  /** Zip end point (zx, zy, zz). */
  ZIP: 2,
  /** Wall normal and run speed. */
  WALL: 4,
  /** Vault/mantle/ledge traversal. */
  TRAV: 8,
} as const;

/**
 * Hero events carried inside a state packet. Every `PlayerEvent` variant
 * (player/player.ts) has the same shape here, so a client can forward
 * `player.events` as is (M11 added lunge, lungeEnd, strike, dodge, hurt, down and revive).
 */
export type NetEvent =
  | { type: 'jump' }
  | { type: 'land'; impact: number; surface: number; roll: boolean }
  | { type: 'webFire'; hand: number; x: number; y: number; z: number }
  | { type: 'attach'; hand: number; x: number; y: number; z: number; nx: number; ny: number; nz: number }
  | { type: 'release'; good: boolean; broken: boolean; power: number }
  | { type: 'boost' }
  | { type: 'dive' }
  | { type: 'zipStart'; x: number; y: number; z: number; hand: number }
  | { type: 'zipEnd' }
  | { type: 'wallGrab'; surface: number }
  | { type: 'wallJump' }
  | { type: 'vault' }
  | { type: 'mantle' }
  | { type: 'splash'; x: number; y: number; z: number }
  | { type: 'respawn' }
  | { type: 'recover' }
  | { type: 'lunge' }
  | { type: 'lungeEnd'; ok: boolean }
  | { type: 'strike'; move: number }
  | { type: 'dodge' }
  | { type: 'hurt'; dmg: number }
  | { type: 'down' }
  | { type: 'revive' };

/** One hero state sample (wire form of opcode 0x01; the body of each 0x02 entry). */
export interface HeroSample {
  /** u16, wraps. */
  seq: number;
  /** Room time of the sample (ms, u32): the client's estimate, clamped by the server. */
  t: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  facing: number;
  mode: number;
  /** HF bits. */
  flags: number;
  /** HB bits. */
  blocks: number;
  /** Bumped by the client on every deliberate teleport (respawn, water, recovery, server correction); u8, wraps. */
  tp: number;
  /** Combat animation overlay (`CA` action, 0 = none): side, age and length (s). */
  action: number;
  actionSide: number;
  actionT: number;
  actionDur: number;
  ax: number;
  ay: number;
  az: number;
  zx: number;
  zy: number;
  zz: number;
  wnx: number;
  wnz: number;
  wrun: number;
  travKind: number;
  travT: number;
  travDur: number;
  events: NetEvent[];
}

export function makeHeroSample(): HeroSample {
  return {
    seq: 0, t: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, facing: 0, mode: 0, flags: 0, blocks: 0, tp: 0,
    action: 0, actionSide: 0, actionT: 0, actionDur: 0, ax: 0, ay: 0, az: 0, zx: 0, zy: 0, zz: 0, wnx: 0, wnz: 0, wrun: 0,
    travKind: 0, travT: 0, travDur: 0, events: [],
  };
}

// ---------------------------------------------------------------------------
// Room codes

/** Upper-cases and drops spaces and dashes ("k7p2 qx" → "K7P2QX"). */
export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, '');
}

export function isRoomCode(code: string): boolean {
  if (code.length !== NET.roomCodeLength) return false;
  for (let i = 0; i < code.length; i++) if (NET.roomCodeAlphabet.indexOf(code[i]) < 0) return false;
  return true;
}

/** A random room code; `randInt(n)` returns an integer in [0, n) (the server passes crypto.randomInt). */
export function makeRoomCode(randInt: (n: number) => number): string {
  const a = NET.roomCodeAlphabet;
  let s = '';
  for (let i = 0; i < NET.roomCodeLength; i++) s += a[randInt(a.length)];
  return s;
}
