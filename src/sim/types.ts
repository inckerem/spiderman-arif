/**
 * The contract between the shared Room (`sim/room.ts`) and the combat
 * simulation behind it. PURE: no DOM, no rendering, no Node-only APIs.
 *
 * The combat shapes (hero state, intents, events, crime events) have one
 * source of truth, `src/combat/types.ts`; they are re-exported here so the
 * Room, the protocol and the codec can name them from one place.
 */
import type { CollisionWorld } from '../physics/collision';
import type { CityLayout } from '../world/types';
import type { SpawnPoints } from '../combat/spawnPoints';
import type { MapId } from '../net/maps';
import type { CombatEvent, CombatIntent, CrimeEventInfo, HeroState } from '../combat/types';

export { HERO_ID_BASE } from '../combat/types';
export type { CombatEvent, CombatIntent, CrimeEventInfo, HeroState, RejectReason, CrimeEventType } from '../combat/types';

/**
 * One replicated enemy (wire form of an M11 `Enemy`, see codec 0x03). Fields
 * are plain numbers so a sim can fill a preallocated array without allocating.
 */
export interface EnemySnap {
  id: number;
  kind: number;
  state: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Health and guard as fractions 0..1 of their maximum. */
  hp: number;
  guard: number;
  anim: number;
  /** Seconds since the replicated pose started. */
  animT: number;
  flags: number;
  /** Target player id (0 = none). */
  target: number;
}

export function makeEnemySnap(): EnemySnap {
  return { id: 0, kind: 0, state: 0, x: 0, y: 0, z: 0, yaw: 0, hp: 0, guard: 0, anim: 0, animT: 0, flags: 0, target: 0 };
}

/** A hero's own combat state, sent to that player with every snapshot (times in sim seconds inside a sim, room seconds on the wire). */
export interface HeroCombatSnap {
  hp: number;
  maxHp: number;
  down: boolean;
  downUntil: number;
  combo: number;
  comboUntil: number;
  focus: number;
  iframesUntil: number;
}

export function makeHeroCombatSnap(): HeroCombatSnap {
  return { hp: 0, maxHp: 0, down: false, downUntil: 0, combo: 0, comboUntil: 0, focus: 0, iframesUntil: 0 };
}

/** Built once per map and shared by every room on it (server) or by the single local room (SP). */
export interface MapRuntime {
  readonly id: MapId;
  readonly seed: number;
  readonly layout: CityLayout;
  readonly world: CollisionWorld;
  /** Crime-event arenas and patrol loops (validated against the world at build). */
  readonly spawns: SpawnPoints;
}

/**
 * Test hooks (`dbg` messages, server TEST_HOOKS=1): `spawn` [kind, x, y, z],
 * `event` [type index, x, z, boss], `killAll` [], `clear` [], `setHp` [hp] (the sender's hero).
 */
export type DebugOp = 'spawn' | 'event' | 'killAll' | 'clear' | 'setHp';
export const DEBUG_OPS: readonly DebugOp[] = ['spawn', 'event', 'killAll', 'clear', 'setHp'];

/**
 * The combat hook of a Room. M11's `CombatSim` implements this (directly or
 * through a thin adapter); until then rooms run `NullSim` (presence only).
 * Times are sim seconds: the Room converts its millisecond clock, and it may
 * stop stepping a sim while its room has no connected player.
 */
export interface RoomSim {
  /** Sim time (s); advances by exactly SIM_DT per step(). */
  readonly time: number;
  /** Latest movement sample of a hero (client-authoritative, already sanity-checked). */
  upsertHero(s: HeroState): void;
  removeHero(pid: number): void;
  /** Queued; validated at the next step by the sim's own rules (design M11 §5). Times are already sim seconds. */
  intent(pid: number, i: CombatIntent): void;
  /** Advance exactly SIM_DT. */
  step(): void;
  /** Move the events produced since the last call into `out` (the caller owns them afterwards and may rewrite their time fields). */
  drainEvents(out: CombatEvent[]): void;
  /**
   * Fill `out[0..n)` (preallocated) with the enemies nearest to (x, y, z) within
   * `radius`, at most `max`, nearest first. Returns n.
   */
  snapshot(x: number, y: number, z: number, radius: number, out: EnemySnap[], max: number): number;
  /** The hero's own combat state (health, down, combo, focus, i-frames); false for an unknown hero. */
  selfSnap(pid: number, out: HeroCombatSnap): boolean;
  /** Active crime events (sent in `welcome`). */
  crimeEvents(out: CrimeEventInfo[]): void;
  /** Current health of a hero (maxHp for an unknown one). */
  heroHp(pid: number): number;
  /** A server-issued respawn point the hero may teleport to (after a knockout), or false. */
  respawnPoint(pid: number, out: { x: number; y: number; z: number }): boolean;
  /** Test hooks (`dbg` messages from player `pid`); only called when the room has testHooks on. */
  debug(pid: number, op: DebugOp, a: readonly number[]): void;
  /** Round trip of a player (s): online hits on it resolve that much later (dodge grace). */
  setRtt(pid: number, rttS: number): void;
  /** Active enemies (stats and load tests). */
  enemyCount(): number;
}

export interface RoomSimOptions {
  seed: number;
  pvp: boolean;
  maxEnemies: number;
}

export type RoomSimFactory = (map: MapRuntime, opts: RoomSimOptions) => RoomSim;
