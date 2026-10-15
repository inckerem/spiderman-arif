import { F_ANCHOR, F_PROP, SURF_METAL, SURF_WOOD } from '../../physics/collision';
import { CURB } from '../../physics/terrain';
import type { Rect } from '../../world/types';
import {
  F_CABLE,
  F_DECK,
  F_HALL,
  F_SPIRE,
  LEAD,
  PartList,
  STONE,
  addCableChain,
  addCone,
  addDome,
  addMinaret,
  addRoundTower,
  type Part,
} from '../common/prims';

/**
 * Istanbul landmarks and bridges as part lists (M13 §2.6, §2.8, §4g), real
 * size, greybox. Every structure stands on its own stone plinth at the
 * highest ground under it. Colliders and geometry both come from these parts.
 */

type Base = (x: number, z: number) => number;

const OWNER0 = 200000;
const CONCRETE = 0xb9b4aa;
const STEEL = 0x8a9097;
const RED = 0xb8473a;
const HULL = 0x2f3a46;
const WHITE = 0xf2efe6;

interface Ctx {
  P: PartList;
  base: Base;
  isRoad: (x: number, z: number) => boolean;
}

/** Highest and lowest ground under a rectangle (corners, edge midpoints, centre). */
function range(base: Base, r: Rect): [number, number] {
  let lo = Infinity,
    hi = -Infinity;
  for (const fx of [0, 0.5, 1]) {
    for (const fz of [0, 0.5, 1]) {
      const h = base(r.minX + (r.maxX - r.minX) * fx, r.minZ + (r.maxZ - r.minZ) * fz);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
  }
  return [lo, hi];
}

/** A stone plinth under the footprint up to the highest ground plus the curb; returns its top. */
function plinth(c: Ctx, r: Rect): number {
  const [lo, hi] = range(c.base, r);
  const top = hi + CURB;
  if (top - (lo + CURB) > 0.05) c.P.box(r.minX, lo - 1, r.minZ, r.maxX, top, r.maxZ, F_HALL, 0xc8bfae);
  return top;
}

/** A box standing on its own plinth; returns the floor height. */
function hall(c: Ctx, r: Rect, h: number, color = STONE): number {
  const y = plinth(c, r);
  c.P.box(r.minX, y, r.minZ, r.maxX, y + h, r.maxZ, F_HALL, color);
  return y;
}

const R = (minX: number, maxX: number, minZ: number, maxZ: number): Rect => ({ minX, maxX, minZ, maxZ });

/** Ground for a minaret: the highest ground under its pedestal plus the curb. */
function minaret(c: Ctx, x: number, z: number, height: number, serefe: number[], capH: number, shaftR = 1.8): void {
  const ped = shaftR + 0.9;
  const [, hi] = range(c.base, R(x - ped, x + ped, z - ped, z + ped));
  addMinaret(c.P, { x, z, baseY: hi + CURB, height, shaftR, serefe, capH });
}

/**
 * A domed mosque: the prayer hall box, a pendentive block, the main dome on
 * its drum and semi-domes on the given sides (full ellipsoids on their
 * springing points, the inward halves buried in the block).
 */
function mosque(c: Ctx, hallR: Rect, wallH: number, dome: { r: number; crown: number; drumH: number }, semi: Array<'N' | 'S' | 'E' | 'W'>, semiR = dome.r * 0.92): number {
  const y = hall(c, hallR, wallH);
  const cx = (hallR.minX + hallR.maxX) / 2,
    cz = (hallR.minZ + hallR.maxZ) / 2;
  const rise = dome.r * 0.95;
  const spring = y + dome.crown - rise;
  const half = Math.min(dome.r + 1.5, (hallR.maxX - hallR.minX) / 2, (hallR.maxZ - hallR.minZ) / 2);
  c.P.box(cx - half, y + wallH, cz - half, cx + half, spring - dome.drumH, cz + half, F_HALL, STONE);
  addDome(c.P, { x: cx, z: cz, springY: spring, r: dome.r, rise, drumH: dome.drumH });
  const sy = y + wallH + (spring - dome.drumH - y - wallH) * 0.55;
  // Semi-domes never overlap each other (ellipsoid creases resolve poorly at speed).
  semiR = Math.min(semiR, half * 0.68);
  for (const s of semi) {
    const dx = s === 'E' ? 1 : s === 'W' ? -1 : 0,
      dz = s === 'S' ? 1 : s === 'N' ? -1 : 0;
    c.P.ell(cx + dx * half, sy, cz + dz * half, semiR, semiR * 0.8, semiR, F_SPIRE, LEAD);
  }
  return y;
}

/** Courtyard walls (arcades) around a rectangle, with a gate gap in the side facing `gate`. */
function courtyard(c: Ctx, r: Rect, h: number, gate: 'N' | 'S' | 'W' | 'E'): void {
  const t = 3;
  const y = plinth(c, r);
  const P = c.P;
  const mx = (r.minX + r.maxX) / 2,
    mz = (r.minZ + r.maxZ) / 2;
  const sides: Array<[Rect, 'N' | 'S' | 'W' | 'E']> = [
    [R(r.minX, r.maxX, r.minZ, r.minZ + t), 'N'],
    [R(r.minX, r.maxX, r.maxZ - t, r.maxZ), 'S'],
    [R(r.minX, r.minX + t, r.minZ + t, r.maxZ - t), 'W'],
    [R(r.maxX - t, r.maxX, r.minZ + t, r.maxZ - t), 'E'],
  ];
  for (const [s, side] of sides) {
    if (side !== gate) {
      P.box(s.minX, y, s.minZ, s.maxX, y + h, s.maxZ, F_HALL, STONE);
      continue;
    }
    // Two halves around a 10 m gate.
    if (side === 'N' || side === 'S') {
      P.box(s.minX, y, s.minZ, mx - 5, y + h, s.maxZ, F_HALL, STONE);
      P.box(mx + 5, y, s.minZ, s.maxX, y + h, s.maxZ, F_HALL, STONE);
    } else {
      P.box(s.minX, y, s.minZ, s.maxX, y + h, mz - 5, F_HALL, STONE);
      P.box(s.minX, y, mz + 5, s.maxX, y + h, s.maxZ, F_HALL, STONE);
    }
  }
}

/** Row of small domes on a roof (medreses, bazaars). */
function domeRow(c: Ctx, r: Rect, y: number, step: number, dr: number): void {
  const nx = Math.max(1, Math.floor((r.maxX - r.minX) / step)),
    nz = Math.max(1, Math.floor((r.maxZ - r.minZ) / step));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x = r.minX + (r.maxX - r.minX) * ((i + 0.5) / nx),
        z = r.minZ + (r.maxZ - r.minZ) * ((j + 0.5) / nz);
      c.P.ell(x, y, z, dr, dr * 0.55, dr, F_SPIRE, LEAD);
    }
  }
}

/** Square stack of shrinking boxes (obelisks, monuments). */
function stack(c: Ctx, x: number, z: number, y: number, tiers: Array<[number, number]>, color: number): void {
  let yy = y;
  for (const [half, h] of tiers) {
    c.P.box(x - half, yy, z - half, x + half, yy + h, z + half, F_HALL, color);
    yy += h;
  }
}

/** A low deck along Z from z0 to z1 (z0 < z1) that ramps from the shore level up to `top` over `ramp` metres at each end (steps of 0.25 m). */
function zDeck(c: Ctx, x0: number, x1: number, z0: number, z1: number, top: number, ramp: number, color: number, lamps: number[], rails = true): (z: number) => number {
  const P = c.P;
  const low = CURB;
  const yAt = (z: number): number => {
    const d = Math.min(z - z0, z1 - z);
    return low + (top - low) * Math.max(0, Math.min(1, d / ramp));
  };
  const steps = Math.max(1, Math.ceil((top - low) / 0.25));
  const stepLen = ramp / steps;
  // Ramp steps are solid down into the water (an embankment): an open stair underside would catch a flying hero.
  const piece = (za: number, zb: number, y: number, solid: boolean): void => {
    P.box(x0, solid ? -6 : y - 1, za, x1, y, zb, F_DECK, color);
    if (rails) {
      P.box(x0, y, za, x0 + 0.3, y + 1.1, zb, F_DECK, STEEL, SURF_METAL);
      P.box(x1 - 0.3, y, za, x1, y + 1.1, zb, F_DECK, STEEL, SURF_METAL);
    }
  };
  for (let i = 0; i < steps; i++) {
    const y = low + ((top - low) * (i + 1)) / steps;
    piece(z0 + i * stepLen, z0 + (i + 1) * stepLen, y, true);
    piece(z1 - (i + 1) * stepLen, z1 - i * stepLen, y, true);
  }
  piece(z0 + ramp, z1 - ramp, top, false);
  // Lamp posts along both edges.
  for (const lx of lamps) {
    for (let z = z0 + 8; z < z1 - 4; z += 16) P.cyl(lx, z, yAt(z), yAt(z) + 7.2, 0.14, F_PROP | F_ANCHOR, 0x3a3f44, SURF_METAL, { segs: 6 });
  }
  return yAt;
}

export function buildIstanbulParts(base: Base, isRoad: (x: number, z: number) => boolean): Part[] {
  const P = new PartList();
  const c: Ctx = { P, base, isRoad };
  let owner = OWNER0;
  const next = (): void => {
    P.owner = owner++;
  };

  // --- Hagia Sophia ---
  next();
  {
    const y = mosque(c, R(26, 94, 286, 348), 28, { r: 15.5, crown: 55.6, drumH: 3 }, ['E', 'W']);
    // Buttresses on the north and south sides (sunk into the slope so they never float).
    for (const [x0, x1] of [[38, 48], [72, 82]] as const) {
      P.box(x0, y - 4, 280, x1, y + 30, 286, F_HALL, 0xe2c9a6);
      P.box(x0, y - 4, 348, x1, y + 30, 353, F_HALL, 0xe2c9a6);
    }
    minaret(c, 21.5, 283, 60, [42, 50], 8);
    minaret(c, 21.5, 350, 60, [42, 50], 8);
    minaret(c, 98.5, 283, 50, [36], 7);
    minaret(c, 98.5, 350, 50, [36], 7);
  }

  // --- Blue Mosque (Sultan Ahmed) ---
  next();
  {
    mosque(c, R(33, 87, 487, 553), 24, { r: 11.75, crown: 43, drumH: 2 }, ['N', 'S', 'E', 'W']);
    courtyard(c, R(33, 87, 424, 486), 9, 'N');
    for (const [x, z] of [[29.5, 487], [90.5, 487], [29.5, 553], [90.5, 553]] as const) minaret(c, x, z, 64, [40, 48, 55], 8);
    for (const x of [29.5, 90.5]) minaret(c, x, 422, 64, [44, 52], 8);
  }

  // --- Hippodrome: obelisks and the Serpent Column ---
  next();
  {
    const y1 = plinth(c, R(-23, -17, 467, 473)) - CURB;
    stack(c, -20, 470, y1, [[2.6, 5], [1.4, 6], [1.15, 6], [0.9, 5.5], [0.5, 2.5]], 0xc9b28d);
    const y2 = plinth(c, R(-23.5, -16.5, 556.5, 563.5)) - CURB;
    stack(c, -20, 560, y2, [[3, 3], [1.9, 8], [1.6, 8], [1.3, 8], [0.9, 4], [0.4, 1]], 0x9e8f7a);
    const y3 = base(-20, 515) + CURB;
    P.cyl(-20, 515, y3 - 0.5, y3 + 5, 0.45, F_SPIRE, 0x6b6050, SURF_METAL, { segs: 8 });
  }

  // --- Topkapı: gates, Tower of Justice, wings, precinct wall ---
  next();
  {
    hall(c, R(141, 155, 290, 310), 18, 0xe4dccb);
    const gy = hall(c, R(200, 208, 291, 309), 12);
    for (const z of [287, 313]) {
      P.cyl(204, z, gy - 1, gy + 15, 3.5, F_SPIRE, STONE, undefined, { segs: 16 });
      addCone(P, 204, z, gy + 15, gy + 21, 3.7, 0.3, F_SPIRE, LEAD);
    }
    const ty = hall(c, R(236, 244, 266, 274), 30);
    P.box(237, ty + 30, 267, 243, ty + 34, 273, F_HALL, STONE);
    addCone(P, 240, 270, ty + 34, ty + 41, 3.6, 0.3, F_SPIRE, LEAD);
    hall(c, R(214, 232, 225, 262), 11);
    hall(c, R(248, 258, 225, 300), 9);
    hall(c, R(214, 258, 330, 360), 12);
    hall(c, R(214, 258, 390, 432), 10);
    for (const [z0, z1] of [[215, 290], [310, 440]] as const) hall(c, R(140, 143, z0, z1), 11, 0xd8ccb4);
  }

  // --- Yeni Cami and the Spice Bazaar ---
  next();
  {
    mosque(c, R(-63, -26, 132, 169), 18, { r: 8.75, crown: 36, drumH: 2 }, ['N', 'S', 'E', 'W'], 7.6);
    courtyard(c, R(-108, -67, 132, 169), 8, 'W');
    minaret(c, -66.5, 129.5, 52, [34, 41, 47], 6, 1.6);
    minaret(c, -66.5, 171.5, 52, [34, 41, 47], 6, 1.6);
  }
  next();
  {
    const y = hall(c, R(-28, 58, 177, 193), 11, 0xd9c7a8);
    domeRow(c, R(-28, 58, 177, 193), y + 11, 8, 2.8);
  }

  // --- Süleymaniye and its medreses ---
  next();
  {
    mosque(c, R(-327, -273, 173, 227), 26, { r: 13.5, crown: 53, drumH: 2 }, ['N', 'S']);
    courtyard(c, R(-327, -273, 126, 171), 9, 'N');
    minaret(c, -330.5, 172, 76, [46, 55, 63.8], 12, 2);
    minaret(c, -269.5, 172, 76, [46, 55, 63.8], 12, 2);
    minaret(c, -330.5, 124, 56, [40, 48], 8);
    minaret(c, -269.5, 124, 56, [40, 48], 8);
    for (const [x0, x1] of [[-378, -342], [-258, -222]] as const) {
      for (const [z0, z1] of [[115, 170], [182, 238], [250, 295]] as const) {
        const r = R(x0, x1, z0, z1);
        const y = hall(c, r, 9, 0xe0d6c2);
        domeRow(c, r, y + 9, 9, 3.2);
      }
    }
  }

  // --- Beyazıt Tower and the Grand Bazaar ---
  next();
  {
    const y = plinth(c, R(-205, -195, 295, 305));
    P.cyl(-200, 300, y - 1, y + 62, 3.6, F_SPIRE, 0xe9e1cf, undefined, { segs: 16 });
    P.cyl(-200, 300, y + 61, y + 62.2, 4.8, F_SPIRE, 0xd0c4ad, undefined, { segs: 16 });
    P.cyl(-200, 300, y + 62.2, y + 78, 3.0, F_SPIRE, 0xe9e1cf, undefined, { segs: 16 });
    addCone(P, -200, 300, y + 78, y + 85, 3.2, 0.3, F_SPIRE, LEAD);
  }
  next();
  {
    const r = R(-148, -52, 232, 308);
    const y = hall(c, r, 10, 0xd8c3a0);
    domeRow(c, r, y + 10, 12, 3.4);
  }

  // --- Valens Aqueduct: a level top 29 m above the valley floor at Atatürk Bulvarı ---
  next();
  {
    const top = base(-500, 260) + 29;
    const z0 = 256,
      z1 = 264;
    P.box(-720, top - 4, z0, -380, top, z1, F_HALL, 0xc7a27a);
    P.box(-720, top - 17.5, z0 + 0.5, -380, top - 15, z1 - 0.5, F_HALL, 0xc7a27a);
    for (let x = -718; x <= -382; x += 13) {
      if (Math.abs(x + 500) < 14 || isRoad(x, 260) || isRoad(x - 2.5, 260) || isRoad(x + 2.5, 260)) continue;
      const [lo] = range(base, R(x - 2, x + 2, z0, z1));
      P.box(x - 2, lo - 1, z0, x + 2, top - 4, z1, F_HALL, 0xbf9970);
    }
  }

  // --- Galata Tower ---
  next();
  {
    const y = plinth(c, R(31, 49, -264, -246));
    addRoundTower(P, { x: 40, z: -255, baseY: y, r: 8.23, balcony: 51.65, drumH: 3.5, coneTop: 62.6, finialTop: 66.9 }, 0xd8cdb8);
  }

  // --- Taksim: Republic Monument and the AKM ---
  next();
  {
    const y = plinth(c, R(101.5, 108.5, -593.5, -586.5)) - CURB;
    stack(c, 105, -590, y, [[3.5, 2.2], [1.6, 8.8]], 0x9c9a8a);
    hall(c, R(145, 168, -615, -570), 30, 0xb7b9bb);
  }

  // --- Dolmabahçe ---
  next();
  {
    hall(c, R(320, 342, -528, -452), 18, 0xf0ebe0);
    hall(c, R(322, 342, -500, -480), 24, 0xf0ebe0);
    const cy = hall(c, R(328.75, 333.25, -448.25, -443.75), 22, 0xf0ebe0);
    addCone(P, 331, -446, cy + 22, cy + 27, 2.4, 0.3, F_SPIRE, LEAD);
  }

  // --- Ortaköy Mosque ---
  next();
  {
    mosque(c, R(433.9, 446.1, -661.1, -648.9), 13, { r: 6, crown: 25, drumH: 1.5 }, []);
    minaret(c, 431.5, -663.5, 32, [22], 5, 1.3);
    minaret(c, 448.5, -663.5, 32, [22], 5, 1.3);
  }

  // --- Üsküdar: Mihrimah and Şemsi Paşa ---
  next();
  {
    mosque(c, R(688, 712, 48, 72), 18, { r: 9, crown: 35, drumH: 2 }, ['W']);
    minaret(c, 685, 45, 50, [34, 41], 6, 1.6);
    minaret(c, 715, 45, 50, [34, 41], 6, 1.6);
  }
  next();
  {
    mosque(c, R(654, 666, 164, 176), 9, { r: 5, crown: 18, drumH: 1 }, []);
    minaret(c, 651.5, 161.5, 25, [17], 4, 1.1);
  }

  // --- Maiden's Tower ---
  next();
  {
    const y = base(575, 211.5) + CURB;
    P.box(564, -2, 204.5, 586, y + 9, 218.5, F_HALL, 0xe9e2d2);
    P.box(571.5, y + 9, 208, 578.5, y + 18, 215, F_HALL, 0xe9e2d2);
    addCone(P, 575, 211.5, y + 18, y + 23, 4.2, 0.4, F_SPIRE, LEAD);
    P.cyl(575, 211.5, y + 23, y + 25, 0.5, F_SPIRE, 0xc9a54a, SURF_METAL, { segs: 6 });
  }

  // --- Galata Bridge (x 0, along Z): upper deck, lower walkways with restaurants, lamps, catenary ---
  next();
  {
    const yAt = zDeck(c, -21, 21, -95, 95, 6.5, 35, 0x9a9690, [-20.6, 20.6]);
    for (let z = -80; z <= 80; z += 30) P.cyl(0, z, yAt(z), yAt(z) + 8.5, 0.18, F_PROP | F_ANCHOR, 0x3a3f44, SURF_METAL, { segs: 6 });
    for (const s of [-1, 1]) {
      for (const [za, zb] of [[-58, -40], [40, 58]] as const) {
        const xa = s > 0 ? 13 : -21,
          xb = s > 0 ? 21 : -13;
        P.box(xa, -0.2, za, xb, 0.3, zb, F_DECK, 0x8f877b, SURF_WOOD);
        const ra = s > 0 ? 17 : -21,
          rb = s > 0 ? 21 : -17;
        P.box(ra, 0.3, za + 2, rb, 3.8, zb - 2, F_HALL, 0xcf8f55);
      }
    }
    for (const z of [-45, 45, -20, 20]) P.box(-12, -6, z - 2, 12, 5.5, z + 2, F_DECK, CONCRETE);
  }

  // --- Atatürk Bridge (x -500, along Z) ---
  next();
  {
    zDeck(c, -512.5, -487.5, -166, -9, 6, 30, 0x9a9690, [-512, -488]);
    for (const z of [-117, -87, -57]) P.box(-508, -6, z - 2, -492, 5, z + 2, F_DECK, CONCRETE);
  }

  // --- Haliç Metro Bridge (x -275, along Z): cable-stayed, deck at 13 m ---
  next();
  {
    const x0 = -282,
      x1 = -268,
      top = 13;
    // South: the deck runs on into the hill until the ground reaches it.
    let zS = 140;
    for (let z = 60; z <= 140; z += 1) {
      if (base(-275, z) + CURB >= top - 0.25) {
        zS = z;
        break;
      }
    }
    const zN = -162;
    P.box(x0, top - 1.2, zN, x1, top, zS, F_DECK, 0x9fa4a8);
    P.box(x0, top, zN, x0 + 0.3, top + 1.1, zS, F_DECK, STEEL, SURF_METAL);
    P.box(x1 - 0.3, top, zN, x1, top + 1.1, zS, F_DECK, STEEL, SURF_METAL);
    // North ramp down to the street, solid steps of 0.25 m.
    const steps = Math.ceil((top - CURB) / 0.25);
    const rampLen = 50;
    for (let i = 0; i < steps; i++) {
      const y = top - ((top - CURB) * (i + 1)) / steps;
      const za = zN - ((i + 1) * rampLen) / steps,
        zb = zN - (i * rampLen) / steps;
      const [lo] = range(base, R(x0, x1, za, zb));
      P.box(x0, Math.min(lo, y) - 1, za, x1, y, zb, F_DECK, 0x9fa4a8);
    }
    // Piers of the approach spans.
    for (const z of [-151, 97]) if (z < zS - 3) P.box(-278, -6, z - 2, -272, top - 1.2, z + 2, F_DECK, CONCRETE);
    // Pylons: twin legs, a top beam and stay masts at the deck edges.
    for (const zp of [52, -128]) {
      const [lo] = range(base, R(-286, -264, zp - 1.5, zp + 1.5));
      const yb = Math.min(lo, 0) - 6;
      P.box(-286, yb, zp - 1.5, -283, 65, zp + 1.5, F_DECK, 0xdfe2e4, SURF_METAL);
      P.box(-267, yb, zp - 1.5, -264, 65, zp + 1.5, F_DECK, 0xdfe2e4, SURF_METAL);
      P.box(-286, 61, zp - 1.5, -264, 64, zp + 1.5, F_DECK, 0xdfe2e4, SURF_METAL);
      P.box(-286, top - 4, zp - 1.5, -264, top - 1.2, zp + 1.5, F_DECK, 0xdfe2e4, SURF_METAL);
      for (const xm of [-281, -269]) {
        P.box(xm - 1, top, zp - 1, xm + 1, 61, zp + 1, F_SPIRE, 0xdfe2e4, SURF_METAL);
        // Stays fanning to the deck: six toward mid-span, four back.
        const toMid = zp > 0 ? -1 : 1;
        for (let k = 1; k <= 6; k++) {
          addCableChain(P, [[xm, 60 - k * 3, zp], [xm, top + 0.6, zp + toMid * k * 13]], 0.25, F_CABLE, 0x2b2f33, 0.12);
        }
        for (let k = 1; k <= 4; k++) {
          const zEnd = zp - toMid * k * 10;
          if (zEnd > zS - 2) continue;
          addCableChain(P, [[xm, 60 - k * 4, zp], [xm, top + 0.6, zEnd]], 0.25, F_CABLE, 0x2b2f33, 0.12);
        }
      }
    }
  }

  // --- 15 Temmuz Şehitler Bridge (along X at z -740): towers 165 m, deck top 64 m, main span 430 m ---
  next();
  {
    const zc = -740,
      dz0 = zc - 16.7,
      dz1 = zc + 16.7,
      top = 64;
    for (const [ax0, ax1] of [[282, 318], [972, 1000]] as const) {
      const [lo] = range(base, R(ax0, ax1, zc - 24, zc + 24));
      P.box(ax0, lo - 1, zc - 24, ax1, top - 3, zc + 24, F_DECK, CONCRETE);
    }
    P.box(300, top - 3, dz0, 990, top, dz1, F_DECK, 0x9fa4a8);
    P.box(300, top, dz0, 990, top + 1.1, dz0 + 0.3, F_DECK, STEEL, SURF_METAL);
    P.box(300, top, dz1 - 0.3, 990, top + 1.1, dz1, F_DECK, STEEL, SURF_METAL);
    const towers = [440, 870];
    for (const tx of towers) {
      const [lo] = range(base, R(tx - 2.5, tx + 2.5, zc - 22.5, zc + 22.5));
      const yb = Math.min(lo, 0) - 6;
      for (const lz of [zc - 19, zc + 19]) P.box(tx - 2.5, yb, lz - 3.5, tx + 2.5, 165, lz + 3.5, F_DECK, 0xdcdedf, SURF_METAL);
      for (const by of [top - 8, 100, 160]) P.box(tx - 2.5, by - 2, zc - 15.5, tx + 2.5, by + 2, zc + 15.5, F_DECK, 0xdcdedf, SURF_METAL);
    }
    // Main cables (z = ±14): side spans from the anchorages, main span sagging to 70 m at mid-span.
    const cableY = (x: number): number => {
      if (x <= 440) {
        const t = (x - 300) / 140;
        return 66 + (165 - 66) * t - 8 * Math.sin(Math.PI * t);
      }
      if (x >= 870) {
        const t = (990 - x) / 120;
        return 66 + (165 - 66) * t - 7 * Math.sin(Math.PI * t);
      }
      const u = (x - 655) / 215;
      return 70 + 95 * u * u;
    };
    const xs: number[] = [];
    for (let x = 300; x < 440; x += 10) xs.push(x);
    for (let x = 440; x < 870; x += 10) xs.push(x);
    for (let x = 870; x < 990; x += 10) xs.push(x);
    xs.push(990);
    for (const cz of [zc - 14, zc + 14]) {
      addCableChain(P, xs.map((x) => [x, cableY(x), cz] as [number, number, number]), 0.4, F_CABLE, RED, 0.45);
      // Vertical suspenders every 18 m (not at the towers).
      for (let x = 309; x < 990; x += 18) {
        if (towers.some((t) => Math.abs(x - t) < 6)) continue;
        const cy = cableY(x) - 0.5;
        if (cy - top < 1.5) continue;
        P.cyl(x, cz, top, cy, 0.22, F_CABLE, 0xd8d8dc, SURF_METAL, { segs: 5 });
      }
    }
  }

  // --- Moored ships: the cruise ship at Galataport and three vapur ---
  next();
  {
    P.box(334, -6, -320, 366, 2, -70, F_HALL, HULL, SURF_METAL);
    P.box(334, 2, -320, 366, 12, -70, F_HALL, WHITE, SURF_METAL);
    P.box(336, 12, -300, 364, 24, -110, F_HALL, WHITE, SURF_METAL);
    P.box(338, 24, -290, 362, 36, -130, F_HALL, WHITE, SURF_METAL);
    P.box(341, 36, -270, 359, 45, -160, F_HALL, 0xdde3e8, SURF_METAL);
    P.cyl(350, -150, 45, 53, 3.5, F_SPIRE, 0x2f5f8f, SURF_METAL, { segs: 12 });
  }
  for (const [x0, x1, z0, z1] of [
    [-108, -98, 38, 72],
    [162, 172, -100, -66],
    [620, 656, 40, 50],
  ] as const) {
    next();
    const along = x1 - x0 > z1 - z0;
    P.box(x0, -2, z0, x1, 2.6, z1, F_HALL, HULL, SURF_METAL);
    const ix = along ? 3 : 1,
      iz = along ? 1 : 3;
    P.box(x0 + ix, 2.6, z0 + iz, x1 - ix, 5.5, z1 - iz, F_HALL, WHITE, SURF_METAL);
    const mx = (x0 + x1) / 2,
      mz = (z0 + z1) / 2;
    P.cyl(mx, mz, 5.5, 9, 0.9, F_SPIRE, 0x1c1c1c, SURF_METAL, { segs: 10 });
    const ox = along ? (x1 - x0) * 0.3 : 0,
      oz = along ? 0 : (z1 - z0) * 0.3;
    P.cyl(mx + ox, mz + oz, 5.5, 16, 0.2, F_PROP | F_ANCHOR, 0x3a3f44, SURF_METAL, { segs: 6 });
  }
  // Sailboats with 14 m masts at Eminönü and Karaköy.
  for (const [x, z] of [
    [-150, 45],
    [-160, 30],
    [120, -80],
    [230, -85],
  ] as const) {
    next();
    P.box(x - 1.5, -1.2, z - 4.5, x + 1.5, 0.6, z + 4.5, F_HALL, WHITE, SURF_WOOD);
    P.cyl(x, z - 0.5, 0.6, 14.6, 0.15, F_PROP | F_ANCHOR, 0xe0e0e0, SURF_METAL, { segs: 6 });
  }
  return P.parts;
}

/** XZ footprints of the parts (trees and lamps keep out of them). */
export function partFootprints(parts: readonly Part[]): Rect[] {
  const out: Rect[] = [];
  for (const p of parts) {
    if (p.noCollide) continue;
    if (p.k === 0) out.push({ minX: p.a, minZ: p.c, maxX: p.d, maxZ: p.f });
    else if (p.k === 1) out.push({ minX: p.a - p.e, minZ: p.c - p.e, maxX: p.a + p.e, maxZ: p.c + p.e });
    else if (p.k === 2) out.push({ minX: p.a - p.d, minZ: p.c - p.f, maxX: p.a + p.d, maxZ: p.c + p.f });
  }
  return out;
}
