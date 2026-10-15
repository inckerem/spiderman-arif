/**
 * Wire codec (design M12 §2). Binary frames: first byte = opcode, little
 * endian. Text frames: JSON, validated field by field on the server side
 * (`parseClientMsg`), because anything a socket sends is untrusted.
 *
 * Hero state body (opcode 0x01 follows with this; each 0x02 entry is u8 pid + this):
 *   u16 seq, u32 tMs, f32 x,y,z, i16 vx,vy,vz (×100), u16 facing, u8 mode,
 *   u8 flags (HF), u8 blocks (HB), u8 tp, u8 action, u8 actionSide,
 *   u8 actionT (×100), u8 actionDur (×100)                                    = 34 B
 *   [HB.ANCHOR f32×3] [HB.ZIP f32×3] [HB.WALL i8 nx, i8 nz, u8 run ×10] [HB.TRAV u8 kind, u8 t ×100, u8 dur ×100]
 *   u8 nEvents, events (u8 code + payload)
 * Enemy snapshot (0x03): u32 roomMs, u8 count, per enemy 18 B:
 *   u16 id, u8 kind, u8 state, i16 x (×20), i16 y (×50), i16 z (×20), u16 yaw,
 *   u8 hp (×255), u8 guard (×255), u8 anim, u8 animT (×50), u8 flags, u8 target
 *   then u8 hasSelf and, when 1, the receiver's own combat state (21 B):
 *   u16 hp ×10, u16 maxHp ×10, u8 down, i32 downUntil, u16 combo, i32 comboUntil,
 *   u16 focus ×10, i32 iframesUntil (times: ms relative to roomMs)
 *
 * PURE: no DOM, no Node APIs.
 */
import {
  HB,
  NET,
  OP_ENEMIES,
  OP_STATE,
  OP_STATES,
  makeHeroSample,
  type ClientMsg,
  type HeroSample,
  type JoinRequest,
  type NetEvent,
  type ServerMsg,
} from './protocol';
import { isMapId } from './maps';
import { DEBUG_OPS, type CombatIntent, type EnemySnap, type HeroCombatSnap } from '../sim/types';

const TAU = Math.PI * 2;
const ENEMY_BYTES = 18;
const STATE_FIXED = 34;
const STATE_T_OFFSET = 2; // tMs inside the body

// ---------------------------------------------------------------------------
// Byte writer (reused: no allocation per message except the final copy)

export class ByteWriter {
  private buf: ArrayBuffer;
  private dv: DataView;
  private u8: Uint8Array;
  len = 0;

  constructor(capacity = 512) {
    this.buf = new ArrayBuffer(capacity);
    this.dv = new DataView(this.buf);
    this.u8 = new Uint8Array(this.buf);
  }

  reset(): this {
    this.len = 0;
    return this;
  }

  private need(n: number): void {
    if (this.len + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new ArrayBuffer(cap);
    new Uint8Array(next).set(this.u8.subarray(0, this.len));
    this.buf = next;
    this.dv = new DataView(next);
    this.u8 = new Uint8Array(next);
  }

  u8w(v: number): void {
    this.need(1);
    this.dv.setUint8(this.len, v);
    this.len += 1;
  }
  i8w(v: number): void {
    this.need(1);
    this.dv.setInt8(this.len, v);
    this.len += 1;
  }
  u16w(v: number): void {
    this.need(2);
    this.dv.setUint16(this.len, v, true);
    this.len += 2;
  }
  i16w(v: number): void {
    this.need(2);
    this.dv.setInt16(this.len, v, true);
    this.len += 2;
  }
  i32w(v: number): void {
    this.need(4);
    this.dv.setInt32(this.len, v | 0, true);
    this.len += 4;
  }
  u32w(v: number): void {
    this.need(4);
    this.dv.setUint32(this.len, v >>> 0, true);
    this.len += 4;
  }
  f32w(v: number): void {
    this.need(4);
    this.dv.setFloat32(this.len, v, true);
    this.len += 4;
  }
  bytes(b: Uint8Array): void {
    this.need(b.length);
    this.u8.set(b, this.len);
    this.len += b.length;
  }
  /** A copy of the written bytes (safe to hand to a socket). */
  finish(): Uint8Array {
    return this.u8.slice(0, this.len);
  }
}

// ---------------------------------------------------------------------------
// Quantization helpers

const clampInt = (v: number, lo: number, hi: number): number => {
  const r = Math.round(v);
  return r < lo ? lo : r > hi ? hi : r;
};
const q8 = (v: number, scale: number): number => clampInt(v * scale, 0, 255);
const qi8 = (v: number, scale: number): number => clampInt(v * scale, -127, 127);
const qi16 = (v: number, scale: number): number => clampInt(v * scale, -32768, 32767);
const finiteOr0 = (v: number): number => (Number.isFinite(v) ? v : 0);
/** Angle → u16 (wraps). */
export const angleToU16 = (a: number): number => {
  const f = finiteOr0(a) / TAU;
  return Math.round((f - Math.floor(f)) * 65536) & 0xffff;
};
/** u16 → angle in (-π, π]. */
export const u16ToAngle = (v: number): number => {
  const a = (v / 65536) * TAU;
  return a > Math.PI ? a - TAU : a;
};

// ---------------------------------------------------------------------------
// Hero events

export const NE = {
  jump: 1, land: 2, webFire: 3, attach: 4, release: 5, boost: 6, dive: 7, zipStart: 8, zipEnd: 9,
  wallGrab: 10, wallJump: 11, vault: 12, mantle: 13, splash: 14, respawn: 15, recover: 16,
  strike: 17, dodge: 18, hurt: 19, down: 20, revive: 21, lunge: 22, lungeEnd: 23,
} as const satisfies Record<NetEvent['type'], number>;

const NE_NAMES: Array<NetEvent['type'] | undefined> = [];
for (const k of Object.keys(NE) as Array<NetEvent['type']>) NE_NAMES[NE[k]] = k;

function writeEvent(w: ByteWriter, e: NetEvent): void {
  w.u8w(NE[e.type]);
  switch (e.type) {
    case 'land':
      w.u16w(clampInt(e.impact * 100, 0, 65535));
      w.u8w(clampInt(e.surface, 0, 255));
      w.u8w(e.roll ? 1 : 0);
      break;
    case 'webFire':
    case 'zipStart':
      w.u8w(e.hand & 1);
      w.f32w(e.x);
      w.f32w(e.y);
      w.f32w(e.z);
      break;
    case 'attach':
      w.u8w(e.hand & 1);
      w.f32w(e.x);
      w.f32w(e.y);
      w.f32w(e.z);
      w.i8w(qi8(e.nx, 127));
      w.i8w(qi8(e.ny, 127));
      w.i8w(qi8(e.nz, 127));
      break;
    case 'release':
      w.u8w((e.good ? 1 : 0) | (e.broken ? 2 : 0));
      w.u8w(q8(e.power, 255));
      break;
    case 'wallGrab':
      w.u8w(clampInt(e.surface, 0, 255));
      break;
    case 'splash':
      w.f32w(e.x);
      w.f32w(e.y);
      w.f32w(e.z);
      break;
    case 'strike':
      w.u8w(clampInt(e.move, 0, 255));
      break;
    case 'lungeEnd':
      w.u8w(e.ok ? 1 : 0);
      break;
    case 'hurt':
      w.u8w(clampInt(e.dmg, 0, 255));
      break;
    default:
      break; // no payload
  }
}

/** Reads one event at `o`; returns the new offset or -1 (unknown code, truncated). */
function readEvent(dv: DataView, o: number, end: number, out: NetEvent[]): number {
  if (o >= end) return -1;
  const type = NE_NAMES[dv.getUint8(o)];
  o += 1;
  if (!type) return -1;
  const need = (n: number): boolean => o + n <= end;
  switch (type) {
    case 'land':
      if (!need(4)) return -1;
      out.push({ type, impact: dv.getUint16(o, true) / 100, surface: dv.getUint8(o + 2), roll: dv.getUint8(o + 3) !== 0 });
      return o + 4;
    case 'webFire':
    case 'zipStart': {
      if (!need(13)) return -1;
      const hand = dv.getUint8(o) & 1;
      const x = dv.getFloat32(o + 1, true);
      const y = dv.getFloat32(o + 5, true);
      const z = dv.getFloat32(o + 9, true);
      out.push(type === 'webFire' ? { type, hand, x, y, z } : { type, hand, x, y, z });
      return o + 13;
    }
    case 'attach':
      if (!need(16)) return -1;
      out.push({
        type,
        hand: dv.getUint8(o) & 1,
        x: dv.getFloat32(o + 1, true),
        y: dv.getFloat32(o + 5, true),
        z: dv.getFloat32(o + 9, true),
        nx: dv.getInt8(o + 13) / 127,
        ny: dv.getInt8(o + 14) / 127,
        nz: dv.getInt8(o + 15) / 127,
      });
      return o + 16;
    case 'release': {
      if (!need(2)) return -1;
      const b = dv.getUint8(o);
      out.push({ type, good: (b & 1) !== 0, broken: (b & 2) !== 0, power: dv.getUint8(o + 1) / 255 });
      return o + 2;
    }
    case 'wallGrab':
      if (!need(1)) return -1;
      out.push({ type, surface: dv.getUint8(o) });
      return o + 1;
    case 'splash':
      if (!need(12)) return -1;
      out.push({ type, x: dv.getFloat32(o, true), y: dv.getFloat32(o + 4, true), z: dv.getFloat32(o + 8, true) });
      return o + 12;
    case 'strike':
      if (!need(1)) return -1;
      out.push({ type, move: dv.getUint8(o) });
      return o + 1;
    case 'lungeEnd':
      if (!need(1)) return -1;
      out.push({ type, ok: dv.getUint8(o) !== 0 });
      return o + 1;
    case 'hurt':
      if (!need(1)) return -1;
      out.push({ type, dmg: dv.getUint8(o) });
      return o + 1;
    default:
      out.push({ type } as NetEvent);
      return o;
  }
}

// ---------------------------------------------------------------------------
// Hero state

/** Writes a hero state body (no opcode, no pid). */
export function writeHeroBody(w: ByteWriter, s: HeroSample): void {
  w.u16w(s.seq & 0xffff);
  w.u32w(Math.max(0, Math.round(finiteOr0(s.t))));
  w.f32w(s.x);
  w.f32w(s.y);
  w.f32w(s.z);
  w.i16w(qi16(finiteOr0(s.vx), 100));
  w.i16w(qi16(finiteOr0(s.vy), 100));
  w.i16w(qi16(finiteOr0(s.vz), 100));
  w.u16w(angleToU16(s.facing));
  w.u8w(s.mode & 0xff);
  w.u8w(s.flags & 0xff);
  const blocks = s.blocks & 0x0f;
  w.u8w(blocks);
  w.u8w(s.tp & 0xff);
  w.u8w(s.action & 0xff);
  w.u8w(s.actionSide & 0xff);
  w.u8w(q8(finiteOr0(s.actionT), 100));
  w.u8w(q8(finiteOr0(s.actionDur), 100));
  if (blocks & HB.ANCHOR) {
    w.f32w(s.ax);
    w.f32w(s.ay);
    w.f32w(s.az);
  }
  if (blocks & HB.ZIP) {
    w.f32w(s.zx);
    w.f32w(s.zy);
    w.f32w(s.zz);
  }
  if (blocks & HB.WALL) {
    w.i8w(qi8(finiteOr0(s.wnx), 127));
    w.i8w(qi8(finiteOr0(s.wnz), 127));
    w.u8w(q8(finiteOr0(s.wrun), 10));
  }
  if (blocks & HB.TRAV) {
    w.u8w(s.travKind & 0xff);
    w.u8w(q8(finiteOr0(s.travT), 100));
    w.u8w(q8(finiteOr0(s.travDur), 100));
  }
  const n = Math.min(s.events.length, NET.maxStateEvents);
  w.u8w(n);
  for (let i = 0; i < n; i++) writeEvent(w, s.events[i]);
}

/**
 * Reads a hero state body at `o` into `out` (its events array is cleared and
 * refilled). Returns the offset after the body, or -1 when malformed.
 */
export function readHeroBody(dv: DataView, o: number, end: number, out: HeroSample): number {
  if (o + STATE_FIXED + 1 > end) return -1;
  out.seq = dv.getUint16(o, true);
  out.t = dv.getUint32(o + 2, true);
  out.x = dv.getFloat32(o + 6, true);
  out.y = dv.getFloat32(o + 10, true);
  out.z = dv.getFloat32(o + 14, true);
  out.vx = dv.getInt16(o + 18, true) / 100;
  out.vy = dv.getInt16(o + 20, true) / 100;
  out.vz = dv.getInt16(o + 22, true) / 100;
  out.facing = u16ToAngle(dv.getUint16(o + 24, true));
  out.mode = dv.getUint8(o + 26);
  out.flags = dv.getUint8(o + 27);
  const blocks = dv.getUint8(o + 28);
  if (blocks & 0xf0) return -1;
  out.blocks = blocks;
  out.tp = dv.getUint8(o + 29);
  out.action = dv.getUint8(o + 30);
  out.actionSide = dv.getUint8(o + 31);
  out.actionT = dv.getUint8(o + 32) / 100;
  out.actionDur = dv.getUint8(o + 33) / 100;
  o += STATE_FIXED;
  if (blocks & HB.ANCHOR) {
    if (o + 12 > end) return -1;
    out.ax = dv.getFloat32(o, true);
    out.ay = dv.getFloat32(o + 4, true);
    out.az = dv.getFloat32(o + 8, true);
    o += 12;
  }
  if (blocks & HB.ZIP) {
    if (o + 12 > end) return -1;
    out.zx = dv.getFloat32(o, true);
    out.zy = dv.getFloat32(o + 4, true);
    out.zz = dv.getFloat32(o + 8, true);
    o += 12;
  }
  if (blocks & HB.WALL) {
    if (o + 3 > end) return -1;
    out.wnx = dv.getInt8(o) / 127;
    out.wnz = dv.getInt8(o + 1) / 127;
    out.wrun = dv.getUint8(o + 2) / 10;
    o += 3;
  }
  if (blocks & HB.TRAV) {
    if (o + 3 > end) return -1;
    out.travKind = dv.getUint8(o);
    out.travT = dv.getUint8(o + 1) / 100;
    out.travDur = dv.getUint8(o + 2) / 100;
    o += 3;
  }
  if (o + 1 > end) return -1;
  const n = dv.getUint8(o);
  o += 1;
  if (n > NET.maxStateEvents) return -1;
  out.events.length = 0;
  for (let i = 0; i < n; i++) {
    o = readEvent(dv, o, end, out.events);
    if (o < 0) return -1;
  }
  return o;
}

const viewOf = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** C→S own hero state (opcode 0x01). */
export function encodeHeroState(s: HeroSample, w: ByteWriter = new ByteWriter(96)): Uint8Array {
  w.reset();
  w.u8w(OP_STATE);
  writeHeroBody(w, s);
  return w.finish();
}

/** Decodes a whole 0x01 packet; false when it is anything else or has trailing bytes. */
export function decodeHeroState(b: Uint8Array, out: HeroSample): boolean {
  if (b.length < 1 + STATE_FIXED + 1 || b[0] !== OP_STATE) return false;
  return readHeroBody(viewOf(b), 1, b.length, out) === b.length;
}

/** Rewrites tMs in a 0x01 packet in place (the server clamps it before relaying). */
export function setHeroStateTime(b: Uint8Array, tMs: number): void {
  viewOf(b).setUint32(1 + STATE_T_OFFSET, Math.max(0, Math.round(tMs)) >>> 0, true);
}

/**
 * S→C hero states batch (0x02): u8 count, then per entry u8 pid + body. The
 * bodies are the clients' own 0x01 packets without the opcode.
 */
export function encodeHeroStates(pids: readonly number[], packets: readonly Uint8Array[], count: number, w: ByteWriter): Uint8Array {
  w.reset();
  w.u8w(OP_STATES);
  const n = Math.min(count, 255);
  w.u8w(n);
  for (let i = 0; i < n; i++) {
    w.u8w(pids[i] & 0xff);
    w.bytes(packets[i].subarray(1));
  }
  return w.finish();
}

/**
 * Calls `each(pid, sample)` for every entry of a 0x02 batch. `scratch` is
 * reused between entries, so copy what must be kept. False when malformed.
 */
export function decodeHeroStates(b: Uint8Array, scratch: HeroSample, each: (pid: number, s: HeroSample) => void): boolean {
  if (b.length < 2 || b[0] !== OP_STATES) return false;
  const dv = viewOf(b);
  const n = b[1];
  let o = 2;
  for (let i = 0; i < n; i++) {
    if (o >= b.length) return false;
    const pid = b[o];
    o = readHeroBody(dv, o + 1, b.length, scratch);
    if (o < 0) return false;
    each(pid, scratch);
  }
  return o === b.length;
}

export function cloneHeroSample(s: HeroSample, out: HeroSample = makeHeroSample()): HeroSample {
  const ev = out.events;
  Object.assign(out, s);
  out.events = ev;
  ev.length = 0;
  for (const e of s.events) ev.push({ ...e });
  return out;
}

// ---------------------------------------------------------------------------
// Enemy snapshot

const SELF_BYTES = 21;
const I32_MIN = -2147483648;
const I32_MAX = 2147483647;
const relMs = (tS: number, roomMs: number): number => clampInt(finiteOr0(tS) * 1000 - roomMs, I32_MIN, I32_MAX);

/**
 * S→C enemy snapshot (0x03): the nearest enemies and, when `self` is given,
 * the receiver's own combat state (times in room seconds).
 */
export function encodeEnemySnapshot(roomMs: number, snaps: readonly EnemySnap[], count: number, w: ByteWriter, self: HeroCombatSnap | null = null): Uint8Array {
  w.reset();
  w.u8w(OP_ENEMIES);
  w.u32w(Math.max(0, Math.round(roomMs)));
  const n = Math.min(count, 255);
  w.u8w(n);
  for (let i = 0; i < n; i++) {
    const e = snaps[i];
    w.u16w(e.id & 0xffff);
    w.u8w(e.kind & 0xff);
    w.u8w(e.state & 0xff);
    w.i16w(qi16(finiteOr0(e.x), 20));
    w.i16w(qi16(finiteOr0(e.y), 50));
    w.i16w(qi16(finiteOr0(e.z), 20));
    w.u16w(angleToU16(e.yaw));
    w.u8w(q8(finiteOr0(e.hp), 255));
    w.u8w(q8(finiteOr0(e.guard), 255));
    w.u8w(e.anim & 0xff);
    w.u8w(q8(finiteOr0(e.animT), 50));
    w.u8w(e.flags & 0xff);
    w.u8w(e.target & 0xff);
  }
  w.u8w(self ? 1 : 0);
  if (self) {
    const base = Math.max(0, Math.round(roomMs));
    w.u16w(clampInt(finiteOr0(self.hp) * 10, 0, 65535));
    w.u16w(clampInt(finiteOr0(self.maxHp) * 10, 0, 65535));
    w.u8w(self.down ? 1 : 0);
    w.i32w(relMs(self.downUntil, base));
    w.u16w(clampInt(self.combo, 0, 65535));
    w.i32w(relMs(self.comboUntil, base));
    w.u16w(clampInt(finiteOr0(self.focus) * 10, 0, 65535));
    w.i32w(relMs(self.iframesUntil, base));
  }
  return w.finish();
}

/**
 * Decodes a 0x03 snapshot into the preallocated `out` (grown with fresh
 * objects only when too short) and, when present, the own state into
 * `self` (times in room seconds). Returns { roomMs, count, hasSelf } or null.
 */
export function decodeEnemySnapshot(
  b: Uint8Array,
  out: EnemySnap[],
  make: () => EnemySnap,
  self: HeroCombatSnap | null = null,
): { roomMs: number; count: number; hasSelf: boolean } | null {
  if (b.length < 7 || b[0] !== OP_ENEMIES) return null;
  const dv = viewOf(b);
  const roomMs = dv.getUint32(1, true);
  const n = b[5];
  const flagAt = 6 + n * ENEMY_BYTES;
  if (b.length < flagAt + 1) return null;
  const hasSelf = b[flagAt] === 1;
  if (b.length !== flagAt + 1 + (hasSelf ? SELF_BYTES : 0)) return null;
  while (out.length < n) out.push(make());
  let o = 6;
  for (let i = 0; i < n; i++, o += ENEMY_BYTES) {
    const e = out[i];
    e.id = dv.getUint16(o, true);
    e.kind = dv.getUint8(o + 2);
    e.state = dv.getUint8(o + 3);
    e.x = dv.getInt16(o + 4, true) / 20;
    e.y = dv.getInt16(o + 6, true) / 50;
    e.z = dv.getInt16(o + 8, true) / 20;
    e.yaw = u16ToAngle(dv.getUint16(o + 10, true));
    e.hp = dv.getUint8(o + 12) / 255;
    e.guard = dv.getUint8(o + 13) / 255;
    e.anim = dv.getUint8(o + 14);
    e.animT = dv.getUint8(o + 15) / 50;
    e.flags = dv.getUint8(o + 16);
    e.target = dv.getUint8(o + 17);
  }
  if (hasSelf && self) {
    o = flagAt + 1;
    const t = (rel: number): number => (roomMs + rel) / 1000;
    self.hp = dv.getUint16(o, true) / 10;
    self.maxHp = dv.getUint16(o + 2, true) / 10;
    self.down = dv.getUint8(o + 4) !== 0;
    self.downUntil = t(dv.getInt32(o + 5, true));
    self.combo = dv.getUint16(o + 9, true);
    self.comboUntil = t(dv.getInt32(o + 11, true));
    self.focus = dv.getUint16(o + 15, true) / 10;
    self.iframesUntil = t(dv.getInt32(o + 17, true));
  }
  return { roomMs, count: n, hasSelf };
}

// ---------------------------------------------------------------------------
// Text messages

export function encodeMsg(m: ServerMsg | ClientMsg): string {
  return JSON.stringify(m);
}

/** Server messages come from our own server; only the envelope is checked. */
export function parseServerMsg(text: string): ServerMsg | null {
  try {
    const m = JSON.parse(text) as unknown;
    return isObj(m) && typeof m.t === 'string' ? (m as ServerMsg) : null;
  } catch {
    return null;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => isNum(v) && Number.isInteger(v) && v >= lo && v <= hi;
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

const AIM_KINDS = ['yank', 'pin', 'takedown'] as const;

function parseIntent(v: unknown): CombatIntent | null {
  if (!isObj(v) || !isInt(v.seq, 0, 0xffffffff)) return null;
  if (v.k === 'dodge') return isNum(v.t) ? { k: 'dodge', seq: v.seq, t: v.t } : null;
  if (!isInt(v.target, 0, 0xffff) || !isNum(v.viewT) || !isNum(v.hx) || !isNum(v.hy) || !isNum(v.hz)) return null;
  const base = { seq: v.seq, target: v.target, viewT: v.viewT, hx: v.hx, hy: v.hy, hz: v.hz };
  if (v.k === 'strike') return isInt(v.move, 0, 255) ? { k: 'strike', move: v.move, ...base } : null;
  const k = AIM_KINDS.find((a) => a === v.k);
  return k ? { k, ...base } : null;
}

function parseJoin(v: unknown): JoinRequest | null {
  if (!isObj(v)) return null;
  if (v.kind === 'public') return { kind: 'public' };
  if (v.kind === 'code') return isStr(v.code, 16) ? { kind: 'code', code: v.code } : null;
  if (v.kind === 'create') return typeof v.pvp === 'boolean' ? { kind: 'create', pvp: v.pvp } : null;
  return null;
}

/**
 * Parses and validates a client text frame. Rebuilds the message from checked
 * fields only (unknown fields are dropped). Null for anything malformed.
 */
export function parseClientMsg(text: string): ClientMsg | null {
  if (text.length > NET.maxPayload) return null;
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(m)) return null;
  switch (m.t) {
    case 'hello': {
      if (!isInt(m.v, 0, 0xffff) || !isStr(m.name, 64) || !isStr(m.costume, 32) || !isMapId(m.map)) return null;
      const join = parseJoin(m.join);
      if (!join) return null;
      if (m.token !== undefined && !isStr(m.token, 64)) return null;
      const hello: ClientMsg = { t: 'hello', v: m.v, name: m.name, costume: m.costume, map: m.map, join };
      if (typeof m.token === 'string') hello.token = m.token;
      return hello;
    }
    case 'act': {
      const i = parseIntent(m.i);
      return i ? { t: 'act', i } : null;
    }
    case 'ping':
      return isNum(m.c) ? { t: 'ping', c: m.c } : null;
    case 'leave':
      return { t: 'leave' };
    case 'dbg': {
      const op = DEBUG_OPS.find((o) => o === m.op);
      if (!op || !Array.isArray(m.a) || m.a.length > 8 || !m.a.every(isNum)) return null;
      return { t: 'dbg', op, a: m.a.slice() as number[] };
    }
    default:
      return null;
  }
}
