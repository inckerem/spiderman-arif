import type { Rect } from '../world/types';

export type Polygon = ReadonlyArray<readonly [number, number]>;

/**
 * Land polygons with a bucket grid: water is everything outside them. Each
 * 16 m cell is land, water or mixed (with the polygon edges that touch it).
 * Mixed cells answer exactly: the land state of the cell centre is known,
 * and every edge crossing the short segment from the centre to the query
 * point flips it (the segment stays inside the cell, so only the cell's own
 * edges can cross it). Polygons must not overlap.
 */
export class WaterMask {
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  /** Edges as x0, z0, x1, z1. */
  readonly edges: Float64Array;
  readonly edgeCount: number;
  /** 0 water, 1 land, 2 mixed. */
  private readonly state: Uint8Array;
  /** Land state of each mixed cell's reference point (exact). */
  private readonly centerLand: Uint8Array;
  /** Reference point of each cell (x, z): kept clear of the cell's edges, so its state is never ambiguous. */
  private readonly ref: Float64Array;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;

  constructor(
    readonly polygons: readonly Polygon[],
    extent: Rect,
    cell = 16,
  ) {
    this.cell = cell;
    this.x0 = extent.minX;
    this.z0 = extent.minZ;
    this.nx = Math.ceil((extent.maxX - extent.minX) / cell);
    this.nz = Math.ceil((extent.maxZ - extent.minZ) / cell);
    let n = 0;
    for (const p of polygons) n += p.length;
    this.edgeCount = n;
    const e = new Float64Array(n * 4);
    let k = 0;
    for (const p of polygons) {
      for (let i = 0; i < p.length; i++) {
        const a = p[i]!,
          b = p[(i + 1) % p.length]!;
        e[k++] = a[0];
        e[k++] = a[1];
        e[k++] = b[0];
        e[k++] = b[1];
      }
    }
    this.edges = e;
    // Bucket the edges by the cells their bounding box touches (a superset is fine).
    const ncell = this.nx * this.nz;
    const counts = new Int32Array(ncell);
    const forCells = (i: number, fn: (c: number) => void): void => {
      const o = i * 4;
      const ax = Math.min(e[o]!, e[o + 2]!),
        bx = Math.max(e[o]!, e[o + 2]!);
      const az = Math.min(e[o + 1]!, e[o + 3]!),
        bz = Math.max(e[o + 1]!, e[o + 3]!);
      const cx0 = Math.max(0, Math.floor((ax - this.x0) / cell)),
        cx1 = Math.min(this.nx - 1, Math.floor((bx - this.x0) / cell));
      const cz0 = Math.max(0, Math.floor((az - this.z0) / cell)),
        cz1 = Math.min(this.nz - 1, Math.floor((bz - this.z0) / cell));
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          // Keep only cells the segment really passes near (cheap slab test on the cell box).
          if (segmentHitsBox(e[o]!, e[o + 1]!, e[o + 2]!, e[o + 3]!, this.x0 + cx * cell, this.z0 + cz * cell, cell)) fn(cz * this.nx + cx);
        }
      }
    };
    for (let i = 0; i < n; i++) forCells(i, (c) => counts[c]!++);
    const start = new Int32Array(ncell + 1);
    for (let c = 0; c < ncell; c++) start[c + 1] = start[c]! + counts[c]!;
    const items = new Int32Array(start[ncell]!);
    const fill = new Int32Array(ncell);
    for (let i = 0; i < n; i++) forCells(i, (c) => (items[start[c]! + fill[c]!++] = i));
    this.cellStart = start;
    this.cellItems = items;
    this.state = new Uint8Array(ncell);
    this.centerLand = new Uint8Array(ncell);
    this.ref = new Float64Array(ncell * 2);
    for (let cz = 0; cz < this.nz; cz++) {
      for (let cx = 0; cx < this.nx; cx++) {
        const c = cz * this.nx + cx;
        // Of a 5 x 5 lattice inside the cell, the point farthest from the cell's edges.
        let rx = this.x0 + (cx + 0.5) * cell,
          rz = this.z0 + (cz + 0.5) * cell;
        if (start[c + 1]! > start[c]!) {
          let bestD = -1;
          for (let a = 0; a < 5; a++) {
            for (let b = 0; b < 5; b++) {
              const px = this.x0 + (cx + 0.1 + a * 0.2) * cell,
                pz = this.z0 + (cz + 0.1 + b * 0.2) * cell;
              let dmin = Infinity;
              for (let k = start[c]!; k < start[c + 1]!; k++) dmin = Math.min(dmin, segDist(e, items[k]!, px, pz));
              if (dmin > bestD) {
                bestD = dmin;
                rx = px;
                rz = pz;
              }
            }
          }
        }
        this.ref[c * 2] = rx;
        this.ref[c * 2 + 1] = rz;
        const land = this.insideBrute(rx, rz);
        this.centerLand[c] = land ? 1 : 0;
        this.state[c] = start[c + 1]! > start[c]! ? 2 : land ? 1 : 0;
      }
    }
  }

  /** Plain even-odd point-in-polygon over every edge (reference and fallback outside the grid). */
  insideBrute(x: number, z: number): boolean {
    const e = this.edges;
    let inside = false;
    for (let i = 0; i < this.edgeCount; i++) {
      const o = i * 4;
      const az = e[o + 1]!,
        bz = e[o + 3]!;
      if (az > z !== bz > z) {
        const ax = e[o]!,
          bx = e[o + 2]!;
        if (x < ax + ((z - az) * (bx - ax)) / (bz - az)) inside = !inside;
      }
    }
    return inside;
  }

  isLand(x: number, z: number): boolean {
    const cs = this.cell;
    const cx = Math.floor((x - this.x0) / cs),
      cz = Math.floor((z - this.z0) / cs);
    if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) return this.insideBrute(x, z);
    const c = cz * this.nx + cx;
    const st = this.state[c]!;
    if (st !== 2) return st === 1;
    // Mixed: flip the centre's state for every edge crossing centre -> point.
    const px = this.ref[c * 2]!,
      pz = this.ref[c * 2 + 1]!;
    let land = this.centerLand[c] === 1;
    const e = this.edges;
    for (let k = this.cellStart[c]!, end = this.cellStart[c + 1]!; k < end; k++) {
      const o = this.cellItems[k]! * 4;
      if (segmentsCross(px, pz, x, z, e[o]!, e[o + 1]!, e[o + 2]!, e[o + 3]!)) land = !land;
    }
    return land;
  }

  isWater(x: number, z: number): boolean {
    return !this.isLand(x, z);
  }

  /**
   * Nearest point on any shore edge (searching outward cell ring by cell
   * ring). Writes the point and returns the distance (Infinity if none within `maxR`).
   */
  nearestShore(x: number, z: number, out: { x: number; z: number }, maxR = 600): number {
    const cs = this.cell;
    const cx = Math.floor((x - this.x0) / cs),
      cz = Math.floor((z - this.z0) / cs);
    let best = Infinity;
    const e = this.edges;
    const test = (c: number): void => {
      for (let k = this.cellStart[c]!, end = this.cellStart[c + 1]!; k < end; k++) {
        const o = this.cellItems[k]! * 4;
        const ax = e[o]!,
          az = e[o + 1]!,
          bx = e[o + 2]!,
          bz = e[o + 3]!;
        const vx = bx - ax,
          vz = bz - az;
        const l2 = vx * vx + vz * vz || 1;
        let t = ((x - ax) * vx + (z - az) * vz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + vx * t,
          qz = az + vz * t;
        const d = Math.hypot(x - qx, z - qz);
        if (d < best) {
          best = d;
          out.x = qx;
          out.z = qz;
        }
      }
    };
    const rings = Math.ceil(maxR / cs);
    for (let r = 0; r <= rings; r++) {
      if (best < (r - 1) * cs) break;
      for (let j = cz - r; j <= cz + r; j++) {
        if (j < 0 || j >= this.nz) continue;
        for (let i = cx - r; i <= cx + r; i++) {
          if (i < 0 || i >= this.nx) continue;
          if (Math.max(Math.abs(i - cx), Math.abs(j - cz)) !== r) continue;
          test(j * this.nx + i);
        }
      }
    }
    return best;
  }
}

/** Distance from (x, z) to edge i. */
function segDist(e: Float64Array, i: number, x: number, z: number): number {
  const o = i * 4;
  const ax = e[o]!,
    az = e[o + 1]!;
  const vx = e[o + 2]! - ax,
    vz = e[o + 3]! - az;
  const l2 = vx * vx + vz * vz || 1;
  let t = ((x - ax) * vx + (z - az) * vz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - ax - vx * t, z - az - vz * t);
}

/** Proper intersection of segments p0-p1 and q0-q1 (endpoints on the half-open convention of the even-odd test). */
function segmentsCross(p0x: number, p0z: number, p1x: number, p1z: number, q0x: number, q0z: number, q1x: number, q1z: number): boolean {
  const d1 = orient(q0x, q0z, q1x, q1z, p0x, p0z);
  const d2 = orient(q0x, q0z, q1x, q1z, p1x, p1z);
  if (d1 > 0 === d2 > 0) return false;
  const d3 = orient(p0x, p0z, p1x, p1z, q0x, q0z);
  const d4 = orient(p0x, p0z, p1x, p1z, q1x, q1z);
  return d3 > 0 !== d4 > 0;
}

function orient(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

/** Does the segment touch the square cell [x, x+s] x [z, z+s] (slightly grown)? */
function segmentHitsBox(ax: number, az: number, bx: number, bz: number, x: number, z: number, s: number): boolean {
  const eps = 1e-6;
  const minX = x - eps,
    maxX = x + s + eps,
    minZ = z - eps,
    maxZ = z + s + eps;
  let t0 = 0,
    t1 = 1;
  const dx = bx - ax,
    dz = bz - az;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, ax - minX) && clip(dx, maxX - ax) && clip(-dz, az - minZ) && clip(dz, maxZ - az);
}
