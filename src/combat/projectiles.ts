import { PK } from './types';

/**
 * Enemy projectiles (pure, shared with the server): drone plasma bolts and
 * thrown bottles (boss darts in chunk 8). Each flies ballistically from its
 * launch state; the sim sweeps it every step against the world (raycast) and
 * the heroes' capsules (segment-to-segment distance). Gunmen do not use
 * these: their rounds are delayed hitscan (`CombatSim`).
 */

/** Gravity per projectile kind (m/s²): bolts and darts fly straight, bottles arc. */
export const PROJ_GRAVITY: readonly number[] = [0, 14, 0];
/** Collision radius per kind (m). */
export const PROJ_RADIUS: readonly number[] = [0.22, 0.14, 0.12];
/** Lifetime per kind (s). */
export const PROJ_LIFE: readonly number[] = [2.5, 3, 2.5];
export const MAX_PROJECTILES = 48;

export interface Projectile {
  id: number;
  kind: number;
  /** Shooter and target entity ids. */
  src: number;
  tgt: number;
  atk: number;
  dmg: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  born: number;
}

function makeProjectile(): Projectile {
  return { id: 0, kind: PK.BOLT, src: 0, tgt: -1, atk: 0, dmg: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, born: 0 };
}

/** Pooled projectiles; `list` holds the live ones in launch order (deterministic iteration). */
export class ProjectilePool {
  readonly list: Projectile[] = [];
  private readonly free: Projectile[] = [];
  private nextId = 1;

  constructor() {
    for (let i = 0; i < MAX_PROJECTILES; i++) this.free.push(makeProjectile());
  }

  /** A new projectile, or null when the pool is exhausted. */
  launch(kind: number, src: number, tgt: number, atk: number, dmg: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, now: number): Projectile | null {
    const p = this.free.pop();
    if (!p) return null;
    p.id = this.nextId;
    this.nextId = this.nextId >= 0xffff ? 1 : this.nextId + 1;
    p.kind = kind;
    p.src = src;
    p.tgt = tgt;
    p.atk = atk;
    p.dmg = dmg;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.born = now;
    this.list.push(p);
    return p;
  }

  /** Remove the live projectile at `index`. */
  remove(index: number): void {
    const p = this.list[index]!;
    this.list.splice(index, 1);
    this.free.push(p);
  }

  clear(): void {
    for (const p of this.list) this.free.push(p);
    this.list.length = 0;
  }
}

/**
 * Launch velocity for a projectile of `speed` toward (tx, ty, tz) from
 * (x, y, z) under `gravity`: straight for bolts; for an arc, the flight time
 * is the straight-line time and the vertical speed compensates the drop.
 * Writes into `out` and returns the flight time.
 */
export function aimVelocity(x: number, y: number, z: number, tx: number, ty: number, tz: number, speed: number, gravity: number, out: { x: number; y: number; z: number }): number {
  const dx = tx - x,
    dy = ty - y,
    dz = tz - z;
  const d = Math.hypot(dx, dy, dz) || 1;
  const t = Math.max(0.35, d / speed);
  out.x = dx / t;
  out.y = dy / t + 0.5 * gravity * t;
  out.z = dz / t;
  return t;
}

/**
 * Smallest distance between segments P0-P1 and Q0-Q1, and the parameter of
 * the closest point on P (written to `outS[0]`). Standard clamped solution.
 */
export function segmentDistance(
  p0x: number,
  p0y: number,
  p0z: number,
  p1x: number,
  p1y: number,
  p1z: number,
  q0x: number,
  q0y: number,
  q0z: number,
  q1x: number,
  q1y: number,
  q1z: number,
  outS: Float64Array,
): number {
  const ux = p1x - p0x,
    uy = p1y - p0y,
    uz = p1z - p0z;
  const vx = q1x - q0x,
    vy = q1y - q0y,
    vz = q1z - q0z;
  const wx = p0x - q0x,
    wy = p0y - q0y,
    wz = p0z - q0z;
  const a = ux * ux + uy * uy + uz * uz;
  const b = ux * vx + uy * vy + uz * vz;
  const c = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uy * wy + uz * wz;
  const e = vx * wx + vy * wy + vz * wz;
  const den = a * c - b * b;
  let s = 0,
    t = 0;
  if (a < 1e-12 && c < 1e-12) {
    s = 0;
    t = 0;
  } else if (a < 1e-12) {
    s = 0;
    t = Math.min(1, Math.max(0, e / c));
  } else if (c < 1e-12) {
    t = 0;
    s = Math.min(1, Math.max(0, -d / a));
  } else {
    s = den > 1e-12 ? Math.min(1, Math.max(0, (b * e - c * d) / den)) : 0;
    t = (b * s + e) / c;
    if (t < 0) {
      t = 0;
      s = Math.min(1, Math.max(0, -d / a));
    } else if (t > 1) {
      t = 1;
      s = Math.min(1, Math.max(0, (b - d) / a));
    }
  }
  outS[0] = s;
  const dx = wx + ux * s - vx * t,
    dy = wy + uy * s - vy * t,
    dz = wz + uz * s - vz * t;
  return Math.hypot(dx, dy, dz);
}
