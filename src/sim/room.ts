/**
 * Shared Room (design M12 §3): player slots, hero state relay with movement
 * sanity checks, the shared day-night clock, the PvP flag and the combat hook
 * (`RoomSim`). The Node server runs one per room; M11's LocalLink runs one
 * in-process for single player, so this file is PURE: no DOM, no rendering,
 * no Node-only APIs (tokens use the Web Crypto global, present in browsers
 * and Node alike).
 *
 * Times: the host passes its monotonic millisecond clock ("room ms"). On the
 * wire every time is room ms (binary) or room seconds (JSON: `ce` events,
 * intents). The sim keeps its own seconds (it may sleep while nobody is
 * connected); the Room converts both ways.
 */
import { tuning } from '../config/tuning';
import { DayClock } from '../net/clock';
import { encodeEnemySnapshot, encodeHeroStates, setHeroStateTime, ByteWriter } from '../net/codec';
import { checkName, nameKey, uniqueName } from '../net/names';
import {
  HF,
  NET,
  PROTOCOL_VERSION,
  type CorrectWhy,
  type KickWhy,
  type LeftWhy,
  type HeroSample,
  type PlayerInfo,
  type RoomInfo,
  type ServerMsg,
} from '../net/protocol';
import { SIM_DT, SIM_HZ } from './nullSim';
import {
  makeEnemySnap,
  makeHeroCombatSnap,
  type CombatEvent,
  type HeroCombatSnap,
  type CombatIntent,
  type CrimeEventInfo,
  type DebugOp,
  type EnemySnap,
  type HeroState,
  type MapRuntime,
  type RoomSim,
} from './types';

export interface RoomConfig {
  id: string;
  map: MapRuntime;
  /** Forced off in public rooms. */
  pvp: boolean;
  maxPlayers: number;
  publicRoom: boolean;
  /** Private rooms: the join code. */
  code?: string;
  /** Public rooms: 1-based index ("#2" is the first overflow room). */
  index: number;
  /** Accept `dbg` messages. */
  testHooks: boolean;
  /** Seconds a disconnected slot is kept for reconnects (default NET.reconnectGraceS). */
  reconnectGraceS?: number;
  /** Starting hour and real minutes per day (default tuning.time). */
  startHour?: number;
  dayLen?: number;
  /** Reconnect token source (default: 128 random bits from the Web Crypto global). */
  newToken?: () => string;
}

/** How a Room reaches its players. The host maps pids to connections. */
export interface RoomOut {
  send(pid: number, m: ServerMsg | Uint8Array): void;
  /** Tell the player (`kick` with `why`) and close its connection. The Room has already removed or handed over the slot. */
  disconnect(pid: number, why: KickWhy): void;
}

export interface Slot {
  readonly pid: number;
  readonly name: string;
  readonly costume: string;
  readonly token: string;
  connected: boolean;
  disconnectedAt: number;
  /** The sim's view of this hero (reused object). */
  readonly hero: HeroState;
  hasState: boolean;
  /** Last accepted sample: position, room ms, teleport counter. */
  lx: number;
  ly: number;
  lz: number;
  lt: number;
  ltp: number;
  /** A correction the client still has to apply. */
  fix: { x: number; y: number; z: number; sentAt: number } | null;
  /** Room ms of recent corrections (sliding window). */
  readonly corrections: number[];
  /** Round trip (ms) as measured by the host. */
  rtt: number;
  /** Enemies in the last snapshot sent. */
  lastSnapCount: number;
}

export type AdmitResult =
  | { pid: number; name: string; token: string; resumed: boolean; welcome: ServerMsg }
  | { reject: 'full' | 'name' | 'profanity' };

/** Outcome of a state check, for tests and logging. */
export const STATE_OK = 0;
export const STATE_CORRECTED = 1;
/** Dropped without counting: in flight before the client applied a correction. */
export const STATE_DROPPED = 2;
export const STATE_KICKED = 3;
export const STATE_IGNORED = 4;

const COSTUME_RE = /^[A-Za-z0-9_-]{1,32}$/;

function defaultToken(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export class Room {
  readonly id: string;
  readonly info: RoomInfo;
  readonly players = new Map<number, Slot>();
  readonly clock: DayClock;
  readonly maxPlayers: number;
  readonly pvp: boolean;
  /** Room ms of the last step (or the last host call that passed a time). */
  nowMs = 0;
  /** Steps run (awake or not). */
  steps = 0;
  /** Room ms when the room last became empty (no slots), or -1. */
  emptySince: number;

  private readonly cfg: RoomConfig;
  private readonly graceMs: number;
  private readonly newToken: () => string;
  /** room ms = simOffsetMs + sim.time · 1000 while the sim is awake. */
  private simOffsetMs = 0;
  private simAwake = false;
  private lastStepMs = -1;
  private nextClockMs = 0;
  private readonly events: CombatEvent[] = [];
  private readonly snaps: EnemySnap[] = [];
  private readonly relayPids: number[] = [];
  private readonly relayPackets: Uint8Array[] = [];
  private readonly sendPids: number[] = [];
  private readonly sendPackets: Uint8Array[] = [];
  private readonly writer = new ByteWriter(2048);
  private readonly respawn = { x: 0, y: 0, z: 0 };
  private readonly selfBuf = makeHeroCombatSnap();

  constructor(
    cfg: RoomConfig,
    private readonly out: RoomOut,
    readonly sim: RoomSim,
    nowMs = 0,
  ) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.maxPlayers = Math.max(1, Math.min(255, cfg.maxPlayers | 0));
    this.pvp = cfg.pvp && !cfg.publicRoom;
    this.graceMs = (cfg.reconnectGraceS ?? NET.reconnectGraceS) * 1000;
    this.newToken = cfg.newToken ?? defaultToken;
    this.clock = new DayClock(cfg.startHour ?? tuning.time.startHour, cfg.dayLen ?? tuning.time.dayLengthMinutes);
    this.info = {
      id: cfg.id,
      map: cfg.map.id,
      seed: cfg.map.seed,
      public: cfg.publicRoom,
      pvp: this.pvp,
      index: cfg.publicRoom ? cfg.index : 0,
    };
    if (cfg.code) this.info.code = cfg.code;
    for (let i = 0; i < NET.snapshotMax; i++) this.snaps.push(makeEnemySnap());
    this.nowMs = nowMs;
    this.emptySince = nowMs;
  }

  get hour(): number {
    return this.clock.hour;
  }

  /** No slots at all (reconnect slots count as occupied). */
  get empty(): boolean {
    return this.players.size === 0;
  }

  get full(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  get connectedCount(): number {
    let n = 0;
    for (const s of this.players.values()) if (s.connected) n++;
    return n;
  }

  /** Room seconds → sim seconds. */
  toSim(roomS: number): number {
    return roomS - this.simOffsetMs / 1000;
  }

  /** Sim seconds → room seconds. */
  toRoom(simS: number): number {
    return simS + this.simOffsetMs / 1000;
  }

  // -------------------------------------------------------------------------
  // Slots

  /** A slot with this reconnect token exists (connected or within its grace period). */
  hasToken(token: string): boolean {
    for (const s of this.players.values()) if (s.token === token) return true;
    return false;
  }

  /**
   * Admits a player (or resumes a disconnected slot when `token` matches).
   * The caller binds the pid to its connection, then sends `welcome`.
   */
  admit(name: string, costume: string, nowMs: number, token?: string): AdmitResult {
    this.nowMs = nowMs;
    if (token) {
      for (const s of this.players.values()) {
        if (s.token !== token) continue;
        if (s.connected) this.out.disconnect(s.pid, 'replaced');
        s.connected = true;
        s.disconnectedAt = 0;
        s.hero.afk = false;
        s.fix = null;
        return { pid: s.pid, name: s.name, token: s.token, resumed: true, welcome: this.welcome(s) };
      }
    }
    const check = checkName(name);
    if (!check.ok) return { reject: check.why === 'profanity' ? 'profanity' : 'name' };
    if (this.full) return { reject: 'full' };
    let pid = 1;
    while (this.players.has(pid)) pid++;
    const taken = new Set<string>();
    for (const s of this.players.values()) taken.add(nameKey(s.name));
    const display = uniqueName(check.name, taken);
    const slot: Slot = {
      pid,
      name: display,
      costume: COSTUME_RE.test(costume) ? costume : '',
      token: this.newToken(),
      connected: true,
      disconnectedAt: 0,
      hero: { pid, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, mode: 0, grounded: false, facing: 0, afk: false, t: 0 },
      hasState: false,
      lx: 0,
      ly: 0,
      lz: 0,
      lt: 0,
      ltp: 0,
      fix: null,
      corrections: [],
      rtt: 0,
      lastSnapCount: 0,
    };
    this.players.set(pid, slot);
    this.emptySince = -1;
    this.broadcast({ t: 'join', pid, name: display, costume: slot.costume }, pid);
    return { pid, name: display, token: slot.token, resumed: false, welcome: this.welcome(slot) };
  }

  private welcome(s: Slot): ServerMsg {
    const players: PlayerInfo[] = [];
    for (const o of this.players.values()) if (o.pid !== s.pid) players.push({ pid: o.pid, name: o.name, costume: o.costume });
    const active: CrimeEventInfo[] = [];
    this.sim.crimeEvents(active);
    const events = active.map((e) => ({ ...e, startedAt: this.toRoom(e.startedAt) }));
    return {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      pid: s.pid,
      name: s.name,
      room: { ...this.info },
      token: s.token,
      now: this.nowMs,
      players,
      events,
      clock: { hour: this.clock.hour, dayLen: this.clock.dayLen },
      hp: this.sim.heroHp(s.pid),
    };
  }

  /**
   * The connection of `pid` closed. With `keepForReconnect` the slot stays for
   * the grace period (hero frozen, ignored by enemies, invulnerable); without
   * it the player leaves at once and the others get `left`.
   */
  drop(pid: number, keepForReconnect: boolean, nowMs: number, why: LeftWhy = 'disconnect'): void {
    this.nowMs = nowMs;
    const s = this.players.get(pid);
    if (!s) return;
    if (keepForReconnect) {
      if (!s.connected) return;
      s.connected = false;
      s.disconnectedAt = nowMs;
      s.hero.afk = true;
      if (s.hasState) this.sim.upsertHero(s.hero);
      return;
    }
    this.remove(s, why);
  }

  private remove(s: Slot, why: LeftWhy): void {
    this.players.delete(s.pid);
    this.sim.removeHero(s.pid);
    if (this.players.size === 0) this.emptySince = this.nowMs;
    this.broadcast({ t: 'left', pid: s.pid, why });
  }

  /** Kick: remove the slot (the others get `left`), then the host tells the player and closes the connection. */
  kick(pid: number, why: KickWhy): void {
    const s = this.players.get(pid);
    if (!s) return;
    this.remove(s, why);
    this.out.disconnect(pid, why);
  }

  setRtt(pid: number, rttMs: number): void {
    const s = this.players.get(pid);
    if (!s || !Number.isFinite(rttMs)) return;
    s.rtt = Math.max(0, rttMs);
    this.sim.setRtt(pid, s.rtt / 1000);
  }

  // -------------------------------------------------------------------------
  // Hero states

  /**
   * A hero state arrived (client-authoritative movement). Clamps its time
   * into [recv − 1 s, recv], sanity-checks it, hands it to the sim and queues
   * `raw` (the client's 0x01 packet, time rewritten) for the relay batch.
   * Returns a STATE_* code.
   */
  onState(pid: number, s: HeroSample, raw: Uint8Array | null, recvMs: number): number {
    this.nowMs = Math.max(this.nowMs, recvMs);
    const slot = this.players.get(pid);
    if (!slot || !slot.connected) return STATE_IGNORED;
    const t = Math.min(recvMs, Math.max(recvMs - NET.stateTimeWindowMs, s.t));
    s.t = t;
    const verdict = this.checkState(slot, s, recvMs);
    if (verdict !== STATE_OK) return verdict;
    slot.hasState = true;
    slot.lx = s.x;
    slot.ly = s.y;
    slot.lz = s.z;
    slot.lt = Math.max(slot.lt, t);
    slot.ltp = s.tp;
    const h = slot.hero;
    h.x = s.x;
    h.y = s.y;
    h.z = s.z;
    h.vx = s.vx;
    h.vy = s.vy;
    h.vz = s.vz;
    h.mode = s.mode;
    h.facing = s.facing;
    h.grounded = (s.flags & HF.GROUNDED) !== 0;
    h.afk = (s.flags & (HF.AFK | HF.PAUSED)) !== 0;
    h.t = this.toSim(t / 1000);
    this.sim.upsertHero(h);
    if (raw) {
      const copy = Uint8Array.prototype.slice.call(raw) as Uint8Array;
      setHeroStateTime(copy, t);
      this.relayPids.push(pid);
      this.relayPackets.push(copy);
    }
    return STATE_OK;
  }

  private checkState(slot: Slot, s: HeroSample, recvMs: number): number {
    if (
      !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z) ||
      !Number.isFinite(s.vx) || !Number.isFinite(s.vy) || !Number.isFinite(s.vz)
    ) {
      return this.correct(slot, 'nan', recvMs);
    }
    const b = this.cfg.map.layout.bounds;
    const m = NET.boundsMargin;
    if (s.x < b.minX - m || s.x > b.maxX + m || s.z < b.minZ - m || s.z > b.maxZ + m || s.y < NET.minY || s.y > NET.maxY) {
      return this.correct(slot, 'bounds', recvMs);
    }
    if (!slot.hasState) return STATE_OK;
    if (slot.fix) {
      const f = slot.fix;
      const since = Math.max(0, recvMs - f.sentAt) / 1000;
      if (dist(s.x, s.y, s.z, f.x, f.y, f.z) <= NET.maxSpeed * since + NET.speedSlack) {
        slot.fix = null;
        slot.lx = f.x;
        slot.ly = f.y;
        slot.lz = f.z;
        slot.lt = s.t;
        return STATE_OK;
      }
      if (since > NET.correctionResendS) return this.correct(slot, 'speed', recvMs);
      return STATE_DROPPED;
    }
    // Capped: going quiet for a while must not buy an arbitrarily long jump.
    const dt = Math.min(NET.maxStateGapS, Math.max(0, s.t - slot.lt) / 1000);
    const d = dist(s.x, s.y, s.z, slot.lx, slot.ly, slot.lz);
    if (d <= NET.maxSpeed * dt + NET.speedSlack) return STATE_OK;
    if (s.tp === slot.ltp) return this.correct(slot, 'speed', recvMs);
    if (d <= NET.teleportRadius) return STATE_OK;
    const sp = this.cfg.map.layout.spawn;
    if (dist(s.x, s.y, s.z, sp[0], sp[1], sp[2]) <= NET.spawnRadius) return STATE_OK;
    const r = this.respawn;
    if (this.sim.respawnPoint(slot.pid, r) && dist(s.x, s.y, s.z, r.x, r.y, r.z) <= NET.spawnRadius) return STATE_OK;
    return this.correct(slot, 'teleport', recvMs);
  }

  /** Sends `correct` (last valid position, or the map spawn) and counts it; too many is a kick. */
  private correct(slot: Slot, why: CorrectWhy, recvMs: number): number {
    let x = slot.lx;
    let y = slot.ly;
    let z = slot.lz;
    if (!slot.hasState) [x, y, z] = this.cfg.map.layout.spawn;
    slot.fix = { x, y, z, sentAt: recvMs };
    const c = slot.corrections;
    c.push(recvMs);
    const from = recvMs - NET.correctionWindowS * 1000;
    while (c.length && c[0] < from) c.shift();
    if (c.length > NET.kickCorrections) {
      this.kick(slot.pid, 'cheat');
      return STATE_KICKED;
    }
    this.out.send(slot.pid, { t: 'correct', x, y, z, why });
    return STATE_CORRECTED;
  }

  // -------------------------------------------------------------------------
  // Combat hook

  /** A combat intent (rate-limited by the host). Times arrive in room seconds. */
  onIntent(pid: number, i: CombatIntent): void {
    const slot = this.players.get(pid);
    if (!slot || !slot.connected) return;
    // Validation (range, rate, time, state, PvP) is the sim's own: one set of rules for SP and the server.
    this.sim.intent(pid, i.k === 'dodge' ? { ...i, t: this.toSim(i.t) } : { ...i, viewT: this.toSim(i.viewT) });
  }

  /** `dbg` test hooks from player `pid`; ignored unless the room was created with testHooks. */
  onDebug(pid: number, op: DebugOp, a: readonly number[]): boolean {
    if (!this.cfg.testHooks || !this.players.has(pid)) return false;
    this.sim.debug(pid, op, a);
    return true;
  }

  // -------------------------------------------------------------------------
  // Step

  /**
   * One 30 Hz room step at room time `nowMs`: reconnect expiry, the shared
   * clock, the sim (asleep while nobody is connected), combat events, enemy
   * snapshots (every 2nd step) and the hero state relay.
   */
  step(nowMs: number): void {
    const dtS = this.lastStepMs < 0 ? 0 : Math.min(1, Math.max(0, nowMs - this.lastStepMs) / 1000);
    this.lastStepMs = nowMs;
    this.nowMs = nowMs;
    this.steps++;

    for (const s of this.players.values()) {
      if (!s.connected && nowMs - s.disconnectedAt >= this.graceMs) this.remove(s, 'timeout');
    }

    this.clock.advance(dtS);
    if (nowMs >= this.nextClockMs) {
      this.nextClockMs = nowMs + NET.clockEveryS * 1000;
      if (this.players.size) this.broadcast({ t: 'clock', hour: this.clock.hour, dayLen: this.clock.dayLen });
    }

    const awake = this.connectedCount > 0;
    if (awake) {
      const expected = this.simOffsetMs + (this.sim.time + SIM_DT) * 1000;
      if (!this.simAwake || Math.abs(expected - nowMs) > 250) this.simOffsetMs = nowMs - (this.sim.time + SIM_DT) * 1000;
      this.simAwake = true;
      this.sim.step();
      this.flushEvents();
      if (this.steps % NET.snapshotEvery === 0) this.sendSnapshots(nowMs);
    } else {
      this.simAwake = false;
    }
    this.flushRelay();
  }

  private flushEvents(): void {
    const ev = this.events;
    ev.length = 0;
    this.sim.drainEvents(ev);
    if (!ev.length) return;
    let shared: CombatEvent[] | null = null;
    for (const e of ev) {
      switch (e.e) {
        case 'tele':
          e.at = this.toRoom(e.at);
          break;
        case 'down':
          e.until = this.toRoom(e.until);
          break;
        case 'evStart':
          e.ev = { ...e.ev, startedAt: this.toRoom(e.ev.startedAt) }; // the info object may be the sim's own
          break;
        default:
          break;
      }
      if (e.e === 'rej') {
        this.out.send(e.pid, { t: 'ce', ev: [e] });
        continue;
      }
      (shared ??= []).push(e);
    }
    if (shared) this.broadcast({ t: 'ce', ev: shared });
  }

  /** Every connected hero gets the nearest enemies and its own combat state (15 Hz). */
  private sendSnapshots(nowMs: number): void {
    const me = this.selfBuf;
    for (const s of this.players.values()) {
      if (!s.connected || !s.hasState) continue;
      const n = this.sim.snapshot(s.hero.x, s.hero.y, s.hero.z, NET.snapshotRadius, this.snaps, NET.snapshotMax);
      s.lastSnapCount = n;
      let self: HeroCombatSnap | null = null;
      if (this.sim.selfSnap(s.pid, me)) {
        me.downUntil = this.toRoom(me.downUntil);
        me.comboUntil = this.toRoom(me.comboUntil);
        me.iframesUntil = this.toRoom(me.iframesUntil);
        self = me;
      }
      this.out.send(s.pid, encodeEnemySnapshot(nowMs, this.snaps, n, this.writer, self));
    }
  }

  private flushRelay(): void {
    const n = this.relayPids.length;
    if (!n) return;
    for (const r of this.players.values()) {
      if (!r.connected) continue;
      this.sendPids.length = 0;
      this.sendPackets.length = 0;
      for (let i = 0; i < n; i++) {
        if (this.relayPids[i] === r.pid) continue;
        this.sendPids.push(this.relayPids[i]);
        this.sendPackets.push(this.relayPackets[i]);
        if (this.sendPids.length === 255) this.sendBatch(r.pid);
      }
      this.sendBatch(r.pid);
    }
    this.relayPids.length = 0;
    this.relayPackets.length = 0;
  }

  private sendBatch(pid: number): void {
    if (!this.sendPids.length) return;
    this.out.send(pid, encodeHeroStates(this.sendPids, this.sendPackets, this.sendPids.length, this.writer));
    this.sendPids.length = 0;
    this.sendPackets.length = 0;
  }

  /** Sends to every connected player (except one). */
  broadcast(m: ServerMsg | Uint8Array, except = -1): void {
    for (const s of this.players.values()) if (s.connected && s.pid !== except) this.out.send(s.pid, m);
  }
}

/** Steps per second of every Room (and the combat sim). */
export const ROOM_HZ = SIM_HZ;

function dist(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
