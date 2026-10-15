import type { Vector3 } from 'three';
import { tuning } from '../config/tuning';
import { F_BUILDING, type CollisionWorld } from './collision';
import type { CityLayout } from '../world/types';

/**
 * Free standing spots for teleports: recovery, water and combat respawns.
 * Pure (no rendering), shared by the player and the combat sim (also on the
 * Node server).
 */

const SAFE_RADII = [0.8, 1.6, 2.5, 4, 6, 9, 13, 18, 25, 35, 50, 70];

/**
 * Nearest free standing position for an upright capsule around (x, y, z):
 * first straight below, then rings of 16 points at growing radii, each tried
 * at the reference height and up to 40 m above it.
 */
export function findSafeSpot(
  w: CollisionWorld,
  x: number,
  y: number,
  z: number,
  out: Vector3,
  r = tuning.body.radius,
  h = tuning.body.height,
): boolean {
  const tryAt = (cx: number, cz: number, maxY: number): boolean => {
    const s = w.supportHeight(cx, cz, maxY, 0);
    if (s.y === -Infinity) return false;
    if (!w.capsuleFree(cx, s.y + 0.02, cz, r + 0.05, h)) return false;
    out.set(cx, s.y + 0.02, cz);
    return true;
  };
  if (tryAt(x, z, y + 1.5)) return true;
  for (const rad of SAFE_RADII) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const cx = x + Math.cos(a) * rad,
        cz = z + Math.sin(a) * rad;
      if (tryAt(cx, cz, y + 1.5)) return true;
      if (tryAt(cx, cz, y + 40)) return true;
    }
  }
  return false;
}

export interface RespawnRoofOptions {
  /** Distance ring around (x, z). Defaults: `tuning.combat.respawnRoofMin/Max`. */
  minDist?: number;
  maxDist?: number;
  /** Roof height band. Defaults: `tuning.combat.respawnRoofMinY/MaxY`. */
  minY?: number;
  maxY?: number;
  /** Return true for spots that must not be used (inside an active arena). */
  avoid?: (x: number, z: number) => boolean;
}

/** Sample offsets inside a roof (fractions of the half extents): centre first. */
const ROOF_SAMPLES: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.45, 0],
  [-0.45, 0],
  [0, 0.45],
  [0, -0.45],
  [0.45, 0.45],
  [-0.45, -0.45],
  [0.45, -0.45],
  [-0.45, 0.45],
];

/**
 * A free spot on a building roof in a ring around (x, z), for the hero's
 * combat respawn. Roofs are building volume tops in the height band; the
 * nearest qualifying roof wins (ties by layout order, so it is deterministic).
 * The spot stands on a building collider, has room for the hero capsule and
 * is not rejected by `avoid`. Widens the ring once (x2) before giving up.
 */
export function findRespawnRoof(
  w: CollisionWorld,
  layout: CityLayout,
  x: number,
  z: number,
  out: Vector3,
  opts: RespawnRoofOptions = {},
): boolean {
  const c = tuning.combat;
  const minD = opts.minDist ?? c.respawnRoofMin;
  const maxD = opts.maxDist ?? c.respawnRoofMax;
  const minY = opts.minY ?? c.respawnRoofMinY;
  const maxY = opts.maxY ?? c.respawnRoofMaxY;
  const r = tuning.body.radius,
    h = tuning.body.height;
  for (let pass = 0; pass < 2; pass++) {
    const hi = pass === 0 ? maxD : maxD * 2;
    const cands: Array<{ d: number; minX: number; maxX: number; minZ: number; maxZ: number; top: number }> = [];
    for (const b of layout.buildings) {
      for (const v of b.volumes) {
        if (v.maxY < minY || v.maxY > maxY) continue;
        if (v.maxX - v.minX < 4 || v.maxZ - v.minZ < 4) continue;
        const cx = (v.minX + v.maxX) / 2,
          cz = (v.minZ + v.maxZ) / 2;
        const d = Math.hypot(cx - x, cz - z);
        if (d < minD || d > hi) continue;
        cands.push({ d, minX: v.minX, maxX: v.maxX, minZ: v.minZ, maxZ: v.maxZ, top: v.maxY });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    for (const v of cands) {
      const cx = (v.minX + v.maxX) / 2,
        cz = (v.minZ + v.maxZ) / 2;
      const hx = (v.maxX - v.minX) / 2 - 1.2,
        hz = (v.maxZ - v.minZ) / 2 - 1.2;
      for (const [fx, fz] of ROOF_SAMPLES) {
        const px = cx + fx * 2 * hx,
          pz = cz + fz * 2 * hz;
        const s = w.supportHeight(px, pz, v.top + 1, 0);
        if (s.id < 0 || (w.flags[s.id]! & F_BUILDING) === 0) continue;
        if (s.y < minY || s.y < v.top - 0.5) continue;
        if (opts.avoid?.(px, pz)) continue;
        if (!w.capsuleFree(px, s.y + 0.02, pz, r + 0.05, h)) continue;
        out.set(px, s.y + 0.02, pz);
        return true;
      }
    }
  }
  return false;
}
