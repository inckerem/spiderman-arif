import { GeomBuilder } from '../../render/geomBuilder';
import type { HeightfieldTerrain } from '../../physics/heightfield';
import { CURB } from '../../physics/terrain';
import type { CityLayout, Rect, RoadPiece } from '../types';

const PAVING: [number, number, number] = [0.7, 0.66, 0.59];
const PAVING_B: [number, number, number] = [0.66, 0.62, 0.56];
const GRASS_A: [number, number, number] = [0.36, 0.58, 0.28];
const GRASS_B: [number, number, number] = [0.42, 0.64, 0.31];
const SIDEWALK: [number, number, number] = [0.74, 0.7, 0.64];
const PLAZA: [number, number, number] = [0.82, 0.77, 0.67];
const CURB_SIDE: [number, number, number] = [0.52, 0.5, 0.47];
const ASPHALT: [number, number, number] = [0.25, 0.25, 0.27];
const LANE: [number, number, number] = [0.55, 0.5, 0.45];
const SEAWALL: [number, number, number] = [0.5, 0.47, 0.42];
const WOOD: [number, number, number] = [0.5, 0.36, 0.24];

/** Ground mesh resolution (m). */
const STEP = 4;

/**
 * Ground for a heightfield map: a 4 m terrain grid over the land (water
 * vertices next to land are pulled onto the shore line), raised slabs for
 * blocks, plazas and parks draped at the curb height with curb sides, roads
 * as ribbons draped on the road level (decals), seawalls along the shores
 * and piers.
 */
export function buildHeightfieldGround(L: CityLayout, t: HeightfieldTerrain): { ground: GeomBuilder; decals: GeomBuilder } {
  const g = new GeomBuilder();
  const d = new GeomBuilder();
  const B = L.bounds;
  const pad = 220;
  const x0 = Math.floor((B.minX - pad) / STEP) * STEP,
    z0 = Math.floor((B.minZ - pad) / STEP) * STEP;
  const nx = Math.ceil((B.maxX + pad - x0) / STEP),
    nz = Math.ceil((B.maxZ + pad - z0) / STEP);
  const vx = nx + 1;
  const wet = new Uint8Array(vx * (nz + 1));
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) wet[j * vx + i] = t.isWater(x0 + i * STEP, z0 + j * STEP) ? 1 : 0;
  const idx = new Int32Array(vx * (nz + 1)).fill(-1);
  const shore = { x: 0, z: 0 };
  const parks = L.parks ?? [];
  const inPark = (x: number, z: number): boolean => parks.some((p) => x > p.minX && x < p.maxX && z > p.minZ && z < p.maxZ);
  const n = { nx: 0, ny: 1, nz: 0 };
  const vertexAt = (i: number, j: number): number => {
    const k = j * vx + i;
    if (idx[k]! >= 0) return idx[k]!;
    let x = x0 + i * STEP,
      z = z0 + j * STEP;
    let y: number;
    if (wet[k]) {
      // Pull the water vertex onto the shore so the land edge follows the coast.
      t.water.nearestShore(x, z, shore, STEP * 2);
      x = shore.x;
      z = shore.z;
      y = 0;
    } else y = t.baseHeight(x, z);
    t.normalAt(x, z, n);
    const park = inPark(x, z);
    const k2 = 0.5 + 0.5 * Math.sin(x * 0.031) * Math.cos(z * 0.027);
    const a = park ? GRASS_A : PAVING,
      b = park ? GRASS_B : PAVING_B;
    g.setColor(a[0] + (b[0] - a[0]) * k2, a[1] + (b[1] - a[1]) * k2, a[2] + (b[2] - a[2]) * k2);
    idx[k] = g.vertex(x, y, z, n.nx, n.ny, n.nz);
    return idx[k]!;
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * vx + i;
      if (wet[k] && wet[k + 1] && wet[k + vx] && wet[k + vx + 1]) continue;
      const a = vertexAt(i, j + 1),
        b = vertexAt(i + 1, j + 1),
        c = vertexAt(i + 1, j),
        e = vertexAt(i, j);
      g.tri(a, b, c);
      g.tri(a, c, e);
    }
  }
  // Raised slabs: blocks (sidewalks), plazas, parks.
  for (const r of L.blocks) slab(g, t, r, SIDEWALK, SIDEWALK);
  for (const r of L.plazas) slab(g, t, r, PLAZA, PLAZA);
  for (const r of parks) slab(g, t, r, GRASS_A, GRASS_B);
  // Roads (decals on the road level).
  for (const r of L.roads ?? []) ribbon(d, t, r);
  // Seawalls along every shore edge inside the ground mesh.
  g.setColorArr(SEAWALL);
  for (const poly of L.landPolygons ?? []) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i]!;
      const [bx, bz] = poly[(i + 1) % poly.length]!;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) continue;
      // Polygons run with the land on the left or right; the wall faces the water side.
      const ux = (bx - ax) / len,
        uz = (bz - az) / len;
      let wx = uz,
        wz = -ux;
      const mx = (ax + bx) / 2,
        mz = (az + bz) / 2;
      if (!t.isWater(mx + wx * 1.5, mz + wz * 1.5)) {
        wx = -wx;
        wz = -wz;
      }
      const steps = Math.max(1, Math.ceil(len / STEP));
      for (let s = 0; s < steps; s++) {
        const p0x = ax + ((bx - ax) * s) / steps,
          p0z = az + ((bz - az) * s) / steps;
        const p1x = ax + ((bx - ax) * (s + 1)) / steps,
          p1z = az + ((bz - az) * (s + 1)) / steps;
        if (!inside(B, p0x, p0z, pad) && !inside(B, p1x, p1z, pad)) continue;
        // Counter-clockwise seen from the water side.
        const flip = ux * wz - uz * wx < 0;
        const [qx0, qz0, qx1, qz1] = flip ? [p1x, p1z, p0x, p0z] : [p0x, p0z, p1x, p1z];
        g.quad(qx0, -4, qz0, qx1, -4, qz1, qx1, CURB * 0.5, qz1, qx0, CURB * 0.5, qz0, wx, 0, wz);
      }
    }
  }
  // Piers: decks with posts.
  for (const p of L.piers) {
    g.setColorArr(WOOD);
    g.box(p.minX, p.top - 0.5, p.minZ, p.maxX, p.top, p.maxZ, 63 & ~8);
    g.setColor(0.32, 0.24, 0.17);
    const along = p.maxX - p.minX > p.maxZ - p.minZ;
    const len = along ? p.maxX - p.minX : p.maxZ - p.minZ;
    for (let s = 2; s < len; s += 6) {
      for (const side of [0.15, 0.85]) {
        const x = along ? p.minX + s : p.minX + (p.maxX - p.minX) * side;
        const z = along ? p.minZ + (p.maxZ - p.minZ) * side : p.minZ + s;
        g.cylinder(x, z, -4, p.top - 0.5, 0.3, 0.3, 6, false);
      }
    }
  }
  return { ground: g, decals: d };
}

function inside(B: Rect, x: number, z: number, pad: number): boolean {
  return x > B.minX - pad && x < B.maxX + pad && z > B.minZ - pad && z < B.maxZ + pad;
}

/** A slab draped over the terrain at the curb height, with curb sides down to the road level. */
function slab(g: GeomBuilder, t: HeightfieldTerrain, r: Rect, top: [number, number, number], top2: [number, number, number]): void {
  const w = r.maxX - r.minX,
    dd = r.maxZ - r.minZ;
  const nx = Math.max(1, Math.ceil(w / STEP)),
    nz = Math.max(1, Math.ceil(dd / STEP));
  const n = { nx: 0, ny: 1, nz: 0 };
  const base = g.vertexCount;
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = r.minX + (w * i) / nx,
        z = r.minZ + (dd * j) / nz;
      t.normalAt(x, z, n);
      const k = 0.5 + 0.5 * Math.sin(x * 0.05) * Math.cos(z * 0.043);
      g.setColor(top[0] + (top2[0] - top[0]) * k, top[1] + (top2[1] - top[1]) * k, top[2] + (top2[2] - top[2]) * k);
      g.vertex(x, t.baseHeight(x, z) + CURB, z, n.nx, n.ny, n.nz);
    }
  }
  const row = nx + 1;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = base + (j + 1) * row + i,
        b = base + (j + 1) * row + i + 1,
        c = base + j * row + i + 1,
        e = base + j * row + i;
      g.tri(a, b, c);
      g.tri(a, c, e);
    }
  }
  // Curb sides.
  g.setColorArr(CURB_SIDE);
  const side = (ax: number, az: number, bx: number, bz: number, nxx: number, nzz: number, steps: number): void => {
    for (let s = 0; s < steps; s++) {
      const p0x = ax + ((bx - ax) * s) / steps,
        p0z = az + ((bz - az) * s) / steps;
      const p1x = ax + ((bx - ax) * (s + 1)) / steps,
        p1z = az + ((bz - az) * (s + 1)) / steps;
      const y0 = t.baseHeight(p0x, p0z),
        y1 = t.baseHeight(p1x, p1z);
      g.quad(p0x, y0 - 0.05, p0z, p1x, y1 - 0.05, p1z, p1x, y1 + CURB, p1z, p0x, y0 + CURB, p0z, nxx, 0, nzz);
    }
  };
  side(r.maxX, r.maxZ, r.maxX, r.minZ, 1, 0, nz);
  side(r.minX, r.minZ, r.minX, r.maxZ, -1, 0, nz);
  side(r.minX, r.maxZ, r.maxX, r.maxZ, 0, 1, nx);
  side(r.maxX, r.minZ, r.minX, r.minZ, 0, 0 - 1, nx);
}

/** A road ribbon sampled every 4 m, draped 3 cm above the road level. */
function ribbon(d: GeomBuilder, t: HeightfieldTerrain, r: RoadPiece): void {
  const half = r.width / 2;
  d.setColorArr(r.cls === 0 || !r.cars ? LANE : ASPHALT);
  const n = { nx: 0, ny: 1, nz: 0 };
  for (let i = 0; i + 1 < r.pts.length; i++) {
    const [ax, az] = r.pts[i]!;
    const [bx, bz] = r.pts[i + 1]!;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.01) continue;
    const ux = (bx - ax) / len,
      uz = (bz - az) / len;
    // Left of travel (x right, z down): (uz, -ux).
    const lx = uz,
      lz = -ux;
    // Overlap the joints a little so bends never open a gap.
    const ext = Math.min(half, 3);
    const steps = Math.max(1, Math.ceil((len + 2 * ext) / STEP));
    for (let s = 0; s < steps; s++) {
      const s0 = -ext + ((len + 2 * ext) * s) / steps,
        s1 = -ext + ((len + 2 * ext) * (s + 1)) / steps;
      const c0x = ax + ux * s0,
        c0z = az + uz * s0,
        c1x = ax + ux * s1,
        c1z = az + uz * s1;
      const p = [
        [c0x - lx * half, c0z - lz * half],
        [c1x - lx * half, c1z - lz * half],
        [c1x + lx * half, c1z + lz * half],
        [c0x + lx * half, c0z + lz * half],
      ] as const;
      t.normalAt(c0x, c0z, n);
      const ys = p.map(([x, z]) => t.baseHeight(x, z) + 0.03);
      // Counter-clockwise from above: the right edge forward, then the left edge back.
      d.quad(p[0][0], ys[0]!, p[0][1], p[1][0], ys[1]!, p[1][1], p[2][0], ys[2]!, p[2][1], p[3][0], ys[3]!, p[3][1], n.nx, n.ny, n.nz);
    }
  }
}
