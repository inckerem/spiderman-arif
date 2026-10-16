import type { CombatHero, Enemy } from './types';

/** Sim-side enemy: the replicated `Enemy` plus brain and mover bookkeeping (never sent). */
export interface SimEnemy extends Enemy {
  /** Pool index, also the position-history slot. */
  readonly pi: number;
  homeX: number;
  homeY: number;
  homeZ: number;
  /** Desired velocity set by the brain (m/s); `wishY` only for flyers. */
  wishX: number;
  wishY: number;
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
  /** Attack direction locked at launch (brute charge), unit XZ. */
  ax: number;
  az: number;
  /** Gunman burst: rounds left, the time of the next and the burst's start (its rounds dodge as one attack). */
  shots: number;
  nextShot: number;
  burstAt: number;
  /** Line of sight to the target at the last think (chest to chest). */
  los: boolean;
  /** Where it came from (`ORIGIN` in crimeEvents.ts): a test hook, a crime event, a roaming pair, or a stray left by a failed event. */
  origin: number;
  /** Roaming: patrol loop index (`SpawnPoints.loops`, -1 none) and the distance along it of the point it walks to. */
  loop: number;
  loopS: number;
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
