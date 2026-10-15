import { tuning } from '../config/tuning';
import { wrapAngle } from '../core/math';
import type { GroundMover } from './mover';
import type { SimEnemy, SimHero } from './entities';
import { kindStats } from './roster';
import { ANIM, ATK, EF, EK, ES } from './types';

/**
 * Enemy state machines. A brain reads the world through `BrainHost` (the
 * CombatSim) and writes the enemy's state, facing and desired velocity
 * (`wishX/Z`); the sim then moves it and resolves its attacks.
 */
export interface BrainHost {
  readonly time: number;
  readonly mover: GroundMover;
  /** Hero by entity id (HERO_ID_BASE + pid). */
  heroById(id: number): SimHero | undefined;
  /** A hero enemies may chase and hit (present, not down, not afk). */
  heroTargetable(h: SimHero): boolean;
  /** Nearest targetable hero within the aggro range with line of sight, as an entity id, or -1. */
  findTarget(e: SimEnemy): number;
  /** Take a melee slot around the enemy's target; true when it holds one. */
  takeSlot(e: SimEnemy): boolean;
  releaseSlot(e: SimEnemy): void;
  setState(e: SimEnemy, state: number, until?: number): void;
  setAnim(e: SimEnemy, anim: number): void;
  /** Wind up an attack on the current target; it lands `delay` seconds from now. */
  startTelegraph(e: SimEnemy, atk: number, delay: number): void;
}

export type Brain = (host: BrainHost, e: SimEnemy, dt: number) => void;

const TURN_RATE = 10;

function faceToward(e: SimEnemy, dx: number, dz: number, dt: number): void {
  if (dx * dx + dz * dz < 1e-6) return;
  // Same yaw convention as the player: forward = (-sin yaw, -cos yaw).
  const want = Math.atan2(-dx, -dz);
  const d = wrapAngle(want - e.yaw);
  const step = TURN_RATE * dt;
  e.yaw = wrapAngle(e.yaw + (d > step ? step : d < -step ? -step : d));
}

function stand(e: SimEnemy): void {
  e.wishX = 0;
  e.wishZ = 0;
}

/** Walk or run toward (dx, dz) at `speed`, steering around walls. */
function go(host: BrainHost, e: SimEnemy, dx: number, dz: number, speed: number): void {
  const l = Math.hypot(dx, dz);
  if (l < 1e-4) return stand(e);
  const s = host.mover.steer(e.pos.x, e.pos.y, e.pos.z, dx / l, dz / l);
  e.wishX = s.x * speed;
  e.wishZ = s.z * speed;
}

/** States the brain does not drive (timed reactions); true when it handled the step. */
function reactions(host: BrainHost, e: SimEnemy): boolean {
  const t = host.time;
  switch (e.state) {
    case ES.KO:
    case ES.YANKED:
      stand(e);
      return true;
    case ES.STAGGER:
      stand(e);
      if (t >= e.until) {
        e.flags &= ~EF.KNOCKED;
        host.setState(e, e.target >= 0 ? ES.APPROACH : ES.IDLE);
      }
      return true;
    case ES.DOWN:
      stand(e);
      if (t >= e.until) {
        e.flags &= ~EF.KNOCKED;
        host.setState(e, ES.RECOVER, t + 0.5);
        host.setAnim(e, ANIM.GETUP);
      }
      return true;
    case ES.PINNED:
      stand(e);
      if (t >= e.until) host.setState(e, ES.STAGGER, t + tuning.combat.hitStun);
      return true;
  }
  return false;
}

/**
 * Melee fighter (thug: punch; bat thug: slower, harder swing). Spots the
 * nearest hero, closes in, takes one of the melee slots around it (the rest
 * circle at 4-6 m), winds up (telegraph) and strikes, then backs off for its
 * cooldown and gives the slot to the next one.
 */
export const thinkMelee: Brain = (host, e, dt) => {
  if (reactions(host, e)) return;
  const t = host.time;
  const en = tuning.enemies;
  const st = kindStats(e.kind);
  if (t >= e.nextThink) {
    e.nextThink = t + en.retarget;
    const keep = e.target >= 0 ? host.heroById(e.target) : undefined;
    const keepOk = keep !== undefined && host.heroTargetable(keep) && Math.hypot(keep.px - e.pos.x, keep.pz - e.pos.z) <= en.loseRange;
    if (!keepOk) {
      const id = host.findTarget(e);
      if (id !== e.target) {
        host.releaseSlot(e);
        e.target = id;
      }
    }
  }
  const h = e.target >= 0 ? host.heroById(e.target) : undefined;
  if (!h || !host.heroTargetable(h)) {
    if (e.target >= 0) {
      host.releaseSlot(e);
      e.target = -1;
    }
    if (e.tele) e.tele = null;
    if (e.state !== ES.IDLE && e.state !== ES.PATROL) {
      host.setState(e, ES.IDLE);
      e.flags &= ~EF.ALERTED;
    }
    // Drift back home when far from it.
    const hx = e.homeX - e.pos.x,
      hz = e.homeZ - e.pos.z;
    if (hx * hx + hz * hz > 9) {
      go(host, e, hx, hz, st.speed * 0.5);
      faceToward(e, hx, hz, dt);
      host.setAnim(e, ANIM.WALK);
    } else {
      stand(e);
      host.setAnim(e, ANIM.IDLE);
    }
    return;
  }
  const dx = h.px - e.pos.x,
    dy = h.py - e.pos.y,
    dz = h.pz - e.pos.z;
  const dist = Math.hypot(dx, dz);
  faceToward(e, dx, dz, dt);
  switch (e.state) {
    case ES.IDLE:
    case ES.PATROL:
      e.flags |= EF.ALERTED;
      host.setState(e, ES.ALERT, t + en.alertTime);
      host.setAnim(e, ANIM.ALERT);
      stand(e);
      return;
    case ES.ALERT:
      stand(e);
      if (t >= e.until) host.setState(e, ES.APPROACH);
      return;
    case ES.TELEGRAPH:
      // Creep in during the wind-up so a hero standing still is in reach.
      if (dist > st.range * 0.7) go(host, e, dx, dz, 1.5);
      else stand(e);
      return;
    case ES.ATTACK:
      stand(e);
      if (t >= e.until) host.setState(e, ES.RECOVER, t + 0.35);
      return;
    case ES.RECOVER:
      stand(e);
      if (t >= e.until) host.setState(e, ES.APPROACH);
      return;
  }
  // APPROACH / CIRCLE
  const inRange = dist <= st.range && Math.abs(dy) <= 1.5;
  const near = dist <= en.circleMax + 1;
  if (e.slot < 0 && near && t >= e.cooldownUntil - 0.3) host.takeSlot(e);
  if (e.slot >= 0) {
    if (e.state !== ES.APPROACH) host.setState(e, ES.APPROACH);
    if (inRange) {
      stand(e);
      if (t >= e.cooldownUntil) host.startTelegraph(e, e.kind === EK.BAT ? ATK.BAT_SWING : ATK.PUNCH, st.telegraph);
      else host.setAnim(e, ANIM.IDLE);
    } else {
      go(host, e, dx, dz, st.speed);
      host.setAnim(e, ANIM.RUN);
    }
    return;
  }
  if (near) {
    if (e.state !== ES.CIRCLE) host.setState(e, ES.CIRCLE);
    // Orbit at the enemy's own radius, correcting the distance.
    const l = dist || 1;
    const rx = -dx / l,
      rz = -dz / l;
    const corr = Math.max(-1, Math.min(1, e.circleR - dist));
    const wx = -rz * e.circleDir * 0.7 + rx * corr,
      wz = rx * e.circleDir * 0.7 + rz * corr;
    go(host, e, wx, wz, st.speed * 0.45);
    host.setAnim(e, ANIM.STRAFE);
    return;
  }
  if (e.state !== ES.APPROACH) host.setState(e, ES.APPROACH);
  go(host, e, dx, dz, st.speed);
  host.setAnim(e, ANIM.RUN);
};

/** Kinds without a brain yet (later chunks) stand still. */
export const thinkInert: Brain = (host, e) => {
  if (reactions(host, e)) return;
  stand(e);
};

/** Brain per enemy kind. */
export const BRAINS: readonly Brain[] = [
  thinkMelee, // THUG
  thinkMelee, // BAT
  thinkInert, // GUNMAN (chunk 6)
  thinkInert, // BRUTE (chunk 6)
  thinkInert, // DRONE (chunk 6)
  thinkInert, // KOCBASI (chunk 8)
  thinkInert, // KUZGUN (chunk 8)
  thinkInert, // DIKEN (chunk 8)
];
