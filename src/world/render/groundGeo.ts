import { Shape, ShapeGeometry, Vector2 } from 'three';
import { GeomBuilder } from '../../render/geomBuilder';
import { CURB } from '../../physics/terrain';
import type { CityLayout, Rect } from '../types';
import { LIGHTHOUSE } from '../../maps/manhattan/colliders';

const ASPHALT: [number, number, number] = [0.2, 0.21, 0.24];
const SIDEWALK: [number, number, number] = [0.66, 0.63, 0.58];
const CURB_SIDE: [number, number, number] = [0.5, 0.49, 0.47];
const PROMENADE: [number, number, number] = [0.72, 0.64, 0.52];
const SEAWALL: [number, number, number] = [0.46, 0.44, 0.42];
const GRASS_A: [number, number, number] = [0.33, 0.62, 0.27];
const GRASS_B: [number, number, number] = [0.38, 0.68, 0.3];
const PATH: [number, number, number] = [0.83, 0.75, 0.58];
const PLAZA: [number, number, number] = [0.76, 0.7, 0.62];
const WOOD: [number, number, number] = [0.5, 0.36, 0.24];

/** Raised slab with curb sides. */
function slab(b: GeomBuilder, r: Rect, y0: number, y1: number, top: [number, number, number], side: [number, number, number]): void {
  b.setColorArr(top);
  b.box(r.minX, y0, r.minZ, r.maxX, y1, r.maxZ, 4);
  b.setColorArr(side);
  b.box(r.minX, y0, r.minZ, r.maxX, y1, r.maxZ, 1 | 2 | 16 | 32);
}

/**
 * Static ground: road surface, block slabs with curbs, plazas, promenade,
 * seawalls, islet, piers, park lawn with a pond hole and banks. Lane
 * markings and park paths go to a separate builder drawn with polygon
 * offset so they never z-fight.
 */
export function buildGround(L: CityLayout): { ground: GeomBuilder; decals: GeomBuilder } {
  const g = new GeomBuilder();
  const d = new GeomBuilder();
  const land = L.land;
  // Road surface across the whole island.
  g.setColorArr(ASPHALT);
  g.quad(land.minX, 0, land.maxZ, land.maxX, 0, land.maxZ, land.maxX, 0, land.minZ, land.minX, 0, land.minZ, 0, 1, 0);
  // Blocks
  for (const blk of L.blocks) slab(g, blk, 0, CURB, SIDEWALK, CURB_SIDE);
  for (const p of L.plazas) {
    d.setColorArr(PLAZA);
    d.quad(p.minX, CURB + 0.01, p.maxZ, p.maxX, CURB + 0.01, p.maxZ, p.maxX, CURB + 0.01, p.minZ, p.minX, CURB + 0.01, p.minZ, 0, 1, 0);
    // Tile grid lines
    d.setColor(0.6, 0.55, 0.5);
    for (let x = p.minX + 3; x < p.maxX - 1; x += 3) d.quad(x - 0.05, CURB + 0.012, p.maxZ, x + 0.05, CURB + 0.012, p.maxZ, x + 0.05, CURB + 0.012, p.minZ, x - 0.05, CURB + 0.012, p.minZ, 0, 1, 0);
  }
  // Promenade strips (between the island edge and the perimeter drives).
  const pr = L.promenade;
  const strips: Rect[] = [
    { minX: land.minX, maxX: land.maxX, minZ: land.minZ, maxZ: land.minZ + pr },
    { minX: land.minX, maxX: land.maxX, minZ: land.maxZ - pr, maxZ: land.maxZ },
    { minX: land.minX, maxX: land.minX + pr, minZ: land.minZ + pr, maxZ: land.maxZ - pr },
    { minX: land.maxX - pr, maxX: land.maxX, minZ: land.minZ + pr, maxZ: land.maxZ - pr },
  ];
  for (const s of strips) slab(g, s, 0, CURB, PROMENADE, CURB_SIDE);
  // Promenade paving bands
  d.setColor(0.62, 0.55, 0.45);
  for (let z = land.minZ + 10; z < land.maxZ; z += 6) {
    d.quad(land.minX, CURB + 0.01, z + 0.25, land.minX + pr, CURB + 0.01, z + 0.25, land.minX + pr, CURB + 0.01, z - 0.25, land.minX, CURB + 0.01, z - 0.25, 0, 1, 0);
    d.quad(land.maxX - pr, CURB + 0.01, z + 0.25, land.maxX, CURB + 0.01, z + 0.25, land.maxX, CURB + 0.01, z - 0.25, land.maxX - pr, CURB + 0.01, z - 0.25, 0, 1, 0);
  }
  // Seawall faces around the island and islet.
  const seawall = (r: Rect): void => {
    g.setColorArr(SEAWALL);
    g.box(r.minX, -4, r.minZ, r.maxX, CURB, r.maxZ, 1 | 2 | 16 | 32);
    g.setColor(0.36, 0.34, 0.33);
    g.box(r.minX - 0.3, -1.6, r.minZ - 0.3, r.maxX + 0.3, -1.0, r.maxZ + 0.3, 1 | 2 | 16 | 32 | 4);
  };
  seawall(land);
  seawall(L.islet);
  slab(g, L.islet, 0, CURB, PROMENADE, SEAWALL);
  g.setColorArr(PROMENADE);
  // Piers: decks with posts.
  for (const p of L.piers) {
    g.setColorArr(WOOD);
    g.box(p.minX, p.top - 0.5, p.minZ, p.maxX, p.top, p.maxZ, 63 & ~8);
    g.setColor(0.32, 0.24, 0.17);
    const along = p.maxX - p.minX > p.maxZ - p.minZ;
    const len = along ? p.maxX - p.minX : p.maxZ - p.minZ;
    for (let t = 2; t < len; t += 6) {
      for (const side of [0.15, 0.85]) {
        const x = along ? p.minX + t : p.minX + (p.maxX - p.minX) * side;
        const z = along ? p.minZ + (p.maxZ - p.minZ) * side : p.minZ + t;
        g.cylinder(x, z, -4, p.top - 0.5, 0.3, 0.3, 6, false);
      }
    }
    // Deck planks
    d.setColor(0.42, 0.3, 0.2);
    for (let t = 1; t < len; t += 1.6) {
      if (along) {
        const x = p.minX + t;
        d.quad(x - 0.05, p.top + 0.01, p.maxZ, x + 0.05, p.top + 0.01, p.maxZ, x + 0.05, p.top + 0.01, p.minZ, x - 0.05, p.top + 0.01, p.minZ, 0, 1, 0);
      } else {
        const z = p.minZ + t;
        d.quad(p.minX, p.top + 0.01, z + 0.05, p.maxX, p.top + 0.01, z + 0.05, p.maxX, p.top + 0.01, z - 0.05, p.minX, p.top + 0.01, z - 0.05, 0, 1, 0);
      }
    }
  }

  // Park lawn with an elliptical pond hole.
  const P = L.park;
  const pond = L.pond;
  {
    const shape = new Shape();
    shape.moveTo(P.minX, P.minZ);
    shape.lineTo(P.maxX, P.minZ);
    shape.lineTo(P.maxX, P.maxZ);
    shape.lineTo(P.minX, P.maxZ);
    shape.lineTo(P.minX, P.minZ);
    const hole = new Shape();
    const N = 64;
    const pts: Vector2[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push(new Vector2(pond.cx + Math.cos(a) * pond.rx, pond.cz + Math.sin(a) * pond.rz));
    }
    hole.setFromPoints(pts);
    shape.holes.push(hole);
    const sg = new ShapeGeometry(shape, 1);
    const pos = sg.getAttribute('position');
    const idx = sg.getIndex()!;
    const base = g.vertexCount;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i),
        z = pos.getY(i);
      const k = 0.5 + 0.5 * Math.sin(x * 0.02) * Math.cos(z * 0.025);
      g.setColor(GRASS_A[0] + (GRASS_B[0] - GRASS_A[0]) * k, GRASS_A[1] + (GRASS_B[1] - GRASS_A[1]) * k, GRASS_A[2] + (GRASS_B[2] - GRASS_A[2]) * k);
      g.vertex(x, CURB, z, 0, 1, 0);
    }
    // ShapeGeometry lies in XY with +Z normal; mapping Y->Z flips winding, so swap.
    for (let i = 0; i < idx.count; i += 3) g.tri(base + idx.getX(i), base + idx.getX(i + 2), base + idx.getX(i + 1));
    sg.dispose();
    // Park slab sides
    g.setColorArr(CURB_SIDE);
    g.box(P.minX, 0, P.minZ, P.maxX, CURB, P.maxZ, 1 | 2 | 16 | 32);
    // Pond bank (inner wall) and stone rim
    g.setColor(0.5, 0.47, 0.42);
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2,
        a1 = ((i + 1) / N) * Math.PI * 2;
      const x0 = pond.cx + Math.cos(a0) * pond.rx,
        z0 = pond.cz + Math.sin(a0) * pond.rz;
      const x1 = pond.cx + Math.cos(a1) * pond.rx,
        z1 = pond.cz + Math.sin(a1) * pond.rz;
      const nx = -(Math.cos((a0 + a1) / 2) / pond.rx),
        nz = -(Math.sin((a0 + a1) / 2) / pond.rz);
      const nl = Math.hypot(nx, nz);
      g.quad(x1, -1.4, z1, x0, -1.4, z0, x0, CURB, z0, x1, CURB, z1, nx / nl, 0, nz / nl);
      // Rim stones
      const ox0 = pond.cx + Math.cos(a0) * (pond.rx + 1.2),
        oz0 = pond.cz + Math.sin(a0) * (pond.rz + 1.2);
      const ox1 = pond.cx + Math.cos(a1) * (pond.rx + 1.2),
        oz1 = pond.cz + Math.sin(a1) * (pond.rz + 1.2);
      d.setColor(0.7, 0.67, 0.6);
      d.quad(x0, CURB + 0.02, z0, x1, CURB + 0.02, z1, ox1, CURB + 0.02, oz1, ox0, CURB + 0.02, oz0, 0, 1, 0);
    }
  }
  // Park paths as ribbons.
  for (const path of L.paths) {
    d.setColorArr(PATH);
    const hw = path.width / 2;
    const pts = path.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!,
        b = pts[i + 1]!;
      const dx = b[0] - a[0],
        dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l,
        nz = dx / l;
      // Extend slightly to hide seams at joints.
      const ex = (dx / l) * 0.4,
        ez = (dz / l) * 0.4;
      const y = CURB + 0.02;
      d.quad(a[0] - nx * hw - ex, y, a[1] - nz * hw - ez, a[0] + nx * hw - ex, y, a[1] + nz * hw - ez, b[0] + nx * hw + ex, y, b[1] + nz * hw + ez, b[0] - nx * hw + ex, y, b[1] - nz * hw + ez, 0, 1, 0);
    }
  }
  // Park wall coping and the walls themselves.
  for (const w of L.parkWalls) {
    g.setColor(0.58, 0.55, 0.5);
    g.box(w.minX, w.minY, w.minZ, w.maxX, w.maxY, w.maxZ, 63 & ~8);
    g.setColor(0.68, 0.65, 0.6);
    g.box(w.minX - 0.06, w.maxY - 0.08, w.minZ - 0.06, w.maxX + 0.06, w.maxY + 0.04, w.maxZ + 0.06, 63 & ~8);
  }
  // Railings: posts + top rail (visual), collision is the thicker box.
  for (const r of L.railings) {
    g.setColor(0.2, 0.24, 0.26);
    const alongX = r.maxX - r.minX > r.maxZ - r.minZ;
    const len = alongX ? r.maxX - r.minX : r.maxZ - r.minZ;
    const cx = (r.minX + r.maxX) / 2,
      cz = (r.minZ + r.maxZ) / 2;
    if (alongX) {
      g.box(r.minX, r.maxY - 0.08, cz - 0.05, r.maxX, r.maxY, cz + 0.05);
      g.box(r.minX, r.minY + 0.45, cz - 0.03, r.maxX, r.minY + 0.5, cz + 0.03);
      for (let t = 0; t <= len; t += 2) g.box(r.minX + t - 0.04, r.minY, cz - 0.04, r.minX + t + 0.04, r.maxY, cz + 0.04, 63 & ~8 & ~4);
    } else {
      g.box(cx - 0.05, r.maxY - 0.08, r.minZ, cx + 0.05, r.maxY, r.maxZ);
      g.box(cx - 0.03, r.minY + 0.45, r.minZ, cx + 0.03, r.minY + 0.5, r.maxZ);
      for (let t = 0; t <= len; t += 2) g.box(cx - 0.04, r.minY, r.minZ + t - 0.04, cx + 0.04, r.maxY, r.minZ + t + 0.04, 63 & ~8 & ~4);
    }
  }
  // Lighthouse on the islet (white with red bands).
  {
    const Lh = LIGHTHOUSE;
    for (let i = 0; i < 6; i++) {
      const y0 = CURB + (Lh.h - CURB) * (i / 6),
        y1 = CURB + (Lh.h - CURB) * ((i + 1) / 6);
      if (i % 2 === 0) g.setColor(0.95, 0.94, 0.9);
      else g.setColor(0.82, 0.16, 0.14);
      g.cylinder(Lh.x, Lh.z, y0, y1, Lh.r - i * 0.12, Lh.r - (i + 1) * 0.12, 18, false);
    }
    g.setColor(0.2, 0.22, 0.24);
    g.cylinder(Lh.x, Lh.z, Lh.h, Lh.h + 0.4, Lh.r + 0.6, Lh.r + 0.6, 18);
    g.setColor(0.18, 0.2, 0.22);
    g.cylinder(Lh.x, Lh.z, Lh.h + 3.4, Lh.h + 4.5, Lh.r * 0.75, 0.2, 18);
  }

  // Road markings.
  const MY = 0.012;
  const strip = (x0: number, z0: number, x1: number, z1: number): void => {
    d.quad(x0, MY, z1, x1, MY, z1, x1, MY, z0, x0, MY, z0, 0, 1, 0);
  };
  const inPark = (x: number, z: number): boolean => x > P.minX && x < P.maxX && z > P.minZ && z < P.maxZ;
  // Avenues (north-south): double yellow centre lines and dashed white lane
  // lines, one quad per run between intersections.
  const zCuts = [land.minZ + pr, ...L.streets.flatMap((s) => [s.center - s.width / 2 - 0.4, s.center + s.width / 2 + 0.4]), land.maxZ - pr].sort((a, b) => a - b);
  for (const a of L.avenues) {
    for (let i = 0; i + 1 < zCuts.length; i += 2) {
      const z0 = zCuts[i]!,
        z1 = zCuts[i + 1]!;
      if (z1 - z0 < 2 || inPark(a.center, (z0 + z1) / 2)) continue;
      d.setColor(0.98, 0.78, 0.15);
      strip(a.center - 0.28, z0, a.center - 0.13, z1);
      strip(a.center + 0.13, z0, a.center + 0.28, z1);
      if (!a.perimeter) {
        d.setColor(0.94, 0.94, 0.92);
        const lane = a.width / 4;
        for (let z = z0 + 2; z + 3 < z1; z += 9) {
          strip(a.center - lane - 0.08, z, a.center - lane + 0.08, z + 3);
          strip(a.center + lane - 0.08, z, a.center + lane + 0.08, z + 3);
        }
      }
    }
  }
  // Streets (east-west): dashed yellow centre line between intersections.
  const xCuts = [land.minX + pr, ...L.avenues.flatMap((a) => [a.center - a.width / 2 - 0.4, a.center + a.width / 2 + 0.4]), land.maxX - pr].sort((a, b) => a - b);
  for (const st of L.streets) {
    for (let i = 0; i + 1 < xCuts.length; i += 2) {
      const x0 = xCuts[i]!,
        x1 = xCuts[i + 1]!;
      if (x1 - x0 < 2 || inPark((x0 + x1) / 2, st.center)) continue;
      d.setColor(0.98, 0.8, 0.2);
      if (st.perimeter) {
        d.quad(x0, MY, st.center + 0.28, x1, MY, st.center + 0.28, x1, MY, st.center + 0.13, x0, MY, st.center + 0.13, 0, 1, 0);
        d.quad(x0, MY, st.center - 0.13, x1, MY, st.center - 0.13, x1, MY, st.center - 0.28, x0, MY, st.center - 0.28, 0, 1, 0);
      } else {
        for (let x = x0 + 1.5; x + 2.5 < x1; x += 6) d.quad(x, MY, st.center + 0.08, x + 2.5, MY, st.center + 0.08, x + 2.5, MY, st.center - 0.08, x, MY, st.center - 0.08, 0, 1, 0);
      }
    }
  }
  // Crosswalks: zebra stripes across each road at every block corner.
  d.setColor(0.95, 0.95, 0.93);
  for (const blk of L.blocks) {
    // Across the avenue next to each block side (x edges), at both block ends.
    for (const z of [blk.minZ + 1.8, blk.maxZ - 1.8]) {
      for (const [xa, dir] of [
        [blk.maxX, 1],
        [blk.minX, -1],
      ] as Array<[number, number]>) {
        const av = L.avenues.find((a) => Math.abs(a.center - (xa + dir * (a.width / 2))) < 0.6);
        if (!av) continue;
        const x0 = av.center - av.width / 2 + 0.6,
          x1 = av.center + av.width / 2 - 0.6;
        for (let x = x0; x < x1; x += 1.0) d.quad(x, MY, z + 1.6, x + 0.55, MY, z + 1.6, x + 0.55, MY, z - 1.6, x, MY, z - 1.6, 0, 1, 0);
      }
    }
    for (const x of [blk.minX + 1.8, blk.maxX - 1.8]) {
      for (const [za, dir] of [
        [blk.maxZ, 1],
        [blk.minZ, -1],
      ] as Array<[number, number]>) {
        const st = L.streets.find((s) => Math.abs(s.center - (za + dir * (s.width / 2))) < 0.6);
        if (!st) continue;
        const z0 = st.center - st.width / 2 + 0.6,
          z1 = st.center + st.width / 2 - 0.6;
        for (let z = z0; z < z1; z += 1.0) d.quad(x - 1.6, MY, z + 0.55, x + 1.6, MY, z + 0.55, x + 1.6, MY, z, x - 1.6, MY, z, 0, 1, 0);
      }
    }
  }
  return { ground: g, decals: d };
}
