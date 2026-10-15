import type { CombatEvent, CombatIntent, HeroState } from '../types';
import type { CombatView } from './combatView';

/**
 * The client side of a combat room: what the game talks to, whether the
 * combat sim runs in this tab (single player, `LocalCombatLink`) or on the
 * server (M12, a network link). Message shapes follow the design's protocol
 * (`docs/design/m11-m12-combat-multiplayer.md` §M12.2) in object form, so the
 * M12 network link only has to (de)serialize them:
 *
 * - up: the hero's movement sample every tick (`HeroState`; online it is
 *   uploaded at 20 Hz as the binary 0x01 frame) and combat intents (`act`);
 * - down: `ce` batches of combat events (reliable) and enemy snapshots (the
 *   binary 0x03 frame), both fed to `view.apply`.
 */
export interface CombatLink {
  readonly mode: 'local' | 'online';
  /** This client's player id in the room (hero entity id = HERO_ID_BASE + pid). */
  readonly selfPid: number;
  /** Replicated enemies, self health and threats, interpolated for rendering and targeting. */
  readonly view: CombatView;
  /** Room time (s): what intents are stamped with. */
  now(): number;
  /** The time the view is sampled at: `now()` minus the render delay (local: one combat tick; online: 0.1 s). */
  renderTime(): number;
  /** Every simulation tick (120 Hz): upload the hero's state, advance (local) or poll (online) the room, deliver messages to the view. */
  tick(dt: number, self: HeroState): void;
  /** Send a combat intent (validated by the room at its next step). */
  intent(i: CombatIntent): void;
  /** Local: stop stepping. Online: mark the hero away (afk). */
  setPaused(paused: boolean): void;
  close(): void;
}

/** One enemy in a snapshot (object form of a 0x03 entry; the wire quantizes it). */
export interface EnemySnap {
  id: number;
  kind: number;
  state: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  guard: number;
  anim: number;
  animT0: number;
  flags: number;
  /** Target entity id or -1. */
  target: number;
}

/** The receiving hero's own combat state (online: carried with each snapshot). */
export interface SelfSnap {
  hp: number;
  maxHp: number;
  down: boolean;
  downUntil: number;
  combo: number;
  comboUntil: number;
  focus: number;
  iframesUntil: number;
}

/** Enemy snapshot: the nearest enemies at room time `time`. `enemies[0..count)` are valid (pooled arrays). */
export interface CombatSnapshot {
  t: 'snap';
  time: number;
  count: number;
  enemies: readonly EnemySnap[];
  self: SelfSnap | null;
}

/** A batch of combat events from one room step (the protocol's `ce`). */
export interface CombatEventBatch {
  t: 'ce';
  /** Room time of the step that produced them. */
  time: number;
  ev: readonly CombatEvent[];
}

/** Everything a link delivers to the view. */
export type CombatDownMsg = CombatSnapshot | CombatEventBatch;

export function makeEnemySnap(): EnemySnap {
  return { id: 0, kind: 0, state: 0, x: 0, y: 0, z: 0, yaw: 0, hp: 0, maxHp: 0, guard: 0, anim: 0, animT0: 0, flags: 0, target: -1 };
}

export function makeSelfSnap(): SelfSnap {
  return { hp: 0, maxHp: 0, down: false, downUntil: 0, combo: 0, comboUntil: 0, focus: 0, iframesUntil: 0 };
}

export function makeHeroState(pid = 1): HeroState {
  return { pid, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, mode: 0, grounded: false, facing: 0, afk: false, t: 0 };
}
