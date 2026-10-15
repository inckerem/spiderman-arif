import { CollisionWorld, F_ANCHOR, F_BRIDGE, F_BUILDING, F_CAMERA, F_CLIMB, SURF_METAL, SURF_STONE } from '../../physics/collision';

/**
 * Landmark parts (M13 §4g). A landmark is built once as a list of parts;
 * the collision world and the greybox geometry are both made from that
 * list, so they agree by construction. Only the existing collider kinds are
 * used: axis-aligned boxes, vertical cylinders and ellipsoids. Simulation
 * side: no rendering imports here (see partsGeo.ts for the drawing).
 */

export const PART_BOX = 0;
export const PART_CYL = 1;
export const PART_ELL = 2;
/** A drawn tube between two points (cables); its collision comes as separate collide-only boxes or cylinders. */
export const PART_TUBE = 3;

export interface Part {
  k: number;
  /** Box: minX, minY, minZ, maxX, maxY, maxZ. Cylinder: x, y0, z, y1, r0 (collision radius), r1 (drawn top radius). Ellipsoid: x, y, z, rx, ry, rz. Tube: x0, y0, z0, x1, y1, z1. */
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  /** Tube radius (drawn). */
  r?: number;
  flags: number;
  surf: number;
  owner: number;
  /** Colour (0xRRGGBB). */
  color: number;
  /** Collision only (cable chain pieces) or drawing only (tubes, details). */
  noDraw?: boolean;
  noCollide?: boolean;
  /** Drawn faces of a box (GeomBuilder bitmask), default all but the bottom. */
  faces?: number;
  /** Cylinder segments when drawn. */
  segs?: number;
}

/** Hall and plinth boxes: climbable. */
export const F_HALL = F_BUILDING | F_ANCHOR | F_CLIMB | F_CAMERA;
/** Minarets, domes, towers: anchors that block the camera, not climbable (climbing needs boxes). */
export const F_SPIRE = F_BUILDING | F_ANCHOR | F_CAMERA;
/** Cable chains: anchors that never block the camera. */
export const F_CABLE = F_BRIDGE | F_ANCHOR;
/** Bridge decks, towers and piers. */
export const F_DECK = F_BRIDGE | F_ANCHOR | F_CAMERA | F_CLIMB;

export const STONE = 0xe7e0d0;
export const LEAD = 0x8d9499;

export class PartList {
  readonly parts: Part[] = [];
  owner = -1;

  box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, flags: number, color: number, surf = SURF_STONE, extra?: Partial<Part>): void {
    this.parts.push({ k: PART_BOX, a: minX, b: minY, c: minZ, d: maxX, e: maxY, f: maxZ, flags, surf, owner: this.owner, color, ...extra });
  }

  cyl(x: number, z: number, y0: number, y1: number, r: number, flags: number, color: number, surf = SURF_STONE, extra?: Partial<Part>): void {
    this.parts.push({ k: PART_CYL, a: x, b: y0, c: z, d: y1, e: r, f: r, flags, surf, owner: this.owner, color, ...extra });
  }

  ell(x: number, y: number, z: number, rx: number, ry: number, rz: number, flags: number, color: number, surf = SURF_METAL, extra?: Partial<Part>): void {
    this.parts.push({ k: PART_ELL, a: x, b: y, c: z, d: rx, e: ry, f: rz, flags, surf, owner: this.owner, color, ...extra });
  }

  tube(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, color: number): void {
    this.parts.push({ k: PART_TUBE, a: x0, b: y0, c: z0, d: x1, e: y1, f: z1, r, flags: 0, surf: SURF_METAL, owner: this.owner, color, noCollide: true });
  }
}

export interface DomeSpec {
  x: number;
  z: number;
  /** Springing height (where the dome meets its drum). */
  springY: number;
  r: number;
  rise: number;
  drumH: number;
}

/** Dome: an ellipsoid (r, rise, r) on the springing line; its lower half sits in a drum (r + 0.4). */
export function addDome(P: PartList, d: DomeSpec, color = LEAD): void {
  if (d.drumH > 0) P.cyl(d.x, d.z, d.springY - d.drumH, d.springY, d.r + 0.4, F_SPIRE, STONE, SURF_STONE, { segs: 24 });
  P.ell(d.x, d.springY, d.z, d.r, d.rise, d.r, F_SPIRE, color);
  // Alem finial.
  P.cyl(d.x, d.z, d.springY + d.rise - 0.2, d.springY + d.rise + 2.2, 0.18, F_SPIRE, 0xc9a54a, SURF_METAL, { segs: 6, noCollide: true });
}

/**
 * Stacked cylinders from (y0, r0) to (y1, r1), each step at most 1.5 m
 * tall (a cone the capsule can stand next to without gaps).
 */
export function addCone(P: PartList, x: number, z: number, y0: number, y1: number, r0: number, r1: number, flags: number, color: number, surf = SURF_METAL): void {
  const n = Math.max(1, Math.ceil((y1 - y0) / 1.5));
  for (let i = 0; i < n; i++) {
    const ya = y0 + ((y1 - y0) * i) / n,
      yb = y0 + ((y1 - y0) * (i + 1)) / n;
    const ra = r0 + ((r1 - r0) * i) / n,
      rb = r0 + ((r1 - r0) * (i + 1)) / n;
    // Collision at the wider radius of the step; drawn as a frustum.
    P.parts.push({ k: PART_CYL, a: x, b: ya, c: z, d: yb, e: Math.max(ra, rb), f: rb, flags, surf, owner: P.owner, color, segs: 12 });
  }
}

export interface MinaretSpec {
  x: number;
  z: number;
  baseY: number;
  /** Height to the cap tip above baseY. */
  height: number;
  shaftR: number;
  /** Balcony (şerefe) heights above baseY. */
  serefe: number[];
  capH: number;
}

/** Minaret: pedestal box, shaft cylinder, şerefe ring cylinders (r + 1.0, 1.2 m, standable) and a pencil cap. */
export function addMinaret(P: PartList, m: MinaretSpec): void {
  const ped = m.shaftR + 0.9;
  const pedTop = m.baseY + Math.min(9, m.height * 0.14);
  P.box(m.x - ped, m.baseY - 1, m.z - ped, m.x + ped, pedTop, m.z + ped, F_HALL, STONE);
  const shaftTop = m.baseY + m.height - m.capH;
  P.cyl(m.x, m.z, pedTop, shaftTop, m.shaftR, F_SPIRE, STONE, SURF_STONE, { segs: 16 });
  for (const h of m.serefe) {
    const y = m.baseY + h;
    P.cyl(m.x, m.z, y - 1.2, y, m.shaftR + 1.0, F_SPIRE, 0xd8d0bf, SURF_STONE, { segs: 16 });
  }
  addCone(P, m.x, m.z, shaftTop, m.baseY + m.height, m.shaftR + 0.15, 0.25, F_SPIRE, LEAD);
}

export interface RoundTowerSpec {
  x: number;
  z: number;
  baseY: number;
  r: number;
  /** Top of the shaft (balcony level) above baseY. */
  balcony: number;
  drumH: number;
  coneTop: number;
  finialTop: number;
}

/** Galata-style tower: shaft, balcony ring, drum, cone, finial. */
export function addRoundTower(P: PartList, t: RoundTowerSpec, color: number): void {
  const b = t.baseY;
  P.cyl(t.x, t.z, b - 1, b + t.balcony, t.r, F_SPIRE, color, SURF_STONE, { segs: 20 });
  P.cyl(t.x, t.z, b + t.balcony - 1.0, b + t.balcony, t.r + 1.3, F_SPIRE, 0xb9ab95, SURF_STONE, { segs: 20 });
  P.cyl(t.x, t.z, b + t.balcony, b + t.balcony + t.drumH, t.r * 0.82, F_SPIRE, color, SURF_STONE, { segs: 20 });
  addCone(P, t.x, t.z, b + t.balcony + t.drumH, b + t.coneTop, t.r * 0.9, 0.6, F_SPIRE, LEAD);
  P.cyl(t.x, t.z, b + t.coneTop, b + t.finialTop, 0.3, F_SPIRE, 0xc9a54a, SURF_METAL, { segs: 6 });
}

/**
 * Cable chain through `pts`. A segment whose horizontal direction lies
 * along X or Z becomes thin boxes (half thickness r, at least 0.25, the
 * tunnelling floor) each spanning at most 0.5 m of height and 0.5-6 m of
 * length; any other segment becomes vertical cylinders covering at most
 * 1 m of rise each (keep cables in axis planes). Drawn as tubes.
 */
export function addCableChain(P: PartList, pts: Array<[number, number, number]>, r: number, flags: number, color: number, drawR = r): void {
  const h = Math.max(0.25, r);
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0, z0] = pts[i]!;
    const [x1, y1, z1] = pts[i + 1]!;
    P.tube(x0, y0, z0, x1, y1, z1, drawR, color);
    const dx = x1 - x0,
      dy = y1 - y0,
      dz = z1 - z0;
    const hl = Math.hypot(dx, dz);
    const alongX = Math.abs(dz) <= 1e-3 * Math.max(1, hl),
      alongZ = Math.abs(dx) <= 1e-3 * Math.max(1, hl);
    if (alongX || alongZ || hl < 1e-6) {
      const len = Math.hypot(hl, dy);
      let n = Math.max(1, Math.ceil(Math.abs(dy) / 0.5));
      n = Math.max(n, Math.ceil(len / 6));
      n = Math.min(n, Math.max(1, Math.floor(len / 0.5)));
      for (let k = 0; k < n; k++) {
        const ta = k / n,
          tb = (k + 1) / n;
        const ax = x0 + dx * ta,
          ay = y0 + dy * ta,
          az = z0 + dz * ta;
        const bx = x0 + dx * tb,
          by = y0 + dy * tb,
          bz = z0 + dz * tb;
        P.box(Math.min(ax, bx) - h, Math.min(ay, by) - h, Math.min(az, bz) - h, Math.max(ax, bx) + h, Math.max(ay, by) + h, Math.max(az, bz) + h, flags, color, SURF_METAL, { noDraw: true });
      }
    } else {
      const n = Math.max(1, Math.ceil(Math.abs(dy) / 1.0));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const ya = y0 + (dy * k) / n,
          yb = y0 + (dy * (k + 1)) / n;
        P.cyl(x0 + dx * t, z0 + dz * t, Math.min(ya, yb) - 0.05, Math.max(ya, yb) + 0.05, h, flags, color, SURF_METAL, { noDraw: true });
      }
    }
  }
}

/** Collision for every part (in list order). */
export function addPartColliders(w: CollisionWorld, parts: readonly Part[]): void {
  for (const p of parts) {
    if (p.noCollide) continue;
    if (p.k === PART_BOX) w.addBox(p.a, p.b, p.c, p.d, p.e, p.f, p.flags, p.surf, p.owner);
    else if (p.k === PART_CYL) w.addCylinder(p.a, p.c, p.b, p.d, p.e, p.flags, p.surf, p.owner);
    else if (p.k === PART_ELL) w.addEllipsoid(p.a, p.b, p.c, p.d, p.e, p.f, p.flags, p.surf, p.owner);
  }
}
