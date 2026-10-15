import { Vector3 } from 'three';
import { tuning } from '../config/tuning';
import { clamp } from '../core/math';
import { Rng } from '../core/rng';
import type { CollisionWorld } from '../physics/collision';
import { findRespawnRoof, findSafeSpot } from '../physics/safeSpot';
import type { CityLayout } from '../world/types';
import { BRAINS, type BrainHost } from './brains';
import type { SimEnemy, SimHero } from './entities';
import { hashCombat } from './hash';
import { PosHistory } from './history';
import { GroundMover, makeMoveResult } from './mover';
import { isBoss, kindInfo, kindStats } from './roster';
import { inArena, type SpawnPoints } from './spawnPoints';
import {
  ANIM,
  ATK,
  CHAIN_MOVES,
  EF,
  ES,
  HERO_ID_BASE,
  HIT,
  MAX_ENEMY_ID,
  MOVE,
  type CombatEvent,
  type CombatHero,
  type CombatIntent,
  type CrimeEventInfo,
  type Enemy,
  type EnemyKind,
  type HeroState,
  type RejectReason,
} from './types';

export interface CombatSimOptions {
  pvp: boolean;
  /** Pool size (`events.maxEnemiesSp` in single player, `events.maxEnemiesMp` in a room). */
  maxEnemies: number;
}

/** An enemy attack that landed in range and waits for its resolution time (dodge check). */
interface PendingHit {
  src: number;
  pid: number;
  atk: number;
  dmg: number;
  impactAt: number;
  resolveAt: number;
  kx: number;
  ky: number;
  kz: number;
  fl: number;
}

const MAX_HEROES = 64;
const HERO_HISTORY = 24;
const ENEMY_HISTORY = 24;
/** Torso height used for hero-to-enemy distance checks. */
const HERO_TORSO = 1.0;
/** Melee hits on a hero: extra horizontal slack beyond the attack range, and the vertical band. */
const MELEE_SLACK = 0.5;
const MELEE_DY = 1.6;
/** Water or a fall out of the world KOs below this height. */
const KILL_Y = -8;
/** Accepted dodge stamps kept per hero. */
const DODGE_RING = 4;
/** Hero samples this far from the respawn spot are stale after a respawn (until one arrives near it). */
const RESPAWN_STALE = 10;
const RESPAWN_STALE_TIME = 2;

const scratch = new Vector3();

/**
 * The combat world: enemies, heroes' health, hits. Pure and deterministic: a
 * fixed 30 Hz step, one seeded Rng, sim time only. Runs in-process in single
 * player (through the Room, chunk 3) and on the Node server (M12) with the
 * same intent validation.
 *
 * Per step: (1) extrapolate heroes and record history, (2) validate and apply
 * queued intents, (3) scheduler and roaming (chunk 7), (4) brains, (5) movers,
 * (6) telegraph impacts and pending hit resolution (dodges), (7) projectiles
 * (chunk 6), (8) hero regeneration and down -> roof respawn, (9) event
 * clear/expire (chunk 7) and KO recycling.
 */
export class CombatSim implements BrainHost {
  static readonly DT = 1 / 30;
  /** Active enemies (KO'd ones stay `koLinger` seconds, then their pool entry is recycled). */
  readonly enemies: SimEnemy[] = [];
  readonly heroes = new Map<number, SimHero>();
  time = 0;
  steps = 0;
  /** Crime scheduler and roaming patrols (chunk 7; no effect yet). */
  scheduler = false;
  roaming = false;
  pvp: boolean;
  readonly rng: Rng;
  readonly mover: GroundMover;
  readonly maxEnemies: number;

  private readonly pool: SimEnemy[] = [];
  private readonly free: number[] = [];
  private readonly byId = new Map<number, SimEnemy>();
  private nextId = 1;
  private readonly heroSlots: number[] = [];
  private readonly enemyHist: PosHistory;
  private readonly heroHist: PosHistory;
  private readonly queue: Array<{ pid: number; i: CombatIntent }> = [];
  private readonly pending: PendingHit[] = [];
  private readonly out: CombatEvent[] = [];
  private readonly moveRes = makeMoveResult();
  /** Active crime events (chunk 7). */
  readonly events: CrimeEventInfo[] = [];

  constructor(
    readonly world: CollisionWorld,
    readonly layout: CityLayout,
    readonly spawns: SpawnPoints,
    seed: number,
    opts: CombatSimOptions,
  ) {
    this.pvp = opts.pvp;
    this.maxEnemies = Math.max(1, Math.min(opts.maxEnemies, MAX_ENEMY_ID));
    this.rng = new Rng((seed ^ 0x5c0a7b17) >>> 0);
    this.mover = new GroundMover(world);
    this.enemyHist = new PosHistory(this.maxEnemies, ENEMY_HISTORY);
    this.heroHist = new PosHistory(MAX_HEROES, HERO_HISTORY);
    for (let i = this.maxEnemies - 1; i >= 0; i--) {
      this.pool[i] = makeEnemy(i);
      this.free.push(i);
    }
    for (let i = MAX_HEROES - 1; i >= 0; i--) this.heroSlots.push(i);
  }

  // ---------------------------------------------------------------------------
  // Heroes
  // ---------------------------------------------------------------------------

  /** Latest movement sample of a hero (client-authoritative movement). */
  upsertHero(s: HeroState): void {
    let h = this.heroes.get(s.pid);
    if (!h) {
      const hi = this.heroSlots.pop();
      if (hi === undefined) return;
      this.heroHist.clear(hi);
      const c = tuning.combat;
      h = {
        pid: s.pid,
        x: s.x,
        y: s.y,
        z: s.z,
        vx: 0,
        vy: 0,
        vz: 0,
        mode: 0,
        grounded: false,
        facing: 0,
        afk: false,
        t: s.t,
        hp: c.maxHp,
        maxHp: c.maxHp,
        down: false,
        downUntil: 0,
        lastHurt: -1e9,
        iframesUntil: -1e9,
        combo: 0,
        comboUntil: -1e9,
        focus: 0,
        lastStrike: -1e9,
        px: s.x,
        py: s.y,
        pz: s.z,
        hi,
        tokens: c.maxIntentRate,
        grace: 0,
        dodges: new Float64Array(DODGE_RING).fill(-1e9),
        dodgeHead: 0,
        awaitUntil: -1e9,
      };
      this.heroes.set(s.pid, h);
    } else if (this.time < h.awaitUntil && Math.hypot(s.x - h.x, s.y - h.y, s.z - h.z) > RESPAWN_STALE) {
      // Still the pre-respawn position: the client has not applied the teleport yet.
      return;
    } else {
      h.awaitUntil = -1e9;
    }
    h.x = s.x;
    h.y = s.y;
    h.z = s.z;
    h.vx = s.vx;
    h.vy = s.vy;
    h.vz = s.vz;
    h.mode = s.mode;
    h.grounded = s.grounded;
    h.facing = s.facing;
    h.afk = s.afk;
    h.t = s.t;
  }

  removeHero(pid: number): void {
    const h = this.heroes.get(pid);
    if (!h) return;
    const id = HERO_ID_BASE + pid;
    for (const e of this.enemies) {
      if (e.target === id) {
        this.releaseSlot(e);
        e.target = -1;
        e.tele = null;
      }
    }
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i]!.pid === pid) this.pending.splice(i, 1);
    this.heroes.delete(pid);
    this.heroSlots.push(h.hi);
  }

  /** Round-trip time of an online hero (s): hits on it resolve clamp(rtt / 2 + base, 0, max) late. 0 in single player. */
  setRtt(pid: number, rtt: number): void {
    const h = this.heroes.get(pid);
    if (h) h.grace = clamp(rtt / 2 + tuning.combat.graceBase, 0, tuning.combat.graceMax);
  }

  hero(pid: number): CombatHero | undefined {
    return this.heroes.get(pid);
  }

  /** A hero's position extrapolated to the current sim time. */
  heroPos(pid: number, out: Vector3): boolean {
    const h = this.heroes.get(pid);
    if (!h) return false;
    out.set(h.px, h.py, h.pz);
    return true;
  }

  heroById(id: number): SimHero | undefined {
    return id >= HERO_ID_BASE ? this.heroes.get(id - HERO_ID_BASE) : undefined;
  }

  heroTargetable(h: SimHero): boolean {
    return !h.down && !h.afk;
  }

  // ---------------------------------------------------------------------------
  // Intents, events, queries
  // ---------------------------------------------------------------------------

  /** Queue an intent; it is validated and applied at the next step. */
  intent(pid: number, i: CombatIntent): void {
    this.queue.push({ pid, i });
  }

  drainEvents(out: CombatEvent[]): void {
    for (const ev of this.out) out.push(ev);
    this.out.length = 0;
  }

  /** Position of an entity (enemy id or hero id) at sim time `t` from the history (lag compensation). */
  positionAt(id: number, t: number, out: Vector3): boolean {
    if (id >= HERO_ID_BASE) {
      const h = this.heroes.get(id - HERO_ID_BASE);
      if (!h) return false;
      if (!this.heroHist.sample(h.hi, t, out)) out.set(h.px, h.py, h.pz);
      return true;
    }
    const e = this.byId.get(id);
    if (!e) return false;
    if (!this.enemyHist.sample(e.pi, t, out)) out.copy(e.pos);
    return true;
  }

  enemy(id: number): Enemy | undefined {
    return this.byId.get(id);
  }

  hash(): string {
    return hashCombat(this.time, this.enemies, this.heroes);
  }

  // ---------------------------------------------------------------------------
  // Spawning and debug hooks (test API, server TEST_HOOKS)
  // ---------------------------------------------------------------------------

  /** Spawn an enemy standing at (x, z) (snapped to the support below y + 1). Returns its id, or -1 when the pool is full. */
  debugSpawn(kind: EnemyKind, x: number, y: number, z: number, eventId = -1, arena = -1): number {
    const pi = this.free.pop();
    if (pi === undefined) return -1;
    const e = this.pool[pi]!;
    const info = kindInfo(kind);
    const st = kindStats(kind);
    let id = this.nextId;
    while (this.byId.has(id)) id = id >= MAX_ENEMY_ID ? 1 : id + 1;
    this.nextId = id >= MAX_ENEMY_ID ? 1 : id + 1;
    if (!info.flyer) {
      const s = this.world.supportHeight(x, z, y + 1, 0);
      if (s.y > -Infinity) y = s.y;
    }
    e.id = id;
    e.kind = kind;
    e.state = ES.IDLE;
    e.stateT = 0;
    e.pos.set(x, y, z);
    e.vel.set(0, 0, 0);
    e.yaw = this.rng.range(-Math.PI, Math.PI);
    e.hp = st.hp;
    e.maxHp = st.hp;
    e.guard = info.guard;
    e.target = -1;
    e.eventId = eventId;
    e.arena = arena;
    e.flags = 0;
    e.tele = null;
    e.anim = ANIM.IDLE;
    e.animT0 = this.time;
    e.slot = -1;
    e.homeX = x;
    e.homeY = y;
    e.homeZ = z;
    e.wishX = 0;
    e.wishZ = 0;
    e.grounded = !info.flyer;
    e.fallTop = y;
    // Stagger the target searches over the retarget period.
    e.nextThink = this.time + this.rng.float() * tuning.enemies.retarget;
    e.cooldownUntil = this.time;
    e.until = 0;
    const en = tuning.enemies;
    e.circleR = this.rng.range(en.circleMin, en.circleMax);
    e.circleDir = this.rng.chance(0.5) ? 1 : -1;
    e.koAt = 0;
    this.enemies.push(e);
    this.byId.set(id, e);
    this.enemyHist.clear(pi);
    this.enemyHist.record(pi, this.time, x, y, z);
    this.out.push({ e: 'spawn', id, kind, x, y, z });
    return id;
  }

  /** Crime events arrive in chunk 7; until then nothing starts and this returns -1. */
  startEvent(_type: CrimeEventInfo['type'], _x?: number, _z?: number, _boss?: number): number {
    return -1;
  }

  /** Test hook: set a hero's health (0 knocks it down at the next step). */
  debugSetHp(pid: number, hp: number): void {
    const h = this.heroes.get(pid);
    if (!h) return;
    h.hp = clamp(hp, 0, h.maxHp);
    if (h.hp < h.maxHp) h.lastHurt = this.time;
  }

  /** Test hook: KO every enemy (events count them as cleared). */
  debugKillAll(): void {
    for (const e of this.enemies) if (e.state !== ES.KO) this.knockOut(e, -1, -1, e.hp, 0, 0, 0);
  }

  /** Test hook: remove every enemy at once. */
  debugClear(): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) this.recycle(i);
    this.pending.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Step
  // ---------------------------------------------------------------------------

  step(): void {
    const dt = CombatSim.DT;
    this.time += dt;
    this.steps++;
    const t = this.time;
    const c = tuning.combat;

    // (1) Heroes: extrapolate the last sample, record history, refill intent tokens.
    for (const h of this.heroes.values()) {
      const k = clamp(t - h.t, 0, c.heroExtrapolate);
      h.px = h.x + h.vx * k;
      h.py = h.y + h.vy * k;
      h.pz = h.z + h.vz * k;
      this.heroHist.record(h.hi, t, h.px, h.py, h.pz);
      h.tokens = Math.min(c.maxIntentRate, h.tokens + c.maxIntentRate * dt);
      if (h.combo > 0 && t > h.comboUntil) h.combo = 0;
    }

    // (2) Intents.
    for (let i = 0; i < this.queue.length; i++) {
      const q = this.queue[i]!;
      this.applyIntent(q.pid, q.i);
    }
    this.queue.length = 0;

    // (3) Scheduler and roaming: chunk 7.

    // (4) Brains.
    for (const e of this.enemies) {
      e.stateT += dt;
      BRAINS[e.kind]!(this, e, dt);
    }

    // (5) Movers.
    this.separate();
    for (const e of this.enemies) this.moveEnemy(e, dt);

    // (6) Telegraphs land; pending hits resolve (dodge window).
    for (const e of this.enemies) {
      if (e.tele && t >= e.tele.impactAt - 1e-9) this.landAttack(e);
    }
    // (A resolution can drop other pending hits, e.g. when it knocks the hero down: rescan after each.)
    for (let i = 0; i < this.pending.length; ) {
      const p = this.pending[i]!;
      if (t >= p.resolveAt - 1e-9) {
        this.pending.splice(i, 1);
        this.resolvePending(p);
        i = 0;
      } else i++;
    }

    // (7) Projectiles: chunk 6.

    // (8) Heroes: regeneration, down -> respawn.
    for (const h of this.heroes.values()) {
      if (h.down) {
        if (t >= h.downUntil) this.respawn(h);
        continue;
      }
      if (h.hp <= 0) {
        this.knockDownHero(h);
        continue;
      }
      if (h.hp < h.maxHp && t - h.lastHurt >= c.regenDelay) h.hp = Math.min(h.maxHp, h.hp + c.regenRate * dt);
    }

    // (9) Events: chunk 7. KO'd enemies leave after their linger time.
    const linger = tuning.enemies.koLinger;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]!;
      if (e.state === ES.KO && t - e.koAt >= linger) this.recycle(i);
    }
  }

  // ---------------------------------------------------------------------------
  // BrainHost
  // ---------------------------------------------------------------------------

  findTarget(e: SimEnemy): number {
    const range = tuning.enemies.aggroRange;
    const chest = tuning.body.chestHeight;
    const eh = kindInfo(e.kind).height * 0.8;
    let best = -1,
      bestD = range;
    for (const h of this.heroes.values()) {
      if (!this.heroTargetable(h)) continue;
      const d = Math.hypot(h.px - e.pos.x, h.py - e.pos.y, h.pz - e.pos.z);
      if (d >= bestD) continue;
      if (!this.mover.lineOfSight(e.pos.x, e.pos.y + eh, e.pos.z, h.px, h.py + chest, h.pz)) continue;
      best = HERO_ID_BASE + h.pid;
      bestD = d;
    }
    return best;
  }

  takeSlot(e: SimEnemy): boolean {
    if (e.slot >= 0) return true;
    if (e.target < 0 || !kindInfo(e.kind).melee) return false;
    const max = tuning.enemies.maxMeleeAttackers;
    let used = 0;
    for (const o of this.enemies) if (o !== e && o.target === e.target && o.slot >= 0) used |= 1 << o.slot;
    for (let s = 0; s < max; s++) {
      if ((used & (1 << s)) === 0) {
        e.slot = s;
        return true;
      }
    }
    return false;
  }

  releaseSlot(e: SimEnemy): void {
    e.slot = -1;
  }

  setState(e: SimEnemy, state: number, until = 0): void {
    e.state = state;
    e.stateT = 0;
    e.until = until;
  }

  setAnim(e: SimEnemy, anim: number): void {
    if (e.anim === anim) return;
    e.anim = anim;
    e.animT0 = this.time;
  }

  startTelegraph(e: SimEnemy, atk: number, delay: number): void {
    const at = this.time + delay;
    e.tele = { atk, target: e.target, impactAt: at };
    this.setState(e, ES.TELEGRAPH, at);
    this.setAnim(e, ANIM.WINDUP);
    this.out.push({ e: 'tele', src: e.id, tgt: e.target, atk, at });
  }

  // ---------------------------------------------------------------------------
  // Internals: movement
  // ---------------------------------------------------------------------------

  /** Keep enemies `enemies.separation` apart by bending their desired velocity (the resolver stays authoritative). */
  private separate(): void {
    const sep = tuning.enemies.separation;
    const list = this.enemies;
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      if (a.state === ES.KO) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]!;
        if (b.state === ES.KO) continue;
        const dx = b.pos.x - a.pos.x,
          dz = b.pos.z - a.pos.z;
        if (Math.abs(b.pos.y - a.pos.y) > 1.5) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 >= sep * sep) continue;
        const d = Math.sqrt(d2);
        const nx = d > 1e-4 ? dx / d : (a.id & 1) === 0 ? 1 : -1,
          nz = d > 1e-4 ? dz / d : 0;
        const push = ((sep - d) / sep) * 2.5;
        a.wishX -= nx * push;
        a.wishZ -= nz * push;
        b.wishX += nx * push;
        b.wishZ += nz * push;
      }
    }
  }

  private moveEnemy(e: SimEnemy, dt: number): void {
    const info = kindInfo(e.kind);
    if (info.flyer) {
      // Flyers arrive in chunk 6; keep them in place and in history.
      this.enemyHist.record(e.pi, this.time, e.pos.x, e.pos.y, e.pos.z);
      return;
    }
    const en = tuning.enemies;
    const res = this.moveRes;
    let wishX = e.wishX,
      wishZ = e.wishZ;
    let accel = en.accel;
    if (e.state === ES.YANKED) {
      // Kinematic pull toward the hero: straight in, through the resolver.
      const rem = Math.max(e.until - this.time, dt);
      const dx = e.yx - e.pos.x,
        dy = e.yy - e.pos.y,
        dz = e.yz - e.pos.z;
      e.vel.set(dx / rem, Math.max(dy / rem, 0) + en.gravity * dt, dz / rem);
      wishX = e.vel.x;
      wishZ = e.vel.z;
      accel = 1e6;
      if (this.time >= e.until || Math.hypot(dx, dz) < 0.3) {
        e.vel.set(0, 0, 0);
        this.setState(e, ES.STAGGER, this.time + tuning.combat.hitStun);
        this.setAnim(e, ANIM.STAGGER);
      }
    } else if (e.state === ES.KO || e.state === ES.DOWN || e.state === ES.PINNED || (e.state === ES.STAGGER && (e.flags & EF.KNOCKED) !== 0)) {
      // Knocked about: friction only on the ground.
      wishX = 0;
      wishZ = 0;
      accel = e.state === ES.PINNED ? 1e6 : 14;
    }
    // Arena leash: steer back inside the arena rectangle plus the margin.
    if (e.arena >= 0 && e.state !== ES.KO) {
      const a = this.spawns.arenas[e.arena];
      if (a && !inArena(a, e.pos.x, e.pos.z, en.leashMargin)) {
        const dx = a.x - e.pos.x,
          dz = a.z - e.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        const sp = kindStats(e.kind).speed;
        wishX = (dx / l) * sp;
        wishZ = (dz / l) * sp;
      }
    }
    const wasGrounded = e.grounded;
    const edge = e.state !== ES.YANKED && (e.flags & EF.KNOCKED) === 0 && e.state !== ES.KO;
    this.mover.move(e, info.radius, info.height, wishX, wishZ, accel, dt, wasGrounded, edge, res);
    if (!Number.isFinite(e.pos.x) || !Number.isFinite(e.pos.y) || !Number.isFinite(e.pos.z)) {
      e.pos.set(e.homeX, e.homeY, e.homeZ);
      e.vel.set(0, 0, 0);
      res.grounded = true;
    }
    e.grounded = res.grounded;
    if (!e.grounded) {
      e.flags |= EF.AIRBORNE;
      if (wasGrounded) e.fallTop = e.pos.y;
      else if (e.pos.y > e.fallTop) e.fallTop = e.pos.y;
    } else {
      e.flags &= ~EF.AIRBORNE;
      if (!wasGrounded && e.state !== ES.KO && e.fallTop - e.pos.y > en.fallKo) this.knockOut(e, -1, -1, e.hp, 0, 0, 0);
      e.fallTop = e.pos.y;
    }
    if (e.pos.y < KILL_Y && e.state !== ES.KO) this.knockOut(e, -1, -1, e.hp, 0, 0, 0);
    this.enemyHist.record(e.pi, this.time, e.pos.x, e.pos.y, e.pos.z);
  }

  // ---------------------------------------------------------------------------
  // Internals: enemy attacks on heroes
  // ---------------------------------------------------------------------------

  /** A telegraphed attack reaches its impact time: in range -> pending hit (resolved after the hero's grace). */
  private landAttack(e: SimEnemy): void {
    const tele = e.tele!;
    e.tele = null;
    const st = kindStats(e.kind);
    this.setState(e, ES.ATTACK, this.time + 0.2);
    this.setAnim(e, ANIM.STRIKE);
    this.releaseSlot(e);
    e.cooldownUntil = this.time + st.cooldown * this.rng.range(0.85, 1.15);
    const h = this.heroById(tele.target);
    if (!h || !this.heroTargetable(h)) return;
    const dx = h.px - e.pos.x,
      dy = h.py - e.pos.y,
      dz = h.pz - e.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > st.range + MELEE_SLACK || Math.abs(dy) > MELEE_DY) return;
    const kb = tele.atk === ATK.BAT_SWING ? tuning.enemies.bat.knockback : tuning.enemies.thug.knockback;
    const nx = d > 1e-4 ? dx / d : -Math.sin(e.yaw),
      nz = d > 1e-4 ? dz / d : -Math.cos(e.yaw);
    this.pending.push({
      src: e.id,
      pid: h.pid,
      atk: tele.atk,
      dmg: st.damage,
      impactAt: tele.impactAt,
      resolveAt: tele.impactAt + h.grace,
      kx: nx * kb,
      ky: kb >= 5 ? 3 : 1,
      kz: nz * kb,
      fl: kb >= 5 ? HIT.KNOCKDOWN : HIT.STAGGER,
    });
  }

  private resolvePending(p: PendingHit): void {
    const h = this.heroes.get(p.pid);
    if (!h || !this.heroTargetable(h)) return;
    const c = tuning.combat;
    // A dodge stamped in [impactAt - iframes, impactAt + 0.05] avoids it.
    for (let k = 0; k < DODGE_RING; k++) {
      const s = h.dodges[k]!;
      if (s >= p.impactAt - c.dodgeIframes && s <= p.impactAt + 0.05) {
        this.out.push({ e: 'miss', src: p.src, tgt: HERO_ID_BASE + h.pid });
        return;
      }
    }
    this.damageHero(h, p.src, p.atk, p.dmg, p.fl, p.kx, p.ky, p.kz);
  }

  private damageHero(h: SimHero, src: number, move: number, dmg: number, fl: number, kx: number, ky: number, kz: number): void {
    h.hp = Math.max(0, h.hp - dmg);
    h.lastHurt = this.time;
    h.combo = 0;
    if (h.hp <= 0) fl |= HIT.KO;
    this.out.push({ e: 'hit', src, tgt: HERO_ID_BASE + h.pid, move, dmg, hp: h.hp, fl, kx, ky, kz });
    if (h.hp <= 0) this.knockDownHero(h);
  }

  private knockDownHero(h: SimHero): void {
    h.hp = 0;
    h.down = true;
    h.downUntil = this.time + tuning.combat.downTime;
    h.combo = 0;
    const id = HERO_ID_BASE + h.pid;
    for (const e of this.enemies) {
      if (e.target === id) {
        this.releaseSlot(e);
        if (e.tele) {
          e.tele = null;
          this.setState(e, ES.RECOVER, this.time + 0.35);
        }
      }
    }
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i]!.pid === h.pid) this.pending.splice(i, 1);
    this.out.push({ e: 'down', pid: h.pid, until: h.downUntil });
  }

  private respawn(h: SimHero): void {
    const out = scratch;
    const avoid = this.events.length === 0 ? undefined : (x: number, z: number): boolean => this.inActiveArena(x, z);
    if (!findRespawnRoof(this.world, this.layout, h.px, h.pz, out, { avoid })) {
      const s = this.layout.spawn;
      if (!findSafeSpot(this.world, s[0], s[1] + 0.5, s[2], out)) out.set(s[0], s[1], s[2]);
    }
    h.x = h.px = out.x;
    h.y = h.py = out.y;
    h.z = h.pz = out.z;
    h.vx = h.vy = h.vz = 0;
    h.t = this.time;
    h.hp = h.maxHp;
    h.down = false;
    h.lastHurt = -1e9;
    h.combo = 0;
    h.awaitUntil = this.time + RESPAWN_STALE_TIME;
    this.heroHist.clear(h.hi);
    this.heroHist.record(h.hi, this.time, out.x, out.y, out.z);
    this.out.push({ e: 'respawn', pid: h.pid, x: out.x, y: out.y, z: out.z });
  }

  private inActiveArena(x: number, z: number): boolean {
    for (const ev of this.events) if (Math.hypot(x - ev.x, z - ev.z) < ev.radius + 10) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Internals: hero intents (validated identically in single player and on the server)
  // ---------------------------------------------------------------------------

  private reject(pid: number, seq: number, why: RejectReason): void {
    this.out.push({ e: 'rej', pid, seq, why });
  }

  private applyIntent(pid: number, i: CombatIntent): void {
    const h = this.heroes.get(pid);
    if (!h) return;
    const c = tuning.combat;
    const now = this.time;
    if (h.tokens < 1) return this.reject(pid, i.seq, 'rate');
    h.tokens -= 1;
    if (i.k === 'dodge') {
      if (!(i.t >= now - c.viewPast - h.grace && i.t <= now + c.viewFuture)) return this.reject(pid, i.seq, 'time');
      if (h.down) return this.reject(pid, i.seq, 'state');
      h.dodges[h.dodgeHead] = i.t;
      h.dodgeHead = (h.dodgeHead + 1) % DODGE_RING;
      h.iframesUntil = Math.max(h.iframesUntil, i.t + c.dodgeIframes);
      return;
    }
    if (!(i.viewT >= now - c.viewPast && i.viewT <= now + c.viewFuture)) return this.reject(pid, i.seq, 'time');
    if (!Number.isFinite(i.hx) || !Number.isFinite(i.hy) || !Number.isFinite(i.hz)) return this.reject(pid, i.seq, 'range');
    if (Math.hypot(i.hx - h.px, i.hy - h.py, i.hz - h.pz) > c.heroPosTolerance) return this.reject(pid, i.seq, 'range');
    if (h.down || h.afk) return this.reject(pid, i.seq, 'state');
    const heroTarget = i.target >= HERO_ID_BASE;
    if (heroTarget && !this.pvp) return this.reject(pid, i.seq, 'pvp');
    if (heroTarget && i.target - HERO_ID_BASE === pid) return this.reject(pid, i.seq, 'state');
    const e = heroTarget ? undefined : this.byId.get(i.target);
    const th = heroTarget ? this.heroes.get(i.target - HERO_ID_BASE) : undefined;
    if (!e && !th) return this.reject(pid, i.seq, 'state');
    if (e && e.state === ES.KO) return this.reject(pid, i.seq, 'state');
    if (th && (th.down || th.afk)) return this.reject(pid, i.seq, 'state');
    const tp = scratch;
    this.positionAt(i.target, i.viewT, tp);
    const tRad = e ? kindInfo(e.kind).radius : tuning.body.radius;
    const tHgt = e ? kindInfo(e.kind).height : tuning.body.height;
    if (i.k === 'strike') {
      if (i.viewT - h.lastStrike < c.minStrikeInterval * 0.8) return this.reject(pid, i.seq, 'rate');
      let reach = c.reach + c.lagTolerance;
      if (i.move === MOVE.GROUND) {
        if (!e || e.state !== ES.DOWN) return this.reject(pid, i.seq, 'state');
        reach = c.groundFinisherRange + c.lagTolerance;
      } else if (i.move !== MOVE.JAB && i.move !== MOVE.CROSS && i.move !== MOVE.KICK && i.move !== MOVE.UPPER && i.move !== MOVE.AIR) {
        return this.reject(pid, i.seq, 'state');
      }
      if (capsuleDistance(i.hx, i.hy + HERO_TORSO, i.hz, tp.x, tp.y, tp.z, tRad, tHgt) > reach) return this.reject(pid, i.seq, 'range');
      h.lastStrike = i.viewT;
      return this.strike(h, i.target, i.move, i.hx, i.hz);
    }
    if (i.k === 'takedown') {
      if (h.focus < c.takedownCost) return this.reject(pid, i.seq, 'state');
      if (capsuleDistance(i.hx, i.hy + HERO_TORSO, i.hz, tp.x, tp.y, tp.z, tRad, tHgt) > c.takedownRange + c.lagTolerance) return this.reject(pid, i.seq, 'range');
      h.focus -= c.takedownCost;
      return this.strike(h, i.target, MOVE.TAKEDOWN, i.hx, i.hz);
    }
    // Yank / pin: line range from the hero's chest with line of sight.
    const chest = tuning.body.chestHeight;
    const ty = tp.y + tHgt * 0.6;
    const d = Math.hypot(tp.x - i.hx, ty - (i.hy + chest), tp.z - i.hz);
    if (d > c.yankRange + c.lagTolerance) return this.reject(pid, i.seq, 'range');
    if (!this.mover.lineOfSight(i.hx, i.hy + chest, i.hz, tp.x, ty, tp.z)) return this.reject(pid, i.seq, 'range');
    if (!e) return this.reject(pid, i.seq, 'state'); // web lines on heroes: not in M11
    if (i.k === 'yank') this.yank(h, e, i.hx, i.hy, i.hz);
    else this.pin(h, e);
  }

  /** Apply a validated strike (chain move, air, ground finisher or takedown) to an enemy or, in PvP, a hero. */
  private strike(h: SimHero, target: number, move: number, hx: number, hz: number): void {
    const c = tuning.combat;
    const now = this.time;
    // Combo and focus (takedowns spend focus, they do not build it).
    if (move !== MOVE.TAKEDOWN) {
      h.combo = now <= h.comboUntil ? h.combo + 1 : 1;
      h.comboUntil = now + c.comboWindow;
      h.focus = Math.min(100, h.focus + c.focusPerHit);
    }
    let dmg = moveDamage(move);
    let fl: number = HIT.STAGGER;
    let knock = 1.5,
      ky = 0;
    if (move === MOVE.UPPER) {
      fl = HIT.KNOCKDOWN;
      knock = c.chainKnockback;
      ky = 3;
    }
    const src = HERO_ID_BASE + h.pid;
    if (target >= HERO_ID_BASE) {
      const th = this.heroes.get(target - HERO_ID_BASE)!;
      const dx = th.px - hx,
        dz = th.pz - hz;
      const l = Math.hypot(dx, dz) || 1;
      if (move === MOVE.TAKEDOWN) dmg = th.hp;
      this.damageHero(th, src, move, dmg, fl, (dx / l) * knock, ky, (dz / l) * knock);
      return;
    }
    const e = this.byId.get(target)!;
    const dx = e.pos.x - hx,
      dz = e.pos.z - hz;
    const l = Math.hypot(dx, dz);
    const nx = l > 1e-4 ? dx / l : -Math.sin(h.facing),
      nz = l > 1e-4 ? dz / l : -Math.cos(h.facing);
    const boss = isBoss(e.kind);
    if (move === MOVE.GROUND && !boss) dmg = Math.max(dmg, e.hp);
    if (move === MOVE.TAKEDOWN) dmg = boss ? e.maxHp * c.takedownBossFrac : e.hp;
    // Aggro on the attacker.
    if (e.target !== src) {
      this.releaseSlot(e);
      e.target = src;
    }
    e.flags |= EF.ALERTED;
    e.tele = null;
    this.releaseSlot(e);
    if (dmg >= e.hp) {
      this.knockOut(e, src, move, dmg, nx * knock, ky, nz * knock);
      return;
    }
    e.hp -= dmg;
    if (e.state === ES.PINNED) {
      // Webbed in place: it takes the damage and stays pinned.
      knock = 0;
      ky = 0;
    } else if (fl & HIT.KNOCKDOWN || e.state === ES.DOWN) {
      // A hit on a downed enemy keeps it down (no extra time).
      if (e.state !== ES.DOWN) this.setState(e, ES.DOWN, now + c.knockdownTime);
      this.setAnim(e, ANIM.KNOCKDOWN);
      e.flags |= EF.KNOCKED;
    } else {
      this.setState(e, ES.STAGGER, now + c.hitStun);
      this.setAnim(e, ANIM.STAGGER);
      e.flags |= EF.KNOCKED;
    }
    if (knock > 0 || ky > 0) e.vel.set(nx * knock, ky, nz * knock);
    if (ky > 0) e.grounded = false;
    this.out.push({ e: 'hit', src, tgt: e.id, move, dmg, hp: e.hp, fl, kx: nx * knock, ky, kz: nz * knock });
  }

  private knockOut(e: SimEnemy, src: number, move: number, dmg: number, kx: number, ky: number, kz: number): void {
    e.hp = 0;
    e.tele = null;
    this.releaseSlot(e);
    this.setState(e, ES.KO);
    this.setAnim(e, ANIM.KO);
    e.koAt = this.time;
    e.flags |= EF.KNOCKED;
    e.vel.set(kx, ky, kz);
    if (ky > 0) e.grounded = false;
    this.out.push({ e: 'hit', src, tgt: e.id, move, dmg, hp: 0, fl: HIT.KO | HIT.KNOCKDOWN, kx, ky, kz });
  }

  private yank(h: SimHero, e: SimEnemy, hx: number, hy: number, hz: number): void {
    const c = tuning.combat;
    const src = HERO_ID_BASE + h.pid;
    e.tele = null;
    this.releaseSlot(e);
    if (e.target !== src) e.target = src;
    e.flags |= EF.ALERTED;
    const dx = hx - e.pos.x,
      dz = hz - e.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    const stop = Math.min(c.yankStop, l);
    e.yx = hx - (dx / l) * stop;
    e.yy = Math.max(hy, e.pos.y);
    e.yz = hz - (dz / l) * stop;
    const dmg = Math.min(c.yankDmg, e.hp);
    if (dmg >= e.hp) {
      this.knockOut(e, src, MOVE.YANK, dmg, 0, 0, 0);
      return;
    }
    e.hp -= dmg;
    this.setState(e, ES.YANKED, this.time + c.yankTime);
    this.setAnim(e, ANIM.YANKED);
    e.grounded = false;
    this.out.push({ e: 'yank', src, tgt: e.id, dur: c.yankTime });
    this.out.push({ e: 'hit', src, tgt: e.id, move: MOVE.YANK, dmg, hp: e.hp, fl: HIT.STAGGER, kx: 0, ky: 0, kz: 0 });
  }

  private pin(h: SimHero, e: SimEnemy): void {
    const c = tuning.combat;
    const src = HERO_ID_BASE + h.pid;
    e.tele = null;
    this.releaseSlot(e);
    e.target = src;
    e.flags |= EF.ALERTED;
    this.out.push({ e: 'pin', src, tgt: e.id, dur: c.pinTime });
    // A downed enemy pinned to the ground stays down for good.
    if (e.state === ES.DOWN) {
      this.knockOut(e, src, MOVE.PIN, e.hp, 0, 0, 0);
      return;
    }
    this.setState(e, ES.PINNED, this.time + c.pinTime);
    this.setAnim(e, ANIM.PINNED);
    e.vel.set(0, Math.min(e.vel.y, 0), 0);
    this.out.push({ e: 'hit', src, tgt: e.id, move: MOVE.PIN, dmg: 0, hp: e.hp, fl: 0, kx: 0, ky: 0, kz: 0 });
  }

  private recycle(index: number): void {
    const e = this.enemies[index]!;
    this.enemies.splice(index, 1);
    this.byId.delete(e.id);
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i]!.src === e.id) this.pending.splice(i, 1);
    e.id = 0;
    e.tele = null;
    e.slot = -1;
    this.free.push(e.pi);
  }
}

function makeEnemy(pi: number): SimEnemy {
  return {
    id: 0,
    kind: 0,
    state: ES.IDLE,
    stateT: 0,
    pos: new Vector3(),
    vel: new Vector3(),
    yaw: 0,
    hp: 0,
    maxHp: 0,
    guard: 0,
    target: -1,
    eventId: -1,
    arena: -1,
    flags: 0,
    tele: null,
    anim: 0,
    animT0: 0,
    slot: -1,
    pi,
    homeX: 0,
    homeY: 0,
    homeZ: 0,
    wishX: 0,
    wishZ: 0,
    grounded: true,
    fallTop: 0,
    nextThink: 0,
    cooldownUntil: 0,
    until: 0,
    circleR: 5,
    circleDir: 1,
    koAt: 0,
    yx: 0,
    yy: 0,
    yz: 0,
  };
}

/** Damage of a hero move (live tuning). */
export function moveDamage(move: number): number {
  const c = tuning.combat;
  switch (move) {
    case MOVE.JAB:
      return c.jabDmg;
    case MOVE.CROSS:
      return c.crossDmg;
    case MOVE.KICK:
      return c.kickDmg;
    case MOVE.UPPER:
      return c.upperDmg;
    case MOVE.AIR:
      return c.airStrikeDmg;
    case MOVE.GROUND:
      return c.groundFinisherDmg;
    case MOVE.YANK:
      return c.yankDmg;
    default:
      return 0;
  }
}

/** Next chain move after `combo` hits (jab, cross, kick, upper, repeating). */
export function chainMove(combo: number): number {
  return CHAIN_MOVES[((combo % 4) + 4) % 4]!;
}

/** Distance from a point to the surface of an upright capsule (feet at x, y, z; radius r; height h); negative inside. */
export function capsuleDistance(px: number, py: number, pz: number, x: number, y: number, z: number, r: number, h: number): number {
  const lo = y + r,
    hi = Math.max(lo, y + h - r);
  const cy = py < lo ? lo : py > hi ? hi : py;
  return Math.hypot(px - x, py - cy, pz - z) - r;
}
