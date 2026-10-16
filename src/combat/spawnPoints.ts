import { CURB } from '../physics/terrain';
import type { CollisionWorld } from '../physics/collision';
import { D_DOWNTOWN, type CityLayout, type Rect } from '../world/types';
import type { CrimeEventType } from './types';
import { EK } from './types';

/**
 * Arenas (where crime events happen) and patrol loops (where roaming pairs
 * walk), derived from the city layout. Deterministic for a layout and checked
 * against the collision world when built: every spawn spot stands on the
 * arena's surface with room for the largest regular enemy capsule.
 */

/** Arena types. */
export const AR = { STOREFRONT: 0, INTERSECTION: 1, ROOF: 2, AVENUE: 3, PLAZA: 4, PARK: 5, PIER: 6 } as const;
export const AR_NAMES = ['storefront', 'intersection', 'roof', 'avenue', 'plaza', 'park', 'pier'] as const;
export const AR_COUNT = 7;

export interface Arena {
  id: number;
  type: number;
  /** Centre on the walking surface. */
  x: number;
  y: number;
  z: number;
  /** Leash rectangle (enemies stay inside it plus `enemies.leashMargin`; roofs clamp hard at the edge). */
  rect: Rect;
  radius: number;
  roof: boolean;
  /** Owning building for roof and storefront arenas, else -1. */
  buildingId: number;
  district: number;
  /** Spawn spots: x, y (feet), z triples, nearest to the centre first. */
  spots: Float32Array;
}

export interface PatrolLoop {
  /** Closed polyline x, z pairs (the first point repeats at the end). */
  pts: Float32Array;
  /** Cumulative length at each point. */
  cum: Float32Array;
  total: number;
  cx: number;
  cz: number;
  y: number;
}

export interface SpawnPoints {
  arenas: Arena[];
  loops: PatrolLoop[];
  /** Arena ids per type (`AR`). */
  byType: number[][];
}

/** Spot clearance: the brute's capsule (largest regular enemy). */
export const SPOT_RADIUS = 0.55;
export const SPOT_HEIGHT = 2.1;
const MAX_SPOTS = 16;
const MIN_SPOTS = 8;
/** Sidewalk centre line inset (same as pedestrians). */
export const PATROL_INSET = 3.8;
/** Manhattan's sidewalk width (layouts may carry their own). */
const SIDEWALK_GRID = 5;

/** Capsule clearance for an enemy standing at (x, y, z): same margin as the player's safe spots. */
export function spotFree(w: CollisionWorld, x: number, y: number, z: number, r = SPOT_RADIUS, h = SPOT_HEIGHT): boolean {
  return w.capsuleFree(x, y + 0.02, z, r + 0.05, h);
}

/**
 * Collect up to MAX_SPOTS free standing spots from candidate points (x, z),
 * nearest to (cx, cz) first. A spot must stand on a surface within `tol` of
 * `y` (so a street arena never spawns on a car roof, a roof arena never on
 * an HVAC unit).
 */
function collectSpots(w: CollisionWorld, cand: number[], cx: number, cz: number, y: number | ((x: number, z: number) => number), tol: number): Float32Array {
  const order: number[] = [];
  for (let i = 0; i < cand.length; i += 2) order.push(i);
  order.sort((a, b) => Math.hypot(cand[a]! - cx, cand[a + 1]! - cz) - Math.hypot(cand[b]! - cx, cand[b + 1]! - cz) || a - b);
  const out: number[] = [];
  for (const i of order) {
    if (out.length >= MAX_SPOTS * 3) break;
    const x = cand[i]!,
      z = cand[i + 1]!;
    // The surface the spot must stand on (a function of x, z on maps with hills).
    const want = typeof y === 'number' ? y : y(x, z);
    const s = w.supportHeight(x, z, want + 1, 0);
    if (s.y === -Infinity || Math.abs(s.y - want) > tol) continue;
    if (!spotFree(w, x, s.y, z)) continue;
    out.push(x, s.y, z);
  }
  return new Float32Array(out);
}

function grid(minX: number, maxX: number, minZ: number, maxZ: number, step: number, out: number[] = []): number[] {
  const nx = Math.max(1, Math.floor((maxX - minX) / step) + 1),
    nz = Math.max(1, Math.floor((maxZ - minZ) / step) + 1);
  const ox = minX + (maxX - minX - (nx - 1) * step) / 2,
    oz = minZ + (maxZ - minZ - (nz - 1) * step) / 2;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) out.push(ox + i * step, oz + j * step);
  return out;
}

export function buildSpawnPoints(layout: CityLayout, w: CollisionWorld): SpawnPoints {
  const arenas: Arena[] = [];
  const byType: number[][] = [];
  for (let i = 0; i < AR_COUNT; i++) byType.push([]);
  const terr = w.terrain;
  const SIDEWALK = layout.sidewalk ?? SIDEWALK_GRID;
  // Ground level: the curb (sidewalks, plazas, parks) is a constant on the flat grid, the terrain elsewhere.
  const ground = (x: number, z: number): number => terr.height(x, z);
  const curbY = (x: number, z: number): number => (terr.flat ? CURB : terr.height(x, z));
  const curbAt: number | ((x: number, z: number) => number) = terr.flat ? CURB : ground;
  const add = (type: number, x: number, y: number, z: number, rect: Rect, spots: Float32Array, roof: boolean, buildingId: number, district: number): void => {
    if (spots.length < MIN_SPOTS * 3) return;
    const id = arenas.length;
    const radius = Math.max(rect.maxX - rect.minX, rect.maxZ - rect.minZ) / 2;
    arenas.push({ id, type, x, y, z, rect, radius, roof, buildingId, district, spots });
    byType[type]!.push(id);
  };

  // Storefronts: per block side, the widest building with a storefront band facing it.
  for (const blk of layout.blocks) {
    for (let face = 0; face < 4; face++) {
      let best = -1,
        bestLen = 12;
      for (const b of layout.buildings) {
        if (b.style.storefront <= 0) continue;
        const fp = b.footprint;
        if (fp.minX < blk.minX - 1 || fp.maxX > blk.maxX + 1 || fp.minZ < blk.minZ - 1 || fp.maxZ > blk.maxZ + 1) continue;
        const near =
          face === 0 ? fp.maxX > blk.maxX - SIDEWALK - 1.6 : face === 1 ? fp.minX < blk.minX + SIDEWALK + 1.6 : face === 2 ? fp.maxZ > blk.maxZ - SIDEWALK - 1.6 : fp.minZ < blk.minZ + SIDEWALK + 1.6;
        if (!near) continue;
        const len = face <= 1 ? fp.maxZ - fp.minZ : fp.maxX - fp.minX;
        if (len > bestLen) {
          bestLen = len;
          best = b.id;
        }
      }
      if (best < 0) continue;
      const fp = layout.buildings.find((b) => b.id === best)!.footprint;
      let rect: Rect;
      if (face === 0) rect = { minX: blk.maxX - SIDEWALK, maxX: blk.maxX, minZ: fp.minZ, maxZ: fp.maxZ };
      else if (face === 1) rect = { minX: blk.minX, maxX: blk.minX + SIDEWALK, minZ: fp.minZ, maxZ: fp.maxZ };
      else if (face === 2) rect = { minX: fp.minX, maxX: fp.maxX, minZ: blk.maxZ - SIDEWALK, maxZ: blk.maxZ };
      else rect = { minX: fp.minX, maxX: fp.maxX, minZ: blk.minZ, maxZ: blk.minZ + SIDEWALK };
      const cx = (rect.minX + rect.maxX) / 2,
        cz = (rect.minZ + rect.maxZ) / 2;
      // Two lines along the sidewalk (1.6 and 3.6 m from the curb), 2.5 m apart.
      const cand: number[] = [];
      const along = face <= 1 ? rect.maxZ - rect.minZ : rect.maxX - rect.minX;
      for (let a = 1.5; a <= along - 1.5; a += 2.5) {
        for (const inset of [1.6, 3.6]) {
          if (face === 0) cand.push(blk.maxX - inset, rect.minZ + a);
          else if (face === 1) cand.push(blk.minX + inset, rect.minZ + a);
          else if (face === 2) cand.push(rect.minX + a, blk.maxZ - inset);
          else cand.push(rect.minX + a, blk.minZ + inset);
        }
      }
      add(AR.STOREFRONT, cx, curbY(cx, cz), cz, rect, collectSpots(w, cand, cx, cz, curbAt, 0.05), false, best, blk.district);
    }
  }

  // Intersections of inner roads (on land, outside the park).
  for (const av of layout.avenues) {
    for (const st of layout.streets) {
      const x = av.center,
        z = st.center;
      if (terr.isWater(x, z) || terr.inPark(x, z)) continue;
      const hx = av.width / 2,
        hz = st.width / 2;
      const rect = { minX: x - hx - SIDEWALK, maxX: x + hx + SIDEWALK, minZ: z - hz - SIDEWALK, maxZ: z + hz + SIDEWALK };
      const cand = grid(x - hx + 1.5, x + hx - 1.5, z - hz + 1.5, z + hz - 1.5, 3);
      add(AR.INTERSECTION, x, 0, z, rect, collectSpots(w, cand, x, z, 0, 0.05), false, -1, 0);
    }
  }

  // Avenue segments between two streets (long straight runs for a charging boss).
  for (const av of layout.avenues) {
    if (av.perimeter) continue;
    for (let j = 0; j + 1 < layout.streets.length; j++) {
      const s0 = layout.streets[j]!,
        s1 = layout.streets[j + 1]!;
      const z0 = s0.center + s0.width / 2,
        z1 = s1.center - s1.width / 2;
      const x = av.center,
        z = (z0 + z1) / 2;
      if (z1 - z0 < 40 || terr.isWater(x, z) || terr.inPark(x, z) || !terr.isRoad(x, z)) continue;
      const hx = av.width / 2;
      const rect = { minX: x - hx, maxX: x + hx, minZ: z0, maxZ: z1 };
      const cand = grid(x - hx + 2, x + hx - 2, z0 + 3, z1 - 3, 3.5);
      add(AR.AVENUE, x, 0, z, rect, collectSpots(w, cand, x, z, 0, 0.05), false, -1, 0);
    }
  }

  // Maps described by road pieces (no avenue x street grid): crossings, long straight runs and quays.
  if (layout.roads) roadArenas(layout, w, ground, add);

  // Plazas inside blocks.
  for (const p of layout.plazas) {
    const cx = (p.minX + p.maxX) / 2,
      cz = (p.minZ + p.maxZ) / 2;
    const cand = grid(p.minX + 1.5, p.maxX - 1.5, p.minZ + 1.5, p.maxZ - 1.5, 2.5);
    add(AR.PLAZA, cx, curbY(cx, cz), cz, { ...p }, collectSpots(w, cand, cx, cz, curbAt, 0.05), false, -1, 0);
  }

  // Roofs: the top volume of each building with at least 400 m2 of roof.
  for (const b of layout.buildings) {
    let top = b.volumes[0];
    for (const v of b.volumes) if (top && v.maxY > top.maxY) top = v;
    if (!top) continue;
    const wdt = top.maxX - top.minX,
      dpt = top.maxZ - top.minZ;
    if (wdt * dpt < 400 || wdt < 12 || dpt < 12) continue;
    const cx = (top.minX + top.maxX) / 2,
      cz = (top.minZ + top.maxZ) / 2;
    const rect = { minX: top.minX, maxX: top.maxX, minZ: top.minZ, maxZ: top.maxZ };
    const cand = grid(top.minX + 1.5, top.maxX - 1.5, top.minZ + 1.5, top.maxZ - 1.5, 3);
    add(AR.ROOF, cx, top.maxY, cz, rect, collectSpots(w, cand, cx, cz, top.maxY, 0.05), true, b.id, b.district);
  }

  // Park: open lawns on a 40 m grid, clear of the pond.
  for (const pk of layout.parks ?? [layout.park]) {
    const pd = layout.pond;
    const centres = grid(pk.minX + 20, pk.maxX - 20, pk.minZ + 20, pk.maxZ - 20, 40);
    for (let i = 0; i < centres.length; i += 2) {
      const x = centres[i]!,
        z = centres[i + 1]!;
      const dx = (x - pd.cx) / (pd.rx + 14),
        dz = (z - pd.cz) / (pd.rz + 14);
      if (dx * dx + dz * dz < 1) continue;
      const rect = { minX: x - 12, maxX: x + 12, minZ: z - 12, maxZ: z + 12 };
      const cand = grid(x - 9, x + 9, z - 9, z + 9, 3);
      const spots = collectSpots(w, cand, x, z, curbAt, 0.05);
      if (spots.length < MAX_SPOTS * 3) continue;
      add(AR.PARK, x, curbY(x, z), z, rect, spots, false, -1, 0);
    }
  }

  // Piers.
  for (const p of layout.piers) {
    const cx = (p.minX + p.maxX) / 2,
      cz = (p.minZ + p.maxZ) / 2;
    const cand = grid(p.minX + 1.5, p.maxX - 1.5, p.minZ + 1.5, p.maxZ - 1.5, 3);
    add(AR.PIER, cx, p.top, cz, { minX: p.minX, maxX: p.maxX, minZ: p.minZ, maxZ: p.maxZ }, collectSpots(w, cand, cx, cz, p.top, 0.05), false, -1, 0);
  }

  // Patrol loops: sidewalk rectangles inset like the pedestrians', kept only when every 4 m sample is clear.
  const loops: PatrolLoop[] = [];
  // Narrower sidewalks (Istanbul) walk their middle.
  const inset = SIDEWALK === SIDEWALK_GRID ? PATROL_INSET : SIDEWALK / 2;
  for (const b of layout.blocks) {
    const x0 = b.minX + inset,
      x1 = b.maxX - inset,
      z0 = b.minZ + inset,
      z1 = b.maxZ - inset;
    if (x1 - x0 < inset * 2 || z1 - z0 < inset * 2) continue;
    const corners = [x0, z0, x1, z0, x1, z1, x0, z1, x0, z0];
    let ok = true;
    for (let k = 0; k < 4 && ok; k++) {
      const ax = corners[k * 2]!,
        az = corners[k * 2 + 1]!,
        bx = corners[k * 2 + 2]!,
        bz = corners[k * 2 + 3]!;
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(len / 4));
      for (let i = 0; i < n && ok; i++) {
        const x = ax + ((bx - ax) * i) / n,
          z = az + ((bz - az) * i) / n;
        const want = curbY(x, z);
        const s = w.supportHeight(x, z, want + 1, 0);
        if (Math.abs(s.y - want) > 0.05 || !w.capsuleFree(x, s.y + 0.02, z, 0.45, 1.8)) ok = false;
      }
    }
    if (!ok) continue;
    const pts = new Float32Array(corners);
    const cum = new Float32Array(5);
    for (let k = 1; k < 5; k++) cum[k] = cum[k - 1]! + Math.hypot(pts[k * 2]! - pts[k * 2 - 2]!, pts[k * 2 + 1]! - pts[k * 2 - 1]!);
    loops.push({ pts, cum, total: cum[4]!, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, y: curbY((x0 + x1) / 2, (z0 + z1) / 2) });
  }

  return { arenas, loops, byType };
}

type AddArena = (type: number, x: number, y: number, z: number, rect: Rect, spots: Float32Array, roof: boolean, buildingId: number, district: number) => void;

/**
 * Arenas from road pieces: intersections where two axis-aligned roads with
 * cars cross, straight runs of at least 40 m (avenue type, for the charging
 * boss) and quays on the sea side of the coastal roads (pier type). Spots
 * stand on the terrain (road level, or the curb on raised ground).
 */
function roadArenas(layout: CityLayout, w: CollisionWorld, ground: (x: number, z: number) => number, add: AddArena): void {
  const terr = w.terrain;
  const segs: Array<[number, number, number, number, number]> = [];
  for (const r of layout.roads ?? []) {
    if (!r.cars) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i]!,
        b = r.pts[i + 1]!;
      segs.push([a[0], a[1], b[0], b[1], r.width]);
    }
  }
  const axisX = (s: [number, number, number, number, number]): boolean => Math.abs(s[3] - s[1]) < 0.01;
  const axisZ = (s: [number, number, number, number, number]): boolean => Math.abs(s[2] - s[0]) < 0.01;
  // Intersections.
  const found: Array<[number, number]> = [];
  for (const h of segs) {
    if (!axisX(h)) continue;
    const z = h[1],
      hx0 = Math.min(h[0], h[2]),
      hx1 = Math.max(h[0], h[2]);
    for (const v of segs) {
      if (!axisZ(v)) continue;
      const x = v[0],
        vz0 = Math.min(v[1], v[3]),
        vz1 = Math.max(v[1], v[3]);
      // Crossings and T-junctions (a street ends at the other's curb, half its width from the centre line).
      if (x < hx0 - v[4] / 2 - 1 || x > hx1 + v[4] / 2 + 1 || z < vz0 - h[4] / 2 - 1 || z > vz1 + h[4] / 2 + 1) continue;
      if (found.some((f) => Math.abs(f[0] - x) < 20 && Math.abs(f[1] - z) < 20)) continue;
      if (terr.isWater(x, z)) continue;
      found.push([x, z]);
      const hx = v[4] / 2,
        hz = h[4] / 2;
      const rect = { minX: x - hx - 3, maxX: x + hx + 3, minZ: z - hz - 3, maxZ: z + hz + 3 };
      const cand = grid(x - hx + 1.5, x + hx - 1.5, z - hz + 1.5, z + hz - 1.5, 3);
      add(AR.INTERSECTION, x, ground(x, z), z, rect, collectSpots(w, cand, x, z, ground, 0.05), false, -1, 0);
    }
  }
  // Straight runs (between 40 and 120 m of one axis-aligned piece).
  for (const s of segs) {
    const len = Math.hypot(s[2] - s[0], s[3] - s[1]);
    if (len < 40 || (!axisX(s) && !axisZ(s))) continue;
    const cx = (s[0] + s[2]) / 2,
      cz = (s[1] + s[3]) / 2;
    if (terr.isWater(cx, cz)) continue;
    const half = Math.min(len, 120) / 2 - 6,
      hw = s[4] / 2;
    const rect = axisX(s) ? { minX: cx - half, maxX: cx + half, minZ: cz - hw, maxZ: cz + hw } : { minX: cx - hw, maxX: cx + hw, minZ: cz - half, maxZ: cz + half };
    const cand = grid(rect.minX + 2, rect.maxX - 2, rect.minZ + 2, rect.maxZ - 2, 3.5);
    add(AR.AVENUE, cx, ground(cx, cz), cz, rect, collectSpots(w, cand, cx, cz, ground, 0.05), false, -1, 0);
  }
  // Quays: every 140 m along the coastal roads, on the water side.
  for (const r of layout.roads ?? []) {
    if (r.cls !== 3) continue;
    let carry = 70;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i]!;
      const [bx, bz] = r.pts[i + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const ux = (bx - ax) / len,
        uz = (bz - az) / len;
      let t = carry;
      while (t < len) {
        const px = ax + ux * t,
          pz = az + uz * t;
        for (const side of [1, -1]) {
          const nx = -uz * side,
            nz = ux * side;
          const qx = px + nx * (r.width / 2 + 7),
            qz = pz + nz * (r.width / 2 + 7);
          // The water side: water a little further out.
          if (terr.isWater(qx, qz) || !terr.isWater(qx + nx * 14, qz + nz * 14)) continue;
          const rect = { minX: qx - 9, maxX: qx + 9, minZ: qz - 9, maxZ: qz + 9 };
          const all = grid(qx - 7.5, qx + 7.5, qz - 7.5, qz + 7.5, 3);
          const cand: number[] = [];
          for (let k = 0; k < all.length; k += 2) if (!terr.isWater(all[k]!, all[k + 1]!) && !terr.isRoad(all[k]!, all[k + 1]!)) cand.push(all[k]!, all[k + 1]!);
          add(AR.PIER, qx, ground(qx, qz), qz, rect, collectSpots(w, cand, qx, qz, ground, 0.05), false, -1, 0);
        }
        t += 140;
      }
      carry = t - len;
    }
  }
}

/** Arena types a crime event may use (`boss` = boss kind for boss events). */
export function arenaTypesFor(type: CrimeEventType, boss = -1): readonly number[] {
  switch (type) {
    case 'robbery':
      return [AR.STOREFRONT];
    case 'gang':
      return [AR.INTERSECTION];
    case 'drones':
      return [AR.ROOF];
    case 'boss':
      if (boss === EK.KOCBASI) return [AR.AVENUE, AR.PLAZA];
      if (boss === EK.KUZGUN) return [AR.ROOF];
      return [AR.PARK, AR.PIER];
  }
}

/** Whether an arena suits an event beyond its type (roof height band, downtown for Kuzgun). */
export function arenaSuits(a: Arena, type: CrimeEventType, boss = -1): boolean {
  if (type === 'drones') return a.roof && a.y >= 15 && a.y <= 60;
  if (type === 'boss' && boss === EK.KUZGUN) return a.roof && a.district === D_DOWNTOWN;
  return true;
}

/** Point inside an arena's leash rectangle grown by `margin`. */
export function inArena(a: Arena, x: number, z: number, margin = 0): boolean {
  return x >= a.rect.minX - margin && x <= a.rect.maxX + margin && z >= a.rect.minZ - margin && z <= a.rect.maxZ + margin;
}
