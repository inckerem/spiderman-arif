import { tuning } from '../config/tuning';
import { EK, type EnemyKind } from './types';

/** Live per-kind stats (`tuning.enemies.<key>`): the debug panel edits them in place. */
export interface KindStats {
  hp: number;
  speed: number;
  damage: number;
  telegraph: number;
  cooldown: number;
  range: number;
}

/** Fixed per-kind data. Names live in `i18n/tr.ts` under `combat.enemies[key]`. */
export interface KindInfo {
  kind: EnemyKind;
  /** Key into `tuning.enemies` and `tr.combat.enemies`. */
  key: 'thug' | 'bat' | 'gunman' | 'brute' | 'drone' | 'kocbasi' | 'kuzgun' | 'diken';
  /** Collision capsule (feet origin) or, for flyers, sphere radius. */
  radius: number;
  height: number;
  flyer: boolean;
  boss: boolean;
  /** Melee fighter that takes a melee slot around its target. */
  melee: boolean;
  /** Extra skeleton bones beyond the shared 21 (rendering, chunk 5/8). */
  extraBones: number;
  /** Guard (shield or armour) hp at spawn; 0 = none. */
  guard: number;
}

export const ROSTER: readonly KindInfo[] = [
  { kind: EK.THUG, key: 'thug', radius: 0.4, height: 1.8, flyer: false, boss: false, melee: true, extraBones: 0, guard: 0 },
  { kind: EK.BAT, key: 'bat', radius: 0.4, height: 1.8, flyer: false, boss: false, melee: true, extraBones: 0, guard: 0 },
  { kind: EK.GUNMAN, key: 'gunman', radius: 0.4, height: 1.8, flyer: false, boss: false, melee: false, extraBones: 0, guard: 0 },
  { kind: EK.BRUTE, key: 'brute', radius: 0.55, height: 2.1, flyer: false, boss: false, melee: true, extraBones: 0, guard: 1 },
  { kind: EK.DRONE, key: 'drone', radius: 0.6, height: 0, flyer: true, boss: false, melee: false, extraBones: 0, guard: 0 },
  { kind: EK.KOCBASI, key: 'kocbasi', radius: 0.9, height: 2.9, flyer: false, boss: true, melee: true, extraBones: 0, guard: 1 },
  { kind: EK.KUZGUN, key: 'kuzgun', radius: 0.6, height: 2.0, flyer: true, boss: true, melee: false, extraBones: 4, guard: 0 },
  { kind: EK.DIKEN, key: 'diken', radius: 0.5, height: 2.0, flyer: false, boss: true, melee: true, extraBones: 5, guard: 0 },
];

/** Live stats of a kind (tuning edits apply on the next step). */
export function kindStats(kind: EnemyKind): KindStats {
  return tuning.enemies[ROSTER[kind]!.key];
}

export function kindInfo(kind: EnemyKind): KindInfo {
  return ROSTER[kind]!;
}

export const isBoss = (kind: number): boolean => ROSTER[kind]?.boss === true;
