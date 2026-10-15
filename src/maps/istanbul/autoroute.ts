import type { CityLayout } from '../../world/types';
import type { XZ } from '../types';
import { istanbulTerrain } from './gen';

/**
 * Autopilot legs on Istanbul (M13 §3): A* over a graph of the roads (points
 * every 25 m along every road piece, joined where pieces meet) plus the
 * Haliç Metro Bridge, the one Golden Horn crossing with anchors all the way
 * (pylons and stays). Street canyons have facades on both sides to swing
 * from; the coastal roads have water on one side, so they cost more.
 */

/**
 * Bridge links for the autopilot, from deck end to deck end so the leg runs
 * on the deck, between its stays, never under it: the Haliç Metro deck meets
 * the third hill in the south and reaches the street at its ramp foot in the north.
 */
function bridgeLinks(L: CityLayout): Array<[number, number, number, number]> {
  const t = istanbulTerrain(L);
  let zS = 140;
  for (let z = 60; z <= 140; z += 1) {
    if (t.baseHeight(-275, z) + 0.15 >= 12.75) {
      zS = z;
      break;
    }
  }
  return [[-275, zS + 6, -275, -218]];
}

interface Graph {
  x: Float64Array;
  z: Float64Array;
  adj: number[][];
  cost: number[][];
  /** Bucket grid (32 m) for the nearest node. */
  cells: Map<number, number[]>;
  /** Connected component of each node; legs use the largest one only. */
  comp: Int32Array;
  main: number;
}

const GRAPHS = new WeakMap<CityLayout, Graph>();
const CELL = 32;
const key = (cx: number, cz: number): number => (cx + 1000) * 4096 + (cz + 1000);

function build(L: CityLayout): Graph {
  const xs: number[] = [];
  const zs: number[] = [];
  const adj: number[][] = [];
  const cost: number[][] = [];
  const cells = new Map<number, number[]>();
  const node = (x: number, z: number): number => {
    const id = xs.length;
    xs.push(x);
    zs.push(z);
    adj.push([]);
    cost.push([]);
    const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    const l = cells.get(k);
    if (l) l.push(id);
    else cells.set(k, [id]);
    return id;
  };
  const link = (a: number, b: number, w: number): void => {
    const d = Math.hypot(xs[a]! - xs[b]!, zs[a]! - zs[b]!) * w;
    adj[a]!.push(b);
    cost[a]!.push(d);
    adj[b]!.push(a);
    cost[b]!.push(d);
  };
  const near = (x: number, z: number, r: number, skip: (i: number) => boolean): number[] => {
    const out: number[] = [];
    const c0 = Math.floor((x - r) / CELL),
      c1 = Math.floor((x + r) / CELL),
      d0 = Math.floor((z - r) / CELL),
      d1 = Math.floor((z + r) / CELL);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = d0; cz <= d1; cz++) {
        for (const i of cells.get(key(cx, cz)) ?? []) if (!skip(i) && Math.hypot(xs[i]! - x, zs[i]! - z) <= r) out.push(i);
      }
    }
    return out;
  };
  const pieceOf: number[] = [];
  (L.roads ?? []).forEach((r, ri) => {
    // Coastal roads cost more: water on one side means half the anchors.
    const w = r.cls === 3 ? 1.6 : r.cls === 0 ? 1.15 : 1;
    let prev = -1;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i]!;
      const [bx, bz] = r.pts[i + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(len / 25));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) {
        const id = node(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
        pieceOf[id] = ri;
        if (prev >= 0) link(prev, id, w);
        prev = id;
      }
    }
  });
  // Junctions: nodes of different pieces within 16 m.
  for (let i = 0; i < xs.length; i++) {
    for (const j of near(xs[i]!, zs[i]!, 16, (q) => q <= i || pieceOf[q] === pieceOf[i])) link(i, j, 1);
  }
  for (const [ax, az, bx, bz] of bridgeLinks(L)) {
    const a = node(ax, az),
      b = node(bx, bz);
    link(a, b, 1);
    for (const j of near(ax, az, 40, (q) => q === a || q === b)) link(a, j, 1);
    for (const j of near(bx, bz, 40, (q) => q === a || q === b)) link(b, j, 1);
  }
  // Components (a few short road pieces stand alone, e.g. inside a park).
  const comp = new Int32Array(xs.length).fill(-1);
  const sizes: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (comp[i]! >= 0) continue;
    const c = sizes.length;
    let size = 0;
    const stack = [i];
    comp[i] = c;
    while (stack.length) {
      const u = stack.pop()!;
      size++;
      for (const v of adj[u]!) {
        if (comp[v]! < 0) {
          comp[v] = c;
          stack.push(v);
        }
      }
    }
    sizes.push(size);
  }
  let main = 0;
  for (let c = 1; c < sizes.length; c++) if (sizes[c]! > sizes[main]!) main = c;
  return { x: Float64Array.from(xs), z: Float64Array.from(zs), adj, cost, cells, comp, main };
}

function nearest(g: Graph, x: number, z: number): number {
  let best = -1,
    bd = Infinity;
  for (let r = 0; r < 12 && best < 0; r++) {
    const c = Math.floor(x / CELL),
      d = Math.floor(z / CELL);
    for (let cx = c - r; cx <= c + r; cx++) {
      for (let cz = d - r; cz <= d + r; cz++) {
        if (Math.max(Math.abs(cx - c), Math.abs(cz - d)) !== r) continue;
        for (const i of g.cells.get(key(cx, cz)) ?? []) {
          if (g.comp[i] !== g.main) continue;
          const dd = Math.hypot(g.x[i]! - x, g.z[i]! - z);
          if (dd < bd) {
            bd = dd;
            best = i;
          }
        }
      }
    }
  }
  return best;
}

/** A* from the node nearest a to the node nearest b; the node path (empty when unreachable). */
function astar(g: Graph, s: number, t: number): number[] {
  const n = g.x.length;
  const gs = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const open: number[] = [s];
  const fs = new Float64Array(n).fill(Infinity);
  gs[s] = 0;
  fs[s] = Math.hypot(g.x[s]! - g.x[t]!, g.z[s]! - g.z[t]!);
  const closed = new Uint8Array(n);
  while (open.length) {
    // Binary heap would be faster; the graph is small enough for a linear pick.
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (fs[open[i]!]! < fs[open[bi]!]!) bi = i;
    const u = open[bi]!;
    open[bi] = open[open.length - 1]!;
    open.pop();
    if (u === t) break;
    if (closed[u]) continue;
    closed[u] = 1;
    const a = g.adj[u]!,
      c = g.cost[u]!;
    for (let k = 0; k < a.length; k++) {
      const v = a[k]!;
      const ng = gs[u]! + c[k]!;
      if (ng < gs[v]!) {
        gs[v] = ng;
        from[v] = u;
        fs[v] = ng + Math.hypot(g.x[v]! - g.x[t]!, g.z[v]! - g.z[t]!);
        open.push(v);
      }
    }
  }
  if (from[t] < 0 && s !== t) return [];
  const path: number[] = [];
  for (let v = t; v >= 0; v = from[v]!) path.push(v);
  return path.reverse();
}

/** Douglas-Peucker on XZ points down to at most `max` points. */
function reduce(pts: XZ[], max: number): XZ[] {
  let tol = 4;
  let out = pts;
  while (out.length > max) {
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop()!;
      const [ax, az] = pts[a]!,
        [bx, bz] = pts[b]!;
      const l = Math.hypot(bx - ax, bz - az) || 1e-9;
      let bd = -1,
        bi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((pts[i]![0] - ax) * (bz - az) - (pts[i]![1] - az) * (bx - ax)) / l;
        if (d > bd) {
          bd = d;
          bi = i;
        }
      }
      if (bd > tol && bi > 0) {
        keep[bi] = 1;
        stack.push([a, bi], [bi, b]);
      }
    }
    out = pts.filter((_, i) => keep[i]);
    tol *= 1.6;
  }
  return out;
}

/** Writes the leg into `out` (start, road points, goal); returns the point count. */
export function istanbulRoute(L: CityLayout, ax: number, az: number, bx: number, bz: number, out: XZ[]): number {
  let g = GRAPHS.get(L);
  if (!g) {
    g = build(L);
    GRAPHS.set(L, g);
  }
  const s = nearest(g, ax, az),
    t = nearest(g, bx, bz);
  const pts: XZ[] = [[ax, az]];
  if (s >= 0 && t >= 0 && s !== t) {
    for (const v of astar(g, s, t)) pts.push([g.x[v]!, g.z[v]!]);
  }
  pts.push([bx, bz]);
  const red = reduce(pts, out.length);
  let n = 0;
  for (const [x, z] of red) {
    const last = n > 0 ? out[n - 1]! : null;
    if (last && Math.hypot(last[0] - x, last[1] - z) < 8) continue;
    out[n]![0] = x;
    out[n]![1] = z;
    n++;
  }
  if (n < 2) {
    out[1]![0] = bx + 1;
    out[1]![1] = bz;
    n = 2;
  }
  return n;
}
