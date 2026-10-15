/**
 * RoomSim adapter around M11's CombatSim: the server's (and LocalLink's)
 * combat hook. It adds only what the Room needs on top of the sim (nearest-
 * first snapshots into a preallocated array, the last respawn point per
 * player for the Room's teleport check, debug hooks); intent validation is
 * CombatSim's own, so single player and the server share one set of rules.
 * PURE.
 */
import { tuning } from '../config/tuning';
import { CombatSim } from '../combat/combatSim';
import { kindInfo } from '../combat/roster';
import { ENEMY_KIND_COUNT, HERO_ID_BASE, type EnemyKind } from '../combat/types';
import type { CombatEvent, CombatIntent, CrimeEventInfo, DebugOp, EnemySnap, HeroState, MapRuntime, RoomSim, RoomSimFactory, RoomSimOptions } from './types';

const CRIME_TYPES: ReadonlyArray<CrimeEventInfo['type']> = ['robbery', 'gang', 'drones', 'boss'];
/** A server-issued respawn point stays a valid teleport target this long (s of sim time). */
const RESPAWN_VALID_S = 10;

export class CombatRoomSim implements RoomSim {
  /** Last respawn point per player: x, y, z, sim time. */
  private readonly respawns = new Map<number, { x: number; y: number; z: number; t: number }>();
  // Snapshot selection scratch (no allocation per call).
  private idx = new Int32Array(64);
  private d2 = new Float64Array(64);

  constructor(readonly sim: CombatSim) {}

  get time(): number {
    return this.sim.time;
  }

  upsertHero(s: HeroState): void {
    this.sim.upsertHero(s);
  }

  removeHero(pid: number): void {
    this.sim.removeHero(pid);
    this.respawns.delete(pid);
  }

  intent(pid: number, i: CombatIntent): void {
    this.sim.intent(pid, i);
  }

  step(): void {
    this.sim.step();
  }

  drainEvents(out: CombatEvent[]): void {
    const from = out.length;
    this.sim.drainEvents(out);
    for (let i = from; i < out.length; i++) {
      const e = out[i];
      if (e.e === 'respawn') this.respawns.set(e.pid, { x: e.x, y: e.y, z: e.z, t: this.sim.time });
    }
  }

  snapshot(x: number, y: number, z: number, radius: number, out: EnemySnap[], max: number): number {
    const list = this.sim.enemies;
    if (this.idx.length < list.length) {
      this.idx = new Int32Array(list.length * 2);
      this.d2 = new Float64Array(list.length * 2);
    }
    const r2 = radius * radius;
    const lim = Math.min(max, out.length);
    let n = 0;
    // Insertion into a sorted top-`lim` list (enemies ≤ 60, so this beats a full sort).
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const dx = e.pos.x - x;
      const dy = e.pos.y - y;
      const dz = e.pos.z - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > r2 || (n === lim && d >= this.d2[n - 1])) continue;
      let j = n < lim ? n++ : n - 1;
      while (j > 0 && this.d2[j - 1] > d) {
        this.d2[j] = this.d2[j - 1];
        this.idx[j] = this.idx[j - 1];
        j--;
      }
      this.d2[j] = d;
      this.idx[j] = i;
    }
    const now = this.sim.time;
    for (let k = 0; k < n; k++) {
      const e = list[this.idx[k]];
      const s = out[k];
      s.id = e.id;
      s.kind = e.kind;
      s.state = e.state;
      s.x = e.pos.x;
      s.y = e.pos.y;
      s.z = e.pos.z;
      s.yaw = e.yaw;
      s.hp = e.maxHp > 0 ? Math.max(0, e.hp) / e.maxHp : 0;
      s.guard = Math.min(1, Math.max(0, e.guard));
      s.anim = e.anim;
      s.animT = Math.max(0, now - e.animT0);
      s.flags = e.flags;
      s.target = e.target >= HERO_ID_BASE ? e.target - HERO_ID_BASE : 0;
    }
    return n;
  }

  crimeEvents(out: CrimeEventInfo[]): void {
    for (const ev of this.sim.events) out.push({ ...ev });
  }

  heroHp(pid: number): number {
    return this.sim.hero(pid)?.hp ?? tuning.combat.maxHp;
  }

  respawnPoint(pid: number, out: { x: number; y: number; z: number }): boolean {
    const r = this.respawns.get(pid);
    if (!r || this.sim.time - r.t > RESPAWN_VALID_S) return false;
    out.x = r.x;
    out.y = r.y;
    out.z = r.z;
    return true;
  }

  debug(pid: number, op: DebugOp, a: readonly number[]): void {
    const num = (i: number, d: number): number => (Number.isFinite(a[i]) ? a[i] : d);
    switch (op) {
      case 'spawn': {
        const kind = Math.trunc(num(0, 0));
        if (kind < 0 || kind >= ENEMY_KIND_COUNT || kindInfo(kind as EnemyKind) === undefined) return;
        this.sim.debugSpawn(kind as EnemyKind, num(1, 0), num(2, 0), num(3, 0));
        return;
      }
      case 'event': {
        const type = CRIME_TYPES[Math.trunc(num(0, 0))];
        if (type) this.sim.startEvent(type, a[1], a[2], a[3]);
        return;
      }
      case 'killAll':
        this.sim.debugKillAll();
        return;
      case 'clear':
        this.sim.debugClear();
        return;
      case 'setHp':
        this.sim.debugSetHp(pid, num(0, tuning.combat.maxHp));
        return;
    }
  }

  setRtt(pid: number, rttS: number): void {
    this.sim.setRtt(pid, rttS);
  }

  enemyCount(): number {
    return this.sim.enemies.length;
  }

  hash(): string {
    return this.sim.hash();
  }
}

/** The server's default sim factory: a CombatSim per room on the shared map runtime. */
export const combatSimFactory: RoomSimFactory = (map: MapRuntime, opts: RoomSimOptions) =>
  new CombatRoomSim(new CombatSim(map.world, map.layout, map.spawns, opts.seed, { pvp: opts.pvp, maxEnemies: opts.maxEnemies }));
