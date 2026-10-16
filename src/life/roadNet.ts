import type { CityLayout, Road } from '../world/types';

/**
 * Lane graph for traffic (M13 §4e), built from any road layout: the
 * avenue x street grid (Manhattan, with exactly the links the grid traffic
 * always had) or road centre polylines (Istanbul: nodes at crossings,
 * T-junctions and dead ends). Each link is one right-hand lane as a
 * polyline from just past its start junction to the stop line of its end
 * junction. Pure data, no rendering.
 */

export interface LaneNode {
  x: number;
  z: number;
  /** Outgoing link ids. */
  out: number[];
  /** Has traffic lights (north-south and east-west phases). */
  signal: boolean;
  /** Green-wave phase offset (s). */
  offset: number;
}

export interface LaneLink {
  from: number;
  to: number;
  /** Lane polyline: x, z pairs. */
  pts: Float64Array;
  /** Cumulative length at each point. */
  cum: Float64Array;
  len: number;
  /** Unit heading at the start and at the end. */
  sx: number;
  sz: number;
  ex: number;
  ez: number;
}

export interface LaneNet {
  nodes: LaneNode[];
  links: LaneLink[];
}

/** Traffic light cycle (s), shared with the traffic system. */
export const SIGNAL_CYCLE = 26;

function makeLink(from: number, to: number, pts: number[]): LaneLink | null {
  const n = pts.length / 2;
  if (n < 2) return null;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1]! + Math.hypot(pts[i * 2]! - pts[i * 2 - 2]!, pts[i * 2 + 1]! - pts[i * 2 - 1]!);
  const len = cum[n - 1]!;
  const d0 = Math.hypot(pts[2]! - pts[0]!, pts[3]! - pts[1]!) || 1;
  const d1 = Math.hypot(pts[n * 2 - 2]! - pts[n * 2 - 4]!, pts[n * 2 - 1]! - pts[n * 2 - 3]!) || 1;
  return {
    from,
    to,
    pts: Float64Array.from(pts),
    cum,
    len,
    sx: (pts[2]! - pts[0]!) / d0,
    sz: (pts[3]! - pts[1]!) / d0,
    ex: (pts[n * 2 - 2]! - pts[n * 2 - 4]!) / d1,
    ez: (pts[n * 2 - 1]! - pts[n * 2 - 3]!) / d1,
  };
}

const DX = [0, 1, 0, -1];
const DZ = [-1, 0, 1, 0];

function laneOffset(r: Road): number {
  // Streets keep a parking lane at the curb; avenues use the inner lanes.
  return Math.min(4.2, Math.max(2.6, r.width * 0.17));
}

/** The street grid: one node per avenue x street, links between neighbours (none through the park interior). */
export function gridLaneNet(L: CityLayout): LaneNet {
  const nodes: LaneNode[] = [];
  const links: LaneLink[] = [];
  const P = L.park;
  const A = L.avenues,
    S = L.streets;
  const half: Array<[number, number]> = [];
  const inParkX = (x: number): boolean => x > P.minX + 1 && x < P.maxX - 1;
  const inParkZ = (z: number): boolean => z > P.minZ + 1 && z < P.maxZ - 1;
  const idx = (i: number, j: number): number => i * S.length + j;
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < S.length; j++) {
      nodes.push({ x: A[i]!.center, z: S[j]!.center, out: [], signal: true, offset: (i * 2.9 + j * 4.3) % SIGNAL_CYCLE });
      half.push([A[i]!.width / 2, S[j]!.width / 2]);
    }
  }
  const addLink = (a: number, b: number, dir: number, lane: number): void => {
    const na = nodes[a]!,
      nb = nodes[b]!;
    // Exit of A and stop line of B along the travel axis.
    const ha = dir % 2 === 0 ? half[a]![1] : half[a]![0];
    const hb = dir % 2 === 0 ? half[b]![1] : half[b]![0];
    const full = Math.abs(nb.x - na.x) + Math.abs(nb.z - na.z);
    const len = full - ha - hb;
    if (len < 6) return;
    // Right of travel: (-DZ, DX).
    const rx = -DZ[dir]!,
      rz = DX[dir]!;
    const sx = na.x + DX[dir]! * ha + rx * lane,
      sz = na.z + DZ[dir]! * ha + rz * lane;
    const l = makeLink(a, b, [sx, sz, sx + DX[dir]! * len, sz + DZ[dir]! * len])!;
    na.out.push(links.length);
    links.push(l);
  };
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < S.length - 1; j++) {
      const midZ = (S[j]!.center + S[j + 1]!.center) / 2;
      if (inParkX(A[i]!.center) && inParkZ(midZ)) continue;
      const lane = laneOffset(A[i]!);
      addLink(idx(i, j + 1), idx(i, j), 0, lane);
      addLink(idx(i, j), idx(i, j + 1), 2, lane);
    }
  }
  for (let j = 0; j < S.length; j++) {
    for (let i = 0; i < A.length - 1; i++) {
      const midX = (A[i]!.center + A[i + 1]!.center) / 2;
      if (inParkZ(S[j]!.center) && inParkX(midX)) continue;
      const lane = laneOffset(S[j]!);
      addLink(idx(i, j), idx(i + 1, j), 1, lane);
      addLink(idx(i + 1, j), idx(i, j), 3, lane);
    }
  }
  return { nodes, links };
}

interface Piece {
  pts: Array<[number, number]>;
  cum: number[];
  width: number;
  /** Split points: arc length and node id. */
  splits: Array<[number, number]>;
}

/** Closest point on a polyline: arc length and distance. */
function project(p: Piece, x: number, z: number): [number, number] {
  let best = Infinity,
    bs = 0;
  for (let i = 0; i + 1 < p.pts.length; i++) {
    const [ax, az] = p.pts[i]!;
    const [bx, bz] = p.pts[i + 1]!;
    const vx = bx - ax,
      vz = bz - az;
    const l2 = vx * vx + vz * vz;
    let t = l2 > 0 ? ((x - ax) * vx + (z - az) * vz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - ax - vx * t, z - az - vz * t);
    if (d < best) {
      best = d;
      bs = p.cum[i]! + Math.sqrt(l2) * t;
    }
  }
  return [bs, best];
}

/** Point at arc length s. */
function at(p: Piece, s: number): [number, number] {
  for (let i = 0; i + 1 < p.pts.length; i++) {
    if (s <= p.cum[i + 1]! || i + 2 === p.pts.length) {
      const seg = p.cum[i + 1]! - p.cum[i]!;
      const t = seg > 0 ? Math.max(0, Math.min(1, (s - p.cum[i]!) / seg)) : 0;
      return [p.pts[i]![0] + (p.pts[i + 1]![0] - p.pts[i]![0]) * t, p.pts[i]![1] + (p.pts[i + 1]![1] - p.pts[i]![1]) * t];
    }
  }
  return p.pts[p.pts.length - 1]!;
}

/** The part of a polyline between arc lengths s0 < s1. */
function slice(p: Piece, s0: number, s1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [at(p, s0)];
  for (let i = 1; i + 1 < p.pts.length; i++) if (p.cum[i]! > s0 + 0.01 && p.cum[i]! < s1 - 0.01) out.push(p.pts[i]!);
  out.push(at(p, s1));
  return out;
}

/** Polyline offset to the right of travel by `d`, then trimmed by `t0` at the start and `t1` at the end. */
function laneOf(c: Array<[number, number]>, d: number, t0: number, t1: number): number[] | null {
  const n = c.length;
  const off: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = c[Math.max(0, i - 1)]!,
      b = c[Math.min(n - 1, i + 1)]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    // Right of travel (x east, z south): (-dz, dx).
    off.push([c[i]![0] - ((b[1] - a[1]) / l) * d, c[i]![1] + ((b[0] - a[0]) / l) * d]);
  }
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1]! + Math.hypot(off[i]![0] - off[i - 1]![0], off[i]![1] - off[i - 1]![1]));
  const total = cum[n - 1]!;
  if (total - t0 - t1 < 6) return null;
  const P: Piece = { pts: off, cum, width: 0, splits: [] };
  const s = slice(P, t0, total - t1);
  const out: number[] = [];
  for (const [x, z] of s) out.push(x, z);
  return out;
}

/**
 * Lanes from road centre polylines (pieces that carry cars): nodes where a
 * piece ends on another (T-junction), where two cross, and at dead ends;
 * nodes closer than 8 m merge. Every stretch between two nodes is a lane each
 * way, trimmed to the junctions; junctions with three or more stretches have lights.
 */
export function pieceLaneNet(L: CityLayout): LaneNet {
  const pieces: Piece[] = [];
  for (const r of L.roads ?? []) {
    if (!r.cars || r.cls === 0 || r.pts.length < 2) continue;
    const cum = [0];
    for (let i = 1; i < r.pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(r.pts[i]![0] - r.pts[i - 1]![0], r.pts[i]![1] - r.pts[i - 1]![1]));
    pieces.push({ pts: r.pts.map((p) => [p[0], p[1]] as [number, number]), cum, width: r.width, splits: [] });
  }
  // Raw node points (merged below).
  const px: number[] = [];
  const pz: number[] = [];
  const point = (x: number, z: number): number => {
    for (let i = 0; i < px.length; i++) if (Math.hypot(px[i]! - x, pz[i]! - z) < 8) return i;
    px.push(x);
    pz.push(z);
    return px.length - 1;
  };
  pieces.forEach((p, i) => {
    const total = p.cum[p.cum.length - 1]!;
    for (const [s, e] of [
      [0, p.pts[0]!],
      [total, p.pts[p.pts.length - 1]!],
    ] as const) {
      // Ends on another piece: a T-junction at the projection.
      let bestJ = -1,
        bestS = 0,
        bestD = Infinity;
      pieces.forEach((q, j) => {
        if (j === i) return;
        const [qs, d] = project(q, e[0], e[1]);
        if (d <= q.width / 2 + 2.5 && d < bestD) {
          bestD = d;
          bestJ = j;
          bestS = qs;
        }
      });
      if (bestJ >= 0) {
        const q = pieces[bestJ]!;
        const [x, z] = at(q, bestS);
        const id = point(x, z);
        q.splits.push([bestS, id]);
        p.splits.push([s, id]);
      } else p.splits.push([s, point(e[0], e[1])]);
    }
  });
  // Crossings of interior segments (bounding boxes first).
  const box = pieces.map((p) => {
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const [x, z] of p.pts) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    return [x0, x1, z0, z1] as const;
  });
  for (let i = 0; i < pieces.length; i++) {
    const a = pieces[i]!;
    for (let j = i + 1; j < pieces.length; j++) {
      const b = pieces[j]!;
      const A = box[i]!,
        Bx = box[j]!;
      if (A[1] < Bx[0] || Bx[1] < A[0] || A[3] < Bx[2] || Bx[3] < A[2]) continue;
      for (let u = 0; u + 1 < a.pts.length; u++) {
        const [ax, az] = a.pts[u]!,
          [bx, bz] = a.pts[u + 1]!;
        for (let v = 0; v + 1 < b.pts.length; v++) {
          const [cx, cz] = b.pts[v]!,
            [dx, dz] = b.pts[v + 1]!;
          const rx = bx - ax,
            rz = bz - az,
            sx = dx - cx,
            sz = dz - cz;
          const den = rx * sz - rz * sx;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((cx - ax) * sz - (cz - az) * sx) / den,
            w = ((cx - ax) * rz - (cz - az) * rx) / den;
          if (t <= 0.001 || t >= 0.999 || w <= 0.001 || w >= 0.999) continue;
          const x = ax + rx * t,
            z = az + rz * t;
          const id = point(x, z);
          a.splits.push([a.cum[u]! + Math.hypot(rx, rz) * t, id]);
          b.splits.push([b.cum[v]! + Math.hypot(sx, sz) * w, id]);
        }
      }
    }
  }
  const nodes: LaneNode[] = px.map((x, i) => ({ x, z: pz[i]!, out: [], signal: false, offset: (x * 0.013 + pz[i]! * 0.021 + SIGNAL_CYCLE * 10) % SIGNAL_CYCLE }));
  // Stretches between consecutive nodes along each piece.
  const radius = new Float64Array(nodes.length).fill(4);
  const stretches: Array<{ a: number; b: number; c: Array<[number, number]>; width: number }> = [];
  const degree = new Int32Array(nodes.length);
  for (const p of pieces) {
    p.splits.sort((x, y) => x[0] - y[0]);
    for (let k = 0; k + 1 < p.splits.length; k++) {
      const [s0, a] = p.splits[k]!;
      const [s1, b] = p.splits[k + 1]!;
      if (a === b || s1 - s0 < 1) continue;
      // The piece's own geometry (merged node positions may sit a few metres off it).
      const c = slice(p, s0, s1);
      stretches.push({ a, b, c, width: p.width });
      degree[a]!++;
      degree[b]!++;
      radius[a] = Math.max(radius[a]!, p.width / 2 + 1);
      radius[b] = Math.max(radius[b]!, p.width / 2 + 1);
    }
  }
  const links: LaneLink[] = [];
  for (const st of stretches) {
    const lane = Math.min(4.2, Math.max(2.6, st.width * 0.17));
    for (const [from, to, c] of [
      [st.a, st.b, st.c],
      [st.b, st.a, [...st.c].reverse()],
    ] as const) {
      const pts = laneOf(c as Array<[number, number]>, lane, degree[from]! > 1 ? radius[from]! : 1, degree[to]! > 1 ? radius[to]! : 1);
      if (!pts) continue;
      const l = makeLink(from, to, pts);
      if (!l) continue;
      nodes[from]!.out.push(links.length);
      links.push(l);
    }
  }
  for (let i = 0; i < nodes.length; i++) nodes[i]!.signal = degree[i]! >= 3;
  return { nodes, links };
}

/** The lane graph of a layout: road pieces when it has them, the street grid otherwise. */
export function laneNetFor(L: CityLayout): LaneNet {
  return L.roads ? pieceLaneNet(L) : gridLaneNet(L);
}
