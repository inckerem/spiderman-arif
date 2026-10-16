import { Vector3 } from 'three';
import { tuning } from '../config/tuning';
import { clamp } from '../core/math';
import { Rng } from '../core/rng';
import { makeRayHit, type CollisionWorld } from '../physics/collision';
import { findRespawnRoof, findSafeSpot } from '../physics/safeSpot';
import type { CityLayout } from '../world/types';
import { attackStats, BOTTLE_SPEED, BRAINS, type BrainHost } from './brains';
import { CrimeEvents, ORIGIN, type CrimeHost } from './crimeEvents';
import type { SimEnemy, SimHero } from './entities';
import { hashCombat } from './hash';
import { PosHistory } from './history';
import { GroundMover, LOS_SKIP, makeMoveResult } from './mover';
import { aimVelocity, PROJ_GRAVITY, PROJ_LIFE, PROJ_RADIUS, ProjectilePool, segmentDistance } from './projectiles';
import { guardBlocks, isBoss, kindInfo, kindStats } from './roster';
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
  PK,
  type CombatEvent,
  type CombatHero,
  type CombatIntent,
  type CrimeEventInfo,
  EK,
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
/** Gunman muzzle: ahead of the feet and up (aim pose). */
const MUZZLE_FWD = 0.55;
const MUZZLE_UP = 1.42;
/** Hit chance of a gunman's round: base, minus per m/s of target speed and per metre, clamped. */
const SHOT_BASE = 0.92;
const SHOT_PER_SPEED = 0.02;
const SHOT_PER_M = 0.006;
const SHOT_MIN = 0.3;
/** Shove on the hero when a strike bounces off a shield (m/s). */
const BLOCK_BOUNCE = 4;
/** A shield torn off staggers the brute this long. */
const DISARM_STAGGER = 0.8;
/** A charge that meets a wall stuns the brute this long. */
const CHARGE_WALL_STUN = 1.0;
/** Flyers: steering acceleration and the drag while knocked about. */
const FLY_ACCEL = 16;
const FLY_DRAG = 2.5;

const scratch = new Vector3();
const aim = { x: 0, y: 0, z: 0 };

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
export class CombatSim implements BrainHost, CrimeHost {
  static readonly DT = 1 / 30;
  /** Active enemies (KO'd ones stay `koLinger` seconds, then their pool entry is recycled). */
  readonly enemies: SimEnemy[] = [];
  readonly heroes = new Map<number, SimHero>();
  time = 0;
  steps = 0;
  /** Crime scheduler and roaming patrols spawn (off by default; the game turns them on in play, server rooms always). */
  scheduler = false;
  roaming = false;
  /** Online room: crime-event concurrency grows with the players (single player: `events.concurrentSp`). */
  multiplayer = false;
  /** Bosses join the crime-event cycle (chunk 8). */
  bosses = false;
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
  /** Enemy projectiles in flight (bolts, bottles). */
  readonly projectiles = new ProjectilePool();
  private readonly ray = makeRayHit();
  private readonly segS = new Float64Array(1);
  /** Crime events and roaming patrols. */
  readonly crime: CrimeEvents;
  /** Active crime events (the scheduler's replicated infos). */
  readonly events: CrimeEventInfo[];

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
    this.crime = new CrimeEvents(this);
    this.events = this.crime.list;
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
    return hashCombat(this.time, this.enemies, this.heroes, this.projectiles.list, (h) => this.crime.hash(h));
  }

  /** Copies of the active crime events (the Room's `welcome`). */
  crimeEvents(out: CrimeEventInfo[]): void {
    this.crime.snapshot(out);
  }

  // CrimeHost (the scheduler's view of the sim).

  spawnEnemy(kind: EnemyKind, x: number, y: number, z: number, eventId: number, arena: number): number {
    return this.debugSpawn(kind, x, y, z, eventId, arena);
  }

  enemyById(id: number): SimEnemy | undefined {
    return this.byId.get(id);
  }

  despawn(e: SimEnemy): void {
    const i = this.enemies.indexOf(e);
    if (i >= 0) this.recycle(i);
  }

  emit(ev: CombatEvent): void {
    this.out.push(ev);
  }

  patrolPoint(e: SimEnemy, out: { x: number; z: number }): boolean {
    return this.crime.patrolPoint(e, out);
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
    e.wishY = 0;
    e.wishZ = 0;
    e.ax = 0;
    e.az = 0;
    e.shots = 0;
    e.nextShot = 0;
    e.burstAt = 0;
    e.los = false;
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
    e.origin = eventId >= 0 ? ORIGIN.EVENT : ORIGIN.DEBUG;
    e.loop = -1;
    e.loopS = 0;
    this.enemies.push(e);
    this.byId.set(id, e);
    this.enemyHist.clear(pi);
    this.enemyHist.record(pi, this.time, x, y, z);
    this.out.push({ e: 'spawn', id, kind, x, y, z });
    return id;
  }

  /**
   * Start a crime event now (test hooks): at the suitable arena nearest (x, z)
   * when given, else where the scheduler would put it. Returns its id or -1.
   */
  startEvent(type: CrimeEventInfo['type'], x?: number, z?: number, boss?: number): number {
    return this.crime.start(type, x, z, boss);
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
    // Projectiles in flight end where they are (clients drop them on `projEnd`).
    for (const p of this.projectiles.list) this.out.push({ e: 'projEnd', id: p.id, x: p.x, y: p.y, z: p.z, tgt: -1 });
    this.projectiles.clear();
    // Crime events and their timers start over (the views drop the events on their `evEnd`).
    this.crime.reset();
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

    // (3) Crime scheduler and roaming spawns.
    this.crime.schedule();

    // (4) Brains.
    for (const e of this.enemies) {
      e.stateT += dt;
      BRAINS[e.kind]!(this, e, dt);
    }

    // (5) Movers.
    this.separate();
    for (const e of this.enemies) this.moveEnemy(e, dt);

    // (6) Telegraphs land, bursts fire their rounds, charges connect; pending hits resolve (dodge window).
    for (const e of this.enemies) {
      if (e.tele && t >= e.tele.impactAt - 1e-9) this.landAttack(e);
    }
    for (const e of this.enemies) {
      if (e.state === ES.ATTACK && e.shots > 0 && t >= e.nextShot - 1e-9) this.fireShot(e);
      else if (e.state === ES.SPECIAL && e.kind === EK.BRUTE) this.chargeContact(e);
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

    // (7) Projectiles.
    this.stepProjectiles(dt);

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

    // (9) Crime events: clear, expire, fail; far roamers leave. KO'd enemies leave after their linger time.
    this.crime.lifecycle();
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
    // A disarmed gunman brawls like a thug.
    if (e.target < 0 || (!kindInfo(e.kind).melee && (e.flags & EF.DISARMED) === 0)) return false;
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

  startTelegraph(e: SimEnemy, atk: number, delay: number, anim: number = ANIM.WINDUP, landsIn = 0): void {
    const at = this.time + delay;
    e.tele = { atk, target: e.target, impactAt: at };
    this.setState(e, ES.TELEGRAPH, at);
    this.setAnim(e, anim);
    this.out.push({ e: 'tele', src: e.id, tgt: e.target, atk, at: at + landsIn });
  }

  canSee(e: SimEnemy, h: SimHero): boolean {
    const eh = kindInfo(e.kind).height * 0.8;
    return this.mover.lineOfSight(e.pos.x, e.pos.y + eh, e.pos.z, h.px, h.py + tuning.body.chestHeight, h.pz);
  }

  rand(): number {
    return this.rng.float();
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
      this.moveFlyer(e, info.radius, dt);
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
    } else if (e.state === ES.SPECIAL) {
      // A charge: hard acceleration along the locked direction.
      accel = 60;
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
    // A charge into a wall stuns the brute.
    if (e.state === ES.SPECIAL && res.wall && res.wallNX * e.ax + res.wallNZ * e.az < -0.5) {
      e.vel.set(0, e.vel.y, 0);
      this.setState(e, ES.STAGGER, this.time + CHARGE_WALL_STUN);
      this.setAnim(e, ANIM.STAGGER);
      e.flags |= EF.KNOCKED;
    }
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

  /**
   * Flyer mover: a sphere steered toward the brain's desired velocity
   * (accelerated, in substeps of at most 0.3 m, `resolveSphere` against the
   * world); knocked about it drifts with drag; KO'd it falls and lies on what
   * is below.
   */
  private moveFlyer(e: SimEnemy, r: number, dt: number): void {
    const v = e.vel;
    const p = e.pos;
    const g = tuning.enemies.gravity;
    if (e.state === ES.KO) {
      if (!e.grounded) {
        v.y -= g * dt;
        v.x *= Math.max(0, 1 - 0.8 * dt);
        v.z *= Math.max(0, 1 - 0.8 * dt);
      } else v.set(0, 0, 0);
    } else if (e.state === ES.STAGGER) {
      const k = Math.max(0, 1 - FLY_DRAG * dt);
      v.x *= k;
      v.y = v.y * k - g * 0.15 * dt;
      v.z *= k;
    } else {
      // Arena leash (horizontal), then accelerate toward the wish.
      let wx = e.wishX,
        wz = e.wishZ;
      if (e.arena >= 0) {
        const a = this.spawns.arenas[e.arena];
        if (a && !inArena(a, p.x, p.z, tuning.enemies.leashMargin)) {
          const dx = a.x - p.x,
            dz = a.z - p.z;
          const l = Math.hypot(dx, dz) || 1;
          const sp = kindStats(e.kind).speed;
          wx = (dx / l) * sp;
          wz = (dz / l) * sp;
        }
      }
      const ax = wx - v.x,
        ay = e.wishY - v.y,
        az = wz - v.z;
      const al = Math.hypot(ax, ay, az);
      const maxDv = FLY_ACCEL * dt;
      if (al > maxDv) {
        v.x += (ax / al) * maxDv;
        v.y += (ay / al) * maxDv;
        v.z += (az / al) * maxDv;
      } else v.set(wx, e.wishY, wz);
    }
    if (!(e.state === ES.KO && e.grounded)) {
      const n = Math.max(1, Math.ceil((Math.hypot(v.x, v.y, v.z) * dt) / 0.3));
      const sdt = dt / n;
      for (let i = 0; i < n; i++) {
        const ox = p.x,
          oy = p.y,
          oz = p.z;
        p.x += v.x * sdt;
        p.y += v.y * sdt;
        p.z += v.z * sdt;
        if (this.world.resolveSphere(p, r, 0, 4) > 0) {
          // Pushed out: keep the velocity along the surface only.
          const mx = (p.x - ox) / sdt,
            my = (p.y - oy) / sdt,
            mz = (p.z - oz) / sdt;
          v.set(mx, my, mz);
        }
      }
      if (e.state === ES.KO) {
        const sup = this.world.supportHeight(p.x, p.z, p.y, 0);
        if (sup.y > -Infinity && p.y - r <= sup.y + 0.05 && v.y <= 0) {
          p.y = sup.y + r;
          v.set(0, 0, 0);
          e.grounded = true;
        }
      }
    }
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      p.set(e.homeX, e.homeY, e.homeZ);
      v.set(0, 0, 0);
    }
    if (e.grounded) e.flags &= ~EF.AIRBORNE;
    else e.flags |= EF.AIRBORNE;
    if (p.y < KILL_Y && e.state !== ES.KO) this.knockOut(e, -1, -1, e.hp, 0, 0, 0);
    this.enemyHist.record(e.pi, this.time, p.x, p.y, p.z);
  }

  // ---------------------------------------------------------------------------
  // Internals: enemy attacks on heroes
  // ---------------------------------------------------------------------------

  /** Queue a hit on a hero, resolved after its grace; the dodge check is against `impactAt` (default: now). */
  private queueHit(src: number, h: SimHero, atk: number, dmg: number, kx: number, ky: number, kz: number, fl: number, impactAt = this.time): void {
    this.pending.push({ src, pid: h.pid, atk, dmg, impactAt, resolveAt: this.time + h.grace, kx, ky, kz, fl });
  }

  /** A gunman's round (delayed hitscan): rolled against the target's speed and distance, blocked by the world. */
  private fireShot(e: SimEnemy): void {
    const st = tuning.enemies.gunman;
    e.shots--;
    e.nextShot += st.burstGap;
    const fx = -Math.sin(e.yaw),
      fz = -Math.cos(e.yaw);
    const mx = e.pos.x + fx * MUZZLE_FWD,
      my = e.pos.y + MUZZLE_UP,
      mz = e.pos.z + fz * MUZZLE_FWD;
    const h = this.heroById(e.target);
    let tx: number, ty: number, tz: number;
    let hit = false;
    if (h && this.heroTargetable(h)) {
      tx = h.px;
      ty = h.py + tuning.body.chestHeight;
      tz = h.pz;
      const dx = tx - mx,
        dy = ty - my,
        dz = tz - mz;
      const d = Math.hypot(dx, dy, dz) || 1;
      const blocked = this.world.raycast(mx, my, mz, dx / d, dy / d, dz / d, d, this.ray, LOS_SKIP, -1, 0, true);
      if (blocked) {
        tx = this.ray.x;
        ty = this.ray.y;
        tz = this.ray.z;
      } else if (d <= st.range) {
        const p = clamp(SHOT_BASE - SHOT_PER_SPEED * Math.hypot(h.vx, h.vy, h.vz) - SHOT_PER_M * d, SHOT_MIN, SHOT_BASE);
        hit = this.rng.float() < p;
      }
      if (!blocked && !hit) {
        // A miss: past the hero, off to a side (a tracer worth seeing).
        const side = this.rng.chance(0.5) ? 1 : -1;
        const off = 0.9 + this.rng.float() * 1.1;
        const hl = Math.hypot(dx, dz) || 1;
        tx += (-dz / hl) * off * side + (dx / d) * 6;
        ty += (this.rng.float() - 0.3) * 1.2 + (dy / d) * 6;
        tz += (dx / hl) * off * side + (dz / d) * 6;
      }
      // The whole burst dodges as one attack: every round checks the dodge against the burst's start.
      if (hit) this.queueHit(e.id, h, ATK.BURST, st.damage, (dx / d) * 0.8, 0, (dz / d) * 0.8, HIT.STAGGER, e.burstAt);
    } else {
      tx = mx + fx * 30;
      ty = my;
      tz = mz + fz * 30;
    }
    this.out.push({ e: 'shot', src: e.id, x: mx, y: my, z: mz, tx, ty, tz, hit });
  }

  /** A charging brute reaching its target: a knockdown hit (dodgeable), then he recovers. */
  private chargeContact(e: SimEnemy): void {
    const h = this.heroById(e.target);
    if (!h || !this.heroTargetable(h)) return;
    const dx = h.px - e.pos.x,
      dz = h.pz - e.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > kindInfo(e.kind).radius + tuning.body.radius + 0.5 || Math.abs(h.py - e.pos.y) > MELEE_DY) return;
    const b = tuning.enemies.brute;
    this.queueHit(e.id, h, ATK.CHARGE, b.chargeDamage, e.ax * 8, 3, e.az * 8, HIT.KNOCKDOWN);
    e.vel.x *= 0.2;
    e.vel.z *= 0.2;
    this.setState(e, ES.RECOVER, this.time + 0.7);
    this.setAnim(e, ANIM.STRIKE);
  }

  /** Launch a projectile at a hero, leading it by `lead` of the flight time. */
  private launchAt(e: SimEnemy, h: SimHero, kind: number, atk: number, dmg: number, x: number, y: number, z: number, speed: number, lead: number): void {
    const g = PROJ_GRAVITY[kind]!;
    const ty = h.py + tuning.body.chestHeight;
    let t = aimVelocity(x, y, z, h.px, ty, h.pz, speed, g, aim);
    t = aimVelocity(x, y, z, h.px + h.vx * t * lead, ty + h.vy * t * lead * 0.5, h.pz + h.vz * t * lead, speed, g, aim);
    const p = this.projectiles.launch(kind, e.id, HERO_ID_BASE + h.pid, atk, dmg, x, y, z, aim.x, aim.y, aim.z, this.time);
    if (p) this.out.push({ e: 'proj', id: p.id, kind, src: e.id, tgt: p.tgt, x, y, z, vx: aim.x, vy: aim.y, vz: aim.z });
  }

  /**
   * Projectiles: ballistic flight swept against the world (a raycast over the
   * step) and every targetable hero's capsule (segment distance); the first
   * contact along the step wins. A hero contact queues the hit (dodgeable).
   */
  private stepProjectiles(dt: number): void {
    const list = this.projectiles.list;
    const br = tuning.body.radius,
      bh = tuning.body.height;
    for (let i = 0; i < list.length; ) {
      const p = list[i]!;
      const r = PROJ_RADIUS[p.kind]!;
      p.vy -= PROJ_GRAVITY[p.kind]! * dt;
      const x0 = p.x,
        y0 = p.y,
        z0 = p.z;
      const x1 = x0 + p.vx * dt,
        y1 = y0 + p.vy * dt,
        z1 = z0 + p.vz * dt;
      let best = 2;
      let who: SimHero | null = null;
      for (const h of this.heroes.values()) {
        if (!this.heroTargetable(h)) continue;
        const d = segmentDistance(x0, y0, z0, x1, y1, z1, h.px, h.py + br, h.pz, h.px, h.py + bh - br, h.pz, this.segS);
        if (d <= br + r && this.segS[0]! < best) {
          best = this.segS[0]!;
          who = h;
        }
      }
      const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
      let wall = false;
      if (len > 1e-6 && this.world.raycast(x0, y0, z0, (x1 - x0) / len, (y1 - y0) / len, (z1 - z0) / len, len, this.ray, LOS_SKIP, -1, 0, true)) {
        const s = this.ray.t / len;
        if (s < best) {
          best = s;
          wall = true;
          who = null;
        }
      }
      if (who || wall) {
        const ex = x0 + (x1 - x0) * best,
          ey = y0 + (y1 - y0) * best,
          ez = z0 + (z1 - z0) * best;
        if (who) {
          const l = Math.hypot(p.vx, p.vz) || 1;
          this.queueHit(p.src, who, p.atk, p.dmg, (p.vx / l) * 1.5, 0.5, (p.vz / l) * 1.5, HIT.STAGGER);
        }
        this.out.push({ e: 'projEnd', id: p.id, x: ex, y: ey, z: ez, tgt: who ? HERO_ID_BASE + who.pid : -1 });
        this.projectiles.remove(i);
        continue;
      }
      p.x = x1;
      p.y = y1;
      p.z = z1;
      if (this.time - p.born > PROJ_LIFE[p.kind]! || p.y < KILL_Y) {
        this.out.push({ e: 'projEnd', id: p.id, x: p.x, y: p.y, z: p.z, tgt: -1 });
        this.projectiles.remove(i);
        continue;
      }
      i++;
    }
  }

  /** A telegraphed attack reaches its impact time: in range -> pending hit (resolved after the hero's grace). */
  private landAttack(e: SimEnemy): void {
    const tele = e.tele!;
    e.tele = null;
    const st = attackStats(e);
    const en = tuning.enemies;
    this.setState(e, ES.ATTACK, this.time + 0.2);
    this.setAnim(e, ANIM.STRIKE);
    this.releaseSlot(e);
    e.cooldownUntil = this.time + st.cooldown * this.rng.range(0.85, 1.15);
    const h = this.heroById(tele.target);
    switch (tele.atk) {
      case ATK.BURST:
        // The rounds fire from this step on (`fireShot`), `burstGap` apart.
        e.shots = Math.max(1, Math.round(en.gunman.burst));
        e.nextShot = this.time;
        e.burstAt = tele.impactAt;
        this.setState(e, ES.ATTACK, this.time + (e.shots - 1) * en.gunman.burstGap + 0.25);
        this.setAnim(e, ANIM.SHOOT);
        return;
      case ATK.CHARGE: {
        // The run: straight along the locked direction, up to the distance it chose plus 3 m.
        const b = en.brute;
        const d = h ? Math.hypot(h.px - e.pos.x, h.pz - e.pos.z) : 8;
        this.setState(e, ES.SPECIAL, this.time + Math.min(1.6, (d + 3) / Math.max(1, b.chargeSpeed)));
        this.setAnim(e, ANIM.CHARGE);
        return;
      }
      case ATK.BOLT: {
        this.setState(e, ES.ATTACK, this.time + 0.25);
        if (!h || !this.heroTargetable(h)) return;
        const r = kindInfo(e.kind).radius + 0.15;
        const fx = -Math.sin(e.yaw),
          fz = -Math.cos(e.yaw);
        this.launchAt(e, h, PK.BOLT, ATK.BOLT, st.damage, e.pos.x + fx * r, e.pos.y, e.pos.z + fz * r, en.drone.boltSpeed, 0.5);
        return;
      }
      case ATK.BOTTLE: {
        this.setState(e, ES.ATTACK, this.time + 0.3);
        if (!h || !this.heroTargetable(h)) return;
        const fx = -Math.sin(e.yaw),
          fz = -Math.cos(e.yaw);
        this.launchAt(e, h, PK.BOTTLE, ATK.BOTTLE, en.thug.bottleDamage, e.pos.x + fx * 0.3, e.pos.y + 1.9, e.pos.z + fz * 0.3, BOTTLE_SPEED, 0.3);
        return;
      }
      default:
        break;
    }
    if (!h || !this.heroTargetable(h)) return;
    const dx = h.px - e.pos.x,
      dy = h.py - e.pos.y,
      dz = h.pz - e.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > st.range + MELEE_SLACK || Math.abs(dy) > MELEE_DY) return;
    const kb = tele.atk === ATK.BAT_SWING ? en.bat.knockback : tele.atk === ATK.SLAM ? 7 : en.thug.knockback;
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
        e.shots = 0;
        if (e.tele || e.state === ES.SPECIAL) {
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
    const info = e ? kindInfo(e.kind) : null;
    const tRad = info ? info.radius : tuning.body.radius;
    let tHgt = info ? info.height : tuning.body.height;
    // A flyer's position is its centre: as a capsule it is a sphere from centre - r to centre + r.
    if (info && info.flyer) {
      tp.y -= info.radius;
      tHgt = info.radius * 2;
    }
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
      return this.strike(h, i.target, i.move, i.hx, i.hy, i.hz);
    }
    if (i.k === 'takedown') {
      if (h.focus < c.takedownCost) return this.reject(pid, i.seq, 'state');
      if (capsuleDistance(i.hx, i.hy + HERO_TORSO, i.hz, tp.x, tp.y, tp.z, tRad, tHgt) > c.takedownRange + c.lagTolerance) return this.reject(pid, i.seq, 'range');
      h.focus -= c.takedownCost;
      return this.strike(h, i.target, MOVE.TAKEDOWN, i.hx, i.hy, i.hz);
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
  private strike(h: SimHero, target: number, move: number, hx: number, hy: number, hz: number): void {
    const c = tuning.combat;
    const now = this.time;
    // The brute's shield: a frontal strike bounces off (no damage, no combo; the hero is shoved back).
    let guardFl = 0;
    if (target < HERO_ID_BASE && move !== MOVE.TAKEDOWN) {
      const g = this.byId.get(target)!;
      guardFl = guardBlocks(g.kind, g.guard, g.flags, g.state, g.pos.x, g.pos.y, g.pos.z, g.yaw, hx, hy, hz);
      if (guardFl === HIT.BLOCKED) {
        const dx = hx - g.pos.x,
          dz = hz - g.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        if (g.target !== HERO_ID_BASE + h.pid) {
          this.releaseSlot(g);
          g.target = HERO_ID_BASE + h.pid;
        }
        g.flags |= EF.ALERTED;
        if (g.state !== ES.TELEGRAPH && g.state !== ES.ATTACK && g.state !== ES.SPECIAL) this.setAnim(g, ANIM.BLOCK);
        this.out.push({ e: 'hit', src: HERO_ID_BASE + h.pid, tgt: g.id, move, dmg: 0, hp: g.hp, fl: HIT.BLOCKED, kx: (dx / l) * BLOCK_BOUNCE, ky: 1.5, kz: (dz / l) * BLOCK_BOUNCE });
        return;
      }
    }
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
    const flyer = kindInfo(e.kind).flyer;
    fl |= guardFl;
    if (flyer) {
      // Juggled: popped up and back, staggered in the air (never knocked down).
      knock = move === MOVE.AIR ? 3 : 2;
      ky = 2.5;
      fl = (fl & ~HIT.KNOCKDOWN) | HIT.STAGGER;
    } else if (e.kind === EK.BRUTE) knock *= 0.5;
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
    } else if (flyer) {
      this.setState(e, ES.STAGGER, now + c.hitStun * 2);
      this.setAnim(e, ANIM.STAGGER);
      e.flags |= EF.KNOCKED;
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
    e.shots = 0;
    e.flags |= EF.KNOCKED;
    e.vel.set(kx, ky, kz);
    if (ky > 0 || kindInfo(e.kind).flyer) e.grounded = false;
    this.out.push({ e: 'hit', src, tgt: e.id, move, dmg, hp: 0, fl: HIT.KO | HIT.KNOCKDOWN, kx, ky, kz });
    this.crime.onKo(e, src);
  }

  private yank(h: SimHero, e: SimEnemy, hx: number, hy: number, hz: number): void {
    const c = tuning.combat;
    const src = HERO_ID_BASE + h.pid;
    e.tele = null;
    e.shots = 0;
    this.releaseSlot(e);
    if (e.target !== src) e.target = src;
    e.flags |= EF.ALERTED;
    const dx = hx - e.pos.x,
      dz = hz - e.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    if (kindInfo(e.kind).flyer) {
      // A drone yanked out of the air: down for good, falling toward the hero.
      this.out.push({ e: 'yank', src, tgt: e.id, dur: 0 });
      this.knockOut(e, src, MOVE.YANK, e.hp, (dx / l) * 5, 2, (dz / l) * 5);
      return;
    }
    if (e.kind === EK.BRUTE && e.guard > 0 && (e.flags & EF.SHIELDLESS) === 0) {
      // Too heavy to pull: the line tears the shield away instead and he staggers.
      e.flags |= EF.SHIELDLESS | EF.KNOCKED;
      e.guard = 0;
      const dmg = Math.min(c.yankDmg, e.hp - 1);
      e.hp -= Math.max(0, dmg);
      this.setState(e, ES.STAGGER, this.time + DISARM_STAGGER);
      this.setAnim(e, ANIM.STAGGER);
      this.out.push({ e: 'yank', src, tgt: e.id, dur: 0 });
      this.out.push({ e: 'hit', src, tgt: e.id, move: MOVE.YANK, dmg: Math.max(0, dmg), hp: e.hp, fl: HIT.STAGGER | HIT.DISARM, kx: 0, ky: 0, kz: 0 });
      return;
    }
    // A gunman yanked loses his gun (and brawls from then on).
    let disarm = 0;
    if (e.kind === EK.GUNMAN && (e.flags & EF.DISARMED) === 0) {
      e.flags |= EF.DISARMED;
      disarm = HIT.DISARM;
    }
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
    this.out.push({ e: 'hit', src, tgt: e.id, move: MOVE.YANK, dmg, hp: e.hp, fl: HIT.STAGGER | disarm, kx: 0, ky: 0, kz: 0 });
  }

  private pin(h: SimHero, e: SimEnemy): void {
    const c = tuning.combat;
    const src = HERO_ID_BASE + h.pid;
    e.tele = null;
    e.shots = 0;
    this.releaseSlot(e);
    e.target = src;
    e.flags |= EF.ALERTED | EF.WEBBED;
    // The brute is only stunned briefly (and his guard is down meanwhile).
    const dur = e.kind === EK.BRUTE ? tuning.enemies.brute.pinStun : c.pinTime;
    this.out.push({ e: 'pin', src, tgt: e.id, dur });
    // A downed enemy pinned to the ground stays down for good; a webbed drone drops.
    if (e.state === ES.DOWN || kindInfo(e.kind).flyer) {
      this.knockOut(e, src, MOVE.PIN, e.hp, 0, 0, 0);
      return;
    }
    this.setState(e, ES.PINNED, this.time + dur);
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
    e.shots = 0;
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
    wishY: 0,
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
    ax: 0,
    az: 0,
    shots: 0,
    nextShot: 0,
    burstAt: 0,
    los: false,
    origin: 0,
    loop: -1,
    loopS: 0,
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
