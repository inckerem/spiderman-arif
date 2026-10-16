import type { Vector3 } from 'three';
import { makeTerrainHit, type TerrainModel } from './terrain';

// Collider kinds
export const BOX = 0;
export const CYL = 1;
export const ELL = 2;

// Collider flags
export const F_ANCHOR = 1; // web lines may attach
export const F_CLIMB = 2; // wall cling surface
export const F_CAMERA = 4; // blocks the camera spring arm (thin props do not)
export const F_TREE = 8;
export const F_BUILDING = 16;
export const F_PROP = 32;
export const F_BRIDGE = 64;
export const F_CANOPY = 128;
export const F_LOW = 256; // low obstacle (vault candidates, never a swing anchor)

// Surface types (footsteps, audio)
export const SURF_CONCRETE = 0;
export const SURF_METAL = 1;
export const SURF_WOOD = 2;
export const SURF_GRASS = 3;
export const SURF_FOLIAGE = 4;
export const SURF_GLASS = 5;
export const SURF_STONE = 6;
export const SURF_GRAVEL = 7;
export const SURF_WATER = 8;

export interface RayHit {
  hit: boolean;
  t: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  /** Collider id, -1 for terrain, -2 for water. */
  id: number;
}

export function makeRayHit(): RayHit {
  return { hit: false, t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, id: -1 };
}

/** Summary of the contacts produced by one capsule resolution. */
export interface ContactSummary {
  ground: boolean;
  groundNY: number;
  groundId: number;
  groundSurface: number;
  wall: boolean;
  wallId: number;
  wallNX: number;
  wallNZ: number;
  wallClimbable: boolean;
  ceiling: boolean;
  anyId: number;
  maxDepth: number;
}

export function makeContactSummary(): ContactSummary {
  return {
    ground: false,
    groundNY: 0,
    groundId: -1,
    groundSurface: SURF_CONCRETE,
    wall: false,
    wallId: -1,
    wallNX: 0,
    wallNZ: 0,
    wallClimbable: false,
    ceiling: false,
    anyId: -1,
    maxDepth: 0,
  };
}

export function clearContactSummary(c: ContactSummary): void {
  c.ground = false;
  c.groundNY = 0;
  c.groundId = -1;
  c.groundSurface = SURF_CONCRETE;
  c.wall = false;
  c.wallId = -1;
  c.wallNX = 0;
  c.wallNZ = 0;
  c.wallClimbable = false;
  c.ceiling = false;
  c.anyId = -1;
  c.maxDepth = 0;
}

const EPS = 1e-6;

/**
 * Static collision world: analytic primitives in struct-of-arrays storage and
 * a uniform XZ grid for broad phase. Nothing allocates after `build()`.
 */
export class CollisionWorld {
  count = 0;
  private cap: number;
  kind: Uint8Array;
  flags: Uint16Array;
  surface: Uint8Array;
  owner: Int32Array;
  /** Shape parameters, 6 per collider (see add* methods). */
  p: Float32Array;
  /** World AABB, 6 per collider: minX, minY, minZ, maxX, maxY, maxZ. */
  bb: Float32Array;

  // Grid
  readonly cell = 16;
  readonly gx0: number;
  readonly gz0: number;
  readonly nx: number;
  readonly nz: number;
  private cellStart: Int32Array = new Int32Array(1);
  private cellItems: Int32Array = new Int32Array(1);
  private stamp: Uint32Array = new Uint32Array(1);
  private stampValue = 1;
  readonly queryBuf = new Int32Array(8192);
  private readonly terrainHit = makeTerrainHit();

  constructor(
    readonly terrain: TerrainModel,
    readonly minX: number,
    readonly minZ: number,
    readonly maxX: number,
    readonly maxZ: number,
    capacity = 32768,
  ) {
    this.cap = capacity;
    this.kind = new Uint8Array(capacity);
    this.flags = new Uint16Array(capacity);
    this.surface = new Uint8Array(capacity);
    this.owner = new Int32Array(capacity);
    this.p = new Float32Array(capacity * 6);
    this.bb = new Float32Array(capacity * 6);
    this.gx0 = minX;
    this.gz0 = minZ;
    this.nx = Math.ceil((maxX - minX) / this.cell);
    this.nz = Math.ceil((maxZ - minZ) / this.cell);
  }

  private grow(): void {
    const cap = this.cap * 2;
    const grow8 = (a: Uint8Array): Uint8Array => {
      const n = new Uint8Array(cap);
      n.set(a);
      return n;
    };
    this.kind = grow8(this.kind);
    this.surface = grow8(this.surface);
    const f = new Uint16Array(cap);
    f.set(this.flags);
    this.flags = f;
    const o = new Int32Array(cap);
    o.set(this.owner);
    this.owner = o;
    const p = new Float32Array(cap * 6);
    p.set(this.p);
    this.p = p;
    const bb = new Float32Array(cap * 6);
    bb.set(this.bb);
    this.bb = bb;
    this.cap = cap;
  }

  private alloc(kind: number, flags: number, surface: number, owner: number): number {
    if (this.count >= this.cap) this.grow();
    const id = this.count++;
    this.kind[id] = kind;
    this.flags[id] = flags;
    this.surface[id] = surface;
    this.owner[id] = owner;
    return id;
  }

  addBox(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    flags: number,
    surface: number,
    owner = -1,
  ): number {
    const id = this.alloc(BOX, flags, surface, owner);
    const o = id * 6;
    this.p[o] = minX;
    this.p[o + 1] = minY;
    this.p[o + 2] = minZ;
    this.p[o + 3] = maxX;
    this.p[o + 4] = maxY;
    this.p[o + 5] = maxZ;
    this.bb.set(this.p.subarray(o, o + 6), o);
    return id;
  }

  /** Vertical cylinder from y0 to y1. */
  addCylinder(
    cx: number,
    cz: number,
    y0: number,
    y1: number,
    r: number,
    flags: number,
    surface: number,
    owner = -1,
  ): number {
    const id = this.alloc(CYL, flags, surface, owner);
    const o = id * 6;
    this.p[o] = cx;
    this.p[o + 1] = y0;
    this.p[o + 2] = cz;
    this.p[o + 3] = y1;
    this.p[o + 4] = r;
    this.p[o + 5] = 0;
    this.bb[o] = cx - r;
    this.bb[o + 1] = y0;
    this.bb[o + 2] = cz - r;
    this.bb[o + 3] = cx + r;
    this.bb[o + 4] = y1;
    this.bb[o + 5] = cz + r;
    return id;
  }

  addEllipsoid(
    cx: number,
    cy: number,
    cz: number,
    rx: number,
    ry: number,
    rz: number,
    flags: number,
    surface: number,
    owner = -1,
  ): number {
    const id = this.alloc(ELL, flags, surface, owner);
    const o = id * 6;
    this.p[o] = cx;
    this.p[o + 1] = cy;
    this.p[o + 2] = cz;
    this.p[o + 3] = rx;
    this.p[o + 4] = ry;
    this.p[o + 5] = rz;
    this.bb[o] = cx - rx;
    this.bb[o + 1] = cy - ry;
    this.bb[o + 2] = cz - rz;
    this.bb[o + 3] = cx + rx;
    this.bb[o + 4] = cy + ry;
    this.bb[o + 5] = cz + rz;
    return id;
  }

  /** Build the broad-phase grid. Call once after all colliders are added. */
  build(): void {
    const ncell = this.nx * this.nz;
    const counts = new Int32Array(ncell + 1);
    const cs = this.cell;
    for (let i = 0; i < this.count; i++) {
      const o = i * 6;
      const x0 = Math.max(0, Math.floor((this.bb[o]! - this.gx0) / cs));
      const x1 = Math.min(this.nx - 1, Math.floor((this.bb[o + 3]! - this.gx0) / cs));
      const z0 = Math.max(0, Math.floor((this.bb[o + 2]! - this.gz0) / cs));
      const z1 = Math.min(this.nz - 1, Math.floor((this.bb[o + 5]! - this.gz0) / cs));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) counts[z * this.nx + x]!++;
    }
    const start = new Int32Array(ncell + 1);
    for (let c = 0; c < ncell; c++) start[c + 1] = start[c]! + counts[c]!;
    const items = new Int32Array(start[ncell]!);
    const fill = new Int32Array(ncell);
    for (let i = 0; i < this.count; i++) {
      const o = i * 6;
      const x0 = Math.max(0, Math.floor((this.bb[o]! - this.gx0) / cs));
      const x1 = Math.min(this.nx - 1, Math.floor((this.bb[o + 3]! - this.gx0) / cs));
      const z0 = Math.max(0, Math.floor((this.bb[o + 2]! - this.gz0) / cs));
      const z1 = Math.min(this.nz - 1, Math.floor((this.bb[o + 5]! - this.gz0) / cs));
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const c = z * this.nx + x;
          items[start[c]! + fill[c]!++] = i;
        }
    }
    this.cellStart = start;
    this.cellItems = items;
    this.stamp = new Uint32Array(this.count);
    this.stampValue = 1;
  }

  private nextStamp(): number {
    this.stampValue++;
    if (this.stampValue > 0xfffffff0) {
      this.stamp.fill(0);
      this.stampValue = 1;
    }
    return this.stampValue;
  }

  /**
   * Gather collider ids whose AABB overlaps the query box into `out`.
   * Returns the number written. `requireFlags` filters by flag bits (any).
   */
  gatherAabb(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: Int32Array = this.queryBuf,
    anyFlags = 0,
  ): number {
    const cs = this.cell;
    const x0 = Math.max(0, Math.floor((minX - this.gx0) / cs));
    const x1 = Math.min(this.nx - 1, Math.floor((maxX - this.gx0) / cs));
    const z0 = Math.max(0, Math.floor((minZ - this.gz0) / cs));
    const z1 = Math.min(this.nz - 1, Math.floor((maxZ - this.gz0) / cs));
    if (x1 < x0 || z1 < z0) return 0;
    const st = this.nextStamp();
    let n = 0;
    const bb = this.bb;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const c = z * this.nx + x;
        const e = this.cellStart[c + 1]!;
        for (let k = this.cellStart[c]!; k < e; k++) {
          const id = this.cellItems[k]!;
          if (this.stamp[id] === st) continue;
          this.stamp[id] = st;
          if (anyFlags !== 0 && (this.flags[id]! & anyFlags) === 0) continue;
          const o = id * 6;
          if (
            bb[o]! > maxX ||
            bb[o + 3]! < minX ||
            bb[o + 1]! > maxY ||
            bb[o + 4]! < minY ||
            bb[o + 2]! > maxZ ||
            bb[o + 5]! < minZ
          )
            continue;
          if (n < out.length) out[n++] = id;
        }
      }
    }
    return n;
  }

  // ---------------------------------------------------------------------------
  // Capsule (upright) contact
  // ---------------------------------------------------------------------------

  /** Scratch result written by `capsuleContact`. */
  readonly cr = { depth: 0, nx: 0, ny: 0, nz: 0 };

  /**
   * Contact between an upright capsule (feet at px,py,pz; radius r; height h)
   * and collider `id`. Returns true when penetrating; result in `this.cr`.
   */
  capsuleContact(id: number, px: number, py: number, pz: number, r: number, h: number): boolean {
    const o = id * 6;
    const p = this.p;
    const y0 = py + r;
    const y1 = py + h - r;
    const cr = this.cr;
    const k = this.kind[id]!;
    if (k === BOX) {
      const minX = p[o]!,
        minY = p[o + 1]!,
        minZ = p[o + 2]!,
        maxX = p[o + 3]!,
        maxY = p[o + 4]!,
        maxZ = p[o + 5]!;
      const cx = px < minX ? minX : px > maxX ? maxX : px;
      const cz = pz < minZ ? minZ : pz > maxZ ? maxZ : pz;
      let sy: number, by: number;
      if (y1 < minY) {
        sy = y1;
        by = minY;
      } else if (y0 > maxY) {
        sy = y0;
        by = maxY;
      } else {
        const lo = y0 > minY ? y0 : minY;
        const hi = y1 < maxY ? y1 : maxY;
        sy = by = (lo + hi) * 0.5;
      }
      const dx = px - cx,
        dy = sy - by,
        dz = pz - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r * r) return false;
      if (d2 > EPS) {
        const d = Math.sqrt(d2);
        cr.depth = r - d;
        cr.nx = dx / d;
        cr.ny = dy / d;
        cr.nz = dz / d;
        return true;
      }
      // Axis inside the box: minimum translation out.
      let best = maxX - px + r;
      cr.nx = 1;
      cr.ny = 0;
      cr.nz = 0;
      let v = px - minX + r;
      if (v < best) {
        best = v;
        cr.nx = -1;
      }
      v = maxZ - pz + r;
      if (v < best) {
        best = v;
        cr.nx = 0;
        cr.nz = 1;
      }
      v = pz - minZ + r;
      if (v < best) {
        best = v;
        cr.nx = 0;
        cr.nz = -1;
      }
      v = maxY - y0 + r;
      if (v < best * 1.15) {
        best = v;
        cr.nx = 0;
        cr.nz = 0;
        cr.ny = 1;
      }
      v = y1 - minY + r;
      if (v < best) {
        best = v;
        cr.nx = 0;
        cr.nz = 0;
        cr.ny = -1;
      }
      cr.depth = best;
      return true;
    }
    if (k === CYL) {
      const ccx = p[o]!,
        ya = p[o + 1]!,
        ccz = p[o + 2]!,
        yb = p[o + 3]!,
        R = p[o + 4]!;
      const dx = px - ccx,
        dz = pz - ccz;
      const dxz = Math.sqrt(dx * dx + dz * dz);
      let sy: number, by: number;
      let overlapY = false;
      if (y1 < ya) {
        sy = y1;
        by = ya;
      } else if (y0 > yb) {
        sy = y0;
        by = yb;
      } else {
        overlapY = true;
        sy = by = 0;
      }
      if (dxz > R) {
        const ox = (dx / dxz) * (dxz - R);
        const oz = (dz / dxz) * (dxz - R);
        const oy = sy - by;
        const d2 = ox * ox + oy * oy + oz * oz;
        if (d2 >= r * r) return false;
        if (d2 > EPS) {
          const d = Math.sqrt(d2);
          cr.depth = r - d;
          cr.nx = ox / d;
          cr.ny = oy / d;
          cr.nz = oz / d;
          return true;
        }
      }
      if (!overlapY) {
        const oy = sy - by;
        const ay = Math.abs(oy);
        if (ay >= r) return false;
        cr.depth = r - ay;
        cr.nx = 0;
        cr.nz = 0;
        cr.ny = oy >= 0 ? 1 : -1;
        return true;
      }
      // Deep: axis inside the cylinder radius with Y overlap.
      let best = R + r - dxz;
      if (dxz > EPS) {
        cr.nx = dx / dxz;
        cr.nz = dz / dxz;
      } else {
        cr.nx = 1;
        cr.nz = 0;
      }
      cr.ny = 0;
      const up = yb - y0 + r;
      if (up < best * 1.15) {
        best = up;
        cr.nx = 0;
        cr.nz = 0;
        cr.ny = 1;
      }
      const down = y1 - ya + r;
      if (down < best) {
        best = down;
        cr.nx = 0;
        cr.nz = 0;
        cr.ny = -1;
      }
      cr.depth = best;
      return true;
    }
    // Ellipsoid: closest segment point in scaled space, radial projection.
    const ecx = p[o]!,
      ecy = p[o + 1]!,
      ecz = p[o + 2]!,
      rx = p[o + 3]!,
      ry = p[o + 4]!,
      rz = p[o + 5]!;
    const sy = ecy < y0 ? y0 : ecy > y1 ? y1 : ecy;
    const qx = (px - ecx) / rx,
      qy = (sy - ecy) / ry,
      qz = (pz - ecz) / rz;
    const kq = Math.sqrt(qx * qx + qy * qy + qz * qz);
    if (kq < 1e-5) {
      cr.depth = ry + r;
      cr.nx = 0;
      cr.ny = 1;
      cr.nz = 0;
      return true;
    }
    // Surface point along the scaled radial direction
    const sx = ecx + (px - ecx) / kq,
      syy = ecy + (sy - ecy) / kq,
      sz = ecz + (pz - ecz) / kq;
    let nx = (sx - ecx) / (rx * rx),
      ny = (syy - ecy) / (ry * ry),
      nz = (sz - ecz) / (rz * rz);
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const dist = (px - sx) * nx + (sy - syy) * ny + (pz - sz) * nz;
    if (dist >= r) return false;
    cr.depth = r - dist;
    cr.nx = nx;
    cr.ny = ny;
    cr.nz = nz;
    return true;
  }

  /**
   * Resolve penetration of an upright capsule against the candidate colliders
   * and the terrain. Only velocity into a surface is removed, so tangential
   * motion is preserved. Returns the summary in `out`.
   */
  resolveCapsule(
    pos: Vector3,
    vel: Vector3,
    r: number,
    h: number,
    cands: Int32Array,
    nCands: number,
    out: ContactSummary,
    iterations = 8,
  ): void {
    for (let it = 0; it < iterations; it++) {
      let any = false;
      for (let k = 0; k < nCands; k++) {
        const id = cands[k]!;
        if (!this.capsuleContact(id, pos.x, pos.y, pos.z, r, h)) continue;
        const cr = this.cr;
        if (cr.depth <= 1e-7) continue;
        any = true;
        if (cr.depth > out.maxDepth) out.maxDepth = cr.depth;
        pos.x += cr.nx * (cr.depth + 1e-5);
        pos.y += cr.ny * (cr.depth + 1e-5);
        pos.z += cr.nz * (cr.depth + 1e-5);
        const vn = vel.x * cr.nx + vel.y * cr.ny + vel.z * cr.nz;
        if (vn < 0) {
          vel.x -= cr.nx * vn;
          vel.y -= cr.ny * vn;
          vel.z -= cr.nz * vn;
        }
        out.anyId = id;
        if (cr.ny > 0.65) {
          if (!out.ground || cr.ny > out.groundNY) {
            out.ground = true;
            out.groundNY = cr.ny;
            out.groundId = id;
            out.groundSurface = this.surface[id]!;
          }
        } else if (cr.ny < -0.6) {
          out.ceiling = true;
        } else if (Math.abs(cr.ny) < 0.35) {
          const climb = (this.flags[id]! & F_CLIMB) !== 0 && this.kind[id] === BOX;
          if (!out.wall || (climb && !out.wallClimbable)) {
            out.wall = true;
            out.wallId = id;
            const l = Math.hypot(cr.nx, cr.nz) || 1;
            out.wallNX = cr.nx / l;
            out.wallNZ = cr.nz / l;
            out.wallClimbable = climb;
          }
        }
      }
      if (!any) break;
    }
    // Terrain
    const t = this.terrain;
    if (!t.isWater(pos.x, pos.z)) {
      const gh = t.height(pos.x, pos.z);
      if (pos.y < gh) {
        const d = gh - pos.y;
        if (d > out.maxDepth && d > 0.5) out.maxDepth = d;
        pos.y = gh;
        if (vel.y < 0) vel.y = 0;
        out.ground = true;
        out.groundNY = 1;
        out.groundId = -1;
        out.groundSurface = t.surfaceAt(pos.x, pos.z);
      }
    }
  }

  /** Largest penetration depth of the capsule against any collider (0 if free). */
  capsulePenetration(px: number, py: number, pz: number, r: number, h: number): number {
    const n = this.gatherAabb(px - r - 0.1, py - 0.1, pz - r - 0.1, px + r + 0.1, py + h + 0.1, pz + r + 0.1);
    let maxD = 0;
    const buf = this.queryBuf;
    for (let k = 0; k < n; k++) {
      if (this.capsuleContact(buf[k]!, px, py, pz, r, h) && this.cr.depth > maxD) maxD = this.cr.depth;
    }
    if (!this.terrain.isWater(px, pz)) {
      const gh = this.terrain.height(px, pz);
      if (py < gh - 0.001 && gh - py > maxD) maxD = gh - py;
    }
    return maxD;
  }

  /** Collider with the deepest capsule penetration (-1 none, -2 terrain). */
  deepestContact(px: number, py: number, pz: number, r: number, h: number): { id: number; depth: number } {
    const n = this.gatherAabb(px - r - 0.1, py - 0.1, pz - r - 0.1, px + r + 0.1, py + h + 0.1, pz + r + 0.1);
    let best = -1,
      maxD = 0;
    const buf = this.queryBuf;
    for (let k = 0; k < n; k++) {
      if (this.capsuleContact(buf[k]!, px, py, pz, r, h) && this.cr.depth > maxD) {
        maxD = this.cr.depth;
        best = buf[k]!;
      }
    }
    if (!this.terrain.isWater(px, pz)) {
      const gh = this.terrain.height(px, pz);
      if (py < gh - 0.001 && gh - py > maxD) {
        maxD = gh - py;
        best = -2;
      }
    }
    return { id: best, depth: maxD };
  }

  /** True when an upright capsule at the position overlaps nothing (with margin). */
  capsuleFree(px: number, py: number, pz: number, r: number, h: number, margin = 0.02): boolean {
    return this.capsulePenetration(px, py, pz, r + margin, h) <= 1e-4;
  }

  /**
   * Height of the highest support surface under (x, z) not higher than maxY.
   * `footR` extends box and cylinder footprints for the rounded capsule base.
   * Returns -Infinity over open water with nothing beneath.
   */
  supportHeight(x: number, z: number, maxY: number, footR = 0.15, boxesOnly = false, withEllipsoids = false): { y: number; id: number } {
    const res = this.supportResult;
    res.id = -1;
    res.y = -Infinity;
    if (!this.terrain.isWater(x, z)) {
      res.y = this.terrain.height(x, z);
    }
    const n = this.gatherAabb(x - footR, -50, z - footR, x + footR, maxY, z + footR);
    const buf = this.queryBuf;
    const p = this.p;
    for (let k = 0; k < n; k++) {
      const id = buf[k]!;
      const o = id * 6;
      const kd = this.kind[id]!;
      if (boxesOnly && kd !== BOX) continue;
      if (kd === ELL && !withEllipsoids) continue;
      let top = -Infinity;
      if (kd === BOX) {
        if (x >= p[o]! - footR && x <= p[o + 3]! + footR && z >= p[o + 2]! - footR && z <= p[o + 5]! + footR)
          top = p[o + 4]!;
      } else if (kd === CYL) {
        const dx = x - p[o]!,
          dz = z - p[o + 2]!;
        const R = p[o + 4]! + footR;
        if (dx * dx + dz * dz <= R * R) top = p[o + 3]!;
      } else {
        const qx = (x - p[o]!) / p[o + 3]!,
          qz = (z - p[o + 2]!) / p[o + 5]!;
        const q = qx * qx + qz * qz;
        if (q < 1) top = p[o + 1]! + p[o + 4]! * Math.sqrt(1 - q);
      }
      if (top <= maxY + 1e-4 && top > res.y) {
        res.y = top;
        res.id = id;
      }
    }
    return res;
  }
  private readonly supportResult = { y: 0, id: -1 };

  // ---------------------------------------------------------------------------
  // Ray queries
  // ---------------------------------------------------------------------------

  /**
   * Ray against collider i, inflated by `inflate` (sphere cast). Returns t or
   * Infinity; normal in `this.rn`.
   */
  private readonly rn = { x: 0, y: 0, z: 0 };

  rayCollider(
    id: number,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxT: number,
    inflate: number,
  ): number {
    const o = id * 6;
    const p = this.p;
    const k = this.kind[id]!;
    const rn = this.rn;
    if (k === BOX) {
      const minX = p[o]! - inflate,
        minY = p[o + 1]! - inflate,
        minZ = p[o + 2]! - inflate;
      const maxX = p[o + 3]! + inflate,
        maxY = p[o + 4]! + inflate,
        maxZ = p[o + 5]! + inflate;
      let tmin = -Infinity,
        tmax = Infinity;
      let axis = -1;
      let sign = 0;
      // X slab
      if (Math.abs(dx) < 1e-12) {
        if (ox < minX || ox > maxX) return Infinity;
      } else {
        const inv = 1 / dx;
        let t1 = (minX - ox) * inv,
          t2 = (maxX - ox) * inv;
        let s = -1;
        if (t1 > t2) {
          const tt = t1;
          t1 = t2;
          t2 = tt;
          s = 1;
        }
        if (t1 > tmin) {
          tmin = t1;
          axis = 0;
          sign = s;
        }
        if (t2 < tmax) tmax = t2;
      }
      if (Math.abs(dy) < 1e-12) {
        if (oy < minY || oy > maxY) return Infinity;
      } else {
        const inv = 1 / dy;
        let t1 = (minY - oy) * inv,
          t2 = (maxY - oy) * inv;
        let s = -1;
        if (t1 > t2) {
          const tt = t1;
          t1 = t2;
          t2 = tt;
          s = 1;
        }
        if (t1 > tmin) {
          tmin = t1;
          axis = 1;
          sign = s;
        }
        if (t2 < tmax) tmax = t2;
      }
      if (Math.abs(dz) < 1e-12) {
        if (oz < minZ || oz > maxZ) return Infinity;
      } else {
        const inv = 1 / dz;
        let t1 = (minZ - oz) * inv,
          t2 = (maxZ - oz) * inv;
        let s = -1;
        if (t1 > t2) {
          const tt = t1;
          t1 = t2;
          t2 = tt;
          s = 1;
        }
        if (t1 > tmin) {
          tmin = t1;
          axis = 2;
          sign = s;
        }
        if (t2 < tmax) tmax = t2;
      }
      if (tmax < tmin || tmax < 0) return Infinity;
      if (tmin < 0) {
        // Origin inside.
        rn.x = -dx;
        rn.y = -dy;
        rn.z = -dz;
        return 0;
      }
      if (tmin > maxT) return Infinity;
      rn.x = axis === 0 ? sign : 0;
      rn.y = axis === 1 ? sign : 0;
      rn.z = axis === 2 ? sign : 0;
      return tmin;
    }
    if (k === CYL) {
      const cx = p[o]!,
        ya = p[o + 1]! - inflate,
        cz = p[o + 2]!,
        yb = p[o + 3]! + inflate,
        R = p[o + 4]! + inflate;
      const lx = ox - cx,
        lz = oz - cz;
      let best = Infinity;
      const a = dx * dx + dz * dz;
      const c = lx * lx + lz * lz - R * R;
      if (c <= 0 && oy >= ya && oy <= yb) {
        rn.x = -dx;
        rn.y = -dy;
        rn.z = -dz;
        return 0;
      }
      if (a > 1e-12) {
        const b = 2 * (lx * dx + lz * dz);
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
          const t = (-b - Math.sqrt(disc)) / (2 * a);
          if (t >= 0 && t <= maxT) {
            const y = oy + dy * t;
            if (y >= ya && y <= yb) {
              best = t;
              rn.x = (lx + dx * t) / R;
              rn.y = 0;
              rn.z = (lz + dz * t) / R;
            }
          }
        }
      }
      // Caps
      if (Math.abs(dy) > 1e-12) {
        const capY = dy < 0 ? yb : ya;
        const t = (capY - oy) / dy;
        if (t >= 0 && t < best && t <= maxT) {
          const hx = lx + dx * t,
            hz = lz + dz * t;
          if (hx * hx + hz * hz <= R * R) {
            best = t;
            rn.x = 0;
            rn.y = dy < 0 ? 1 : -1;
            rn.z = 0;
          }
        }
      }
      return best;
    }
    // Ellipsoid
    const rx = p[o + 3]! + inflate,
      ry = p[o + 4]! + inflate,
      rz = p[o + 5]! + inflate;
    const lx = (ox - p[o]!) / rx,
      ly = (oy - p[o + 1]!) / ry,
      lz = (oz - p[o + 2]!) / rz;
    const sdx = dx / rx,
      sdy = dy / ry,
      sdz = dz / rz;
    const a = sdx * sdx + sdy * sdy + sdz * sdz;
    const b = 2 * (lx * sdx + ly * sdy + lz * sdz);
    const c = lx * lx + ly * ly + lz * lz - 1;
    if (c <= 0) {
      rn.x = -dx;
      rn.y = -dy;
      rn.z = -dz;
      return 0;
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) return Infinity;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0 || t > maxT) return Infinity;
    let nx = (lx + sdx * t) / rx,
      ny = (ly + sdy * t) / ry,
      nz = (lz + sdz * t) / rz;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    rn.x = nx;
    rn.y = ny;
    rn.z = nz;
    return t;
  }

  /**
   * Raycast (direction must be normalised). `skipFlags` ignores colliders with
   * any of those flags, `requireFlags` (if non-zero) only tests colliders that
   * have one of them. `ignoreId` skips one collider. `inflate` > 0 performs a
   * conservative sphere cast. Terrain and water are included unless
   * `withTerrain` is false.
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxT: number,
    out: RayHit,
    skipFlags = 0,
    ignoreId = -1,
    inflate = 0,
    withTerrain = true,
    requireFlags = 0,
  ): boolean {
    out.hit = false;
    out.t = maxT;
    out.id = -1;
    let best = maxT;
    let bestId = -3;
    let bnx = 0,
      bny = 1,
      bnz = 0;
    const cs = this.cell;
    // Grid traversal (2D DDA in XZ).
    let gx = (ox - this.gx0) / cs;
    let gz = (oz - this.gz0) / cs;
    let tStart = 0;
    // Clip the start into the grid if outside.
    if (gx < 0 || gz < 0 || gx >= this.nx || gz >= this.nz) {
      let t0 = 0,
        t1 = maxT;
      const gminX = this.gx0,
        gmaxX = this.gx0 + this.nx * cs;
      const gminZ = this.gz0,
        gmaxZ = this.gz0 + this.nz * cs;
      if (Math.abs(dx) < 1e-12) {
        if (ox < gminX || ox > gmaxX) t1 = -1;
      } else {
        let a = (gminX - ox) / dx,
          b = (gmaxX - ox) / dx;
        if (a > b) {
          const tt = a;
          a = b;
          b = tt;
        }
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
      }
      if (Math.abs(dz) < 1e-12) {
        if (oz < gminZ || oz > gmaxZ) t1 = -1;
      } else {
        let a = (gminZ - oz) / dz,
          b = (gmaxZ - oz) / dz;
        if (a > b) {
          const tt = a;
          a = b;
          b = tt;
        }
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
      }
      if (t1 < t0) {
        tStart = Infinity;
      } else {
        tStart = t0 + 1e-4;
        gx = (ox + dx * tStart - this.gx0) / cs;
        gz = (oz + dz * tStart - this.gz0) / cs;
      }
    }
    if (tStart < best) {
      let ix = Math.min(this.nx - 1, Math.max(0, Math.floor(gx)));
      let iz = Math.min(this.nz - 1, Math.max(0, Math.floor(gz)));
      const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
      const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
      const tDeltaX = stepX !== 0 ? cs / Math.abs(dx) : Infinity;
      const tDeltaZ = stepZ !== 0 ? cs / Math.abs(dz) : Infinity;
      let tMaxX =
        stepX > 0
          ? tStart + ((ix + 1) * cs + this.gx0 - (ox + dx * tStart)) / dx
          : stepX < 0
            ? tStart + (ix * cs + this.gx0 - (ox + dx * tStart)) / dx
            : Infinity;
      let tMaxZ =
        stepZ > 0
          ? tStart + ((iz + 1) * cs + this.gz0 - (oz + dz * tStart)) / dz
          : stepZ < 0
            ? tStart + (iz * cs + this.gz0 - (oz + dz * tStart)) / dz
            : Infinity;
      const st = this.nextStamp();
      let tCell = tStart;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (tCell > best) break;
        const c = iz * this.nx + ix;
        const e = this.cellStart[c + 1]!;
        for (let k = this.cellStart[c]!; k < e; k++) {
          const id = this.cellItems[k]!;
          if (this.stamp[id] === st) continue;
          this.stamp[id] = st;
          if (id === ignoreId) continue;
          const f = this.flags[id]!;
          if ((f & skipFlags) !== 0) continue;
          if (requireFlags !== 0 && (f & requireFlags) === 0) continue;
          const t = this.rayCollider(id, ox, oy, oz, dx, dy, dz, best, inflate);
          if (t < best) {
            best = t;
            bestId = id;
            bnx = this.rn.x;
            bny = this.rn.y;
            bnz = this.rn.z;
          }
        }
        // Step to the next cell
        if (tMaxX < tMaxZ) {
          tCell = tMaxX;
          tMaxX += tDeltaX;
          ix += stepX;
          if (ix < 0 || ix >= this.nx) break;
        } else {
          if (tMaxZ === Infinity) break;
          tCell = tMaxZ;
          tMaxZ += tDeltaZ;
          iz += stepZ;
          if (iz < 0 || iz >= this.nz) break;
        }
      }
    }
    // Terrain / water surface
    if (withTerrain) {
      const th = this.terrainHit;
      if (this.terrain.rayIntersect(ox, oy, oz, dx, dy, dz, best, inflate, th)) {
        best = th.t;
        bestId = th.water ? -2 : -1;
        bnx = th.nx;
        bny = th.ny;
        bnz = th.nz;
      }
    }
    if (bestId === -3) return false;
    out.hit = true;
    out.t = best;
    out.x = ox + dx * best;
    out.y = oy + dy * best;
    out.z = oz + dz * best;
    out.nx = bnx;
    out.ny = bny;
    out.nz = bnz;
    out.id = bestId;
    return true;
  }

  /** Max penetration of a sphere against colliders with `flagsMask` (0 = all) and terrain. */
  spherePenetration(x: number, y: number, z: number, r: number, skipFlags = 0): number {
    const n = this.gatherAabb(x - r, y - r, z - r, x + r, y + r, z + r);
    const buf = this.queryBuf;
    let maxD = 0;
    for (let k = 0; k < n; k++) {
      const id = buf[k]!;
      if ((this.flags[id]! & skipFlags) !== 0) continue;
      const d = this.sphereDepth(id, x, y, z, r);
      if (d > maxD) maxD = d;
    }
    if (!this.terrain.isWater(x, z)) {
      const gh = this.terrain.height(x, z);
      if (y - r < gh && gh - (y - r) > maxD) maxD = gh - (y - r);
    }
    return maxD;
  }

  /** Penetration depth of a sphere into collider id (0 if separated). Normal in `cr`. */
  sphereDepth(id: number, x: number, y: number, z: number, r: number): number {
    // A sphere is a capsule of height 2r with feet at y - r.
    if (!this.capsuleContact(id, x, y - r, z, r, 2 * r)) return 0;
    return this.cr.depth;
  }

  /** Push a sphere out of all colliders (camera safety). Returns total push length. */
  resolveSphere(pos: Vector3, r: number, skipFlags = 0, iterations = 4): number {
    let total = 0;
    for (let it = 0; it < iterations; it++) {
      const n = this.gatherAabb(pos.x - r, pos.y - r, pos.z - r, pos.x + r, pos.y + r, pos.z + r);
      const buf = this.queryBuf;
      let any = false;
      for (let k = 0; k < n; k++) {
        const id = buf[k]!;
        if ((this.flags[id]! & skipFlags) !== 0) continue;
        if (!this.capsuleContact(id, pos.x, pos.y - r, pos.z, r, 2 * r)) continue;
        const cr = this.cr;
        if (cr.depth <= 1e-6) continue;
        pos.x += cr.nx * (cr.depth + 1e-4);
        pos.y += cr.ny * (cr.depth + 1e-4);
        pos.z += cr.nz * (cr.depth + 1e-4);
        total += cr.depth;
        any = true;
      }
      if (!this.terrain.isWater(pos.x, pos.z)) {
        const gh = this.terrain.height(pos.x, pos.z);
        if (pos.y - r < gh) {
          total += gh - (pos.y - r);
          pos.y = gh + r;
          any = true;
        }
      } else {
        const wl = this.terrain.waterLevelAt(pos.x, pos.z);
        if (pos.y - r < wl) {
          pos.y = wl + r;
          any = true;
        }
      }
      if (!any) break;
    }
    return total;
  }

  /**
   * Closest point on the surface of collider id to (x, y, z). For boxes it
   * considers only the four vertical faces whose normal faces `viewer`
   * (so roof-edge and facade anchors are visible from the player).
   * Writes into `out`; returns false when no face qualifies.
   */
  closestAnchorPoint(
    id: number,
    x: number,
    y: number,
    z: number,
    vx: number,
    vz: number,
    out: { x: number; y: number; z: number; nx: number; ny: number; nz: number },
  ): boolean {
    const o = id * 6;
    const p = this.p;
    const k = this.kind[id]!;
    if (k === BOX) {
      const minX = p[o]!,
        minY = p[o + 1]!,
        minZ = p[o + 2]!,
        maxX = p[o + 3]!,
        maxY = p[o + 4]!,
        maxZ = p[o + 5]!;
      let bestD = Infinity;
      const cy = y < minY ? minY : y > maxY ? maxY : y;
      const cxz = x < minX ? minX : x > maxX ? maxX : x;
      const czz = z < minZ ? minZ : z > maxZ ? maxZ : z;
      // +X face
      if (vx > maxX) {
        const d = (x - maxX) * (x - maxX) + (y - cy) * (y - cy) + (z - czz) * (z - czz);
        if (d < bestD) {
          bestD = d;
          out.x = maxX;
          out.y = cy;
          out.z = czz;
          out.nx = 1;
          out.ny = 0;
          out.nz = 0;
        }
      }
      if (vx < minX) {
        const d = (x - minX) * (x - minX) + (y - cy) * (y - cy) + (z - czz) * (z - czz);
        if (d < bestD) {
          bestD = d;
          out.x = minX;
          out.y = cy;
          out.z = czz;
          out.nx = -1;
          out.ny = 0;
          out.nz = 0;
        }
      }
      if (vz > maxZ) {
        const d = (x - cxz) * (x - cxz) + (y - cy) * (y - cy) + (z - maxZ) * (z - maxZ);
        if (d < bestD) {
          bestD = d;
          out.x = cxz;
          out.y = cy;
          out.z = maxZ;
          out.nx = 0;
          out.ny = 0;
          out.nz = 1;
        }
      }
      if (vz < minZ) {
        const d = (x - cxz) * (x - cxz) + (y - cy) * (y - cy) + (z - minZ) * (z - minZ);
        if (d < bestD) {
          bestD = d;
          out.x = cxz;
          out.y = cy;
          out.z = minZ;
          out.nx = 0;
          out.ny = 0;
          out.nz = -1;
        }
      }
      if (bestD === Infinity) return false;
      // Keep the anchor a hair inside the face extents (corners are fine).
      return true;
    }
    if (k === CYL) {
      const cx = p[o]!,
        ya = p[o + 1]!,
        cz = p[o + 2]!,
        yb = p[o + 3]!,
        R = p[o + 4]!;
      // Approach from the viewer side, biased toward the ideal point.
      let dx = (x + vx) * 0.5 - cx,
        dz = (z + vz) * 0.5 - cz;
      let l = Math.hypot(dx, dz);
      if (l < 1e-6) {
        dx = vx - cx;
        dz = vz - cz;
        l = Math.hypot(dx, dz) || 1;
      }
      out.nx = dx / l;
      out.ny = 0;
      out.nz = dz / l;
      out.x = cx + out.nx * R;
      out.z = cz + out.nz * R;
      out.y = y < ya ? ya : y > yb ? yb : y;
      return true;
    }
    const cx = p[o]!,
      cy = p[o + 1]!,
      cz = p[o + 2]!,
      rx = p[o + 3]!,
      ry = p[o + 4]!,
      rz = p[o + 5]!;
    // Radial projection toward a point between the ideal point and the viewer.
    const tx = (x * 2 + vx) / 3 - cx,
      ty = y - cy,
      tz = (z * 2 + vz) / 3 - cz;
    const q = Math.sqrt((tx / rx) ** 2 + (ty / ry) ** 2 + (tz / rz) ** 2);
    if (q < 1e-6) return false;
    out.x = cx + tx / q;
    out.y = cy + ty / q;
    out.z = cz + tz / q;
    let nx = (out.x - cx) / (rx * rx),
      ny = (out.y - cy) / (ry * ry),
      nz = (out.z - cz) / (rz * rz);
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    out.nx = nx;
    out.ny = ny;
    out.nz = nz;
    return true;
  }

  /** Top Y of collider id. */
  topY(id: number): number {
    return this.bb[id * 6 + 4]!;
  }
}
