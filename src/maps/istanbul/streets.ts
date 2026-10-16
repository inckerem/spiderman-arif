import type { Rng } from '../../core/rng';
import type { Rect, RoadPiece } from '../../world/types';
import type { Arterial } from './data';

/**
 * Street layout helpers for Istanbul (§2.7): the coastal roads as an iso
 * line of the shore distance field, the seeded axis-aligned BSP of local
 * streets and lanes, and the largest valid rectangle inside a leaf.
 */

/** A scalar field on a vertex grid (the 2 m terrain grid). */
export interface GridField {
  x0: number;
  z0: number;
  cell: number;
  /** Vertices per row. */
  vx: number;
  vz: number;
  f: Float32Array;
}

export function sampleField(g: GridField, x: number, z: number): number {
  const i = Math.round((x - g.x0) / g.cell),
    j = Math.round((z - g.z0) / g.cell);
  if (i < 0 || j < 0 || i >= g.vx || j >= g.vz) return 0;
  return g.f[j * g.vx + i]!;
}

/**
 * Iso line `level` of the field (marching squares), chained into
 * polylines and simplified (Douglas-Peucker, `tol` metres).
 */
export function isoLines(g: GridField, level: number, tol = 0.6): Array<Array<[number, number]>> {
  const { vx, vz, f, cell, x0, z0 } = g;
  // Edge ids: horizontal edge (i,j)-(i+1,j) = 2k, vertical (i,j)-(i,j+1) = 2k+1, k = j*vx+i.
  const segA: number[] = [];
  const segB: number[] = [];
  const at = (i: number, j: number): number => f[j * vx + i]!;
  for (let j = 0; j < vz - 1; j++) {
    for (let i = 0; i < vx - 1; i++) {
      const a = at(i, j) < level ? 1 : 0,
        b = at(i + 1, j) < level ? 1 : 0,
        c = at(i + 1, j + 1) < level ? 1 : 0,
        d = at(i, j + 1) < level ? 1 : 0;
      const code = a | (b << 1) | (c << 2) | (d << 3);
      if (code === 0 || code === 15) continue;
      const k = j * vx + i;
      const eT = 2 * k, // top: (i,j)-(i+1,j)
        eR = 2 * (j * vx + i + 1) + 1, // right: (i+1,j)-(i+1,j+1)
        eB = 2 * ((j + 1) * vx + i), // bottom: (i,j+1)-(i+1,j+1)
        eL = 2 * k + 1; // left: (i,j)-(i,j+1)
      const add = (p: number, q: number): void => {
        segA.push(p);
        segB.push(q);
      };
      switch (code) {
        case 1:
        case 14:
          add(eL, eT);
          break;
        case 2:
        case 13:
          add(eT, eR);
          break;
        case 3:
        case 12:
          add(eL, eR);
          break;
        case 4:
        case 11:
          add(eR, eB);
          break;
        case 6:
        case 9:
          add(eT, eB);
          break;
        case 7:
        case 8:
          add(eL, eB);
          break;
        case 5:
          add(eL, eT);
          add(eR, eB);
          break;
        case 10:
          add(eT, eR);
          add(eL, eB);
          break;
      }
    }
  }
  const point = (e: number): [number, number] => {
    const k = e >> 1;
    const i = k % vx,
      j = (k - i) / vx;
    const p = at(i, j);
    if ((e & 1) === 0) {
      const q = at(i + 1, j);
      const t = (level - p) / (q - p || 1e-9);
      return [x0 + (i + t) * cell, z0 + j * cell];
    }
    const q = at(i, j + 1);
    const t = (level - p) / (q - p || 1e-9);
    return [x0 + i * cell, z0 + (j + t) * cell];
  };
  // Chain the segments through their shared edge ids (each edge joins at most two).
  const byEdge = new Map<number, number[]>();
  for (let s = 0; s < segA.length; s++) {
    for (const e of [segA[s]!, segB[s]!]) {
      const l = byEdge.get(e);
      if (l) l.push(s);
      else byEdge.set(e, [s]);
    }
  }
  const used = new Uint8Array(segA.length);
  const extend = (from: number, out: number[]): void => {
    let e = from;
    for (;;) {
      let next = -1;
      for (const c of byEdge.get(e)!) if (!used[c]) next = c;
      if (next < 0) return;
      used[next] = 1;
      e = segA[next] === e ? segB[next]! : segA[next]!;
      out.push(e);
    }
  };
  const lines: Array<Array<[number, number]>> = [];
  for (let s = 0; s < segA.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const fwd: number[] = [segB[s]!];
    extend(segB[s]!, fwd);
    const back: number[] = [];
    extend(segA[s]!, back);
    const edges = [...back.reverse(), segA[s]!, ...fwd];
    lines.push(simplify(edges.map(point), tol));
  }
  return lines;
}

/** Douglas-Peucker. */
export function simplify(pts: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, az] = pts[a]!;
    const [bx, bz] = pts[b]!;
    const vx = bx - ax,
      vz = bz - az;
    const l = Math.hypot(vx, vz) || 1e-9;
    let best = -1,
      bi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, pz] = pts[i]!;
      const d = Math.abs((px - ax) * vz - (pz - az) * vx) / l;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > tol && bi > 0) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Splits a polyline into the runs where `ok(x, z)` holds (sampled every `step` metres), simplified. */
export function clipPolyline(pts: Array<[number, number]>, ok: (x: number, z: number) => boolean, step = 2, minLen = 8): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  let curLen = 0;
  const flush = (): void => {
    if (cur.length >= 2 && curLen >= minLen) out.push(simplify(cur, 0.25));
    cur = [];
    curLen = 0;
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i]!;
    const [bx, bz] = pts[i + 1]!;
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const t = k / n;
      const x = ax + (bx - ax) * t,
        z = az + (bz - az) * t;
      if (ok(x, z)) {
        const last = cur[cur.length - 1];
        if (last) curLen += Math.hypot(x - last[0], z - last[1]);
        cur.push([x, z]);
      } else flush();
    }
  }
  flush();
  return out;
}

export interface BspOptions {
  rng: Rng;
  arterials: readonly Arterial[];
  /** Leaf size where splitting stops (random per cell in [lo, hi]). */
  stopSize: (cx: number, cz: number) => [number, number];
  /** Where a street may run (clips each cut). */
  streetOk: (x: number, z: number, halfWidth: number) => boolean;
}

export interface BspResult {
  /** Leaf rectangles, curb to curb (before validity shrinking). */
  leaves: Rect[];
  roads: RoadPiece[];
}

/**
 * Recursive axis-aligned partition of `root`. A hand-laid arterial crossing
 * a cell over at least 40 % of its extent forces the cut along it;
 * otherwise the cut lands at 35-65 % of the longer side, ±6 m. Each cut is
 * a street (11-14 m, cars) or a lane (6-8 m, no cars); 15 % of lanes stop
 * short (dead ends). Streets are clipped where `streetOk` fails (water,
 * landmarks, parks), so they end in T-junctions there.
 */
export function bsp(root: Rect, o: BspOptions): BspResult {
  const leaves: Rect[] = [];
  const roads: RoadPiece[] = [];
  const rng = o.rng;
  const split = (r: Rect, depth: number): void => {
    const w = r.maxX - r.minX,
      d = r.maxZ - r.minZ;
    const [lo, hi] = o.stopSize((r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2);
    const stop = rng.range(lo, hi);
    // Forced cut along an arterial.
    let forced: Arterial | null = null;
    let bestFrac = 0.4;
    for (const a of o.arterials) {
      const [pMin, pMax, sMin, sMax] = a.axis === 'x' ? [r.minX, r.maxX, r.minZ, r.maxZ] : [r.minZ, r.maxZ, r.minX, r.maxX];
      if (a.at < pMin + a.width / 2 + 12 || a.at > pMax - a.width / 2 - 12) continue;
      const ov = Math.min(sMax, a.to) - Math.max(sMin, a.from);
      const frac = ov / (sMax - sMin);
      if (frac > bestFrac) {
        bestFrac = frac;
        forced = a;
      }
    }
    if (!forced && (Math.max(w, d) < stop || depth > 14)) {
      leaves.push(r);
      return;
    }
    let axis: 'x' | 'z';
    let at: number;
    let width: number;
    let cls: 0 | 1 | 2 | 3;
    let cars: boolean;
    if (forced) {
      axis = forced.axis;
      at = forced.at;
      width = forced.width;
      cls = forced.cls;
      cars = forced.cars;
    } else {
      // Cut across the longer side (x-cut splits the width).
      axis = w > d * 1.15 ? 'x' : d > w * 1.15 ? 'z' : rng.chance(0.5) ? 'x' : 'z';
      const [pMin, pMax] = axis === 'x' ? [r.minX, r.maxX] : [r.minZ, r.maxZ];
      at = pMin + (pMax - pMin) * rng.range(0.35, 0.65) + rng.range(-6, 6);
      const street = rng.chance(0.62);
      width = street ? rng.range(11, 14) : rng.range(6, 8);
      cls = street ? 1 : 0;
      cars = street;
    }
    const half = width / 2;
    const [pMin, pMax] = axis === 'x' ? [r.minX, r.maxX] : [r.minZ, r.maxZ];
    if (at - half - pMin < 8 || pMax - (at + half) < 8) {
      leaves.push(r);
      return;
    }
    // The street along the cut (lanes may stop short), clipped where streets may not run.
    let s0 = axis === 'x' ? r.minZ : r.minX,
      s1 = axis === 'x' ? r.maxZ : r.maxX;
    if (cls === 0 && rng.chance(0.15)) {
      const keep = rng.range(0.55, 0.85) * (s1 - s0);
      if (rng.chance(0.5)) s1 = s0 + keep;
      else s0 = s1 - keep;
    }
    const line: Array<[number, number]> = axis === 'x' ? [[at, s0], [at, s1]] : [[s0, at], [s1, at]];
    if (forced) {
      // The arterial's own range is laid separately; past its ends the cut is a plain street.
      const lo = Math.min(forced.from, forced.to) - 1,
        hi = Math.max(forced.from, forced.to) + 1;
      const outside = (x: number, z: number): boolean => {
        const sv = axis === 'x' ? z : x;
        return (sv < lo || sv > hi) && o.streetOk(x, z, 6);
      };
      for (const pts of clipPolyline(line, outside, 2, 10)) roads.push({ pts, width: 12, cls: 1, cars: true });
    } else {
      for (const pts of clipPolyline(line, (x, z) => o.streetOk(x, z, half), 2, 10)) roads.push({ pts, width, cls, cars });
    }
    const a: Rect = axis === 'x' ? { ...r, maxX: at - half } : { ...r, maxZ: at - half };
    const b: Rect = axis === 'x' ? { ...r, minX: at + half } : { ...r, minZ: at + half };
    split(a, depth + 1);
    split(b, depth + 1);
  };
  split(root, 0);
  return { leaves, roads };
}

/**
 * Largest axis-aligned rectangle of valid samples inside `r` (samples on a
 * `step` lattice, half a step in from the edges). Null when nothing at least
 * `minSide` wide is valid.
 */
export function largestValidRect(r: Rect, ok: (x: number, z: number) => boolean, step = 2, minSide = 10): Rect | null {
  const nx = Math.floor((r.maxX - r.minX) / step),
    nz = Math.floor((r.maxZ - r.minZ) / step);
  if (nx < 1 || nz < 1) return null;
  const okv = new Uint8Array(nx * nz);
  let all = true;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const v = ok(r.minX + (i + 0.5) * step, r.minZ + (j + 0.5) * step) ? 1 : 0;
      okv[j * nx + i] = v;
      if (!v) all = false;
    }
  }
  if (all) return { ...r };
  // Maximal rectangle by histograms (row by row).
  const hgt = new Int32Array(nx);
  let bestA = 0,
    best: [number, number, number, number] | null = null;
  const stack: number[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) hgt[i] = okv[j * nx + i] ? hgt[i]! + 1 : 0;
    stack.length = 0;
    for (let i = 0; i <= nx; i++) {
      const hcur = i < nx ? hgt[i]! : 0;
      while (stack.length && hgt[stack[stack.length - 1]!]! >= hcur) {
        const top = stack.pop()!;
        const hh = hgt[top]!;
        const left = stack.length ? stack[stack.length - 1]! + 1 : 0;
        const wdt = i - left;
        // Prefer areas whose shorter side is big enough.
        if (hh * step >= minSide && wdt * step >= minSide && hh * wdt > bestA) {
          bestA = hh * wdt;
          best = [left, j - hh + 1, i - 1, j];
        }
      }
      stack.push(i);
    }
  }
  if (!best) return null;
  const [i0, j0, i1, j1] = best;
  // Back off the cells' outer half step only on sides that lost samples (keep curb lines where possible).
  return {
    minX: i0 === 0 ? r.minX : r.minX + i0 * step,
    maxX: i1 === nx - 1 ? r.maxX : r.minX + (i1 + 1) * step,
    minZ: j0 === 0 ? r.minZ : r.minZ + j0 * step,
    maxZ: j1 === nz - 1 ? r.maxZ : r.minZ + (j1 + 1) * step,
  };
}
