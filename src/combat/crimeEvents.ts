import { tuning } from '../config/tuning';
import type { Rng } from '../core/rng';
import type { StateHash } from './hash';
import type { SimEnemy, SimHero } from './entities';
import { kindInfo } from './roster';
import { arenaSuits, arenaTypesFor, type Arena, type SpawnPoints } from './spawnPoints';
import { EK, ES, HERO_ID_BASE, type CombatEvent, type CrimeEventInfo, type CrimeEventResult, type CrimeEventType, type EnemyKind } from './types';

/** Where an enemy came from (`SimEnemy.origin`). Roaming and stray enemies despawn far from every hero. */
export const ORIGIN = { DEBUG: 0, EVENT: 1, ROAM: 2, STRAY: 3 } as const;

/** Event phases: announced (banner and beacon, no enemies yet), then active (the wave is out). */
const PH_ANNOUNCE = 0;
const PH_ACTIVE = 1;

/** Scheduled event types and their weights (bosses come every `bossEvery`-th clear once `bosses` is on). */
const TYPES: readonly CrimeEventType[] = ['robbery', 'gang', 'drones'];
const WEIGHTS = [0.45, 0.3, 0.25];
const BOSS_CYCLE: readonly EnemyKind[] = [EK.KOCBASI, EK.KUZGUN, EK.DIKEN];
/** Score multiplier per event type (a gang fight or a drone attack is worth twice a robbery). */
const SCORE_MUL: Record<CrimeEventType, number> = { robbery: 1, gang: 2, drones: 2, boss: 5 };
/** Retry when no arena or pool room was found (s). */
const RETRY = 5;
/** Drones spawn this high over their roof spot (plus up to 2 m). */
const DRONE_LIFT = 4;
/** Roaming pairs: the two walk this far apart along the loop; a patrol point counts as reached within this distance. */
const PAIR_GAP = 1.6;
const LOOP_REACH = 1.5;
/** Pool share roaming may use, and the slots kept free for event waves. */
const ROAM_SHARE = 0.3;

/** What the scheduler needs from the sim (`CombatSim` implements it). */
export interface CrimeHost {
  readonly time: number;
  readonly rng: Rng;
  readonly spawns: SpawnPoints;
  readonly heroes: ReadonlyMap<number, SimHero>;
  readonly enemies: readonly SimEnemy[];
  readonly maxEnemies: number;
  /** Start new events / spawn roaming pairs (both off in manual test mode and with the settings toggle off). */
  readonly scheduler: boolean;
  readonly roaming: boolean;
  /** Online room: concurrency grows with the player count. */
  readonly multiplayer: boolean;
  /** Bosses join the cycle (chunk 8). */
  readonly bosses: boolean;
  /** Spawn an enemy (its `spawn` event goes out); returns its id or -1 when the pool is full. */
  spawnEnemy(kind: EnemyKind, x: number, y: number, z: number, eventId: number, arena: number): number;
  enemyById(id: number): SimEnemy | undefined;
  /** Remove an enemy at once (clients drop it when it leaves the snapshots). */
  despawn(e: SimEnemy): void;
  emit(ev: CombatEvent): void;
}

interface ActiveEvent {
  info: CrimeEventInfo;
  arena: Arena;
  phase: number;
  /** When the wave spawns (end of the announcement). */
  activeAt: number;
  /** A hero came within `expireRadius` (it can no longer expire; it can fail). */
  engaged: boolean;
  /** Heroes that came (rewarded on a clear). */
  pids: number[];
  /** Kinds to spawn when it turns active. */
  plan: EnemyKind[];
}

/**
 * Crime events and roaming patrols (pure, deterministic: the sim's Rng and
 * sim time only; the same code schedules single player and every server
 * room). Lifecycle: announce (`evStart`, banner and beacon on clients; the
 * wave spawns `announceTime` later) → active (`evProg` per KO) → cleared
 * (every enemy KO'd: focus and score for the heroes that came), expired (no
 * hero came within `expireRadius` for `expireAfter`: the enemies vanish) or
 * failed (heroes came but it ran past `failAfter`: no reward, the enemies
 * stay as strays). The first event comes `firstDelay` after a hero appears,
 * the next a gap after each start or end, at most `concurrentSp` at once in
 * single player (online `1 + players / playersPerExtra`, up to
 * `concurrentMp`), at an arena `distMin`-`distMax` from a hero. Wave sizes
 * scale with the heroes in the room. Roaming thug pairs walk sidewalk loops
 * within `roamRadius` of the heroes, spawning out of their sight and
 * vanishing far away.
 *
 * The timers always run; the `scheduler` and `roaming` flags only gate the
 * spawning (and the Rng draws that come with it), so a sim with them off
 * evolves exactly like one that never had them.
 */
export class CrimeEvents {
  /** Active events (the replicated info objects; `CombatSim.events` is this array). */
  readonly list: CrimeEventInfo[] = [];
  private readonly act: ActiveEvent[] = [];
  private nextId = 1;
  /** Next scheduler start (sim time; -1 until a hero is present). */
  nextAt = -1;
  /** Next roaming check (sim time; -1 until a hero is present). */
  roamAt = -1;
  /** Roaming pairs wanted per hero (picked at the first roaming spawn). */
  private roamPairs = 0;
  /** Cleared events so far (the boss cycle) and the next boss. */
  cleared = 0;
  private bossIdx = 0;
  private bossDue = false;
  private readonly tmpHeroes: SimHero[] = [];
  private readonly cand: number[] = [];

  constructor(private readonly host: CrimeHost) {}

  /** Forget every event and timer (a new game, `debugClear`); events still listed end as expired so views drop them. */
  reset(): void {
    for (const a of this.act) this.host.emit({ e: 'evEnd', id: a.info.id, result: 'expire', pids: [], focus: 0, score: 0 });
    this.list.length = 0;
    this.act.length = 0;
    this.nextAt = -1;
    this.roamAt = -1;
    this.roamPairs = 0;
    this.bossDue = false;
  }

  /** Copies of the active events (the Room's `welcome`). */
  snapshot(out: CrimeEventInfo[]): void {
    for (const ev of this.list) out.push({ ...ev });
  }

  /** Concurrent events allowed now. */
  cap(): number {
    const e = tuning.events;
    if (!this.host.multiplayer) return Math.max(1, Math.round(e.concurrentSp));
    return Math.max(1, Math.min(Math.round(e.concurrentMp), 1 + Math.floor(this.host.heroes.size / Math.max(1, e.playersPerExtra))));
  }

  /** Wave size multiplier for the heroes in the room (1 in single player). */
  scale(): number {
    const n = Math.max(1, this.host.heroes.size);
    return Math.min(3, 1 + tuning.events.heroScale * (n - 1));
  }

  // ---------------------------------------------------------------------------
  // Step parts (called by CombatSim.step)

  /** Step part (3): scheduler and roaming spawns. */
  schedule(): void {
    const h = this.host;
    const t = h.time;
    const E = tuning.events;
    if (h.heroes.size === 0) {
      this.nextAt = -1;
      this.roamAt = -1;
      return;
    }
    if (this.nextAt < 0) this.nextAt = t + E.firstDelay;
    if (this.roamAt < 0) this.roamAt = t + E.roamDelay;
    if (t >= this.nextAt - 1e-9) {
      if (!h.scheduler) this.nextAt = t + E.firstDelay;
      else if (this.list.length >= this.cap()) this.nextAt = t + RETRY;
      else this.nextAt = this.startScheduled() >= 0 ? t + this.gap() : t + RETRY;
    }
    if (t >= this.roamAt - 1e-9) {
      this.roamAt = t + Math.max(0.1, E.roamEvery);
      if (h.roaming) this.roamTick();
    }
  }

  /** Step part (9): phases, engagement, clear / expire / fail, far roamers and strays. */
  lifecycle(): void {
    const h = this.host;
    const t = h.time;
    const E = tuning.events;
    for (let i = this.act.length - 1; i >= 0; i--) {
      const a = this.act[i]!;
      const ev = a.info;
      // Who came (engaged, rewarded on a clear).
      for (const hero of h.heroes.values()) {
        if (hero.afk || Math.hypot(hero.px - ev.x, hero.pz - ev.z) > E.expireRadius) continue;
        a.engaged = true;
        if (a.pids.indexOf(hero.pid) < 0) a.pids.push(hero.pid);
      }
      if (a.phase === PH_ANNOUNCE && t >= a.activeAt - 1e-9) this.spawnWave(a);
      const age = t - ev.startedAt;
      if (a.phase === PH_ACTIVE && ev.enemiesLeft <= 0) this.end(i, 'clear');
      else if (!a.engaged && age >= E.expireAfter) this.end(i, 'expire');
      else if (a.engaged && age >= E.failAfter) this.end(i, 'fail');
    }
    // Roaming pairs and strays far from every hero leave.
    if (h.heroes.size === 0) return;
    const far = E.roamDespawn;
    for (let i = h.enemies.length - 1; i >= 0; i--) {
      const e = h.enemies[i]!;
      if ((e.origin !== ORIGIN.ROAM && e.origin !== ORIGIN.STRAY) || e.state === ES.KO) continue;
      if (this.nearestHero(e.pos.x, e.pos.z) > far) h.despawn(e);
    }
  }

  /** An enemy was knocked out (any cause): its event counts down; the hero that did it took part. */
  onKo(e: SimEnemy, src: number): void {
    if (e.eventId < 0) return;
    const a = this.find(e.eventId);
    if (!a) return;
    a.info.enemiesLeft = Math.max(0, a.info.enemiesLeft - 1);
    if (src >= HERO_ID_BASE && a.pids.indexOf(src - HERO_ID_BASE) < 0) a.pids.push(src - HERO_ID_BASE);
    this.host.emit({ e: 'evProg', id: a.info.id, left: a.info.enemiesLeft });
  }

  /**
   * Start an event now (test hooks, `startEvent`): at the suitable arena
   * nearest (x, z) when given, else as the scheduler would pick it around the
   * first hero (or the arena nearest the map centre without heroes). Ignores
   * the concurrency cap. Returns the event id or -1.
   */
  start(type: CrimeEventType, x?: number, z?: number, boss?: number): number {
    const bossKind = type === 'boss' ? (boss !== undefined && BOSS_CYCLE.indexOf(boss as EnemyKind) >= 0 ? (boss as EnemyKind) : BOSS_CYCLE[this.bossIdx % 3]!) : -1;
    let arena: Arena | null = null;
    if (x !== undefined && z !== undefined && Number.isFinite(x) && Number.isFinite(z)) arena = this.nearestArena(type, bossKind, x, z);
    else {
      const hero = this.pickHero();
      arena = hero ? this.pickArena(type, bossKind, hero) : null;
      if (!arena) arena = this.nearestArena(type, bossKind, 0, 0);
    }
    if (!arena) return -1;
    return this.begin(type, bossKind, arena);
  }

  /** Hash of the scheduler state (determinism checks). */
  hash(h: StateHash): void {
    h.num(this.nextAt).num(this.roamAt).int(this.nextId).int(this.cleared).int(this.roamPairs).int(this.bossIdx).bool(this.bossDue).int(this.act.length);
    for (const a of this.act) {
      const ev = a.info;
      h.int(ev.id).int(ev.arena).int(a.phase).int(ev.enemiesLeft).int(ev.total).bool(a.engaged).int(a.pids.length);
    }
    for (const e of this.host.enemies) h.int(e.origin).int(e.loop).num(e.loopS);
  }

  /** Patrol: the point a roaming enemy walks to (advanced along its loop when reached). False when it has no loop. */
  patrolPoint(e: SimEnemy, out: { x: number; z: number }): boolean {
    if (e.loop < 0) return false;
    const loop = this.host.spawns.loops[e.loop];
    if (!loop) return false;
    loopPoint(loop.pts, loop.cum, loop.total, e.loopS, out);
    if (Math.hypot(out.x - e.pos.x, out.z - e.pos.z) < LOOP_REACH) {
      e.loopS = (e.loopS + 3) % loop.total;
      loopPoint(loop.pts, loop.cum, loop.total, e.loopS, out);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Internals

  private find(id: number): ActiveEvent | undefined {
    for (const a of this.act) if (a.info.id === id) return a;
    return undefined;
  }

  private gap(): number {
    const E = tuning.events;
    return this.host.rng.range(Math.min(E.gapMin, E.gapMax), Math.max(E.gapMin, E.gapMax));
  }

  private heroList(): SimHero[] {
    const out = this.tmpHeroes;
    out.length = 0;
    for (const h of this.host.heroes.values()) if (!h.afk) out.push(h);
    return out;
  }

  private pickHero(): SimHero | null {
    const list = this.heroList();
    if (list.length === 0) return null;
    return list.length === 1 ? list[0]! : list[Math.floor(this.host.rng.float() * list.length) % list.length]!;
  }

  private nearestHero(x: number, z: number): number {
    let best = Infinity;
    for (const h of this.host.heroes.values()) best = Math.min(best, Math.hypot(h.px - x, h.pz - z));
    return best;
  }

  /** The scheduler's pick: a boss when one is due (and bosses are on), else a weighted type; tries the others when one has nowhere to happen. */
  private startScheduled(): number {
    const hero = this.pickHero();
    if (!hero) return -1;
    if (this.bossDue && this.host.bosses) {
      const kind = BOSS_CYCLE[this.bossIdx % 3]!;
      const a = this.pickArena('boss', kind, hero);
      if (a) {
        this.bossDue = false;
        this.bossIdx++;
        return this.begin('boss', kind, a);
      }
    }
    let r = this.host.rng.float();
    let first = 0;
    for (; first < TYPES.length - 1; first++) {
      r -= WEIGHTS[first]!;
      if (r < 0) break;
    }
    for (let k = 0; k < TYPES.length; k++) {
      const type = TYPES[(first + k) % TYPES.length]!;
      const a = this.pickArena(type, -1, hero);
      if (a) return this.begin(type, -1, a);
    }
    return -1;
  }

  /** Whether an arena is free: no active event within `eventSpacing`. */
  private arenaFree(a: Arena): boolean {
    const sp = tuning.events.eventSpacing;
    for (const ev of this.list) if (ev.arena === a.id || Math.hypot(ev.x - a.x, ev.z - a.z) < sp) return false;
    return true;
  }

  /** A suitable arena `distMin`-`distMax` from the hero (widened once), not on top of another hero; Rng pick. */
  private pickArena(type: CrimeEventType, boss: number, hero: SimHero): Arena | null {
    const E = tuning.events;
    const sp = this.host.spawns;
    const types = arenaTypesFor(type, boss);
    for (let pass = 0; pass < 2; pass++) {
      const lo = pass === 0 ? E.distMin : E.distMin * 0.5,
        hi = pass === 0 ? E.distMax : E.distMax * 1.5;
      const cand = this.cand;
      cand.length = 0;
      for (const ty of types) {
        for (const id of sp.byType[ty] ?? []) {
          const a = sp.arenas[id]!;
          if (!arenaSuits(a, type, boss) || !this.arenaFree(a)) continue;
          const d = Math.hypot(a.x - hero.px, a.z - hero.pz);
          if (d < lo || d > hi) continue;
          if (this.nearestHero(a.x, a.z) < lo * 0.6) continue;
          cand.push(id);
        }
      }
      if (cand.length > 0) return sp.arenas[cand[Math.floor(this.host.rng.float() * cand.length) % cand.length]!]!;
    }
    return null;
  }

  private nearestArena(type: CrimeEventType, boss: number, x: number, z: number): Arena | null {
    const sp = this.host.spawns;
    let best: Arena | null = null,
      bestD = Infinity;
    for (const ty of arenaTypesFor(type, boss)) {
      for (const id of sp.byType[ty] ?? []) {
        const a = sp.arenas[id]!;
        if (!arenaSuits(a, type, boss)) continue;
        const d = Math.hypot(a.x - x, a.z - z);
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
    }
    return best;
  }

  /** The wave for a type (single-player counts scaled by the heroes in the room). */
  private plan(type: CrimeEventType, boss: number, out: EnemyKind[]): void {
    const rng = this.host.rng;
    const s = this.scale();
    const n = (base: number): number => Math.max(base > 0 ? 1 : 0, Math.round(base * s));
    const push = (kind: EnemyKind, count: number): void => {
      for (let i = 0; i < count; i++) out.push(kind);
    };
    switch (type) {
      case 'robbery':
        // 3 thugs (one with a bat) and 1-2 gunmen.
        push(EK.THUG, n(2));
        push(EK.BAT, n(1));
        push(EK.GUNMAN, n(rng.chance(0.5) ? 2 : 1));
        break;
      case 'gang': {
        // 6-8 mixed and a brute.
        const mix: readonly EnemyKind[] = [EK.THUG, EK.BAT, EK.THUG, EK.GUNMAN, EK.THUG, EK.BAT, EK.GUNMAN, EK.THUG];
        const c = n(6 + Math.floor(rng.float() * 3));
        for (let i = 0; i < c; i++) out.push(mix[i % mix.length]!);
        push(EK.BRUTE, n(1));
        break;
      }
      case 'drones':
        // 4-6 drones and 2 gunmen on the roof.
        push(EK.DRONE, n(4 + Math.floor(rng.float() * 3)));
        push(EK.GUNMAN, n(2));
        break;
      case 'boss':
        out.push((boss >= 0 ? boss : EK.KOCBASI) as EnemyKind);
        push(rng.chance(0.5) ? EK.THUG : EK.BAT, Math.round(Math.floor(rng.float() * 5) * s));
        break;
    }
  }

  /** Announce an event at an arena (the wave follows after `announceTime`). */
  private begin(type: CrimeEventType, boss: number, arena: Arena): number {
    const h = this.host;
    const plan: EnemyKind[] = [];
    this.plan(type, boss, plan);
    // Room in the pool: the wave may shrink, but never below half.
    let busy = 0;
    for (const e of h.enemies) if (e.state !== ES.KO) busy++;
    const room = h.maxEnemies - busy;
    if (room < Math.ceil(plan.length / 2)) return -1;
    if (plan.length > room) plan.length = Math.max(1, room);
    const id = this.nextId;
    this.nextId = this.nextId >= 0x7fff ? 1 : this.nextId + 1;
    const info: CrimeEventInfo = {
      id,
      type,
      boss: type === 'boss' ? boss : -1,
      x: arena.x,
      y: arena.y,
      z: arena.z,
      radius: arena.radius,
      enemiesLeft: plan.length,
      startedAt: h.time,
      arena: arena.id,
      total: plan.length,
    };
    this.list.push(info);
    this.act.push({ info, arena, phase: PH_ANNOUNCE, activeAt: h.time + Math.max(0, tuning.events.announceTime), engaged: false, pids: [], plan });
    h.emit({ e: 'evStart', ev: { ...info } });
    // A zero announce time spawns right away.
    if (tuning.events.announceTime <= 0) this.spawnWave(this.act[this.act.length - 1]!);
    return id;
  }

  private spawnWave(a: ActiveEvent): void {
    const h = this.host;
    a.phase = PH_ACTIVE;
    const spots = a.arena.spots;
    const ns = Math.max(1, spots.length / 3);
    let n = 0;
    for (let i = 0; i < a.plan.length; i++) {
      const kind = a.plan[i]!;
      // Flyers over the roof; boss on the centre spot; the rest fill outwards (wrapping with a small offset).
      const k = i % ns;
      const ring = Math.floor(i / ns);
      let x = spots[k * 3]!,
        y = spots[k * 3 + 1]!,
        z = spots[k * 3 + 2]!;
      if (ring > 0) {
        x += ring * 0.7;
        z -= ring * 0.7;
      }
      if (kindInfo(kind).flyer) y += DRONE_LIFT + (i % 3);
      const id = h.spawnEnemy(kind, x, y, z, a.info.id, a.arena.id);
      if (id < 0) break;
      const e = h.enemyById(id);
      if (e) e.origin = ORIGIN.EVENT;
      n++;
    }
    a.plan.length = 0;
    a.info.enemiesLeft = n;
    a.info.total = n;
    h.emit({ e: 'evProg', id: a.info.id, left: n });
  }

  private end(i: number, result: CrimeEventResult): void {
    const h = this.host;
    const a = this.act[i]!;
    const ev = a.info;
    const E = tuning.events;
    let focus = 0,
      score = 0;
    if (result === 'clear') {
      focus = E.rewardFocus;
      score = Math.round((E.rewardScore + E.rewardPerEnemy * ev.total) * SCORE_MUL[ev.type]);
      for (const pid of a.pids) {
        const hero = h.heroes.get(pid);
        if (hero) hero.focus = Math.min(100, hero.focus + focus);
      }
      this.cleared++;
      if (this.cleared % Math.max(1, Math.round(E.bossEvery)) === 0) this.bossDue = true;
    }
    // Its enemies: gone when nobody came; strays (they fight on, then wander off) when it failed.
    for (let k = h.enemies.length - 1; k >= 0; k--) {
      const e = h.enemies[k]!;
      if (e.eventId !== ev.id) continue;
      if (result === 'expire') h.despawn(e);
      else {
        e.eventId = -1;
        e.arena = -1;
        if (e.origin === ORIGIN.EVENT) e.origin = ORIGIN.STRAY;
      }
    }
    this.act.splice(i, 1);
    this.list.splice(this.list.indexOf(ev), 1);
    h.emit({ e: 'evEnd', id: ev.id, result, pids: a.pids.slice(), focus, score });
    this.nextAt = Math.max(this.nextAt, h.time + this.gap());
  }

  /** Roaming: keep the wanted number of thug pairs patrolling around the heroes. */
  private roamTick(): void {
    const h = this.host;
    const E = tuning.events;
    const rng = h.rng;
    if (this.roamPairs === 0) {
      const lo = Math.max(1, Math.ceil(E.roamMin / 2)),
        hi = Math.max(lo, Math.floor(E.roamMax / 2));
      this.roamPairs = lo + Math.floor(rng.float() * (hi - lo + 1));
    }
    const heroes = this.heroList();
    if (heroes.length === 0) return;
    const want = Math.min(this.roamPairs * 2 * Math.min(3, heroes.length), Math.floor(h.maxEnemies * ROAM_SHARE) & ~1);
    let have = 0,
      busy = 0;
    for (const e of h.enemies) {
      if (e.state === ES.KO) continue;
      busy++;
      if (e.origin === ORIGIN.ROAM) have++;
    }
    if (have + 2 > want || h.maxEnemies - busy < 2 + 4) return;
    // One pair per check, on a loop near a random hero, out of every hero's sight.
    const hero = heroes[Math.floor(rng.float() * heroes.length) % heroes.length]!;
    const loops = h.spawns.loops;
    const cand = this.cand;
    cand.length = 0;
    for (let i = 0; i < loops.length; i++) {
      const l = loops[i]!;
      const d = Math.hypot(l.cx - hero.px, l.cz - hero.pz);
      if (d <= E.roamRadius && d >= E.roamSpawnMin * 0.5) cand.push(i);
    }
    if (cand.length === 0) return;
    const li = cand[Math.floor(rng.float() * cand.length) % cand.length]!;
    const loop = loops[li]!;
    const s0 = rng.float() * loop.total;
    const p = { x: 0, z: 0 };
    loopPoint(loop.pts, loop.cum, loop.total, s0, p);
    if (this.nearestHero(p.x, p.z) < E.roamSpawnMin) return;
    for (let k = 0; k < 2; k++) {
      const s = (s0 - k * PAIR_GAP + loop.total) % loop.total;
      loopPoint(loop.pts, loop.cum, loop.total, s, p);
      const id = h.spawnEnemy(EK.THUG, p.x, loop.y, p.z, -1, -1);
      const e = id >= 0 ? h.enemyById(id) : undefined;
      if (!e) return;
      e.origin = ORIGIN.ROAM;
      e.loop = li;
      // Walk ahead along the loop (the follower keeps its gap).
      e.loopS = (s + 3) % loop.total;
    }
  }
}

/** Point at distance `s` along a closed loop polyline (x, z pairs, cumulative lengths). */
export function loopPoint(pts: Float32Array, cum: Float32Array, total: number, s: number, out: { x: number; z: number }): void {
  const n = cum.length;
  const d = total > 0 ? ((s % total) + total) % total : 0;
  for (let k = 1; k < n; k++) {
    if (d <= cum[k]! || k === n - 1) {
      const seg = cum[k]! - cum[k - 1]!;
      const u = seg > 1e-6 ? Math.min(1, (d - cum[k - 1]!) / seg) : 0;
      out.x = pts[(k - 1) * 2]! + (pts[k * 2]! - pts[(k - 1) * 2]!) * u;
      out.z = pts[(k - 1) * 2 + 1]! + (pts[k * 2 + 1]! - pts[(k - 1) * 2 + 1]!) * u;
      return;
    }
  }
  out.x = pts[0]!;
  out.z = pts[1]!;
}
