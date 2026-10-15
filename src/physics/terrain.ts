import type { CityLayout, Road } from '../world/types';
import { SURF_CONCRETE, SURF_GRASS } from './collision';
import { tuning } from '../config/tuning';
import { clamp } from '../core/math';

export const CURB = 0.15;

/** Where a ray meets the terrain or the water surface. */
export interface TerrainHit {
  t: number;
  /** True when the ray met the water surface first. */
  water: boolean;
  nx: number;
  ny: number;
  nz: number;
}

/**
 * Ground and water of a map, independent of the colliders: a flat grid
 * (Manhattan) or a heightfield over land polygons (Istanbul).
 */
export interface TerrainModel {
  /** True when the road level is the constant 0 everywhere. */
  readonly flat: boolean;
  /** Lowest and highest walkable ground (sidewalks included). */
  readonly minY: number;
  readonly maxY: number;
  /** Road level at (x, z) (0 everywhere on a flat map). */
  baseHeight(x: number, z: number): number;
  /** Walkable ground: the road level on roads, plus the curb elsewhere; the sea bed over water. */
  height(x: number, z: number): number;
  isWater(x: number, z: number): boolean;
  waterLevelAt(x: number, z: number): number;
  isRoad(x: number, z: number): boolean;
  surfaceAt(x: number, z: number): number;
  inPark(x: number, z: number): boolean;
  /**
   * First terrain or water hit along a normalised ray before `maxT`
   * (`inflate` lifts the surfaces for sphere casts). Writes `out`; false when nothing is hit.
   */
  rayIntersect(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, inflate: number, out: TerrainHit): boolean;
  /** Nearest dry spot to respawn on after a fall into water. */
  nearestLand(x: number, z: number, out: { x: number; z: number }): void;
}

export function makeTerrainHit(): TerrainHit {
  return { t: 0, water: false, nx: 0, ny: 1, nz: 0 };
}

/**
 * Flat grid terrain (Manhattan): roads at y = 0, blocks, sidewalks, plazas,
 * park and promenade at the curb height, water outside the island and in the
 * pond. Analytic, so it never tunnels and costs a couple of binary searches.
 */
export class FlatGridTerrain implements TerrainModel {
  readonly roadHeight = 0;
  readonly flat = true;
  readonly minY = 0;
  readonly maxY = CURB;
  private avX0: Float64Array;
  private avX1: Float64Array;
  private stZ0: Float64Array;
  private stZ1: Float64Array;

  constructor(private readonly layout: CityLayout) {
    const toArrays = (roads: Road[]): [Float64Array, Float64Array] => {
      const a = new Float64Array(roads.length);
      const b = new Float64Array(roads.length);
      roads.forEach((r, i) => {
        a[i] = r.center - r.width / 2;
        b[i] = r.center + r.width / 2;
      });
      return [a, b];
    };
    [this.avX0, this.avX1] = toArrays(layout.avenues);
    [this.stZ0, this.stZ1] = toArrays(layout.streets);
  }

  private static inStrips(v: number, lo: Float64Array, hi: Float64Array): boolean {
    // Binary search the last strip whose start <= v.
    let a = 0,
      b = lo.length - 1,
      idx = -1;
    while (a <= b) {
      const m = (a + b) >> 1;
      if (lo[m]! <= v) {
        idx = m;
        a = m + 1;
      } else b = m - 1;
    }
    return idx >= 0 && v <= hi[idx]!;
  }

  inPond(x: number, z: number): boolean {
    const p = this.layout.pond;
    const dx = (x - p.cx) / p.rx,
      dz = (z - p.cz) / p.rz;
    return dx * dx + dz * dz < 1;
  }

  inPark(x: number, z: number): boolean {
    const p = this.layout.park;
    return x > p.minX && x < p.maxX && z > p.minZ && z < p.maxZ;
  }

  onLand(x: number, z: number): boolean {
    const l = this.layout.land;
    if (x >= l.minX && x <= l.maxX && z >= l.minZ && z <= l.maxZ) return true;
    const i = this.layout.islet;
    return x >= i.minX && x <= i.maxX && z >= i.minZ && z <= i.maxZ;
  }

  isWater(x: number, z: number): boolean {
    if (!this.onLand(x, z)) return true;
    return this.inPark(x, z) && this.inPond(x, z);
  }

  waterLevelAt(x: number, z: number): number {
    if (this.onLand(x, z) && this.inPark(x, z) && this.inPond(x, z)) return this.layout.pond.level;
    return tuning.world.waterLevel;
  }

  isRoad(x: number, z: number): boolean {
    const l = this.layout.land;
    if (x < l.minX || x > l.maxX || z < l.minZ || z > l.maxZ) return false;
    if (this.inPark(x, z)) return false;
    return FlatGridTerrain.inStrips(x, this.avX0, this.avX1) || FlatGridTerrain.inStrips(z, this.stZ0, this.stZ1);
  }

  /** Ground surface height (valid on land; over water returns the bed height). */
  height(x: number, z: number): number {
    if (!this.onLand(x, z)) return -12;
    if (this.isRoad(x, z)) return 0;
    return CURB;
  }

  surfaceAt(x: number, z: number): number {
    if (this.inPark(x, z)) return SURF_GRASS;
    return SURF_CONCRETE;
  }

  baseHeight(_x: number, _z: number): number {
    return 0;
  }

  /** Downward rays only: the land plane at the road height, else the water level where the ray meets it. */
  rayIntersect(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, inflate: number, out: TerrainHit): boolean {
    if (!(dy < -1e-9)) return false;
    // Try the land plane first, then water level at the hit location.
    const tg = (this.roadHeight + inflate - oy) / dy;
    if (tg >= 0 && tg < maxT) {
      const hx = ox + dx * tg,
        hz = oz + dz * tg;
      if (!this.isWater(hx, hz)) {
        out.t = tg;
        out.water = false;
        out.nx = 0;
        out.ny = 1;
        out.nz = 0;
        return true;
      }
      const tw = (this.waterLevelAt(hx, hz) + inflate - oy) / dy;
      if (tw >= 0 && tw < maxT) {
        out.t = tw;
        out.water = true;
        out.nx = 0;
        out.ny = 1;
        out.nz = 0;
        return true;
      }
    }
    return false;
  }

  /** Off the pond bank, or the nearest point of the island promenade (or the islet). */
  nearestLand(x: number, z: number, out: { x: number; z: number }): void {
    const L = this.layout;
    if (this.inPark(x, z) && this.inPond(x, z)) {
      const pd = L.pond;
      const dx = (x - pd.cx) / pd.rx,
        dz = (z - pd.cz) / pd.rz;
      const k = Math.hypot(dx, dz) || 1;
      out.x = pd.cx + (dx / k) * (pd.rx + 5);
      out.z = pd.cz + (dz / k) * (pd.rz + 5);
      return;
    }
    const isl = L.islet;
    const dIslet = Math.hypot(Math.max(isl.minX - x, 0, x - isl.maxX), Math.max(isl.minZ - z, 0, z - isl.maxZ));
    const land = L.land;
    const dLand = Math.hypot(Math.max(land.minX - x, 0, x - land.maxX), Math.max(land.minZ - z, 0, z - land.maxZ));
    const r = dIslet < dLand ? isl : land;
    out.x = clamp(x, r.minX + 6, r.maxX - 6);
    out.z = clamp(z, r.minZ + 6, r.maxZ - 6);
  }
}
