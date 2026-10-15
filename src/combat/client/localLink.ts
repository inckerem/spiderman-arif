import { CombatSim } from '../combatSim';
import type { CombatEvent, CombatIntent, HeroState } from '../types';
import type { CombatView } from './combatView';
import { makeEnemySnap, makeSelfSnap, type CombatEventBatch, type CombatLink, type CombatSnapshot, type EnemySnap } from './link';

/** Single player's pid (the room has one slot). */
export const LOCAL_PID = 1;

/**
 * Single player: the combat room runs in this tab. Each 120 Hz tick uploads
 * the hero's state straight into the `CombatSim`, accumulates time and steps
 * the sim at 30 Hz (every 4th tick, so manual test stepping stays exactly
 * deterministic). After every step the sim's events and an enemy snapshot go
 * to the view as the same messages an online link would deliver, without
 * serialization. Intents go through `CombatSim.intent`, so single player
 * runs the server's validation rules.
 */
export class LocalCombatLink implements CombatLink {
  readonly mode = 'local' as const;
  readonly selfPid = LOCAL_PID;
  private acc = 0;
  private paused = false;
  private readonly evBuf: CombatEvent[] = [];
  private readonly batch: CombatEventBatch = { t: 'ce', time: 0, ev: this.evBuf };
  private readonly snapPool: EnemySnap[] = [];
  private readonly selfSnap = makeSelfSnap();
  private readonly snap: CombatSnapshot = { t: 'snap', time: 0, count: 0, enemies: this.snapPool, self: null };

  constructor(
    readonly sim: CombatSim,
    readonly view: CombatView,
  ) {
    view.selfPid = LOCAL_PID;
    for (let i = 0; i < sim.maxEnemies; i++) this.snapPool.push(makeEnemySnap());
  }

  now(): number {
    return this.sim.time + this.acc;
  }

  renderTime(): number {
    return this.now() - CombatSim.DT;
  }

  tick(dt: number, self: HeroState): void {
    if (this.paused) return;
    self.pid = LOCAL_PID;
    self.t = this.now();
    this.sim.upsertHero(self);
    this.acc += dt;
    // Tolerance: four 1/120 s ticks sum to a hair under 1/30 s in floating point.
    while (this.acc >= CombatSim.DT - 1e-9) {
      this.acc -= CombatSim.DT;
      this.sim.step();
      this.publish();
    }
  }

  /** Step the sim once right now (test API), delivering its messages. */
  stepNow(): void {
    this.sim.step();
    this.publish();
  }

  /** Deliver the sim's current state without stepping (after a test hook changed it). */
  sync(): void {
    this.publish();
  }

  intent(i: CombatIntent): void {
    this.sim.intent(LOCAL_PID, i);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  close(): void {
    this.sim.removeHero(LOCAL_PID);
    this.view.reset();
  }

  /** The step's events, then the snapshot (the order an online client receives them in). */
  private publish(): void {
    const sim = this.sim;
    this.evBuf.length = 0;
    sim.drainEvents(this.evBuf);
    if (this.evBuf.length > 0) {
      this.batch.time = sim.time;
      this.view.apply(this.batch);
    }
    const s = this.snap;
    s.time = sim.time;
    let n = 0;
    for (const e of sim.enemies) {
      const o = this.snapPool[n++]!;
      o.id = e.id;
      o.kind = e.kind;
      o.state = e.state;
      o.x = e.pos.x;
      o.y = e.pos.y;
      o.z = e.pos.z;
      o.yaw = e.yaw;
      o.hp = e.hp;
      o.maxHp = e.maxHp;
      o.guard = e.guard;
      o.anim = e.anim;
      o.animT0 = e.animT0;
      o.flags = e.flags;
      o.target = e.target;
    }
    s.count = n;
    const h = sim.hero(LOCAL_PID);
    const self = this.selfSnap;
    if (h) {
      self.hp = h.hp;
      self.maxHp = h.maxHp;
      self.down = h.down;
      self.downUntil = h.downUntil;
      self.combo = h.combo;
      self.comboUntil = h.comboUntil;
      self.focus = h.focus;
      self.iframesUntil = h.iframesUntil;
    }
    s.self = h ? self : null;
    this.view.apply(s);
  }
}
