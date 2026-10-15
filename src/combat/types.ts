import type { Vector3 } from 'three';

/**
 * Shared combat types: ids, kinds, states, moves, intents and events. Used by
 * the pure sim (single player and the Node server) and, from M12, by the wire
 * protocol. Numeric constants instead of `const enum` (isolatedModules).
 */

/** Enemy kinds. */
export const EK = { THUG: 0, BAT: 1, GUNMAN: 2, BRUTE: 3, DRONE: 4, KOCBASI: 5, KUZGUN: 6, DIKEN: 7 } as const;
export type EnemyKind = (typeof EK)[keyof typeof EK];
export const ENEMY_KIND_COUNT = 8;

/** Enemy states (replicated as a byte). */
export const ES = {
  IDLE: 0,
  PATROL: 1,
  ALERT: 2,
  APPROACH: 3,
  CIRCLE: 4,
  TELEGRAPH: 5,
  ATTACK: 6,
  RECOVER: 7,
  STAGGER: 8,
  DOWN: 9,
  PINNED: 10,
  YANKED: 11,
  KO: 12,
  SPECIAL: 13,
} as const;
export const ES_NAMES = [
  'idle',
  'patrol',
  'alert',
  'approach',
  'circle',
  'telegraph',
  'attack',
  'recover',
  'stagger',
  'down',
  'pinned',
  'yanked',
  'ko',
  'special',
] as const;

/** Hero moves (strike intents and `hit` events from heroes). */
export const MOVE = { JAB: 0, CROSS: 1, KICK: 2, UPPER: 3, AIR: 4, GROUND: 5, TAKEDOWN: 6, YANK: 7, PIN: 8 } as const;
/** The chain moves cycle in this order. */
export const CHAIN_MOVES = [MOVE.JAB, MOVE.CROSS, MOVE.KICK, MOVE.UPPER] as const;

/** Enemy attacks (`tele.atk`, and the `move` field of a `hit` whose source is an enemy). */
export const ATK = {
  PUNCH: 16,
  BAT_SWING: 17,
  BOTTLE: 18,
  BURST: 19,
  SLAM: 20,
  CHARGE: 21,
  BOLT: 22,
  RAM_CHARGE: 23,
  STOMP: 24,
  SWOOP: 25,
  DARTS: 26,
  CLAW: 27,
  TAIL_STAB: 28,
  TAIL_SWEEP: 29,
} as const;

/** `hit.fl` bit flags. */
export const HIT = { STAGGER: 1, KNOCKDOWN: 2, KO: 4, BLOCKED: 8, BACK: 16, ABOVE: 32 } as const;

/** `Enemy.flags` bits. */
export const EF = { AIRBORNE: 1, DISARMED: 2, SHIELDLESS: 4, TAIL_STUCK: 8, ALERTED: 16, KNOCKED: 32 } as const;

/** Replicated pose ids (`Enemy.anim`), read by the enemy animator (chunk 5). */
export const ANIM = {
  IDLE: 0,
  WALK: 1,
  RUN: 2,
  ALERT: 3,
  WINDUP: 4,
  STRIKE: 5,
  STAGGER: 6,
  KNOCKDOWN: 7,
  GETUP: 8,
  PINNED: 9,
  YANKED: 10,
  KO: 11,
  TAUNT: 12,
  STRAFE: 13,
} as const;

/** Entity ids: enemies 1..0x7fff, heroes 0x8000 + pid (PvP targets). */
export const HERO_ID_BASE = 0x8000;
export const MAX_ENEMY_ID = 0x7fff;
export const heroId = (pid: number): number => HERO_ID_BASE + pid;
export const isHeroId = (id: number): boolean => id >= HERO_ID_BASE;

export interface Telegraph {
  atk: number;
  /** Target entity id (a hero id). */
  target: number;
  /** Sim time at which the attack lands. */
  impactAt: number;
}

export interface Enemy {
  id: number;
  kind: EnemyKind;
  state: number;
  /** Seconds in the current state. */
  stateT: number;
  pos: Vector3;
  vel: Vector3;
  yaw: number;
  hp: number;
  maxHp: number;
  /** Brute shield / boss armour hp; 0 = off. */
  guard: number;
  /** Target hero id or -1. */
  target: number;
  /** Crime event and arena it belongs to; -1 when roaming or debug-spawned. */
  eventId: number;
  arena: number;
  /** EF bits. */
  flags: number;
  tele: Telegraph | null;
  /** Replicated pose id and its start (sim seconds). */
  anim: number;
  animT0: number;
  /** Melee attack slot around its target (max `enemies.maxMeleeAttackers` holders per hero), -1 none. */
  slot: number;
}

/** What the sim needs from a hero: from Player in single player, from the wire in M12. */
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
  afk: boolean;
  /** Sim (room) time of the sample. */
  t: number;
}

export interface CombatHero extends HeroState {
  hp: number;
  maxHp: number;
  down: boolean;
  downUntil: number;
  lastHurt: number;
  iframesUntil: number;
  combo: number;
  comboUntil: number;
  focus: number;
  lastStrike: number;
}

export type CombatIntent =
  | { k: 'strike'; seq: number; target: number; move: number; viewT: number; hx: number; hy: number; hz: number }
  | { k: 'yank' | 'pin' | 'takedown'; seq: number; target: number; viewT: number; hx: number; hy: number; hz: number }
  | { k: 'dodge'; seq: number; t: number };

export type RejectReason = 'range' | 'rate' | 'time' | 'state' | 'pvp';

export type CrimeEventType = 'robbery' | 'gang' | 'drones' | 'boss';

export interface CrimeEventInfo {
  id: number;
  type: CrimeEventType;
  /** Boss kind for `boss` events, else -1. */
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
  /** An attack that a dodge avoided. */
  | { e: 'miss'; src: number; tgt: number }
  | { e: 'shot'; src: number; x: number; y: number; z: number; tx: number; ty: number; tz: number; hit: boolean }
  | { e: 'proj'; id: number; kind: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }
  | { e: 'projEnd'; id: number; x: number; y: number; z: number; tgt: number }
  | { e: 'yank' | 'pin'; src: number; tgt: number; dur: number }
  | { e: 'down'; pid: number; until: number }
  | { e: 'respawn'; pid: number; x: number; y: number; z: number }
  /** Enemy spawned (replicated reliably; snapshots carry the motion). */
  | { e: 'spawn'; id: number; kind: number; x: number; y: number; z: number }
  | { e: 'evStart'; ev: CrimeEventInfo }
  | { e: 'evEnd'; id: number; result: 'clear' | 'expire' }
  | { e: 'boss'; id: number; phase: number }
  | { e: 'rej'; pid: number; seq: number; why: RejectReason };
