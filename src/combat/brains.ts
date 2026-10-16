import { tuning } from '../config/tuning';
import { wrapAngle } from '../core/math';
import type { GroundMover } from './mover';
import type { SimEnemy, SimHero } from './entities';
import { kindStats, type KindStats } from './roster';
import { ANIM, ATK, EF, EK, ES } from './types';

/**
 * Enemy state machines. A brain reads the world through `BrainHost` (the
 * CombatSim) and writes the enemy's state, facing and desired velocity
 * (`wishX/Y/Z`); the sim then moves it and resolves its attacks.
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
  /** Line of sight from the enemy's eyes (a flyer's centre) to the hero's chest. */
  canSee(e: SimEnemy, h: SimHero): boolean;
  /** Take a melee slot around the enemy's target; true when it holds one. */
  takeSlot(e: SimEnemy): boolean;
  releaseSlot(e: SimEnemy): void;
  setState(e: SimEnemy, state: number, until?: number): void;
  setAnim(e: SimEnemy, anim: number): void;
  /**
   * Wind up an attack on the current target: it fires `delay` seconds from
   * now with pose `anim`; the `tele` event tells the target it lands
   * `landsIn` seconds after that (projectile flight, a charge's run).
   */
  startTelegraph(e: SimEnemy, atk: number, delay: number, anim?: number, landsIn?: number): void;
  /** Deterministic random number in [0, 1) from the sim's generator. */
  rand(): number;
}

export type Brain = (host: BrainHost, e: SimEnemy, dt: number) => void;

const TURN_RATE = 10;
/** The brute turns slowly: a hero can get behind his shield. */
const BRUTE_TURN = 2.5;
const DRONE_TURN = 5;

function faceToward(e: SimEnemy, dx: number, dz: number, dt: number, rate = TURN_RATE): void {
  if (dx * dx + dz * dz < 1e-6) return;
  // Same yaw convention as the player: forward = (-sin yaw, -cos yaw).
  const want = Math.atan2(-dx, -dz);
  const d = wrapAngle(want - e.yaw);
  const step = rate * dt;
  e.yaw = wrapAngle(e.yaw + (d > step ? step : d < -step ? -step : d));
}

function stand(e: SimEnemy): void {
  e.wishX = 0;
  e.wishY = 0;
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

/** Stats an enemy attacks with: a disarmed gunman fights like a thug. */
export function attackStats(e: SimEnemy): KindStats {
  return e.kind === EK.GUNMAN && (e.flags & EF.DISARMED) !== 0 ? tuning.enemies.thug : kindStats(e.kind);
}

/** The melee attack of a kind. */
function meleeAtk(e: SimEnemy): number {
  return e.kind === EK.BAT ? ATK.BAT_SWING : e.kind === EK.BRUTE ? ATK.SLAM : ATK.PUNCH;
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
 * Target upkeep every `retarget` seconds: keep the current hero while it is
 * valid and within `keepRange`, else take the nearest visible one; refresh
 * the cached line of sight. Returns the target (or undefined, after letting
 * go of it).
 */
function acquire(host: BrainHost, e: SimEnemy, keepRange: number): SimHero | undefined {
  const t = host.time;
  if (t >= e.nextThink) {
    e.nextThink = t + tuning.enemies.retarget;
    const keep = e.target >= 0 ? host.heroById(e.target) : undefined;
    const keepOk = keep !== undefined && host.heroTargetable(keep) && Math.hypot(keep.px - e.pos.x, keep.pz - e.pos.z) <= keepRange;
    if (!keepOk) {
      const id = host.findTarget(e);
      if (id !== e.target) {
        host.releaseSlot(e);
        e.target = id;
      }
    }
    const h = e.target >= 0 ? host.heroById(e.target) : undefined;
    e.los = h !== undefined && host.canSee(e, h);
  }
  const h = e.target >= 0 ? host.heroById(e.target) : undefined;
  if (!h || !host.heroTargetable(h)) {
    if (e.target >= 0) {
      host.releaseSlot(e);
      e.target = -1;
    }
    if (e.tele) e.tele = null;
    e.shots = 0;
    return undefined;
  }
  return h;
}

/** No target: back to idle, drifting home when far from it. */
function idle(host: BrainHost, e: SimEnemy, dt: number, speed: number): void {
  if (e.state !== ES.IDLE && e.state !== ES.PATROL) {
    host.setState(e, ES.IDLE);
    e.flags &= ~EF.ALERTED;
  }
  const hx = e.homeX - e.pos.x,
    hz = e.homeZ - e.pos.z;
  if (hx * hx + hz * hz > 9) {
    go(host, e, hx, hz, speed * 0.5);
    faceToward(e, hx, hz, dt);
    host.setAnim(e, ANIM.WALK);
  } else {
    stand(e);
    host.setAnim(e, ANIM.IDLE);
  }
}

/** Spotting, reaction and the attack cycle's timed states shared by every brain; true when it handled the step. */
function attackCycle(host: BrainHost, e: SimEnemy, recover: number): boolean {
  const t = host.time;
  switch (e.state) {
    case ES.IDLE:
    case ES.PATROL:
      e.flags |= EF.ALERTED;
      host.setState(e, ES.ALERT, t + tuning.enemies.alertTime);
      host.setAnim(e, ANIM.ALERT);
      stand(e);
      return true;
    case ES.ALERT:
      stand(e);
      if (t >= e.until) host.setState(e, ES.APPROACH);
      return true;
    case ES.ATTACK:
      stand(e);
      if (t >= e.until) host.setState(e, ES.RECOVER, t + recover);
      return true;
    case ES.RECOVER:
      stand(e);
      if (t >= e.until) host.setState(e, ES.APPROACH);
      return true;
  }
  return false;
}

/**
 * Melee fighter (thug: punch; bat thug: slower, harder swing; brute: slam;
 * a disarmed gunman fights like a thug). Spots the nearest hero, closes in,
 * takes one of the melee slots around it (the rest circle at 4-6 m), winds
 * up (telegraph) and strikes, then backs off for its cooldown and gives the
 * slot to the next one. A thug below a hero more than 3 m up throws bottles
 * instead; a brute without a slot may charge from 6-16 m (head down, in a
 * straight line locked when the run starts).
 */
export const thinkMelee: Brain = (host, e, dt) => {
  if (reactions(host, e)) return;
  const t = host.time;
  const en = tuning.enemies;
  const st = attackStats(e);
  // Random decisions happen only on think steps (once per retarget period).
  const thought = t >= e.nextThink;
  const h = acquire(host, e, en.loseRange);
  const turn = e.kind === EK.BRUTE ? BRUTE_TURN : TURN_RATE;
  if (!h) return idle(host, e, dt, st.speed);
  const dx = h.px - e.pos.x,
    dy = h.py - e.pos.y,
    dz = h.pz - e.pos.z;
  const dist = Math.hypot(dx, dz);
  if (e.state === ES.SPECIAL) {
    // Brute charge: straight along the locked direction until it hits, runs out or meets a wall (the sim decides).
    e.wishX = e.ax * en.brute.chargeSpeed;
    e.wishZ = e.az * en.brute.chargeSpeed;
    faceToward(e, e.ax, e.az, dt, TURN_RATE);
    if (t >= e.until) {
      host.setState(e, ES.RECOVER, t + 0.6);
      host.setAnim(e, ANIM.IDLE);
    }
    return;
  }
  faceToward(e, dx, dz, dt, turn);
  if (attackCycle(host, e, 0.35)) return;
  if (e.state === ES.TELEGRAPH) {
    const atk = e.tele ? e.tele.atk : -1;
    if (atk === ATK.CHARGE) {
      // Lock onto the hero while pawing the ground; the run starts in the chosen direction.
      const l = dist || 1;
      e.ax = dx / l;
      e.az = dz / l;
      stand(e);
    } else if (atk !== ATK.BOTTLE && dist > st.range * 0.7) go(host, e, dx, dz, 1.5);
    // Creep in during a melee wind-up so a hero standing still is in reach.
    else stand(e);
    return;
  }
  // APPROACH / CIRCLE
  // Bottles at a hero out of reach above (roofs, fire escapes, a wall).
  if (e.kind === EK.THUG && dy > en.thug.bottleMinAbove && dist <= en.thug.bottleRange && t >= e.cooldownUntil && e.los) {
    host.releaseSlot(e);
    stand(e);
    const d3 = Math.hypot(dx, dy + 1, dz);
    host.startTelegraph(e, ATK.BOTTLE, en.thug.telegraph * 1.2, ANIM.THROW, Math.max(0.35, d3 / BOTTLE_SPEED));
    return;
  }
  const inRange = dist <= st.range && Math.abs(dy) <= 1.5;
  const near = dist <= en.circleMax + 1;
  // Brute: a charge from mid range when he has no slot (decided once per think).
  if (e.kind === EK.BRUTE && thought && e.slot < 0 && !inRange && dist >= 6 && dist <= 16 && Math.abs(dy) < 1.5 && t >= e.cooldownUntil && e.los && host.rand() < 0.5) {
    e.ax = dx / dist;
    e.az = dz / dist;
    stand(e);
    host.startTelegraph(e, ATK.CHARGE, st.telegraph, ANIM.CHARGE, Math.max(0.1, (dist - 1.2) / en.brute.chargeSpeed));
    return;
  }
  if (e.slot < 0 && near && t >= e.cooldownUntil - 0.3) host.takeSlot(e);
  if (e.slot >= 0) {
    if (e.state !== ES.APPROACH) host.setState(e, ES.APPROACH);
    if (inRange) {
      stand(e);
      if (t >= e.cooldownUntil) host.startTelegraph(e, meleeAtk(e), st.telegraph);
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

/** Bottle launch speed (m/s, straight-line equivalent; the arc adds lift). */
export const BOTTLE_SPEED = 14;

/**
 * Gunman: keeps 12-25 m from his target (backs off when it comes closer,
 * closes in when it is farther or out of sight, strafes in between), and with
 * line of sight within range aims for 0.7 s with a laser sight (the
 * telegraph), then fires a three-round burst of delayed hitscan rounds (the
 * sim rolls each against the target's speed and distance; a dodge in the
 * window makes them miss). Swinging heroes are fair game. A yank disarms
 * him: from then on he brawls like a thug.
 */
export const thinkGunman: Brain = (host, e, dt) => {
  if ((e.flags & EF.DISARMED) !== 0) return thinkMelee(host, e, dt);
  if (reactions(host, e)) return;
  const t = host.time;
  const st = tuning.enemies.gunman;
  const h = acquire(host, e, Math.max(st.range, tuning.enemies.loseRange));
  if (!h) return idle(host, e, dt, st.speed);
  const dx = h.px - e.pos.x,
    dz = h.pz - e.pos.z;
  const dist = Math.hypot(dx, dz);
  faceToward(e, dx, dz, dt);
  if (attackCycle(host, e, 0.4)) return;
  if (e.state === ES.TELEGRAPH) {
    stand(e);
    return;
  }
  const d3 = Math.hypot(dx, h.py - e.pos.y, dz);
  // Far too close (under 60 % of the keep distance): back off before aiming.
  if (t >= e.cooldownUntil && e.los && d3 <= st.range && dist >= st.keepMin * 0.6) {
    stand(e);
    host.startTelegraph(e, ATK.BURST, st.telegraph, ANIM.AIM);
    return;
  }
  if (dist < st.keepMin) {
    // Too close: back off (facing the hero).
    if (e.state !== ES.CIRCLE) host.setState(e, ES.CIRCLE);
    go(host, e, -dx, -dz, st.speed);
    host.setAnim(e, ANIM.STRAFE);
  } else if (dist > st.keepMax || !e.los) {
    if (e.state !== ES.APPROACH) host.setState(e, ES.APPROACH);
    go(host, e, dx, dz, st.speed);
    host.setAnim(e, ANIM.RUN);
  } else {
    if (e.state !== ES.CIRCLE) host.setState(e, ES.CIRCLE);
    const l = dist || 1;
    go(host, e, (dz / l) * e.circleDir, (-dx / l) * e.circleDir, st.speed * 0.4);
    host.setAnim(e, ANIM.STRAFE);
  }
};

/**
 * Drone: flies an orbit around its target (orbit radius 8 m varied per
 * drone, 5 m above it, never lower than 3 m over what is below), climbing
 * when its view is blocked; with line of sight within 25 m it hovers, winds
 * up (eye glow, 0.6 s) and fires a plasma bolt that leads the hero by half
 * its flight. Hits juggle it (a stagger in the air); a pin or a yank drops it.
 */
export const thinkDrone: Brain = (host, e, dt) => {
  if (e.state === ES.KO) return stand(e);
  if (reactions(host, e)) return;
  const t = host.time;
  const st = tuning.enemies.drone;
  const h = acquire(host, e, tuning.enemies.loseRange);
  const w = host.mover.world;
  if (!h) {
    if (e.state !== ES.IDLE) {
      host.setState(e, ES.IDLE);
      e.flags &= ~EF.ALERTED;
    }
    flyTo(e, e.homeX, e.homeY, e.homeZ, st.speed * 0.4);
    host.setAnim(e, ANIM.HOVER);
    return;
  }
  const dx = h.px - e.pos.x,
    dz = h.pz - e.pos.z;
  faceToward(e, dx, dz, dt, DRONE_TURN);
  if (attackCycle(host, e, 0.3)) {
    if (e.state !== ES.ATTACK) host.setAnim(e, ANIM.HOVER);
    return;
  }
  if (e.state === ES.TELEGRAPH) return stand(e);
  const chest = h.py + tuning.body.chestHeight;
  const d3 = Math.hypot(dx, chest - e.pos.y, dz);
  if (t >= e.cooldownUntil && e.los && d3 <= st.range) {
    stand(e);
    host.startTelegraph(e, ATK.BOLT, st.telegraph, ANIM.WINDUP, d3 / Math.max(1, st.boltSpeed));
    return;
  }
  // Orbit: a point ahead on the circle around the hero, above it and clear of what is below.
  const ang = Math.atan2(e.pos.z - h.pz, e.pos.x - h.px) + e.circleDir * 0.6;
  const r = st.orbitRadius + (e.circleR - 5);
  const gx = h.px + Math.cos(ang) * r,
    gz = h.pz + Math.sin(ang) * r;
  const ground = w.supportHeight(e.pos.x, e.pos.z, e.pos.y, 0).y;
  const gy = Math.max(h.py + st.orbitHeight + (e.circleR - 5) * 0.5, (ground > -1e9 ? ground : 0) + 3);
  if (e.state !== ES.CIRCLE) host.setState(e, ES.CIRCLE);
  flyTo(e, gx, gy, gz, st.speed);
  // Blocked view: climb over it.
  if (!e.los) e.wishY = Math.max(e.wishY, st.speed * 0.5);
  host.setAnim(e, ANIM.HOVER);
};

/** Desired flight velocity toward a point, slowing into it. */
function flyTo(e: SimEnemy, x: number, y: number, z: number, speed: number): void {
  const dx = x - e.pos.x,
    dy = y - e.pos.y,
    dz = z - e.pos.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < 0.05) return stand(e);
  const s = Math.min(speed, d * 1.6) / d;
  e.wishX = dx * s;
  e.wishY = dy * s;
  e.wishZ = dz * s;
}

/** Kinds without a brain yet (later chunks) stand still. */
export const thinkInert: Brain = (host, e) => {
  if (reactions(host, e)) return;
  stand(e);
};

/** Brain per enemy kind. */
export const BRAINS: readonly Brain[] = [
  thinkMelee, // THUG
  thinkMelee, // BAT
  thinkGunman, // GUNMAN
  thinkMelee, // BRUTE
  thinkDrone, // DRONE
  thinkInert, // KOCBASI (chunk 8)
  thinkInert, // KUZGUN (chunk 8)
  thinkInert, // DIKEN (chunk 8)
];
