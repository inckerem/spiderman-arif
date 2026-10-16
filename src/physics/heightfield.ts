import { tuning } from '../config/tuning';
import type { Rect } from '../world/types';
import { SURF_CONCRETE, SURF_GRASS, SURF_STONE } from './collision';
import type { RectIndex, RoadIndex } from './roadIndex';
import { CURB, type TerrainHit, type TerrainModel } from './terrain';
import type { WaterMask } from './waterMask';

/** Heights baked on a regular grid (vertex values). */
export interface HeightGrid {
  x0: number;
  z0: number;
  /** Grid spacing (m). */
  cell: number;
  /** Cells per axis (vertices are one more). */
  nx: number;
  nz: number;
  /** Road level at each vertex, (nx + 1) * (nz + 1), row-major in z. */
  h: Float32Array;
}

const MIP = 8; // 8 cells of 2 m = 16 m

/**
 * Terrain over a baked road-level heightfield (bilinear between 2 m
 * vertices), land polygons for water and a road index for curbs. Rays clip
 * to the height slab, step through 16 m cells with the cell maxima to skip
 * empty air, march 1 m steps in candidate cells and bisect the crossing.
 */
export class HeightfieldTerrain implements TerrainModel {
  readonly flat = false;
  readonly minY: number;
  readonly maxY: number;
  readonly waterLevel = tuning.world.waterLevel;
  private readonly x0: number;
  private readonly z0: number;
  private readonly cs: number;
  private readonly inv: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly vx: number;
  private readonly h: Float32Array;
  /** Max height per 16 m cell. */
  private readonly mip: Float32Array;
  private readonly mnx: number;
  private readonly mnz: number;
  private readonly maxBase: number;
  private readonly minBase: number;
  private readonly shore = { x: 0, z: 0 };

  constructor(
    grid: HeightGrid,
    readonly water: WaterMask,
    readonly roads: RoadIndex,
    readonly parks: readonly Rect[] = [],
    /** Raised areas (blocks, plazas, parks) at the curb height; without it everything off the roads is. */
    readonly raised: RectIndex | null = null,
  ) {
    this.x0 = grid.x0;
    this.z0 = grid.z0;
    this.cs = grid.cell;
    this.inv = 1 / grid.cell;
    this.nx = grid.nx;
    this.nz = grid.nz;
    this.vx = grid.nx + 1;
    this.h = grid.h;
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < this.h.length; i++) {
      const v = this.h[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    this.minBase = lo;
    this.maxBase = hi;
    this.minY = lo;
    this.maxY = hi + CURB;
    this.mnx = Math.ceil(this.nx / MIP);
    this.mnz = Math.ceil(this.nz / MIP);
    this.mip = new Float32Array(this.mnx * this.mnz);
    for (let mz = 0; mz < this.mnz; mz++) {
      for (let mx = 0; mx < this.mnx; mx++) {
        let m = -Infinity;
        for (let j = mz * MIP; j <= Math.min(this.nz, (mz + 1) * MIP); j++) {
          for (let i = mx * MIP; i <= Math.min(this.nx, (mx + 1) * MIP); i++) {
            const v = this.h[j * this.vx + i]!;
            if (v > m) m = v;
          }
        }
        this.mip[mz * this.mnx + mx] = m;
      }
    }
  }

  /** Road level (bilinear; clamped at the grid edge). */
  baseHeight(x: number, z: number): number {
    let fx = (x - this.x0) * this.inv,
      fz = (z - this.z0) * this.inv;
    fx = fx < 0 ? 0 : fx > this.nx ? this.nx : fx;
    fz = fz < 0 ? 0 : fz > this.nz ? this.nz : fz;
    let i = Math.floor(fx),
      j = Math.floor(fz);
    if (i >= this.nx) i = this.nx - 1;
    if (j >= this.nz) j = this.nz - 1;
    const tx = fx - i,
      tz = fz - j;
    const o = j * this.vx + i;
    const h = this.h;
    const a = h[o]! + (h[o + 1]! - h[o]!) * tx;
    const b = h[o + this.vx]! + (h[o + this.vx + 1]! - h[o + this.vx]!) * tx;
    return a + (b - a) * tz;
  }

  height(x: number, z: number): number {
    if (this.water.isWater(x, z)) return -12;
    const b = this.baseHeight(x, z);
    if (this.raised) return this.raised.contains(x, z) ? b + CURB : b;
    return this.roads.isRoad(x, z) ? b : b + CURB;
  }

  isWater(x: number, z: number): boolean {
    return this.water.isWater(x, z);
  }

  waterLevelAt(_x: number, _z: number): number {
    return this.waterLevel;
  }

  isRoad(x: number, z: number): boolean {
    return this.roads.isRoad(x, z) && !this.water.isWater(x, z);
  }

  inPark(x: number, z: number): boolean {
    for (const p of this.parks) if (x > p.minX && x < p.maxX && z > p.minZ && z < p.maxZ) return true;
    return false;
  }

  surfaceAt(x: number, z: number): number {
    if (this.inPark(x, z)) return SURF_GRASS;
    return this.roads.isRoad(x, z) ? SURF_CONCRETE : SURF_STONE;
  }

  /** Road-level slope normal by central differences. */
  normalAt(x: number, z: number, out: { nx: number; ny: number; nz: number }): void {
    const e = this.cs * 0.5;
    const gx = (this.baseHeight(x + e, z) - this.baseHeight(x - e, z)) / (2 * e);
    const gz = (this.baseHeight(x, z + e) - this.baseHeight(x, z - e)) / (2 * e);
    const l = Math.sqrt(gx * gx + 1 + gz * gz);
    out.nx = -gx / l;
    out.ny = 1 / l;
    out.nz = -gz / l;
  }

  rayIntersect(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, inflate: number, out: TerrainHit): boolean {
    // Water surface (only from above).
    let tw = Infinity;
    if (dy < -1e-9) {
      const t = (this.waterLevel + inflate - oy) / dy;
      if (t >= 0 && t < maxT && this.water.isWater(ox + dx * t, oz + dz * t)) tw = t;
    }
    let tEnd = Math.min(maxT, tw);
    // Clip to the slab of possible ground heights.
    // The bottom is the water level: a low ray over water can still meet a
    // shore's side (the quay wall) before it reaches the surface. 5 cm margins
    // keep crossings right at the bounds inside the marched span.
    const top = this.maxBase + inflate + 0.05,
      bot = Math.min(this.minBase, this.waterLevel) + inflate - 0.05;
    let t0 = 0;
    if (dy < -1e-9) {
      if (oy > top) t0 = (top - oy) / dy;
      tEnd = Math.min(tEnd, (bot - oy) / dy);
    } else if (dy > 1e-9) {
      tEnd = Math.min(tEnd, (top - oy) / dy);
    } else if (oy > top) {
      tEnd = -1;
    }
    let tl = Infinity;
    if (t0 < tEnd) tl = this.marchLand(ox, oy, oz, dx, dy, dz, t0, tEnd, inflate);
    if (tl === Infinity && tw === Infinity) return false;
    if (tl <= tw) {
      out.t = tl;
      out.water = false;
      this.normalAt(ox + dx * tl, oz + dz * tl, out);
    } else {
      out.t = tw;
      out.water = true;
      out.nx = 0;
      out.ny = 1;
      out.nz = 0;
    }
    return true;
  }

  /** Signed height of the ray above the (inflated) road level at t; water counts as open air. */
  private gap(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, t: number, inflate: number): number {
    return oy + dy * t - inflate - this.baseHeight(ox + dx * t, oz + dz * t);
  }

  /** Inside the ground: under the (inflated) road level on land. */
  private solid(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, t: number, inflate: number): boolean {
    return this.gap(ox, oy, oz, dx, dy, dz, t, inflate) <= 0 && !this.water.isWater(ox + dx * t, oz + dz * t);
  }

  /** The way in (top surface or quay side) between lo (free) and hi (inside), 8 halvings. */
  private bisect(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, lo: number, hi: number, inflate: number): number {
    for (let b = 0; b < 8; b++) {
      const m = (lo + hi) * 0.5;
      if (this.solid(ox, oy, oz, dx, dy, dz, m, inflate)) hi = m;
      else lo = m;
    }
    return hi;
  }

  /** First crossing into the ground along [t0, t1]; Infinity when none. */
  private marchLand(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, t0: number, t1: number, inflate: number): number {
    const ms = this.cs * MIP;
    const gx0 = this.x0,
      gz0 = this.z0;
    let px = ox + dx * t0,
      pz = oz + dz * t0;
    let ix = Math.floor((px - gx0) / ms),
      iz = Math.floor((pz - gz0) / ms);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tdx = stepX !== 0 ? ms / Math.abs(dx) : Infinity;
    const tdz = stepZ !== 0 ? ms / Math.abs(dz) : Infinity;
    let tmx = stepX > 0 ? t0 + ((ix + 1) * ms + gx0 - px) / dx : stepX < 0 ? t0 + (ix * ms + gx0 - px) / dx : Infinity;
    let tmz = stepZ > 0 ? t0 + ((iz + 1) * ms + gz0 - pz) / dz : stepZ < 0 ? t0 + (iz * ms + gz0 - pz) / dz : Infinity;
    // Whether the previous sample was above the ground (rays that start inside never hit).
    let above = false,
      low = false,
      prevT = t0,
      started = false;
    let ta = t0;
    while (ta < t1) {
      const tb = Math.min(t1, tmx, tmz);
      // Cell maximum (outside the grid: the clamped edge cell).
      const cx = ix < 0 ? 0 : ix >= this.mnx ? this.mnx - 1 : ix;
      const cz = iz < 0 ? 0 : iz >= this.mnz ? this.mnz - 1 : iz;
      const cellMax = this.mip[cz * this.mnx + cx]! + inflate;
      const ya = oy + dy * ta,
        yb = oy + dy * tb;
      if ((ya < yb ? ya : yb) > cellMax) {
        above = true;
        low = false;
        started = true;
        prevT = tb;
      } else {
        const n = Math.max(1, Math.ceil(tb - ta));
        for (let k = started ? 1 : 0; k <= n; k++) {
          const t = ta + ((tb - ta) * k) / n;
          const g = this.gap(ox, oy, oz, dx, dy, dz, t, inflate);
          const wet = g <= 0 && this.water.isWater(ox + dx * t, oz + dz * t);
          // Under the quay level over water (now or at the last sample): a shore
          // corner can lie between two samples, so scan that step finely.
          if (above && (low || wet)) {
            for (let ft = prevT + 0.1; ft < t; ft += 0.1) {
              if (this.solid(ox, oy, oz, dx, dy, dz, ft, inflate)) return this.bisect(ox, oy, oz, dx, dy, dz, ft - 0.1, ft, inflate);
            }
          }
          low = wet;
          if (g > 0) above = true;
          else if (!wet && above) return this.bisect(ox, oy, oz, dx, dy, dz, prevT, t, inflate);
          prevT = t;
        }
        started = true;
      }
      ta = tb;
      if (tb >= t1) break;
      if (tmx < tmz) {
        tmx += tdx;
        ix += stepX;
      } else {
        tmz += tdz;
        iz += stepZ;
      }
      px = ox + dx * ta;
      pz = oz + dz * ta;
    }
    return Infinity;
  }

  /** The nearest shore point, then 8 m inland (onto the quay). */
  nearestLand(x: number, z: number, out: { x: number; z: number }): void {
    const s = this.shore;
    if (this.water.nearestShore(x, z, s) === Infinity) {
      out.x = x;
      out.z = z;
      return;
    }
    let ux = s.x - x,
      uz = s.z - z;
    const l = Math.hypot(ux, uz);
    if (l < 1e-6) {
      ux = 1;
      uz = 0;
    } else {
      ux /= l;
      uz /= l;
    }
    for (const d of [8, 4, 14, 22, -8]) {
      const tx = s.x + ux * d,
        tz = s.z + uz * d;
      if (!this.water.isWater(tx, tz)) {
        out.x = tx;
        out.z = tz;
        return;
      }
    }
    out.x = s.x;
    out.z = s.z;
  }
}
