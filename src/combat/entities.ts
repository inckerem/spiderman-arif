import type { CombatHero, Enemy } from './types';

/** Sim-side enemy: the replicated `Enemy` plus brain and mover bookkeeping (never sent). */
export interface SimEnemy extends Enemy {
  /** Pool index, also the position-history slot. */
  readonly pi: number;
  homeX: number;
  homeY: number;
  homeZ: number;
  /** Desired horizontal velocity set by the brain (m/s). */
  wishX: number;
  wishZ: number;
  grounded: boolean;
  /** Highest feet height since leaving the ground (fall KO). */
  fallTop: number;
  /** Next target search (sim time). */
  nextThink: number;
  /** No new attack (or melee slot) before this time. */
  cooldownUntil: number;
  /** End of the current timed state (alert, stagger, down, pinned, yanked, attack, recover). */
  until: number;
  circleR: number;
  circleDir: number;
  koAt: number;
  /** Yank flight: destination. */
  yx: number;
  yy: number;
  yz: number;
}

/** Sim-side hero: the shared `CombatHero` plus extrapolation, rate and dodge bookkeeping. */
export interface SimHero extends CombatHero {
  /** Position extrapolated to the sim time (`x, y, z` is the last sample). */
  px: number;
  py: number;
  pz: number;
  /** Position-history slot. */
  readonly hi: number;
  /** Intent token bucket (refills at `combat.maxIntentRate` per second). */
  tokens: number;
  /** Late hit resolution for this hero (s): RTT / 2 + base, clamped; 0 in single player. */
  grace: number;
  /** Recent accepted dodge stamps (ring). */
  readonly dodges: Float64Array;
  dodgeHead: number;
  /** After a respawn: samples farther than 10 m from the respawn spot are stale until one arrives near it (or this time passes). */
  awaitUntil: number;
}
