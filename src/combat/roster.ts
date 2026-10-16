import { tuning } from '../config/tuning';
import { EF, EK, ES, HIT, type EnemyKind } from './types';

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

/**
 * The shielded brute's guard against a hero strike from (hx, hy, hz): 0 when
 * no guard is up (the strike lands normally), else `HIT.BACK` (from more than
 * `backArcDeg` off his facing) or `HIT.ABOVE` (the hero `aboveHeight` or more
 * above his feet), which land, or `HIT.BLOCKED`. The guard is down without
 * the shield and while he is pinned, down, yanked or knocked out. Shared by
 * the sim (authoritative) and the client (no predicted flinch on a block).
 */
export function guardBlocks(kind: number, guard: number, flags: number, state: number, ex: number, ey: number, ez: number, yaw: number, hx: number, hy: number, hz: number): number {
  if (kind !== EK.BRUTE || guard <= 0 || (flags & EF.SHIELDLESS) !== 0) return 0;
  if (state === ES.PINNED || state === ES.DOWN || state === ES.YANKED || state === ES.KO) return 0;
  const b = tuning.enemies.brute;
  if (hy >= ey + b.aboveHeight) return HIT.ABOVE;
  const dx = hx - ex,
    dz = hz - ez;
  const l = Math.hypot(dx, dz);
  if (l < 1e-4) return HIT.BLOCKED;
  // Facing (the player's convention): forward = (-sin yaw, -cos yaw).
  const cos = (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / l;
  return cos < Math.cos((b.backArcDeg * Math.PI) / 180) ? HIT.BACK : HIT.BLOCKED;
}
