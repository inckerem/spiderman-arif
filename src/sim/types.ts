/**
 * The contract between the shared Room (`sim/room.ts`) and the combat
 * simulation that M11 adds. PURE: no DOM, no rendering, no Node-only APIs.
 *
 * The combat shapes below follow design M11 §3 (`docs/design/m11-m12-combat-multiplayer.md`).
 * M11 owns them: when `src/combat/types.ts` lands it can either import these or
 * move them there and turn this file into re-exports; the Room, the protocol and
 * the codec only depend on the names exported here.
 */
import type { CollisionWorld } from '../physics/collision';
import type { CityLayout } from '../world/types';
import type { MapId } from '../net/maps';

/** Entity ids: enemies 1..0x7fff, heroes 0x8000 + pid (PvP targets). */
export const HERO_ID_BASE = 0x8000;

/** What the combat sim needs from a hero (from Player in SP, from the wire in MP). */
export interface HeroState {
  pid: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  mode: number;
  grounded: boolean;
  facing: number;
  /** Paused, disconnected (reconnect grace) or otherwise away: enemies ignore it and it takes no damage. */
  afk: boolean;
  /** Sim time of the sample (s). */
  t: number;
}

export type CombatIntent =
  | { k: 'strike'; seq: number; target: number; move: number; viewT: number; hx: number; hy: number; hz: number }
  | { k: 'yank' | 'pin' | 'takedown'; seq: number; target: number; viewT: number; hx: number; hy: number; hz: number }
  | { k: 'dodge'; seq: number; t: number };

export interface CrimeEventInfo {
  id: number;
  type: 'robbery' | 'gang' | 'drones' | 'boss';
  boss: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  enemiesLeft: number;
  startedAt: number;
}

export type CombatEvent =
  | { e: 'tele'; src: number; tgt: number; atk: number; at: number }
  | { e: 'hit'; src: number; tgt: number; move: number; dmg: number; hp: number; fl: number; kx: number; ky: number; kz: number }
  | { e: 'miss'; src: number; tgt: number }
  | { e: 'shot'; src: number; x: number; y: number; z: number; tx: number; ty: number; tz: number; hit: boolean }
  | { e: 'proj'; id: number; kind: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }
  | { e: 'projEnd'; id: number; x: number; y: number; z: number; tgt: number }
  | { e: 'yank' | 'pin'; src: number; tgt: number; dur: number }
  | { e: 'down'; pid: number; until: number }
  | { e: 'respawn'; pid: number; x: number; y: number; z: number }
  | { e: 'evStart'; ev: CrimeEventInfo }
  | { e: 'evEnd'; id: number; result: 'clear' | 'expire' }
  | { e: 'boss'; id: number; phase: number }
  | { e: 'rej'; pid: number; seq: number; why: 'range' | 'rate' | 'time' | 'state' | 'pvp' };

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

/** Built once per map and shared by every room on it (server) or by the single local room (SP). */
export interface MapRuntime {
  readonly id: MapId;
  readonly seed: number;
  readonly layout: CityLayout;
  readonly world: CollisionWorld;
}

export type DebugOp = 'spawn' | 'event' | 'killAll';

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
  /** Queued; validated at the next step (design M11 §5). Times are already sim seconds. */
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
  /** Active crime events (sent in `welcome`). */
  crimeEvents(out: CrimeEventInfo[]): void;
  /** Current health of a hero (maxHp for an unknown one). */
  heroHp(pid: number): number;
  /** A server-issued respawn point the hero may teleport to (after a knockout), or false. */
  respawnPoint(pid: number, out: { x: number; y: number; z: number }): boolean;
  /** Test hooks (`dbg` messages); only called when the room has testHooks on. */
  debug(op: DebugOp, a: readonly number[]): void;
}

export interface RoomSimOptions {
  seed: number;
  pvp: boolean;
  maxEnemies: number;
}

export type RoomSimFactory = (map: MapRuntime, opts: RoomSimOptions) => RoomSim;
