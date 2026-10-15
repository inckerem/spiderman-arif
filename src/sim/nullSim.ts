/**
 * The RoomSim used until M11's CombatSim exists (and by rooms that want
 * presence only): it keeps time and the latest hero states, has no enemies,
 * produces no events and never damages anyone. PURE.
 */
import type { CombatEvent, CombatIntent, CrimeEventInfo, DebugOp, EnemySnap, HeroState, RoomSim } from './types';

export const SIM_HZ = 30;
export const SIM_DT = 1 / SIM_HZ;
const MAX_HP = 100;

export class NullSim implements RoomSim {
  time = 0;
  readonly heroes = new Map<number, HeroState>();
  /** Intents received (tests read them). */
  readonly intents: Array<{ pid: number; i: CombatIntent }> = [];
  readonly debugCalls: Array<{ op: DebugOp; a: readonly number[] }> = [];

  upsertHero(s: HeroState): void {
    const h = this.heroes.get(s.pid);
    if (h) Object.assign(h, s);
    else this.heroes.set(s.pid, { ...s });
  }

  removeHero(pid: number): void {
    this.heroes.delete(pid);
  }

  intent(pid: number, i: CombatIntent): void {
    if (this.intents.length < 256) this.intents.push({ pid, i });
  }

  step(): void {
    this.time += SIM_DT;
  }

  drainEvents(_out: CombatEvent[]): void {}

  snapshot(_x: number, _y: number, _z: number, _radius: number, _out: EnemySnap[], _max: number): number {
    return 0;
  }

  crimeEvents(_out: CrimeEventInfo[]): void {}

  heroHp(_pid: number): number {
    return MAX_HP;
  }

  respawnPoint(_pid: number, _out: { x: number; y: number; z: number }): boolean {
    return false;
  }

  debug(op: DebugOp, a: readonly number[]): void {
    this.debugCalls.push({ op, a: a.slice() });
  }
}

export const nullSimFactory = (): RoomSim => new NullSim();
