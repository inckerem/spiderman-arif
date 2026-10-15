import type { Rect } from '../world/types';

/** A straight piece of road: centre line from a to b and its full width. */
export interface RoadSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  width: number;
}

/**
 * Road segments bucketed in 16 m cells: a point is on a road when it lies
 * within half the width of a segment's centre line. Bridge decks are not
 * in it (they are colliders).
 */
export class RoadIndex {
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  private readonly seg: Float64Array;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;
  readonly count: number;

  constructor(segments: readonly RoadSegment[], extent: Rect, cell = 16) {
    this.cell = cell;
    this.x0 = extent.minX;
    this.z0 = extent.minZ;
    this.nx = Math.ceil((extent.maxX - extent.minX) / cell);
    this.nz = Math.ceil((extent.maxZ - extent.minZ) / cell);
    this.count = segments.length;
    const s = new Float64Array(segments.length * 5);
    segments.forEach((r, i) => s.set([r.ax, r.az, r.bx, r.bz, r.width / 2], i * 5));
    this.seg = s;
    const ncell = this.nx * this.nz;
    const counts = new Int32Array(ncell);
    const each = (i: number, fn: (c: number) => void): void => {
      const o = i * 5;
      const h = s[o + 4]!;
      const cx0 = Math.max(0, Math.floor((Math.min(s[o]!, s[o + 2]!) - h - this.x0) / cell));
      const cx1 = Math.min(this.nx - 1, Math.floor((Math.max(s[o]!, s[o + 2]!) + h - this.x0) / cell));
      const cz0 = Math.max(0, Math.floor((Math.min(s[o + 1]!, s[o + 3]!) - h - this.z0) / cell));
      const cz1 = Math.min(this.nz - 1, Math.floor((Math.max(s[o + 1]!, s[o + 3]!) + h - this.z0) / cell));
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) fn(cz * this.nx + cx);
    };
    for (let i = 0; i < segments.length; i++) each(i, (c) => counts[c]!++);
    const start = new Int32Array(ncell + 1);
    for (let c = 0; c < ncell; c++) start[c + 1] = start[c]! + counts[c]!;
    const items = new Int32Array(start[ncell]!);
    const fill = new Int32Array(ncell);
    for (let i = 0; i < segments.length; i++) each(i, (c) => (items[start[c]! + fill[c]!++] = i));
    this.cellStart = start;
    this.cellItems = items;
  }

  /** Distance from (x, z) to the centre line of segment i. */
  private dist(i: number, x: number, z: number): number {
    const s = this.seg,
      o = i * 5;
    const ax = s[o]!,
      az = s[o + 1]!;
    const vx = s[o + 2]! - ax,
      vz = s[o + 3]! - az;
    const l2 = vx * vx + vz * vz;
    let t = l2 > 0 ? ((x - ax) * vx + (z - az) * vz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(x - ax - vx * t, z - az - vz * t);
  }

  isRoad(x: number, z: number): boolean {
    const cx = Math.floor((x - this.x0) / this.cell),
      cz = Math.floor((z - this.z0) / this.cell);
    if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) return false;
    const c = cz * this.nx + cx;
    for (let k = this.cellStart[c]!, e = this.cellStart[c + 1]!; k < e; k++) {
      const i = this.cellItems[k]!;
      if (this.dist(i, x, z) <= this.seg[i * 5 + 4]!) return true;
    }
    return false;
  }

  /** Plain check over every segment (reference for the self-test). */
  isRoadBrute(x: number, z: number): boolean {
    for (let i = 0; i < this.count; i++) if (this.dist(i, x, z) <= this.seg[i * 5 + 4]!) return true;
    return false;
  }
}

/** Axis-aligned rectangles bucketed in 16 m cells (raised blocks, plazas, parks). */
export class RectIndex {
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  private readonly r: Float64Array;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;

  constructor(rects: readonly Rect[], extent: Rect, cell = 16) {
    this.cell = cell;
    this.x0 = extent.minX;
    this.z0 = extent.minZ;
    this.nx = Math.ceil((extent.maxX - extent.minX) / cell);
    this.nz = Math.ceil((extent.maxZ - extent.minZ) / cell);
    const r = new Float64Array(rects.length * 4);
    rects.forEach((q, i) => r.set([q.minX, q.minZ, q.maxX, q.maxZ], i * 4));
    this.r = r;
    const ncell = this.nx * this.nz;
    const counts = new Int32Array(ncell);
    const each = (i: number, fn: (c: number) => void): void => {
      const o = i * 4;
      const cx0 = Math.max(0, Math.floor((r[o]! - this.x0) / cell)),
        cx1 = Math.min(this.nx - 1, Math.floor((r[o + 2]! - this.x0) / cell));
      const cz0 = Math.max(0, Math.floor((r[o + 1]! - this.z0) / cell)),
        cz1 = Math.min(this.nz - 1, Math.floor((r[o + 3]! - this.z0) / cell));
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) fn(cz * this.nx + cx);
    };
    for (let i = 0; i < rects.length; i++) each(i, (c) => counts[c]!++);
    const start = new Int32Array(ncell + 1);
    for (let c = 0; c < ncell; c++) start[c + 1] = start[c]! + counts[c]!;
    const items = new Int32Array(start[ncell]!);
    const fill = new Int32Array(ncell);
    for (let i = 0; i < rects.length; i++) each(i, (c) => (items[start[c]! + fill[c]!++] = i));
    this.cellStart = start;
    this.cellItems = items;
  }

  /** Index of a rectangle containing (x, z) (edges included), -1 if none. */
  find(x: number, z: number): number {
    const cx = Math.floor((x - this.x0) / this.cell),
      cz = Math.floor((z - this.z0) / this.cell);
    if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) return -1;
    const c = cz * this.nx + cx;
    const r = this.r;
    for (let k = this.cellStart[c]!, e = this.cellStart[c + 1]!; k < e; k++) {
      const o = this.cellItems[k]! * 4;
      if (x >= r[o]! && x <= r[o + 2]! && z >= r[o + 1]! && z <= r[o + 3]!) return this.cellItems[k]!;
    }
    return -1;
  }

  contains(x: number, z: number): boolean {
    return this.find(x, z) >= 0;
  }
}
