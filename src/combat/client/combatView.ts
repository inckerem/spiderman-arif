import { tuning } from '../../config/tuning';
import { ES, HERO_ID_BASE, type CombatEvent } from '../types';
import type { CombatDownMsg, CombatSnapshot } from './link';

/** Samples kept per enemy (online snapshots come at 15 Hz and render 0.1 s late: 8 is plenty). */
const RING = 8;
/** Extrapolation limit past the newest sample (s). */
const MAX_EXTRAPOLATE = 0.15;
/** Pending enemy attacks on this hero tracked at once. */
const MAX_THREATS = 8;
/** Recent events kept for tests and diagnostics. */
const LOG_SIZE = 128;

/** An enemy as this client sees it: replicated state plus a position interpolated at the render time. */
export interface ViewEnemy {
  id: number;
  kind: number;
  state: number;
  /** Interpolated at the last `update` (render time). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  guard: number;
  flags: number;
  anim: number;
  animT0: number;
  target: number;
  /** Render-only: a predicted hit flinch plays until this room time (prediction, chunk 4). */
  flinchUntil: number;
  /** Sample ring (room time, position, yaw), oldest at `head`. */
  readonly ts: Float64Array;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly zs: Float64Array;
  readonly yaws: Float64Array;
  head: number;
  n: number;
  /** Snapshot serial that last listed it (gone from snapshots = gone). */
  seen: number;
}

/** An enemy attack on this hero, from its telegraph until it lands or misses. */
export interface ThreatInfo {
  /** Attacker entity id, attack (`ATK`), impact time (room seconds). */
  src: number;
  atk: number;
  at: number;
  /** Attacker position when last sampled. */
  x: number;
  z: number;
}

/** This hero's combat state, from snapshots and events. */
export interface SelfView {
  hp: number;
  maxHp: number;
  down: boolean;
  downUntil: number;
  combo: number;
  comboUntil: number;
  focus: number;
  iframesUntil: number;
}

export interface LoggedEvent {
  time: number;
  ev: CombatEvent;
}

function makeViewEnemy(): ViewEnemy {
  return {
    id: 0,
    kind: 0,
    state: 0,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    hp: 0,
    maxHp: 0,
    guard: 0,
    flags: 0,
    anim: 0,
    animT0: 0,
    target: -1,
    flinchUntil: -1e9,
    ts: new Float64Array(RING),
    xs: new Float64Array(RING),
    ys: new Float64Array(RING),
    zs: new Float64Array(RING),
    yaws: new Float64Array(RING),
    head: 0,
    n: 0,
    seen: 0,
  };
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Client-side combat state (browser, no DOM): the replicated enemies with
 * positions interpolated at the link's render time, this hero's health,
 * combo and focus, and the enemy attacks aimed at it (spider-sense, dodge
 * timing). Fed only through `apply` with the link's messages, so single
 * player and online look the same to the router, HUD and renderers.
 *
 * Interpolation (design §M12.4): linear in position and yaw between the two
 * samples around the render time, extrapolated at most 0.15 s past the
 * newest on an underrun; a change into YANKED or KO snaps (the history is
 * dropped) so a yank never smears across the street.
 */
export class CombatView {
  /** Enemies currently replicated (pooled entries; order is not stable). */
  readonly enemies: ViewEnemy[] = [];
  readonly self: SelfView = { hp: 100, maxHp: 100, down: false, downUntil: 0, combo: 0, comboUntil: -1e9, focus: 0, iframesUntil: -1e9 };
  /** The soonest pending attack on this hero, or null. */
  threat: ThreatInfo | null = null;
  selfPid = 1;
  /** Room time of the newest snapshot. */
  snapTime = 0;
  private readonly byId = new Map<number, ViewEnemy>();
  private readonly pool: ViewEnemy[] = [];
  private readonly threats: ThreatInfo[] = [];
  private nThreats = 0;
  private serial = 0;
  /** Events not yet taken by `drainEvents` (the router, audio, HUD). */
  private readonly pending: CombatEvent[] = [];
  private readonly log: LoggedEvent[] = [];
  private logHead = 0;

  constructor() {
    for (let i = 0; i < MAX_THREATS; i++) this.threats.push({ src: 0, atk: 0, at: 0, x: 0, z: 0 });
  }

  get selfId(): number {
    return HERO_ID_BASE + this.selfPid;
  }

  enemy(id: number): ViewEnemy | undefined {
    return this.byId.get(id);
  }

  /** A message from the link: an event batch or a snapshot. */
  apply(msg: CombatDownMsg): void {
    if (msg.t === 'snap') this.applySnapshot(msg);
    else for (const ev of msg.ev) this.applyEvent(ev, msg.time);
  }

  /** Interpolate every enemy at `renderTime` and refresh the threat list at room time `now`. */
  update(now: number, renderTime: number): void {
    for (const e of this.enemies) this.sample(e, renderTime);
    // Threats: drop the stale ones (landed or long past), keep the soonest.
    let best: ThreatInfo | null = null;
    for (let i = 0; i < this.nThreats; ) {
      const t = this.threats[i]!;
      if (now > t.at + 0.25) {
        this.removeThreat(i);
        continue;
      }
      const e = this.byId.get(t.src);
      if (e) {
        t.x = e.x;
        t.z = e.z;
      }
      if (!best || t.at < best.at) best = t;
      i++;
    }
    this.threat = best;
  }

  /** Take the events received since the last call. */
  drainEvents(out: CombatEvent[]): void {
    for (const ev of this.pending) out.push(ev);
    this.pending.length = 0;
  }

  /** Recent events, oldest first (tests, diagnostics). */
  recentEvents(): LoggedEvent[] {
    const n = this.log.length;
    if (n < LOG_SIZE) return this.log.slice();
    return [...this.log.slice(this.logHead), ...this.log.slice(0, this.logHead)];
  }

  /** Render-only predicted flinch (the confirmed `hit` decides the damage). */
  flinch(id: number, until: number): void {
    const e = this.byId.get(id);
    if (e) e.flinchUntil = until;
  }

  /** Forget everything (leaving a room, a new game). */
  reset(): void {
    for (const e of this.enemies) this.pool.push(e);
    this.enemies.length = 0;
    this.byId.clear();
    this.nThreats = 0;
    this.threat = null;
    this.pending.length = 0;
    this.log.length = 0;
    this.logHead = 0;
    const s = this.self;
    s.hp = s.maxHp = tuning.combat.maxHp;
    s.down = false;
    s.combo = 0;
    s.comboUntil = -1e9;
    s.focus = 0;
    s.iframesUntil = -1e9;
  }

  // ---------------------------------------------------------------------------

  private applySnapshot(s: CombatSnapshot): void {
    const serial = ++this.serial;
    this.snapTime = s.time;
    for (let i = 0; i < s.count; i++) {
      const o = s.enemies[i]!;
      let e = this.byId.get(o.id);
      if (!e) {
        e = this.pool.pop() ?? makeViewEnemy();
        e.id = o.id;
        e.n = 0;
        e.head = 0;
        e.flinchUntil = -1e9;
        e.x = o.x;
        e.y = o.y;
        e.z = o.z;
        e.yaw = o.yaw;
        e.state = o.state;
        this.enemies.push(e);
        this.byId.set(o.id, e);
      }
      // A yank or a KO teleports the pose: no smear from the old samples.
      if (o.state !== e.state && (o.state === ES.YANKED || o.state === ES.KO)) e.n = 0;
      e.kind = o.kind;
      e.state = o.state;
      e.hp = o.hp;
      e.maxHp = o.maxHp;
      e.guard = o.guard;
      e.flags = o.flags;
      e.anim = o.anim;
      e.animT0 = o.animT0;
      e.target = o.target;
      e.seen = serial;
      this.push(e, s.time, o.x, o.y, o.z, o.yaw);
    }
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]!;
      if (e.seen === serial) continue;
      this.enemies[i] = this.enemies[this.enemies.length - 1]!;
      this.enemies.pop();
      this.byId.delete(e.id);
      this.pool.push(e);
      for (let k = this.nThreats - 1; k >= 0; k--) if (this.threats[k]!.src === e.id) this.removeThreat(k);
    }
    const self = s.self;
    if (self) {
      const v = this.self;
      v.hp = self.hp;
      v.maxHp = self.maxHp;
      v.down = self.down;
      v.downUntil = self.downUntil;
      v.combo = self.combo;
      v.comboUntil = self.comboUntil;
      v.focus = self.focus;
      v.iframesUntil = self.iframesUntil;
    }
  }

  private push(e: ViewEnemy, t: number, x: number, y: number, z: number, yaw: number): void {
    // Same time twice (a re-sent snapshot): overwrite the newest.
    let k: number;
    if (e.n > 0 && Math.abs(e.ts[(e.head + e.n - 1) % RING]! - t) < 1e-6) k = (e.head + e.n - 1) % RING;
    else if (e.n < RING) k = (e.head + e.n++) % RING;
    else {
      k = e.head;
      e.head = (e.head + 1) % RING;
    }
    e.ts[k] = t;
    e.xs[k] = x;
    e.ys[k] = y;
    e.zs[k] = z;
    e.yaws[k] = yaw;
  }

  private sample(e: ViewEnemy, t: number): void {
    const n = e.n;
    if (n === 0) return;
    const R = RING;
    const first = e.head;
    const last = (e.head + n - 1) % R;
    if (n === 1 || t <= e.ts[first]!) {
      const k = t <= e.ts[first]! ? first : last;
      e.x = e.xs[k]!;
      e.y = e.ys[k]!;
      e.z = e.zs[k]!;
      e.yaw = e.yaws[k]!;
      return;
    }
    if (t >= e.ts[last]!) {
      // Underrun: extrapolate from the last two samples, at most MAX_EXTRAPOLATE.
      const p = (e.head + n - 2) % R;
      const span = e.ts[last]! - e.ts[p]!;
      const k = span > 1e-6 ? Math.min(t - e.ts[last]!, MAX_EXTRAPOLATE) / span : 0;
      e.x = e.xs[last]! + (e.xs[last]! - e.xs[p]!) * k;
      e.y = e.ys[last]! + (e.ys[last]! - e.ys[p]!) * k;
      e.z = e.zs[last]! + (e.zs[last]! - e.zs[p]!) * k;
      e.yaw = e.yaws[last]!;
      return;
    }
    for (let i = n - 2; i >= 0; i--) {
      const a = (e.head + i) % R;
      if (e.ts[a]! <= t) {
        const b = (a + 1) % R;
        const span = e.ts[b]! - e.ts[a]!;
        const u = span > 1e-6 ? (t - e.ts[a]!) / span : 1;
        e.x = e.xs[a]! + (e.xs[b]! - e.xs[a]!) * u;
        e.y = e.ys[a]! + (e.ys[b]! - e.ys[a]!) * u;
        e.z = e.zs[a]! + (e.zs[b]! - e.zs[a]!) * u;
        e.yaw = lerpAngle(e.yaws[a]!, e.yaws[b]!, u);
        return;
      }
    }
  }

  private applyEvent(ev: CombatEvent, time: number): void {
    // Nobody draining (combat switched off mid-step): keep only the newest.
    if (this.pending.length >= 256) this.pending.splice(0, 128);
    this.pending.push(ev);
    if (this.log.length < LOG_SIZE) this.log.push({ time, ev });
    else {
      this.log[this.logHead] = { time, ev };
      this.logHead = (this.logHead + 1) % LOG_SIZE;
    }
    const me = this.selfId;
    const s = this.self;
    switch (ev.e) {
      case 'tele':
        if (ev.tgt === me) this.addThreat(ev.src, ev.atk, ev.at);
        break;
      case 'hit':
        if (ev.tgt === me) {
          s.hp = ev.hp;
          s.combo = 0;
          this.clearThreat(ev.src);
        } else if (ev.src === me) {
          const e = this.byId.get(ev.tgt);
          if (e) e.hp = ev.hp;
        }
        break;
      case 'miss':
        if (ev.tgt === me) this.clearThreat(ev.src);
        break;
      case 'down':
        if (ev.pid === this.selfPid) {
          s.down = true;
          s.downUntil = ev.until;
          s.hp = 0;
          this.nThreats = 0;
          this.threat = null;
        }
        break;
      case 'respawn':
        if (ev.pid === this.selfPid) {
          s.down = false;
          s.hp = s.maxHp;
        }
        break;
      default:
        break;
    }
  }

  private addThreat(src: number, atk: number, at: number): void {
    this.clearThreat(src);
    if (this.nThreats >= MAX_THREATS) return;
    const t = this.threats[this.nThreats++]!;
    t.src = src;
    t.atk = atk;
    t.at = at;
    const e = this.byId.get(src);
    t.x = e ? e.x : 0;
    t.z = e ? e.z : 0;
  }

  private clearThreat(src: number): void {
    for (let i = this.nThreats - 1; i >= 0; i--) if (this.threats[i]!.src === src) this.removeThreat(i);
  }

  private removeThreat(i: number): void {
    const last = this.nThreats - 1;
    if (i !== last) {
      const a = this.threats[i]!;
      this.threats[i] = this.threats[last]!;
      this.threats[last] = a;
    }
    this.nThreats--;
    if (this.threat && this.nThreats === 0) this.threat = null;
  }
}

