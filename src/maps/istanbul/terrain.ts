import { edt2d } from '../../core/edt';
import { smoothstep } from '../../core/math';
import type { HeightGrid } from '../../physics/heightfield';
import type { WaterMask } from '../../physics/waterMask';
import type { Rect } from '../../world/types';
import { HILLS, MAX_SLOPE, QUAY, SHORE_RISE } from './data';

/** Grid spacing of the baked heightfield (m). */
export const HEIGHT_CELL = 2;

/**
 * Bakes the road-level heights: the hills (max of the plateau bumps) fade
 * in from the quay with the distance to the shore (an exact distance
 * transform of the water mask on the grid), then a slope limiter keeps
 * every land slope at or under MAX_SLOPE. Water vertices stay at 0.
 */
export function bakeIstanbulHeights(mask: WaterMask, extent: Rect): HeightGrid & { wet: Uint8Array; shore: Float32Array } {
  const cell = HEIGHT_CELL;
  const nx = Math.ceil((extent.maxX - extent.minX) / cell);
  const nz = Math.ceil((extent.maxZ - extent.minZ) / cell);
  const vx = nx + 1,
    vz = nz + 1;
  const n = vx * vz;
  const wet = new Uint8Array(n);
  for (let j = 0; j < vz; j++) {
    const z = extent.minZ + j * cell;
    for (let i = 0; i < vx; i++) wet[j * vx + i] = mask.isWater(extent.minX + i * cell, z) ? 1 : 0;
  }
  const shore = distanceField(wet, vx, vz, cell, extent, []);
  const d2 = shore;
  const h = new Float32Array(n);
  for (let j = 0; j < vz; j++) {
    const z = extent.minZ + j * cell;
    for (let i = 0; i < vx; i++) {
      const k = j * vx + i;
      if (wet[k]) continue;
      const x = extent.minX + i * cell;
      // Distance to the shore: half a cell less than to the nearest water vertex.
      const ds = Math.max(0, d2[k]! - cell * 0.5);
      const f = smoothstep(QUAY, SHORE_RISE, ds);
      if (f <= 0) continue;
      let m = 0;
      for (const hl of HILLS) {
        const rx = (x - hl.cx) / hl.rx,
          rz = (z - hl.cz) / hl.rz;
        const r = Math.sqrt(rx * rx + rz * rz);
        if (r >= 1) continue;
        const v = hl.h * (1 - smoothstep(hl.p, 1, r));
        if (v > m) m = v;
      }
      h[k] = f * m;
    }
  }
  limitSlope(h, vx, vz, cell, MAX_SLOPE * 0.9);
  return { x0: extent.minX, z0: extent.minZ, cell, nx, nz, h, wet, shore };
}

/**
 * Distance (m) from every grid vertex to the nearest water vertex or to any
 * of `rects` (exact Euclidean distance transform on the vertex grid).
 */
export function distanceField(wet: Uint8Array, vx: number, vz: number, cell: number, extent: Rect, rects: readonly Rect[]): Float32Array {
  const f = new Float32Array(vx * vz);
  for (let k = 0; k < f.length; k++) f[k] = wet[k] ? 0 : 1e20;
  for (const r of rects) {
    const i0 = Math.max(0, Math.ceil((r.minX - extent.minX) / cell)),
      i1 = Math.min(vx - 1, Math.floor((r.maxX - extent.minX) / cell));
    const j0 = Math.max(0, Math.ceil((r.minZ - extent.minZ) / cell)),
      j1 = Math.min(vz - 1, Math.floor((r.maxZ - extent.minZ) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f[j * vx + i] = 0;
  }
  edt2d(f, vx, vz);
  for (let k = 0; k < f.length; k++) f[k] = Math.sqrt(f[k]!) * cell;
  return f;
}

/**
 * Lowers vertices so no neighbour step (8 directions) is steeper than `s`:
 * a min-plus chamfer pass forward and backward, twice.
 */
function limitSlope(h: Float32Array, vx: number, vz: number, cell: number, s: number): void {
  const a = s * cell,
    b = s * cell * Math.SQRT2;
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < vz; j++) {
      for (let i = 0; i < vx; i++) {
        const k = j * vx + i;
        let v = h[k]!;
        if (i > 0) v = Math.min(v, h[k - 1]! + a);
        if (j > 0) {
          v = Math.min(v, h[k - vx]! + a);
          if (i > 0) v = Math.min(v, h[k - vx - 1]! + b);
          if (i < vx - 1) v = Math.min(v, h[k - vx + 1]! + b);
        }
        h[k] = v;
      }
    }
    for (let j = vz - 1; j >= 0; j--) {
      for (let i = vx - 1; i >= 0; i--) {
        const k = j * vx + i;
        let v = h[k]!;
        if (i < vx - 1) v = Math.min(v, h[k + 1]! + a);
        if (j < vz - 1) {
          v = Math.min(v, h[k + vx]! + a);
          if (i < vx - 1) v = Math.min(v, h[k + vx + 1]! + b);
          if (i > 0) v = Math.min(v, h[k + vx - 1]! + b);
        }
        h[k] = v;
      }
    }
  }
}

/** Steepest land slope by central differences over the grid (ignores vertices next to water). */
export function maxLandSlope(g: HeightGrid, isWaterVertex: (i: number, j: number) => boolean): number {
  const vx = g.nx + 1;
  let m = 0;
  for (let j = 1; j < g.nz; j++) {
    for (let i = 1; i < g.nx; i++) {
      if (isWaterVertex(i, j) || isWaterVertex(i - 1, j) || isWaterVertex(i + 1, j) || isWaterVertex(i, j - 1) || isWaterVertex(i, j + 1)) continue;
      const k = j * vx + i;
      const gx = (g.h[k + 1]! - g.h[k - 1]!) / (2 * g.cell);
      const gz = (g.h[k + vx]! - g.h[k - vx]!) / (2 * g.cell);
      const s = Math.hypot(gx, gz);
      if (s > m) m = s;
    }
  }
  return m;
}
