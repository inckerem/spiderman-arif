import { Rng } from '../../core/rng';
import { clamp, lerp } from '../../core/math';
import { CURB } from '../../physics/terrain';
import {
  D_DOWNTOWN,
  D_LOW,
  D_MID,
  D_WATERFRONT,
  PROP_ANTENNA,
  PROP_BILLBOARD,
  PROP_BLADE_SIGN,
  PROP_HELIPAD,
  PROP_HVAC,
  PROP_TANK,
  PROP_WALL_SIGN,
  SP_BENCH,
  SP_BOLLARD,
  SP_CAR,
  SP_FOUNTAIN,
  SP_HYDRANT,
  SP_LAMP,
  SP_PARK_LAMP,
  SP_TRAFFIC_LIGHT,
  SP_TRASH,
  TREE_MAPLE,
  TREE_OAK,
  TREE_PINE,
  TREE_POPLAR,
  type Block,
  type BoxSpec,
  type BridgeSpec,
  type Building,
  type CityLayout,
  type District,
  type FacadeStyle,
  type PathPolyline,
  type Pier,
  type Rect,
  type Road,
  type RoofProp,
  type StreetProp,
  type Tree,
  type Volume,
} from '../../world/types';

const LAND: Rect = { minX: -720, maxX: 720, minZ: -760, maxZ: 760 };
const ISLET: Rect = { minX: 975, maxX: 1085, minZ: -150, maxZ: 150 };
const PROMENADE = 18;
const SIDEWALK = 5;

type RGB = [number, number, number];
const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

/** District facade palettes (saturated comic look). */
const PALETTES: Record<District, { wall: number[]; trim: number[]; glass: number[]; windows: number[] }> = {
  [D_DOWNTOWN]: {
    wall: [0x3d6f8f, 0x2f5d7a, 0x5a7d95, 0x8aa7b8, 0xc9c1ad, 0xb7ae9b, 0x456a7a, 0x6d8798, 0x2e4c63, 0xd8cfb8],
    trim: [0xe8e1cf, 0x1f2f3d, 0xcfd8de, 0x9fb3bf],
    glass: [0x6fb3d6, 0x4f97c2, 0x87c6de, 0x3d84ad, 0x9fd0e0],
    windows: [0, 0, 5, 6, 1],
  },
  [D_MID]: {
    wall: [0xb5543b, 0xc96f45, 0xd9b48a, 0xe3cfa5, 0x9c4a3b, 0xcf8b5a, 0x7f9a8a, 0xd7a35a, 0xa86a52, 0xe0c391],
    trim: [0xf2e7cf, 0x5a3b2e, 0xe9dcc0, 0x3b4a52],
    glass: [0x4a7891, 0x557f99, 0x3f6a80],
    windows: [1, 2, 3, 6, 1],
  },
  [D_LOW]: {
    wall: [0xe0664f, 0x4fb3a5, 0xf0b84a, 0x8f7bd1, 0xd9534f, 0x58a6d6, 0xe98a4b, 0x6fbf73, 0xc94f6d, 0xf2d06b],
    trim: [0xfaf3e3, 0x2d2a32, 0xf7e6c4],
    glass: [0x4a6f88, 0x3f6278],
    windows: [1, 2, 3, 1],
  },
  [D_WATERFRONT]: {
    wall: [0x8c3b2f, 0x5f7a4d, 0x7a3a2e, 0x4f6b72, 0x9a5a3a, 0x6b6f4a],
    trim: [0x2b2b2b, 0xd8cfb5, 0x3d3d3d],
    glass: [0x3a5566, 0x445d6b],
    windows: [4, 4, 1],
  },
};

function rectW(r: Rect): number {
  return r.maxX - r.minX;
}
function rectD(r: Rect): number {
  return r.maxZ - r.minZ;
}

function genRoads(rng: Rng, lo: number, hi: number, segments: number, widths: number[], wideChance: number): Road[] {
  const driveW = 22;
  const a = lo + driveW / 2;
  const b = hi - driveW / 2;
  const weights: number[] = [];
  for (let i = 0; i < segments; i++) weights.push(0.78 + rng.float() * 0.44);
  const total = weights.reduce((s, w) => s + w, 0);
  const roads: Road[] = [{ center: a, width: driveW, perimeter: true }];
  let acc = a;
  for (let i = 0; i < segments - 1; i++) {
    acc += ((b - a) * weights[i]!) / total;
    const w = rng.chance(wideChance) ? 24 : rng.pick(widths);
    roads.push({ center: Math.round(acc * 2) / 2, width: w, perimeter: false });
  }
  roads.push({ center: b, width: driveW, perimeter: true });
  return roads;
}

function nearestIndex(roads: Road[], v: number, lo: number, hi: number): number {
  let best = lo,
    bd = Infinity;
  for (let i = lo; i <= hi; i++) {
    const d = Math.abs(roads[i]!.center - v);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function insetRect(r: Rect, l: number, rr: number, n: number, s: number): Rect {
  return { minX: r.minX + l, maxX: r.maxX - rr, minZ: r.minZ + n, maxZ: r.maxZ - s };
}

function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return a.minX < b.maxX + pad && a.maxX > b.minX - pad && a.minZ < b.maxZ + pad && a.maxZ > b.minZ - pad;
}

function distPointRect(x: number, z: number, r: Rect): number {
  const dx = Math.max(r.minX - x, 0, x - r.maxX);
  const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
  return Math.hypot(dx, dz);
}

function makeStyle(rng: Rng, district: District): FacadeStyle {
  const pal = PALETTES[district];
  const window = rng.pick(pal.windows);
  const floorHeight =
    district === D_WATERFRONT ? rng.range(4.6, 5.4) : district === D_DOWNTOWN ? rng.range(3.8, 4.2) : rng.range(3.3, 3.8);
  const bayWidth = window === 0 || window === 5 ? rng.range(2.4, 3.2) : window === 4 ? rng.range(3.6, 4.6) : rng.range(2.9, 3.9);
  return {
    window,
    floorHeight,
    bayWidth,
    wall: hex(rng.pick(pal.wall)),
    trim: hex(rng.pick(pal.trim)),
    glass: hex(rng.pick(pal.glass)),
    storefront: district === D_DOWNTOWN ? 0 : district === D_WATERFRONT ? 0 : rng.chance(0.75) ? rng.range(3.6, 4.4) : 0,
    litRatio: rng.range(0.3, 0.7),
    pilasters: window !== 0 && window !== 5 && rng.chance(0.55),
  };
}

interface GenContext {
  rng: Rng;
  buildings: Building[];
  props: StreetProp[];
  trees: Tree[];
}

function addBuilding(
  ctx: GenContext,
  fp: Rect,
  height: number,
  district: District,
  opts: { streetFaces: number[]; allowSigns: boolean; baseY?: number },
): Building | null {
  const rng = ctx.rng;
  const w = rectW(fp),
    d = rectD(fp);
  if (w < 6 || d < 6) return null;
  const baseY = opts.baseY ?? CURB;
  const style = makeStyle(rng, district);
  const fh = style.floorHeight;
  // Keep every building inside its district's height band (crowns included).
  const [bandLo, bandHi, crownReserve] = HEIGHT_BANDS[district];
  let floors = Math.max(3, Math.round((height - baseY) / fh));
  while (floors > 3 && baseY + floors * fh > bandHi - crownReserve) floors--;
  while (baseY + floors * fh < bandLo) floors++;
  let H = baseY + floors * fh;
  const volumes: Volume[] = [];
  const minSide = (r: Rect): number => Math.min(rectW(r), rectD(r));

  if (district === D_DOWNTOWN && H > 100) {
    const baseFloors = rng.int(2, 4);
    const baseTop = baseY + baseFloors * fh + 1.2;
    volumes.push({ ...fp, minY: baseY, maxY: baseTop, role: 0 });
    let rect = insetRect(fp, rng.range(0, 3.5), rng.range(0, 3.5), rng.range(0, 3.5), rng.range(0, 3.5));
    if (minSide(rect) < 16) rect = { ...fp };
    const tiers = rng.int(1, 3);
    const fracs = tiers === 1 ? [1] : tiers === 2 ? [rng.range(0.6, 0.74), 1] : [rng.range(0.48, 0.6), rng.range(0.74, 0.86), 1];
    let y = baseTop;
    const shaft = H - baseTop;
    for (let i = 0; i < fracs.length; i++) {
      const top = baseTop + shaft * fracs[i]!;
      if (top - y < fh) continue;
      volumes.push({ ...rect, minY: y, maxY: top, role: 1 });
      y = top;
      // Setback for the next tier unless the tower is already slender.
      const next = insetRect(rect, rng.range(2, 5), rng.range(2, 5), rng.range(2, 5), rng.range(2, 5));
      if (i < fracs.length - 1 && minSide(next) >= 12) rect = next;
    }
    H = y;
    // Crown
    const top = volumes[volumes.length - 1]!;
    const topRect: Rect = top;
    const crownKind = rng.float();
    if (crownKind < 0.45 && minSide(topRect) > 16) {
      const c1 = insetRect(topRect, 3, 3, 3, 3);
      volumes.push({ ...c1, minY: H, maxY: H + rng.range(5, 8), role: 2 });
      H = volumes[volumes.length - 1]!.maxY;
    } else if (crownKind < 0.75 && minSide(topRect) > 20) {
      const c1 = insetRect(topRect, 2.5, 2.5, 2.5, 2.5);
      const h1 = rng.range(4, 6);
      volumes.push({ ...c1, minY: H, maxY: H + h1, role: 2 });
      const c2 = insetRect(c1, 3, 3, 3, 3);
      volumes.push({ ...c2, minY: H + h1, maxY: H + h1 + rng.range(4, 6), role: 2 });
      H = volumes[volumes.length - 1]!.maxY;
    }
  } else if (district === D_MID || district === D_DOWNTOWN) {
    let y = baseY;
    if (rng.chance(0.7)) {
      const bt = baseY + fh * rng.int(1, 2) + 0.6;
      volumes.push({ ...fp, minY: y, maxY: bt, role: 0 });
      y = bt;
    }
    if (H > 50 && rng.chance(0.5) && minSide(fp) > 22) {
      const st = lerp(y, H, rng.range(0.72, 0.86));
      volumes.push({ ...fp, minY: y, maxY: st, role: 1 });
      const r2 = insetRect(fp, rng.range(2, 4), rng.range(2, 4), rng.range(2, 4), rng.range(2, 4));
      volumes.push({ ...r2, minY: st, maxY: H, role: 1 });
    } else {
      volumes.push({ ...fp, minY: y, maxY: H, role: 1 });
    }
    if (rng.chance(0.3)) {
      const top = volumes[volumes.length - 1]!;
      if (minSide(top) > 14) {
        const c = insetRect(top, 3, 3, 3, 3);
        volumes.push({ ...c, minY: H, maxY: H + rng.range(3.5, 5), role: 2 });
        H = volumes[volumes.length - 1]!.maxY;
      }
    }
  } else {
    volumes.push({ ...fp, minY: baseY, maxY: H, role: 1 });
  }

  // Parapets on exposed roofs.
  const parapets: BoxSpec[] = [];
  const PT = 0.3;
  for (let i = 0; i < volumes.length; i++) {
    const v = volumes[i]!;
    const above = volumes[i + 1];
    const area = rectW(v) * rectD(v);
    if (area < 110) continue;
    if (
      above &&
      Math.abs(above.minY - v.maxY) < 0.01 &&
      Math.abs(above.minX - v.minX) < 0.3 &&
      Math.abs(above.maxX - v.maxX) < 0.3 &&
      Math.abs(above.minZ - v.minZ) < 0.3 &&
      Math.abs(above.maxZ - v.maxZ) < 0.3
    )
      continue;
    const ph = district === D_DOWNTOWN ? rng.range(1.1, 1.35) : rng.range(0.95, 1.2);
    const y0 = v.maxY,
      y1 = v.maxY + ph;
    parapets.push({ minX: v.minX, maxX: v.maxX, minY: y0, maxY: y1, minZ: v.minZ, maxZ: v.minZ + PT });
    parapets.push({ minX: v.minX, maxX: v.maxX, minY: y0, maxY: y1, minZ: v.maxZ - PT, maxZ: v.maxZ });
    parapets.push({ minX: v.minX, maxX: v.minX + PT, minY: y0, maxY: y1, minZ: v.minZ + PT, maxZ: v.maxZ - PT });
    parapets.push({ minX: v.maxX - PT, maxX: v.maxX, minY: y0, maxY: y1, minZ: v.minZ + PT, maxZ: v.maxZ - PT });
  }

  // Roof props on the topmost roof.
  const props: RoofProp[] = [];
  const topV = volumes[volumes.length - 1]!;
  const roofY = topV.maxY;
  const roof = insetRect(topV, 1.4, 1.4, 1.4, 1.4);
  const placed: Rect[] = [];
  const tryPlace = (sx: number, sz: number, centerBias: boolean): { x: number; z: number } | null => {
    for (let a = 0; a < 10; a++) {
      const rw = rectW(roof) - sx,
        rd = rectD(roof) - sz;
      if (rw <= 0.2 || rd <= 0.2) return null;
      const fx = centerBias ? 0.5 + (rng.float() - 0.5) * 0.3 : rng.float();
      const fz = centerBias ? 0.5 + (rng.float() - 0.5) * 0.3 : rng.float();
      const x = roof.minX + sx / 2 + rw * fx;
      const z = roof.minZ + sz / 2 + rd * fz;
      const r: Rect = { minX: x - sx / 2, maxX: x + sx / 2, minZ: z - sz / 2, maxZ: z + sz / 2 };
      if (placed.some((p) => rectsOverlap(p, r, 1.2))) continue;
      placed.push(r);
      return { x, z };
    }
    return null;
  };
  const tall = H > 100;
  if (tall && rng.chance(0.42)) {
    const r = rng.range(0.35, 0.65);
    const h = rng.range(14, 40);
    const at = tryPlace(2.5, 2.5, true);
    if (at) props.push({ type: PROP_ANTENNA, x: at.x, y: roofY, z: at.z, sx: r, sy: h, sz: r, face: 0, variant: rng.int(0, 3) });
  } else if (tall && rng.chance(0.35) && rectW(roof) > 18 && rectD(roof) > 18) {
    const at = tryPlace(14, 14, true);
    if (at) props.push({ type: PROP_HELIPAD, x: at.x, y: roofY, z: at.z, sx: 12, sy: 0.05, sz: 12, face: 0, variant: 0 });
  }
  if (!tall && (district === D_MID || district === D_LOW || district === D_WATERFRONT) && rng.chance(0.55)) {
    const r = rng.range(1.7, 2.5);
    const at = tryPlace(r * 2 + 0.6, r * 2 + 0.6, false);
    if (at) {
      props.push({
        type: PROP_TANK,
        x: at.x,
        y: roofY,
        z: at.z,
        sx: r,
        sy: rng.range(3.6, 5),
        sz: rng.range(2.6, 3.4),
        face: 0,
        variant: rng.int(0, 2),
      });
    }
  }
  if (!tall && rng.chance(0.14) && opts.streetFaces.length > 0) {
    // Billboard near a street-facing roof edge.
    const face = rng.pick(opts.streetFaces);
    const along = face <= 1 ? rectD(roof) : rectW(roof);
    const bw = Math.min(along - 2, rng.range(8, 12));
    if (bw > 6) {
      const bh = rng.range(3.5, 5);
      const off = 1.2;
      let x = (roof.minX + roof.maxX) / 2,
        z = (roof.minZ + roof.maxZ) / 2;
      if (face === 0) x = roof.maxX - off;
      if (face === 1) x = roof.minX + off;
      if (face === 2) z = roof.maxZ - off;
      if (face === 3) z = roof.minZ + off;
      const r: Rect =
        face <= 1
          ? { minX: x - 0.6, maxX: x + 0.6, minZ: z - bw / 2, maxZ: z + bw / 2 }
          : { minX: x - bw / 2, maxX: x + bw / 2, minZ: z - 0.6, maxZ: z + 0.6 };
      if (!placed.some((p) => rectsOverlap(p, r, 0.8))) {
        placed.push(r);
        props.push({ type: PROP_BILLBOARD, x, y: roofY, z, sx: bw, sy: bh, sz: 2.6, face, variant: rng.int(0, 15) });
      }
    }
  }
  const nH = tall ? rng.int(2, 5) : rng.int(1, 3);
  for (let i = 0; i < nH; i++) {
    const sx = rng.range(1.6, 3.8),
      sz = rng.range(1.6, 3.8),
      sy = rng.range(1.2, 2.3);
    const at = tryPlace(sx, sz, false);
    if (at) props.push({ type: PROP_HVAC, x: at.x, y: roofY, z: at.z, sx, sy, sz, face: 0, variant: rng.int(0, 3) });
  }
  // Signage on the street facade.
  if (opts.allowSigns && opts.streetFaces.length > 0) {
    const base = volumes[0]!;
    if (rng.chance(0.4) && base.maxY - base.minY > 10) {
      const face = rng.pick(opts.streetFaces);
      const along = face <= 1 ? rectD(base) : rectW(base);
      if (along > 10) {
        const t = rng.range(0.15, 0.85);
        const hgt = rng.range(4, 6.5);
        const y = baseY + (style.storefront || 4) + 1.2;
        let x: number, z: number;
        if (face <= 1) {
          x = face === 0 ? base.maxX : base.minX;
          z = lerp(base.minZ + 2, base.maxZ - 2, t);
        } else {
          z = face === 2 ? base.maxZ : base.minZ;
          x = lerp(base.minX + 2, base.maxX - 2, t);
        }
        props.push({ type: PROP_BLADE_SIGN, x, y, z, sx: 1.1, sy: hgt, sz: 0.3, face, variant: rng.int(0, 15) });
      }
    }
    if (style.storefront > 0) {
      for (const face of opts.streetFaces) {
        if (!rng.chance(0.6)) continue;
        const along = face <= 1 ? rectD(base) : rectW(base);
        const sw = Math.min(along * 0.6, rng.range(5, 9));
        if (sw < 3) continue;
        const t = rng.range(0.3, 0.7);
        let x: number, z: number;
        if (face <= 1) {
          x = face === 0 ? base.maxX : base.minX;
          z = lerp(base.minZ, base.maxZ, t);
        } else {
          z = face === 2 ? base.maxZ : base.minZ;
          x = lerp(base.minX, base.maxX, t);
        }
        props.push({
          type: PROP_WALL_SIGN,
          x,
          y: baseY + style.storefront - 0.2,
          z,
          sx: sw,
          sy: 1.1,
          sz: 0.18,
          face,
          variant: rng.int(0, 15),
        });
      }
    }
  }

  const b: Building = {
    id: ctx.buildings.length,
    district,
    volumes,
    parapets,
    props,
    style,
    height: H,
    footprint: { ...fp },
    seed: rng.int(0, 1 << 30),
  };
  ctx.buildings.push(b);
  return b;
}

function districtFor(rng: Rng, cx: number, cz: number, park: Rect): District {
  const core = Math.exp(-(((cx - 40) / 330) ** 2) - (((cz - 470) / 230) ** 2));
  const mid = 0.92 * Math.exp(-(((cx + 20) / 300) ** 2) - (((cz - 30) / 150) ** 2));
  const density = Math.max(core, mid) + (rng.float() - 0.5) * 0.12;
  const shore = Math.min(cx - LAND.minX, LAND.maxX - cx, cz - LAND.minZ, LAND.maxZ - cz);
  const parkAdj = distPointRect(cx, cz, park) < 70;
  if (density > 0.55) return D_DOWNTOWN;
  if (shore < 120) return density > 0.35 ? D_MID : rng.chance(0.45) ? D_WATERFRONT : D_LOW;
  if (density > 0.2 || parkAdj) return D_MID;
  return D_LOW;
}

/** Height bands per district (min, max, reserve for crowns above the main body), metres. */
const HEIGHT_BANDS: Record<District, [number, number, number]> = {
  [D_LOW]: [15, 40, 0],
  [D_MID]: [40, 100, 5],
  [D_DOWNTOWN]: [120, 250, 12],
  [D_WATERFRONT]: [15, 40, 0],
};

function heightFor(rng: Rng, district: District, cx: number, cz: number): number {
  if (district === D_DOWNTOWN) {
    const core = Math.exp(-(((cx - 40) / 300) ** 2) - (((cz - 470) / 210) ** 2));
    const mid = Math.exp(-(((cx + 20) / 260) ** 2) - (((cz - 30) / 130) ** 2));
    const k = clamp(Math.max(core, mid * 0.8) * 0.85 + rng.float() * 0.3, 0, 1);
    if (rng.chance(0.18)) return rng.range(70, 98);
    return lerp(120, 250, k);
  }
  if (district === D_MID) return rng.range(40, 95);
  if (district === D_WATERFRONT) return rng.range(15, 30);
  return rng.range(15, 40);
}

/** Split a block into lots along its long axis, 1 or 2 rows deep. */
function makeLots(rng: Rng, inner: Rect, district: District): Array<{ rect: Rect; faces: number[] }> {
  const lots: Array<{ rect: Rect; faces: number[] }> = [];
  const longX = rectW(inner) >= rectD(inner);
  const depth = longX ? rectD(inner) : rectW(inner);
  const range: [number, number] =
    district === D_DOWNTOWN ? [28, 55] : district === D_MID ? [18, 36] : district === D_WATERFRONT ? [20, 40] : [11, 24];
  const rows: Rect[] = [];
  if (depth > 62) {
    const alley = rng.chance(0.4) ? 5 : 0;
    const split = depth / 2 + (rng.float() - 0.5) * 8;
    if (longX) {
      rows.push({ ...inner, maxZ: inner.minZ + split - alley / 2 });
      rows.push({ ...inner, minZ: inner.minZ + split + alley / 2 });
    } else {
      rows.push({ ...inner, maxX: inner.minX + split - alley / 2 });
      rows.push({ ...inner, minX: inner.minX + split + alley / 2 });
    }
  } else rows.push({ ...inner });
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]!;
    const len = longX ? rectW(row) : rectD(row);
    let at = 0;
    while (at < len - 0.01) {
      let w = rng.range(range[0], range[1]);
      if (len - at - w < range[0] * 0.8) w = len - at;
      const a = at,
        b = Math.min(len, at + w);
      at = b;
      const rect: Rect = longX
        ? { minX: row.minX + a, maxX: row.minX + b, minZ: row.minZ, maxZ: row.maxZ }
        : { minX: row.minX, maxX: row.maxX, minZ: row.minZ + a, maxZ: row.minZ + b };
      const faces: number[] = [];
      // Street faces: lot edges on the block boundary.
      if (Math.abs(rect.maxX - inner.maxX) < 0.01) faces.push(0);
      if (Math.abs(rect.minX - inner.minX) < 0.01) faces.push(1);
      if (Math.abs(rect.maxZ - inner.maxZ) < 0.01) faces.push(2);
      if (Math.abs(rect.minZ - inner.minZ) < 0.01) faces.push(3);
      lots.push({ rect, faces });
    }
  }
  return lots;
}

function samplePolyline(pts: Array<[number, number]>, step: number): Array<[number, number]> {
  // Catmull-Rom through control points, resampled at roughly `step` metres.
  const out: Array<[number, number]> = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!,
      p1 = pts[i]!,
      p2 = pts[i + 1]!,
      p3 = pts[Math.min(n - 1, i + 2)]!;
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const k = Math.max(2, Math.ceil(segLen / step));
    for (let j = 0; j < k; j++) {
      const t = j / k,
        t2 = t * t,
        t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[n - 1]!);
  return out;
}

function distToPolyline(x: number, z: number, pts: Array<[number, number]>): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!,
      b = pts[i + 1]!;
    const abx = b[0] - a[0],
      abz = b[1] - a[1];
    const l2 = abx * abx + abz * abz || 1;
    const t = clamp(((x - a[0]) * abx + (z - a[1]) * abz) / l2, 0, 1);
    const d = Math.hypot(x - (a[0] + abx * t), z - (a[1] + abz * t));
    if (d < best) best = d;
  }
  return best;
}

function makeTree(rng: Rng, species: number, x: number, z: number, y: number, height: number, park: boolean): Tree {
  let rx: number, ry: number, cyF: number, trunkTopF: number;
  switch (species) {
    case TREE_PINE:
      rx = 0.2 * height;
      ry = 0.36 * height;
      cyF = 0.6;
      trunkTopF = 0.5;
      break;
    case TREE_POPLAR:
      rx = 0.14 * height;
      ry = 0.37 * height;
      cyF = 0.58;
      trunkTopF = 0.42;
      break;
    case TREE_MAPLE:
      rx = 0.3 * height;
      ry = 0.27 * height;
      cyF = 0.62;
      trunkTopF = 0.5;
      break;
    default:
      rx = 0.31 * height;
      ry = 0.26 * height;
      cyF = 0.63;
      trunkTopF = 0.52;
  }
  // Collision canopy is 80 % of the visual foliage volume.
  return {
    species,
    x,
    z,
    y,
    height,
    trunkRadius: clamp(0.022 * height, 0.22, 0.65),
    trunkTop: y + height * trunkTopF,
    cy: y + height * cyF,
    rx: rx * 0.8,
    ry: ry * 0.8,
    scale: height,
    rot: rng.range(0, Math.PI * 2),
    park,
  };
}

function genPark(rng: Rng, park: Rect, ctx: GenContext): {
  pond: CityLayout['pond'];
  paths: PathPolyline[];
  walls: BoxSpec[];
} {
  const w = rectW(park),
    d = rectD(park);
  const cx = (park.minX + park.maxX) / 2;
  const pond = {
    cx: cx + (rng.float() - 0.5) * w * 0.25,
    cz: park.minZ + d * rng.range(0.3, 0.42),
    rx: rng.range(68, 84),
    rz: rng.range(42, 54),
    level: -0.55,
  };
  // Wall with entrance gaps.
  const walls: BoxSpec[] = [];
  const WI = 2.5,
    WT = 0.5,
    WH = 0.85;
  const gapsX: number[] = [];
  const gapsZ: number[] = [];
  for (let t = 0.12; t < 0.95; t += rng.range(0.18, 0.26)) gapsX.push(lerp(park.minX, park.maxX, t));
  for (let t = 0.1; t < 0.95; t += rng.range(0.14, 0.2)) gapsZ.push(lerp(park.minZ, park.maxZ, t));
  const GAP = 8;
  const addWallRun = (horizontal: boolean, fixed: number, a: number, b: number, gaps: number[]): void => {
    let cur = a;
    const cuts = [...gaps.filter((g) => g > a + GAP && g < b - GAP), b + GAP / 2].sort((p, q) => p - q);
    for (const g of cuts) {
      const end = Math.min(b, g - GAP / 2);
      if (end - cur > 2) {
        if (horizontal)
          walls.push({ minX: cur, maxX: end, minY: CURB, maxY: CURB + WH, minZ: fixed - WT / 2, maxZ: fixed + WT / 2 });
        else walls.push({ minX: fixed - WT / 2, maxX: fixed + WT / 2, minY: CURB, maxY: CURB + WH, minZ: cur, maxZ: end });
      }
      cur = g + GAP / 2;
    }
  };
  addWallRun(true, park.minZ + WI, park.minX + WI + 6, park.maxX - WI - 6, gapsX);
  addWallRun(true, park.maxZ - WI, park.minX + WI + 6, park.maxX - WI - 6, gapsX);
  addWallRun(false, park.minX + WI, park.minZ + WI + 6, park.maxZ - WI - 6, gapsZ);
  addWallRun(false, park.maxX - WI, park.minZ + WI + 6, park.maxZ - WI - 6, gapsZ);

  // Paths: an inner loop plus crossing paths.
  const paths: PathPolyline[] = [];
  const loopInset = 22;
  const loopPts: Array<[number, number]> = [];
  const nLoop = 28;
  for (let i = 0; i <= nLoop; i++) {
    const a = (i / nLoop) * Math.PI * 2;
    const ex = (w / 2 - loopInset) * (1 + (rng.float() - 0.5) * 0.06);
    const ez = (d / 2 - loopInset) * (1 + (rng.float() - 0.5) * 0.06);
    // Superellipse for a rounded-rectangle loop
    const c = Math.cos(a),
      s = Math.sin(a);
    const px = cx + ex * Math.sign(c) * Math.pow(Math.abs(c), 0.45);
    const pz = (park.minZ + park.maxZ) / 2 + ez * Math.sign(s) * Math.pow(Math.abs(s), 0.45);
    loopPts.push([px, pz]);
  }
  loopPts[loopPts.length - 1] = loopPts[0]!;
  paths.push({ points: samplePolyline(loopPts, 4), width: 5.5 });
  const entrances: Array<[number, number]> = [];
  for (const g of gapsX) {
    entrances.push([g, park.minZ + 1]);
    entrances.push([g, park.maxZ - 1]);
  }
  for (const g of gapsZ) {
    entrances.push([park.minX + 1, g]);
    entrances.push([park.maxX - 1, g]);
  }
  const avoidPond = (x: number, z: number): [number, number] => {
    const dx = (x - pond.cx) / (pond.rx + 18),
      dz = (z - pond.cz) / (pond.rz + 18);
    const k = Math.hypot(dx, dz);
    if (k < 1) return [pond.cx + (dx / (k || 1)) * (pond.rx + 18), pond.cz + (dz / (k || 1)) * (pond.rz + 18)];
    return [x, z];
  };
  for (let i = 0; i < 4; i++) {
    const a = entrances[rng.int(0, entrances.length - 1)]!;
    let b = entrances[rng.int(0, entrances.length - 1)]!;
    for (let tries = 0; tries < 8 && Math.hypot(a[0] - b[0], a[1] - b[1]) < Math.min(w, d) * 0.7; tries++)
      b = entrances[rng.int(0, entrances.length - 1)]!;
    const pts: Array<[number, number]> = [a];
    const k = 4;
    for (let j = 1; j < k; j++) {
      const t = j / k;
      const nx = lerp(a[0], b[0], t) + (rng.float() - 0.5) * 70;
      const nz = lerp(a[1], b[1], t) + (rng.float() - 0.5) * 70;
      pts.push(avoidPond(clamp(nx, park.minX + 12, park.maxX - 12), clamp(nz, park.minZ + 12, park.maxZ - 12)));
    }
    pts.push(b);
    paths.push({ points: samplePolyline(pts, 4), width: rng.range(3.5, 4.5) });
  }
  // Path ring around the pond
  const pondPts: Array<[number, number]> = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    pondPts.push([pond.cx + Math.cos(a) * (pond.rx + 9), pond.cz + Math.sin(a) * (pond.rz + 9)]);
  }
  paths.push({ points: samplePolyline(pondPts, 4), width: 4 });

  // Meadows
  const meadows: Array<[number, number, number]> = [];
  for (let i = 0; i < 3; i++) {
    for (let tries = 0; tries < 20; tries++) {
      const r = rng.range(30, 46);
      const mx = rng.range(park.minX + r + 20, park.maxX - r - 20);
      const mz = rng.range(park.minZ + r + 20, park.maxZ - r - 20);
      if (Math.hypot((mx - pond.cx) / (pond.rx + r), (mz - pond.cz) / (pond.rz + r)) < 1.1) continue;
      if (meadows.some((m) => Math.hypot(m[0] - mx, m[1] - mz) < m[2] + r + 20)) continue;
      meadows.push([mx, mz, r]);
      break;
    }
  }

  // Trees: dart throwing with variable spacing (8-18 m) and species-aware clearance.
  const parkTrees: Tree[] = [];
  const cell = 18;
  const gw = Math.ceil(w / cell) + 1,
    gd = Math.ceil(d / cell) + 1;
  const grid: number[][] = Array.from({ length: gw * gd }, () => []);
  const noise = (x: number, z: number): number =>
    0.5 + 0.25 * Math.sin(x * 0.021 + 1.3) * Math.cos(z * 0.017 - 0.7) + 0.25 * Math.sin((x + z) * 0.009 + 2.1);
  const attempts = 26000;
  for (let a = 0; a < attempts; a++) {
    const x = rng.range(park.minX + 7, park.maxX - 7);
    const z = rng.range(park.minZ + 7, park.maxZ - 7);
    if (Math.hypot((x - pond.cx) / (pond.rx + 9), (z - pond.cz) / (pond.rz + 9)) < 1) continue;
    let onPath = false;
    for (const p of paths) {
      if (distToPolyline(x, z, p.points) < p.width / 2 + 3.2) {
        onPath = true;
        break;
      }
    }
    if (onPath) continue;
    let inMeadow = false;
    for (const m of meadows) if (Math.hypot(x - m[0], z - m[1]) < m[2]) inMeadow = true;
    if (inMeadow && !rng.chance(0.03)) continue;
    const spacing = 8 + 10 * clamp(noise(x, z), 0, 1);
    const species = rng.weighted([TREE_OAK, TREE_MAPLE, TREE_PINE, TREE_POPLAR], [35, 25, 22, 18]);
    const height =
      species === TREE_PINE
        ? rng.range(16, 28)
        : species === TREE_POPLAR
          ? rng.range(15, 26)
          : species === TREE_MAPLE
            ? rng.range(12, 19)
            : rng.range(14, 24);
    const t = makeTree(rng, species, x, z, CURB, height, true);
    const gx = Math.floor((x - park.minX) / cell),
      gz = Math.floor((z - park.minZ) / cell);
    let ok = true;
    for (let iz = Math.max(0, gz - 2); iz <= Math.min(gd - 1, gz + 2) && ok; iz++) {
      for (let ix = Math.max(0, gx - 2); ix <= Math.min(gw - 1, gx + 2) && ok; ix++) {
        for (const j of grid[iz * gw + ix]!) {
          const o = parkTrees[j]!;
          const dd = Math.hypot(o.x - x, o.z - z);
          const need = Math.max(spacing, 8, (o.rx + t.rx) * 0.9);
          if (dd < need) {
            ok = false;
            break;
          }
        }
      }
    }
    if (!ok) continue;
    grid[gz * gw + gx]!.push(parkTrees.length);
    parkTrees.push(t);
  }
  ctx.trees.push(...parkTrees);

  // Park lamps and benches along paths.
  for (const p of paths) {
    let acc = 0;
    let side = 1;
    for (let i = 1; i < p.points.length; i++) {
      const a = p.points[i - 1]!,
        b = p.points[i]!;
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      acc += seg;
      if (acc > 32) {
        acc = 0;
        const nx = -(b[1] - a[1]) / (seg || 1),
          nz = (b[0] - a[0]) / (seg || 1);
        const off = p.width / 2 + 1.2;
        const x = b[0] + nx * off * side,
          z = b[1] + nz * off * side;
        if (!(Math.hypot((x - pond.cx) / (pond.rx + 2), (z - pond.cz) / (pond.rz + 2)) < 1)) {
          if (rng.chance(0.55)) ctx.props.push({ type: SP_PARK_LAMP, x, y: CURB, z, rot: 0, variant: 0 });
          else
            ctx.props.push({
              type: SP_BENCH,
              x,
              y: CURB,
              z,
              rot: Math.atan2(nx * side, nz * side),
              variant: 1,
            });
        }
        side = -side;
      }
    }
  }
  return { pond, paths, walls };
}

function genBridge(): BridgeSpec {
  const deckY0 = 22,
    deckY1 = 24.5;
  const x0 = 726,
    x1 = 981;
  const deck: BoxSpec = { minX: x0, maxX: x1, minY: deckY0, maxY: deckY1, minZ: -10, maxZ: 10 };
  const towerXs = [792, 915];
  const towerTop = 96;
  const towers: BoxSpec[] = [];
  const beams: BoxSpec[] = [];
  for (const tx of towerXs) {
    towers.push({ minX: tx - 3, maxX: tx + 3, minY: -6, maxY: towerTop, minZ: 10, maxZ: 15.5 });
    towers.push({ minX: tx - 3, maxX: tx + 3, minY: -6, maxY: towerTop, minZ: -15.5, maxZ: -10 });
    beams.push({ minX: tx - 2.5, maxX: tx + 2.5, minY: 58, maxY: 62, minZ: -10, maxZ: 10 });
    beams.push({ minX: tx - 2.5, maxX: tx + 2.5, minY: towerTop - 5, maxY: towerTop - 1, minZ: -10, maxZ: 10 });
    beams.push({ minX: tx - 2.5, maxX: tx + 2.5, minY: 14, maxY: deckY0, minZ: -10, maxZ: 10 });
  }
  const anchorages: BoxSpec[] = [
    { minX: 700, maxX: 726, minY: -6, maxY: 28, minZ: -16, maxZ: 16 },
    { minX: 981, maxX: 1004, minY: -6, maxY: 28, minZ: -16, maxZ: 16 },
  ];
  // Main cable: anchorage top -> tower -> sag -> tower -> anchorage.
  const keys: Array<[number, number]> = [
    [713, 28],
    [towerXs[0]!, towerTop],
    [(towerXs[0]! + towerXs[1]!) / 2, 36],
    [towerXs[1]!, towerTop],
    [992, 28],
  ];
  const cable: Array<[number, number]> = [];
  const cableY = (x: number): number => {
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i]!,
        b = keys[i + 1]!;
      if (x >= a[0] && x <= b[0]) {
        const t = (x - a[0]) / (b[0] - a[0]);
        if (i === 1 || i === 2) {
          // Parabolic sag in the main span.
          const xm = keys[2]![0];
          const half = keys[3]![0] - xm;
          const u = (x - xm) / half;
          return keys[2]![1] + (towerTop - keys[2]![1]) * u * u;
        }
        // Side spans: gentle curve.
        return lerp(a[1], b[1], t * t * 0.4 + t * 0.6);
      }
    }
    return 28;
  };
  for (let x = keys[0]![0]; x <= keys[4]![0]; x += 3) cable.push([x, cableY(x)]);
  const suspenders: Array<[number, number, number, number]> = [];
  for (let x = x0 + 8; x < x1 - 6; x += 9) {
    if (towerXs.some((t) => Math.abs(t - x) < 6)) continue;
    const top = cableY(x);
    if (top - deckY1 < 3) continue;
    suspenders.push([x, 12.6, deckY1, top]);
    suspenders.push([x, -12.6, deckY1, top]);
  }
  return { deck, towers, beams, anchorages, suspenders, cable, cableZ: 12.6 };
}

export function generateCity(seed: number): CityLayout {
  const rng = new Rng(seed);
  const ctx: GenContext = { rng, buildings: [], props: [], trees: [] };
  const inner = { minX: LAND.minX + PROMENADE, maxX: LAND.maxX - PROMENADE, minZ: LAND.minZ + PROMENADE, maxZ: LAND.maxZ - PROMENADE };
  const avenues = genRoads(rng.fork(1), inner.minX, inner.maxX, 10, [22, 23, 24], 0.0);
  const streets = genRoads(rng.fork(2), inner.minZ, inner.maxZ, 18, [18, 18, 19, 20], 0.15);

  // Park bounded by roads.
  const iw = nearestIndex(avenues, -205, 1, avenues.length - 2);
  let ie = nearestIndex(avenues, 205, 1, avenues.length - 2);
  if (ie - iw < 2) ie = Math.min(avenues.length - 2, iw + 3);
  const jn = nearestIndex(streets, -655, 1, streets.length - 2);
  let js = nearestIndex(streets, -140, 1, streets.length - 2);
  const parkRect = (): Rect => ({
    minX: avenues[iw]!.center + avenues[iw]!.width / 2,
    maxX: avenues[ie]!.center - avenues[ie]!.width / 2,
    minZ: streets[jn]!.center + streets[jn]!.width / 2,
    maxZ: streets[js]!.center - streets[js]!.width / 2,
  });
  let park = parkRect();
  while (rectD(park) < 470 && js < streets.length - 3) {
    js++;
    park = parkRect();
  }

  // Blocks
  const blocks: Block[] = [];
  const plazas: Rect[] = [];
  const brng = rng.fork(3);
  for (let i = 0; i < avenues.length - 1; i++) {
    for (let j = 0; j < streets.length - 1; j++) {
      const a = avenues[i]!,
        b = avenues[i + 1]!,
        c = streets[j]!,
        d = streets[j + 1]!;
      const r: Rect = {
        minX: a.center + a.width / 2,
        maxX: b.center - b.width / 2,
        minZ: c.center + c.width / 2,
        maxZ: d.center - d.width / 2,
      };
      const cx = (r.minX + r.maxX) / 2,
        cz = (r.minZ + r.maxZ) / 2;
      if (cx > park.minX && cx < park.maxX && cz > park.minZ && cz < park.maxZ) continue;
      const district = districtFor(brng, cx, cz, park);
      blocks.push({ ...r, id: blocks.length, district, hasPlaza: false });
    }
  }

  // Buildings per block.
  const lrng = rng.fork(4);
  ctx.rng = lrng;
  for (const blk of blocks) {
    const innerRect = insetRect(blk, SIDEWALK, SIDEWALK, SIDEWALK, SIDEWALK);
    let lots = makeLots(lrng, innerRect, blk.district);
    if (blk.district === D_DOWNTOWN && lrng.chance(0.22) && rectW(innerRect) < 95 && rectD(innerRect) < 95) {
      lots = [{ rect: innerRect, faces: [0, 1, 2, 3] }];
    }
    let plazaDone = false;
    for (const lot of lots) {
      const cx = (lot.rect.minX + lot.rect.maxX) / 2,
        cz = (lot.rect.minZ + lot.rect.maxZ) / 2;
      if (
        !plazaDone &&
        (blk.district === D_DOWNTOWN || blk.district === D_MID) &&
        lots.length > 2 &&
        lrng.chance(0.07) &&
        rectW(lot.rect) > 18 &&
        rectD(lot.rect) > 18
      ) {
        plazaDone = true;
        blk.hasPlaza = true;
        plazas.push({ ...lot.rect });
        ctx.props.push({ type: SP_FOUNTAIN, x: cx, y: CURB, z: cz, rot: 0, variant: 0 });
        const corners: Array<[number, number]> = [
          [lot.rect.minX + 4, lot.rect.minZ + 4],
          [lot.rect.maxX - 4, lot.rect.minZ + 4],
          [lot.rect.minX + 4, lot.rect.maxZ - 4],
          [lot.rect.maxX - 4, lot.rect.maxZ - 4],
        ];
        for (const [x, z] of corners) {
          ctx.trees.push(makeTree(lrng, lrng.chance(0.5) ? TREE_MAPLE : TREE_OAK, x, z, CURB, lrng.range(8, 11), false));
        }
        ctx.props.push({ type: SP_BENCH, x: cx, y: CURB, z: lot.rect.minZ + 9, rot: 0, variant: 0 });
        ctx.props.push({ type: SP_BENCH, x: cx, y: CURB, z: lot.rect.maxZ - 9, rot: Math.PI, variant: 0 });
        continue;
      }
      // Front setback variety on street faces.
      const fp = { ...lot.rect };
      const sb = (): number => (lrng.chance(0.3) ? lrng.range(0.4, 1.4) : 0.05);
      if (lot.faces.includes(0)) fp.maxX -= sb();
      if (lot.faces.includes(1)) fp.minX += sb();
      if (lot.faces.includes(2)) fp.maxZ -= sb();
      if (lot.faces.includes(3)) fp.minZ += sb();
      // Tiny inset on shared walls avoids coincident faces.
      if (!lot.faces.includes(0)) fp.maxX -= 0.05;
      if (!lot.faces.includes(1)) fp.minX += 0.05;
      if (!lot.faces.includes(2)) fp.maxZ -= 0.05;
      if (!lot.faces.includes(3)) fp.minZ += 0.05;
      let h = heightFor(lrng, blk.district, cx, cz);
      if (Math.min(rectW(fp), rectD(fp)) < 26) h = Math.min(h, 140);
      if (Math.min(rectW(fp), rectD(fp)) < 16) h = Math.min(h, 70);
      // Lower fillers between downtown towers are midrise buildings (40-100 m band).
      const district = blk.district === D_DOWNTOWN && h < 120 ? D_MID : blk.district;
      addBuilding(ctx, fp, h, district, { streetFaces: lot.faces, allowSigns: district !== D_DOWNTOWN || lrng.chance(0.3) });
    }
  }

  // Park content.
  const parkGen = genPark(rng.fork(5), park, ctx);

  // Street dressing along block perimeters.
  const srng = rng.fork(6);
  const isAvenueSide = (face: number): boolean => face <= 1;
  for (const blk of blocks) {
    const sides: Array<{ face: number; ax: number; az: number; bx: number; bz: number; nx: number; nz: number }> = [
      { face: 0, ax: blk.maxX, az: blk.minZ, bx: blk.maxX, bz: blk.maxZ, nx: 1, nz: 0 },
      { face: 1, ax: blk.minX, az: blk.minZ, bx: blk.minX, bz: blk.maxZ, nx: -1, nz: 0 },
      { face: 2, ax: blk.minX, az: blk.maxZ, bx: blk.maxX, bz: blk.maxZ, nx: 0, nz: 1 },
      { face: 3, ax: blk.minX, az: blk.minZ, bx: blk.maxX, bz: blk.minZ, nx: 0, nz: -1 },
    ];
    const treesOnBlock = blk.district === D_MID || blk.district === D_LOW ? 0.7 : blk.district === D_DOWNTOWN ? 0.35 : 0.2;
    for (const s of sides) {
      const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
      const tx = (s.bx - s.ax) / len,
        tz = (s.bz - s.az) / len;
      const rot = Math.atan2(tx, tz);
      // Lamps
      for (let at = 7; at < len - 4; at += 30) {
        ctx.props.push({ type: SP_LAMP, x: s.ax + tx * at - s.nx * 0.7, y: CURB, z: s.az + tz * at - s.nz * 0.7, rot: Math.atan2(s.nx, s.nz), variant: 0 });
      }
      // Street trees
      if (srng.chance(treesOnBlock)) {
        for (let at = 14; at < len - 10; at += srng.range(13, 19)) {
          if (((at - 7) % 30 + 30) % 30 < 3 || ((at - 7) % 30 + 30) % 30 > 27) continue;
          const x = s.ax + tx * at - s.nx * 2.3,
            z = s.az + tz * at - s.nz * 2.3;
          ctx.trees.push(makeTree(srng, srng.chance(0.6) ? TREE_MAPLE : TREE_OAK, x, z, CURB, srng.range(7.5, 11.5), false));
        }
      }
      // Hydrant near the first corner, trash can near the second.
      if (srng.chance(0.6)) ctx.props.push({ type: SP_HYDRANT, x: s.ax + tx * 5 - s.nx * 0.9, y: CURB, z: s.az + tz * 5 - s.nz * 0.9, rot, variant: 0 });
      if (srng.chance(0.5))
        ctx.props.push({ type: SP_TRASH, x: s.ax + tx * (len - 5) - s.nx * 0.9, y: CURB, z: s.az + tz * (len - 5) - s.nz * 0.9, rot, variant: 0 });
      // Benches on avenue sides in busier districts.
      if (isAvenueSide(s.face) && (blk.district === D_DOWNTOWN || blk.district === D_MID) && srng.chance(0.5)) {
        const at = len * srng.range(0.3, 0.7);
        ctx.props.push({ type: SP_BENCH, x: s.ax + tx * at - s.nx * 1.3, y: CURB, z: s.az + tz * at - s.nz * 1.3, rot: Math.atan2(-s.nx, -s.nz), variant: 0 });
      }
      // Parked cars along streets (east-west sides), in the road's parking lane.
      if (!isAvenueSide(s.face)) {
        for (let at = 12; at < len - 12; at += srng.range(6.2, 9)) {
          if (!srng.chance(0.55)) continue;
          ctx.props.push({
            type: SP_CAR,
            x: s.ax + tx * at + s.nx * 1.35,
            y: 0,
            z: s.az + tz * at + s.nz * 1.35,
            rot: rot + (srng.chance(0.5) ? Math.PI : 0),
            variant: srng.int(0, 7),
          });
        }
      }
    }
    // Traffic lights on two opposite corners.
    ctx.props.push({ type: SP_TRAFFIC_LIGHT, x: blk.maxX - 0.8, y: CURB, z: blk.maxZ - 0.8, rot: 0, variant: 0 });
    ctx.props.push({ type: SP_TRAFFIC_LIGHT, x: blk.minX + 0.8, y: CURB, z: blk.minZ + 0.8, rot: Math.PI, variant: 1 });
  }
  // Lamps around the park edge sidewalk.
  {
    const p = park;
    for (let x = p.minX + 10; x < p.maxX - 5; x += 30) {
      ctx.props.push({ type: SP_LAMP, x, y: CURB, z: p.minZ + 0.7, rot: Math.PI, variant: 0 });
      ctx.props.push({ type: SP_LAMP, x, y: CURB, z: p.maxZ - 0.7, rot: 0, variant: 0 });
    }
    for (let z = p.minZ + 10; z < p.maxZ - 5; z += 30) {
      ctx.props.push({ type: SP_LAMP, x: p.minX + 0.7, y: CURB, z, rot: -Math.PI / 2, variant: 0 });
      ctx.props.push({ type: SP_LAMP, x: p.maxX - 0.7, y: CURB, z, rot: Math.PI / 2, variant: 0 });
    }
  }

  // Waterfront: piers, railings, promenade lamps, bridge, islet.
  const wrng = rng.fork(7);
  const piers: Pier[] = [];
  const pierZs: number[] = [];
  for (let z = -560; z <= 600; z += wrng.range(210, 270)) pierZs.push(z + wrng.range(-30, 30));
  for (const z of pierZs) {
    const L = wrng.range(80, 130),
      W = wrng.range(16, 24);
    piers.push({ minX: LAND.minX - L, maxX: LAND.minX + 0.5, minZ: z - W / 2, maxZ: z + W / 2, top: CURB });
  }
  for (const z of [-470, -250, 300, 520]) {
    const zz = z + wrng.range(-25, 25);
    const L = wrng.range(70, 110),
      W = wrng.range(16, 22);
    piers.push({ minX: LAND.maxX - 0.5, maxX: LAND.maxX + L, minZ: zz - W / 2, maxZ: zz + W / 2, top: CURB });
  }
  // Ferry pier at the south tip.
  piers.push({ minX: -120, maxX: -96, minZ: LAND.maxZ - 0.5, maxZ: LAND.maxZ + 90, top: CURB });
  // Pier sheds and dressing.
  for (const p of piers) {
    const len = Math.max(rectW(p), rectD(p));
    const alongX = rectW(p) > rectD(p);
    if (wrng.chance(0.6) && len > 70) {
      const shed: Rect = alongX
        ? { minX: p.minX + (p.minX < 0 ? 8 : len * 0.3), maxX: p.maxX - (p.minX < 0 ? len * 0.3 : 8), minZ: p.minZ + 3, maxZ: p.maxZ - 3 }
        : { minX: p.minX + 3, maxX: p.maxX - 3, minZ: p.minZ + len * 0.3, maxZ: p.maxZ - 8 };
      addBuilding(ctx, shed, wrng.range(10, 16), D_WATERFRONT, { streetFaces: [], allowSigns: false, baseY: CURB });
    }
    // Bollards along the edges
    for (let t = 6; t < len - 3; t += 12) {
      if (alongX) {
        const x = p.minX < 0 ? p.maxX - t : p.minX + t;
        ctx.props.push({ type: SP_BOLLARD, x, y: CURB, z: p.minZ + 0.8, rot: 0, variant: 0 });
        ctx.props.push({ type: SP_BOLLARD, x, y: CURB, z: p.maxZ - 0.8, rot: 0, variant: 0 });
      } else {
        const z = p.minZ + t;
        ctx.props.push({ type: SP_BOLLARD, x: p.minX + 0.8, y: CURB, z, rot: 0, variant: 0 });
        ctx.props.push({ type: SP_BOLLARD, x: p.maxX - 0.8, y: CURB, z, rot: 0, variant: 0 });
      }
    }
  }
  const bridge = genBridge();

  // Railings along the island edge with gaps for piers and the bridge anchorage.
  const railings: BoxSpec[] = [];
  const RT = 0.25,
    RH = 1.1;
  const gapsOn = (side: 'W' | 'E' | 'N' | 'S'): Array<[number, number]> => {
    const g: Array<[number, number]> = [];
    for (const p of piers) {
      if (side === 'W' && p.maxX <= LAND.minX + 1) g.push([p.minZ, p.maxZ]);
      if (side === 'E' && p.minX >= LAND.maxX - 1) g.push([p.minZ, p.maxZ]);
      if (side === 'S' && p.minZ >= LAND.maxZ - 1) g.push([p.minX, p.maxX]);
    }
    if (side === 'E') g.push([-17, 17]);
    return g.sort((a, b) => a[0] - b[0]);
  };
  const railRun = (side: 'W' | 'E' | 'N' | 'S'): void => {
    const horizontal = side === 'N' || side === 'S';
    const lo = horizontal ? LAND.minX : LAND.minZ,
      hi = horizontal ? LAND.maxX : LAND.maxZ;
    let cur = lo + 0.3;
    for (const [a, b] of [...gapsOn(side), [hi - 0.3, hi + 1] as [number, number]]) {
      const end = a;
      if (end - cur > 1) {
        if (side === 'W') railings.push({ minX: LAND.minX + 0.1, maxX: LAND.minX + 0.1 + RT, minY: CURB, maxY: CURB + RH, minZ: cur, maxZ: end });
        if (side === 'E') railings.push({ minX: LAND.maxX - 0.1 - RT, maxX: LAND.maxX - 0.1, minY: CURB, maxY: CURB + RH, minZ: cur, maxZ: end });
        if (side === 'N') railings.push({ minX: cur, maxX: end, minY: CURB, maxY: CURB + RH, minZ: LAND.minZ + 0.1, maxZ: LAND.minZ + 0.1 + RT });
        if (side === 'S') railings.push({ minX: cur, maxX: end, minY: CURB, maxY: CURB + RH, minZ: LAND.maxZ - 0.1 - RT, maxZ: LAND.maxZ - 0.1 });
      }
      cur = Math.max(cur, b);
    }
  };
  railRun('W');
  railRun('E');
  railRun('N');
  railRun('S');
  // Islet railings
  {
    const i = ISLET;
    railings.push({ minX: i.minX + 0.1, maxX: i.maxX - 0.1, minY: CURB, maxY: CURB + RH, minZ: i.minZ + 0.1, maxZ: i.minZ + 0.1 + RT });
    railings.push({ minX: i.minX + 0.1, maxX: i.maxX - 0.1, minY: CURB, maxY: CURB + RH, minZ: i.maxZ - 0.1 - RT, maxZ: i.maxZ - 0.1 });
    railings.push({ minX: i.maxX - 0.1 - RT, maxX: i.maxX - 0.1, minY: CURB, maxY: CURB + RH, minZ: i.minZ + 0.4, maxZ: i.maxZ - 0.4 });
    railings.push({ minX: i.minX + 0.1, maxX: i.minX + 0.1 + RT, minY: CURB, maxY: CURB + RH, minZ: i.minZ + 0.4, maxZ: -17 });
    railings.push({ minX: i.minX + 0.1, maxX: i.minX + 0.1 + RT, minY: CURB, maxY: CURB + RH, minZ: 17, maxZ: i.maxZ - 0.4 });
  }
  // Promenade lamps
  for (let z = LAND.minZ + 20; z < LAND.maxZ - 10; z += 32) {
    ctx.props.push({ type: SP_LAMP, x: LAND.minX + 3, y: CURB, z, rot: Math.PI / 2, variant: 1 });
    ctx.props.push({ type: SP_LAMP, x: LAND.maxX - 3, y: CURB, z, rot: -Math.PI / 2, variant: 1 });
  }
  for (let x = LAND.minX + 24; x < LAND.maxX - 10; x += 32) {
    ctx.props.push({ type: SP_LAMP, x, y: CURB, z: LAND.minZ + 3, rot: 0, variant: 1 });
    ctx.props.push({ type: SP_LAMP, x, y: CURB, z: LAND.maxZ - 3, rot: Math.PI, variant: 1 });
  }
  // Islet: warehouses, lighthouse, trees.
  {
    const i = ISLET;
    addBuilding(ctx, { minX: i.minX + 34, maxX: i.minX + 70, minZ: i.minZ + 14, maxZ: i.minZ + 60 }, wrng.range(14, 22), D_WATERFRONT, {
      streetFaces: [1],
      allowSigns: false,
    });
    addBuilding(ctx, { minX: i.minX + 34, maxX: i.minX + 74, minZ: i.maxZ - 64, maxZ: i.maxZ - 18 }, wrng.range(12, 20), D_WATERFRONT, {
      streetFaces: [1],
      allowSigns: false,
    });
    for (let k = 0; k < 18; k++) {
      const x = wrng.range(i.minX + 8, i.minX + 28);
      const z = wrng.range(i.minZ + 10, i.maxZ - 10);
      if (Math.abs(z) < 24) continue;
      ctx.trees.push(makeTree(wrng, wrng.chance(0.5) ? TREE_PINE : TREE_OAK, x, z, CURB, wrng.range(10, 16), false));
    }
    for (let z = i.minZ + 12; z < i.maxZ - 6; z += 28) ctx.props.push({ type: SP_LAMP, x: i.minX + 4, y: CURB, z, rot: 0, variant: 1 });
  }

  // Spawn on a mid-rise roof near the park's south-east corner.
  let spawn: [number, number, number] = [park.maxX + 30, CURB, park.maxZ + 30];
  {
    let best = Infinity;
    for (const b of ctx.buildings) {
      if (b.height < 38 || b.height > 95) continue;
      const top = b.volumes[b.volumes.length - 1]!;
      const cx = (top.minX + top.maxX) / 2,
        cz = (top.minZ + top.maxZ) / 2;
      const d = Math.hypot(cx - (park.maxX + 70), cz - (park.maxZ + 60));
      if (d < best && rectW(top) > 14 && rectD(top) > 14) {
        best = d;
        spawn = [cx, top.maxY, cz];
      }
    }
  }

  const parkTrees = ctx.trees.filter((t) => t.park).length;
  return {
    mapId: 'manhattan',
    seed,
    land: { ...LAND },
    islet: { ...ISLET },
    promenade: PROMENADE,
    avenues,
    streets,
    park,
    pond: parkGen.pond,
    paths: parkGen.paths,
    blocks,
    plazas,
    buildings: ctx.buildings,
    trees: ctx.trees,
    props: ctx.props,
    parkWalls: parkGen.walls,
    railings,
    piers,
    bridge,
    bounds: { minX: -1060, maxX: 1260, minZ: -1060, maxZ: 1060 },
    spawn,
    stats: {
      buildings: ctx.buildings.length,
      parkTrees,
      streetTrees: ctx.trees.length - parkTrees,
      maxHeight: ctx.buildings.reduce((m, b) => Math.max(m, b.height), 0),
    },
  };
}
