import type { Rng } from '../../core/rng';
import type { TerrainModel } from '../../physics/terrain';
import type { CityLayout } from '../../world/types';
import { WP_PARK, WP_ROOF, WP_WATERFRONT, type MapDefinition, type Waypoint, type XZ } from '../types';
import { IST_EXTENT, PENINSULA, EUROPE_N, ASIA } from './data';
import { generateIstanbul, istanbulParts, istanbulTerrain } from './gen';
import { addPartColliders } from '../common/prims';

/** Point-in-polygon (even-odd). */
function inPoly(p: ReadonlyArray<readonly [number, number]>, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, zi] = p[i]!;
    const [xj, zj] = p[j]!;
    if (zi > z !== zj > z && x < xi + ((z - zi) * (xj - xi)) / (zj - zi)) inside = !inside;
  }
  return inside;
}

/** 0 historic peninsula, 1 European north, 2 Asian shore, -1 water. */
function landmass(x: number, z: number): number {
  if (inPoly(PENINSULA, x, z)) return 0;
  if (inPoly(EUROPE_N, x, z)) return 1;
  if (inPoly(ASIA, x, z)) return 2;
  return -1;
}

function waypoints(L: CityLayout, t: TerrainModel): Waypoint[] {
  const out: Waypoint[] = [];
  for (const b of L.buildings) {
    const v = b.volumes[b.volumes.length - 1]!;
    const ground = b.plinth ? b.plinth.minY + 1 : b.volumes[0]!.minY;
    if (v.maxY - ground < 14 || v.maxY - ground > 170 || v.maxX - v.minX < 12 || v.maxZ - v.minZ < 12) continue;
    out.push({ x: (v.minX + v.maxX) / 2, z: (v.minZ + v.maxZ) / 2, kind: WP_ROOF, building: b.id, roofY: v.maxY });
  }
  for (const p of L.parks ?? []) {
    for (let x = p.minX + 20; x < p.maxX - 10; x += 45) {
      for (let z = p.minZ + 20; z < p.maxZ - 10; z += 45) if (!t.isWater(x, z)) out.push({ x, z, kind: WP_PARK, building: -1, roofY: 0 });
    }
  }
  // The shore roads every 90 m.
  for (const r of L.roads ?? []) {
    if (r.cls !== 3) continue;
    let carry = 45;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i]!;
      const [bx, bz] = r.pts[i + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      let s = carry;
      while (s < len) {
        const x = ax + ((bx - ax) * s) / len,
          z = az + ((bz - az) * s) / len;
        if (!t.isWater(x, z)) out.push({ x, z, kind: WP_WATERFRONT, building: -1, roofY: 0 });
        s += 90;
      }
      carry = s - len;
    }
  }
  return out;
}

/**
 * Autopilot legs: straight, except that a leg between the peninsula and the
 * north crosses the Golden Horn on the Haliç Metro Bridge, and a leg to or
 * from the Asian shore crosses on the 15 Temmuz Bridge.
 */
function route(_L: CityLayout, ax: number, az: number, bx: number, bz: number, _variant: boolean, out: XZ[]): number {
  let n = 0;
  const put = (x: number, z: number): void => {
    if (n >= out.length) return;
    out[n]![0] = x;
    out[n]![1] = z;
    n++;
  };
  put(ax, az);
  const ma = landmass(ax, az),
    mb = landmass(bx, bz);
  if (ma >= 0 && mb >= 0 && ma !== mb) {
    if (ma === 2 || mb === 2) {
      // 15 Temmuz: west bank (x 420) <-> east bank (x 890) at z = -740.
      const westFirst = ma !== 2;
      if (westFirst && ma === 0) put(-275, 60), put(-275, -150);
      put(westFirst ? 420 : 890, -740);
      put(westFirst ? 890 : 420, -740);
      if (!westFirst && mb === 0) put(-275, -150), put(-275, 60);
    } else if (ma === 0) {
      put(-275, 60);
      put(-275, -150);
    } else {
      put(-275, -150);
      put(-275, 60);
    }
  }
  put(bx, bz);
  return n;
}

export const ISTANBUL: MapDefinition = {
  id: 'istanbul',
  defaultSeed: 1337,
  collisionExtent: IST_EXTENT,
  generate: generateIstanbul,
  createTerrain: istanbulTerrain,
  addColliders: (w, L) => addPartColliders(w, istanbulParts(L)),
  testSpots: {
    // Anywhere on land inside the core bounds, at street level.
    street: (rng: Rng, L: CityLayout, t: TerrainModel) => {
      const b = L.bounds;
      let x = 0,
        z = 0;
      for (let k = 0; k < 40; k++) {
        x = rng.range(b.minX + 60, b.maxX - 60);
        z = rng.range(b.minZ + 60, b.maxZ - 60);
        if (!t.isWater(x, z)) break;
      }
      return [x, t.height(x, z) + 0.5, z];
    },
    // Area-weighted over the parks.
    park: (rng: Rng, L: CityLayout) => {
      const parks = L.parks ?? [L.park];
      let total = 0;
      for (const p of parks) total += (p.maxX - p.minX) * (p.maxZ - p.minZ);
      let pick = rng.float() * total;
      let p = parks[0]!;
      for (const q of parks) {
        pick -= (q.maxX - q.minX) * (q.maxZ - q.minZ);
        if (pick <= 0) {
          p = q;
          break;
        }
      }
      const x = rng.range(p.minX + 5, p.maxX - 5),
        z = rng.range(p.minZ + 5, p.maxZ - 5);
      return [x, istanbulTerrain(L).height(x, z) + 0.5, z];
    },
  },
  routes: {
    // Blue Mosque, Süleymaniye, over the Haliç Metro Bridge, Şişhane, Galata Tower, İstiklal, Taksim, Levent.
    city: () => [
      [60, 470],
      [-300, 120],
      [-275, 52],
      [-275, -128],
      [-150, -250],
      [40, -300],
      [70, -560],
      [100, -700],
      [100, -900],
    ],
    // Gülhane to Sarayburnu, tree to tree.
    park: () => [
      [140, 160],
      [305, 160],
      [318, 235],
    ],
    expect: { minDistance: 1650, treeOnlyPark: true },
  },
  autopilot: { waypoints, route },
  ringRoutes: () => [],
};
