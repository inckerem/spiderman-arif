/**
 * A presence-only RoomSim (server SIM=null, and tests of the Room itself):
 * it keeps time and the latest hero states, has no enemies and never damages
 * anyone. Every targeted intent is rejected with `state` (there is nothing to
 * hit); the real rules live in CombatSim (`combatRoomSim.ts`). PURE.
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
  readonly debugCalls: Array<{ pid: number; op: DebugOp; a: readonly number[] }> = [];
  readonly rtts = new Map<number, number>();
  private readonly out: CombatEvent[] = [];

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
    if (i.k !== 'dodge') this.out.push({ e: 'rej', pid, seq: i.seq, why: 'state' });
  }

  step(): void {
    this.time += SIM_DT;
  }

  drainEvents(out: CombatEvent[]): void {
    for (const e of this.out) out.push(e);
    this.out.length = 0;
  }

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

  debug(pid: number, op: DebugOp, a: readonly number[]): void {
    this.debugCalls.push({ pid, op, a: a.slice() });
  }

  setRtt(pid: number, rttS: number): void {
    this.rtts.set(pid, rttS);
  }

  enemyCount(): number {
    return 0;
  }
}

export const nullSimFactory = (): RoomSim => new NullSim();
