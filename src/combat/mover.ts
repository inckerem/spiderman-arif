import type { Vector3 } from 'three';
import { tuning } from '../config/tuning';
import {
  clearContactSummary,
  F_CANOPY,
  F_LOW,
  F_PROP,
  F_TREE,
  makeContactSummary,
  makeRayHit,
  type CollisionWorld,
} from '../physics/collision';

/**
 * Enemy movement against the static collision world. Ground enemies are
 * upright capsules (feet origin) moved like the player: gravity, substeps of
 * at most 0.3 m, `gatherAabb` once per step and `resolveCapsule` per substep,
 * terrain last. No allocation per call.
 */

export interface MoveBody {
  pos: Vector3;
  vel: Vector3;
}

export interface MoveResult {
  grounded: boolean;
  wall: boolean;
  wallNX: number;
  wallNZ: number;
  maxDepth: number;
}

export function makeMoveResult(): MoveResult {
  return { grounded: false, wall: false, wallNX: 0, wallNZ: 0, maxDepth: 0 };
}

/** Colliders that never block an enemy's line of sight (thin props, trees, low obstacles). */
export const LOS_SKIP = F_PROP | F_TREE | F_CANOPY | F_LOW;

const MAX_SUB = 0.3;
const PROBE_LEN = 1.5;
const PROBE_COS = Math.cos(Math.PI / 6);
const PROBE_SIN = Math.sin(Math.PI / 6);
/** Drops deeper than this stop a walking enemy at the edge (roofs, piers, raised plazas). */
const EDGE_DROP = 1.0;
const SNAP_DOWN = 0.5;

export class GroundMover {
  private readonly cands = new Int32Array(1024);
  private readonly contact = makeContactSummary();
  private readonly ray = makeRayHit();
  /** Steering result of `steer`. */
  readonly steerOut = { x: 0, z: 0 };

  constructor(readonly world: CollisionWorld) {}

  /**
   * Wall probes: two rays at +-30 degrees around the desired direction (dx, dz
   * normalised), 1.5 m at knee height. When one hits a wall the direction
   * turns along the wall's tangent (the side closer to the desired one).
   * Writes a unit direction into `steerOut`.
   */
  steer(px: number, py: number, pz: number, dx: number, dz: number): { x: number; z: number } {
    const o = this.steerOut;
    o.x = dx;
    o.z = dz;
    const w = this.world;
    const y = py + 0.6;
    let nx = 0,
      nz = 0,
      hits = 0;
    for (let s = -1; s <= 1; s += 2) {
      const rx = dx * PROBE_COS - dz * PROBE_SIN * s,
        rz = dz * PROBE_COS + dx * PROBE_SIN * s;
      if (w.raycast(px, y, pz, rx, 0, rz, PROBE_LEN, this.ray, F_CANOPY, -1, 0, false) && Math.abs(this.ray.ny) < 0.5) {
        nx += this.ray.nx;
        nz += this.ray.nz;
        hits++;
      }
    }
    if (hits === 0) return o;
    const l = Math.hypot(nx, nz);
    if (l < 1e-4) return o;
    nx /= l;
    nz /= l;
    const into = dx * nx + dz * nz;
    if (into >= 0) return o;
    // Remove the part into the wall, keep sliding along it.
    let tx = dx - nx * into,
      tz = dz - nz * into;
    let tl = Math.hypot(tx, tz);
    if (tl < 0.2) {
      // Head-on: pick a tangent (deterministic side).
      tx = -nz;
      tz = nx;
      tl = 1;
    }
    o.x = tx / tl;
    o.z = tz / tl;
    return o;
  }

  /** True when the line between two points is clear of solid, sight-blocking geometry. */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax,
      dy = by - ay,
      dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-3) return true;
    return !this.world.raycast(ax, ay, az, dx / d, dy / d, dz / d, d, this.ray, LOS_SKIP, -1, 0, true);
  }

  /**
   * One step for an upright capsule: horizontal velocity eases toward
   * (wishVx, wishVz) at `accel` while grounded (momentum is kept in the air),
   * gravity, then resolution. `edgeGuard` keeps a walking enemy from stepping
   * off drops deeper than 1 m.
   */
  move(b: MoveBody, r: number, h: number, wishVx: number, wishVz: number, accel: number, dt: number, grounded: boolean, edgeGuard: boolean, out: MoveResult): void {
    const w = this.world;
    const p = b.pos,
      v = b.vel;
    if (grounded) {
      const ax = wishVx - v.x,
        az = wishVz - v.z;
      const al = Math.hypot(ax, az);
      const maxDv = accel * dt;
      if (al > maxDv) {
        v.x += (ax / al) * maxDv;
        v.z += (az / al) * maxDv;
      } else {
        v.x = wishVx;
        v.z = wishVz;
      }
      if (edgeGuard) {
        const sp = Math.hypot(v.x, v.z);
        if (sp > 0.05) {
          const fx = v.x / sp,
            fz = v.z / sp;
          const s = w.supportHeight(p.x + fx * (r + 0.45), p.z + fz * (r + 0.45), p.y + 0.5, 0);
          if (s.y < p.y - EDGE_DROP) {
            v.x = 0;
            v.z = 0;
          }
        }
      }
    }
    v.y -= tuning.enemies.gravity * dt;
    if (v.y < -60) v.y = -60;

    const dist = Math.hypot(v.x, v.y, v.z) * dt;
    const n = Math.max(1, Math.ceil(dist / MAX_SUB));
    const sdt = dt / n;
    const ex = Math.abs(v.x * dt) + r + 0.2,
      ez = Math.abs(v.z * dt) + r + 0.2;
    const nC = w.gatherAabb(p.x - ex, p.y + Math.min(0, v.y * dt) - 0.6, p.z - ez, p.x + ex, p.y + h + Math.max(0, v.y * dt) + 0.3, p.z + ez, this.cands);
    const c = this.contact;
    clearContactSummary(c);
    out.grounded = false;
    out.wall = false;
    out.maxDepth = 0;
    for (let i = 0; i < n; i++) {
      p.x += v.x * sdt;
      p.y += v.y * sdt;
      p.z += v.z * sdt;
      w.resolveCapsule(p, v, r, h, this.cands, nC, c);
    }
    out.grounded = c.ground;
    out.wall = c.wall;
    out.wallNX = c.wallNX;
    out.wallNZ = c.wallNZ;
    out.maxDepth = c.maxDepth;
    // Stay on the ground over small drops (curbs, step-downs) while walking.
    if (grounded && !c.ground && v.y <= 0) {
      const s = w.supportHeight(p.x, p.z, p.y + 0.05, r * 0.5);
      if (s.y > -Infinity && p.y - s.y <= SNAP_DOWN && w.capsuleFree(p.x, s.y + 0.01, p.z, r, h, 0)) {
        p.y = s.y;
        v.y = 0;
        out.grounded = true;
      }
    }
  }
}
