import type { Rng } from '../../core/rng';
import { FlatGridTerrain, type TerrainModel } from '../../physics/terrain';
import type { CityLayout } from '../../world/types';
import { WP_PARK, WP_ROOF, WP_WATERFRONT, type MapDefinition, type RingRouteSpec, type Waypoint, type XZ } from '../types';
import { addManhattanColliders } from './colliders';
import { generateCity } from './gen';

/** Maximum points of an autopilot leg on the grid (with pond detours). */
const ROUTE_CAP = 7;

function waypoints(L: CityLayout, t: TerrainModel): Waypoint[] {
  const out: Waypoint[] = [];
  for (const b of L.buildings) {
    const v = b.volumes[b.volumes.length - 1]!;
    if (v.maxY < 22 || v.maxY > 170 || v.maxX - v.minX < 12 || v.maxZ - v.minZ < 12) continue;
    out.push({ x: (v.minX + v.maxX) / 2, z: (v.minZ + v.maxZ) / 2, kind: WP_ROOF, building: b.id, roofY: v.maxY });
  }
  const P = L.park;
  for (let x = P.minX + 30; x < P.maxX - 20; x += 60) {
    for (let z = P.minZ + 30; z < P.maxZ - 20; z += 60) {
      // Not on or near the pond (nothing to swing from above the water).
      const pd = L.pond;
      const nearPond = ((x - pd.cx) / (pd.rx + 40)) ** 2 + ((z - pd.cz) / (pd.rz + 40)) ** 2 < 1;
      if (!t.isWater(x, z) && !nearPond) out.push({ x, z, kind: WP_PARK, building: -1, roofY: 0 });
    }
  }
  // The waterfront: a ring 45 m inside the island's edge.
  const R = L.land;
  const inset = 45;
  const add = (x: number, z: number): void => {
    if (!t.isWater(x, z)) out.push({ x, z, kind: WP_WATERFRONT, building: -1, roofY: 0 });
  };
  for (let x = R.minX + inset; x <= R.maxX - inset; x += 90) {
    add(x, R.minZ + inset);
    add(x, R.maxZ - inset);
  }
  for (let z = R.minZ + inset + 90; z <= R.maxZ - inset - 90; z += 90) {
    add(R.minX + inset, z);
    add(R.maxX - inset, z);
  }
  return out;
}

/**
 * Route to the goal along the grid: over to the nearest avenue, along it to
 * the street nearest the goal and along that street (or streets first),
 * then in to the goal. Street canyons have anchors on both sides; the
 * waterfront drive is left out (water on one side).
 */
function route(L: CityLayout, px: number, pz: number, gx: number, gz: number, avenueFirst: boolean, out: XZ[]): number {
  const near = (roads: CityLayout['avenues'], v: number): number => {
    let best = v,
      bd = Infinity;
    for (const r of roads) {
      if (r.perimeter) continue;
      const d = Math.abs(r.center - v);
      if (d < bd) {
        bd = d;
        best = r.center;
      }
    }
    return best;
  };
  let n = 0;
  const put = (x: number, z: number): void => {
    const prev = n > 0 ? out[n - 1]! : null;
    if (prev && Math.hypot(prev[0] - x, prev[1] - z) < 12) return;
    out[n]![0] = x;
    out[n]![1] = z;
    n++;
  };
  put(px, pz);
  if (avenueFirst) {
    const ax = near(L.avenues, px),
      sz = near(L.streets, gz);
    put(ax, pz);
    put(ax, sz);
    put(gx, sz);
  } else {
    const sz = near(L.streets, pz),
      ax = near(L.avenues, gx);
    put(px, sz);
    put(ax, sz);
    put(ax, gz);
  }
  put(gx, gz);
  if (n < 2) {
    out[1]![0] = gx + 1;
    out[1]![1] = gz;
    n = 2;
  }
  return avoidPond(L, out, n);
}

/**
 * The park pond has nothing to swing from above it: a leg that would cross
 * it (with a margin) goes around its nearer side instead.
 */
function avoidPond(L: CityLayout, route: XZ[], routeN: number): number {
  const pd = L.pond;
  const cap = Math.min(ROUTE_CAP, route.length);
  const rx = pd.rx + 30,
    rz = pd.rz + 30;
  const inside = (x: number, z: number): boolean => ((x - pd.cx) / rx) ** 2 + ((z - pd.cz) / rz) ** 2 < 1;
  for (let i = 0; i + 1 < routeN && routeN < cap; i++) {
    const a = route[i]!,
      b = route[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let hit = false;
    for (let k = 1, steps = Math.max(2, Math.ceil(len / 10)); k < steps && !hit; k++) {
      const t = k / steps;
      hit = inside(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
    }
    if (!hit) continue;
    // Around the side that keeps the leg shortest: east or west for a north-south leg, else north or south.
    const ns = Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]);
    let bx = 0,
      bz = 0,
      best = Infinity;
    for (const sgn of [-1, 1]) {
      const x = ns ? pd.cx + sgn * (rx + 15) : (a[0] + b[0]) / 2;
      const z = ns ? (a[1] + b[1]) / 2 : pd.cz + sgn * (rz + 15);
      const d = Math.hypot(x - a[0], z - a[1]) + Math.hypot(b[0] - x, b[1] - z);
      if (d < best) {
        best = d;
        bx = x;
        bz = z;
      }
    }
    for (let j = routeN; j > i + 1; j--) {
      route[j]![0] = route[j - 1]![0];
      route[j]![1] = route[j - 1]![1];
    }
    route[i + 1]![0] = bx;
    route[i + 1]![1] = bz;
    routeN++;
    i++;
  }
  return routeN;
}

function ringRoutes(L: CityLayout): RingRouteSpec[] {
  const out: RingRouteSpec[] = [];
  // Park: south edge to north edge, skirting the pond; each ring sits in a
  // gap between canopies with tall trees ahead to swing from.
  {
    const P = L.park;
    const pd = L.pond;
    const cx = (P.minX + P.maxX) / 2;
    const side = pd.cx - pd.rx - P.minX > P.maxX - (pd.cx + pd.rx) ? (P.minX + pd.cx - pd.rx) / 2 : (P.maxX + pd.cx + pd.rx) / 2;
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i < 7; i++) {
      const u = i / 6;
      const z = P.maxZ - 14 - u * (P.maxZ - P.minZ - 28);
      const x = i === 0 || i === 6 ? cx : side + Math.sin(i * 1.7) * 18;
      pts.push([x, 9 + (i % 2) * 2, z]);
    }
    out.push({ id: 'park', pts });
  }
  // Downtown towers: along the avenue through the tallest buildings.
  {
    const tall = [...L.buildings].sort((a, b) => b.height - a.height).slice(0, 16);
    let bx = 0,
      bz = 0;
    for (const b of tall) {
      bx += (b.footprint.minX + b.footprint.maxX) / 2;
      bz += (b.footprint.minZ + b.footprint.maxZ) / 2;
    }
    bx /= tall.length;
    bz /= tall.length;
    let ave = L.avenues[0]!;
    for (const a of L.avenues) if (!a.perimeter && Math.abs(a.center - bx) < Math.abs(ave.center - bx)) ave = a;
    const zMax = Math.min(L.land.maxZ - 80, bz + 240),
      zMin = Math.max(L.land.minZ + 80, zMax - 480);
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i < 7; i++) {
      const z = zMax - (i / 6) * (zMax - zMin);
      pts.push([ave.center + (i % 2 === 0 ? -3 : 3), 34 + (i % 3) * 12, z]);
    }
    out.push({ id: 'downtown', pts });
  }
  // Waterfront: along the east promenade toward the bridge.
  {
    // Over the waterfront drive, between the last row of buildings and the promenade.
    const edge = L.avenues[L.avenues.length - 1]!;
    const x = edge.center;
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i < 5; i++) pts.push([x, 10 + (i % 2) * 3, -420 + i * 80]);
    const deck = L.bridge.deck;
    const tower = L.bridge.towers[0];
    pts.push([tower ? tower.minX - 14 : deck.minX + 40, deck.maxY + 9, (deck.minZ + deck.maxZ) / 2]);
    out.push({ id: 'waterfront', pts });
  }
  return out;
}

export const MANHATTAN: MapDefinition = {
  id: 'manhattan',
  defaultSeed: 1337,
  collisionExtent: { minX: -1300, minZ: -1150, maxX: 1300, maxZ: 1150 },
  generate: generateCity,
  createTerrain: (L) => new FlatGridTerrain(L),
  addColliders: addManhattanColliders,
  testSpots: {
    // Street level anywhere on the island.
    street: (rng: Rng, L: CityLayout) => [rng.range(L.land.minX + 10, L.land.maxX - 10), 0.5, rng.range(L.land.minZ + 10, L.land.maxZ - 10)],
    park: (rng: Rng, L: CityLayout) => [rng.range(L.park.minX + 5, L.park.maxX - 5), 0.5, rng.range(L.park.minZ + 5, L.park.maxZ - 5)],
  },
  routes: {
    // South-west corner to north-east corner along avenues and streets.
    city: (L) => {
      const westAve = L.avenues[1]!.center;
      const northSt = L.streets[1]!.center;
      const southSt = L.streets[L.streets.length - 2]!.center;
      const eastAve = L.avenues[L.avenues.length - 2]!.center;
      return [
        [westAve, southSt + 5],
        [westAve, northSt],
        [eastAve, northSt],
      ];
    },
    // South edge to north edge, skirting the pond on its wider side.
    park: (L) => {
      const P = L.park;
      const pond = L.pond;
      const westRoom = pond.cx - pond.rx - P.minX;
      const eastRoom = P.maxX - (pond.cx + pond.rx);
      const sideX = westRoom > eastRoom ? (P.minX + pond.cx - pond.rx) / 2 : (P.maxX + pond.cx + pond.rx) / 2;
      return [
        [(P.minX + P.maxX) / 2, P.maxZ - 12],
        [sideX, pond.cz + pond.rz + 20],
        [sideX, pond.cz - pond.rz - 20],
        [(P.minX + P.maxX) / 2, P.minZ + 12],
      ];
    },
    expect: { minDistance: 1800, treeOnlyPark: true },
  },
  autopilot: { waypoints, route },
  ringRoutes,
};
