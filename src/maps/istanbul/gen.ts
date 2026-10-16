import { Rng } from '../../core/rng';
import { clamp } from '../../core/math';
import { HeightfieldTerrain } from '../../physics/heightfield';
import { RectIndex, RoadIndex, type RoadSegment } from '../../physics/roadIndex';
import { CURB } from '../../physics/terrain';
import { WaterMask } from '../../physics/waterMask';
import {
  D_DOWNTOWN,
  D_LOW,
  D_MID,
  HIP_PITCH,
  HIP_STEP_H,
  LOOK_APARTMENT,
  LOOK_GLASS,
  LOOK_STONE,
  LOOK_WOODEN,
  PROP_HVAC,
  PROP_ROOF_TANK,
  PROP_SOLAR,
  PROP_WALL_SIGN,
  SP_LAMP,
  TREE_CYPRESS,
  TREE_OAK,
  TREE_PLANE,
  TREE_STONEPINE,
  type Block,
  type BoxSpec,
  type BridgeSpec,
  type Building,
  type CityLayout,
  type District,
  type FacadeStyle,
  type Pier,
  type Rect,
  type RoadPiece,
  type RoofProp,
  type StreetProp,
  type Tree,
  type Volume,
} from '../../world/types';
import { makeTree } from '../manhattan/gen';
import {
  ARTERIALS,
  COAST_ROAD_OFFSET,
  COAST_ROAD_WIDTH,
  IST_BOUNDS,
  IST_EXTENT,
  LAND_POLYGONS,
  LANDMARKS,
  LEVENT,
  PARKS,
  PIERS,
  ROOTS,
  type Arterial,
} from './data';
import { bsp, clipPolyline, isoLines, largestValidRect, sampleField, type GridField } from './streets';
import { bakeIstanbulHeights, distanceField } from './terrain';
import { buildIstanbulParts, partFootprints } from './landmarks';
import type { Part } from '../common/prims';

/** Sidewalk between the curb and the building fronts (m). */
const SIDEWALK = 3;
const FLOOR = 3.1;
const SHOP_FLOOR = 4.0;

type RGB = [number, number, number];
const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

/**
 * §2.6 palette per look: cream EFE3C8, ochre D9A65B, dusty rose D49A8A,
 * terracotta B8613E, mint A9C7B0, warm grey C9C6BE, sand E2C99A, mustard
 * E8CF7A, chalk F2EFE6, pastel blue 9EB9C9; timber 7A5236; stone E7E0D0.
 */
const WOOD_WALLS = [0xd49a8a, 0xa9c7b0, 0xd9a65b, 0xefe3c8, 0x9eb9c9, 0x9a6a48, 0xe8cf7a, 0xb8613e, 0xd49a8a, 0xa9c7b0];
const APT_WALLS = [0xefe3c8, 0xe2c99a, 0xf2efe6, 0xc9c6be, 0xd49a8a, 0xd9a65b, 0x9eb9c9, 0xe8cf7a, 0xb8613e];
const STONE_WALLS = [0xc9c6be, 0xe2c99a, 0xe7e0d0, 0xd8c3a0, 0xcdbb9c, 0xb9ab95];
const TRIMS = [0xf2efe6, 0xe7e0d0, 0xefe3c8];
const WOOD_TRIMS = [0xf2efe6, 0x7a5236, 0xefe3c8];
const GLASS = [0x4a6f88, 0x3f6278, 0x557f99];
const TOWER_WALLS = [0x8aa7b8, 0x5a7d95, 0xc9c1ad, 0x3d6f8f, 0xd8cfb8];
/** Clay roof tiles. */
const TILES = [0xb24a2e, 0xa8432a, 0xc0603a];

/** Gap between two rectangles (0 when they touch or overlap). */
const rectGap = (a: Rect, b: Rect): number => Math.hypot(Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minZ - b.maxZ, b.minZ - a.maxZ));
const grow = (r: Rect, d: number): Rect => ({ minX: r.minX - d, maxX: r.maxX + d, minZ: r.minZ - d, maxZ: r.maxZ + d });
const inRect = (r: Rect, x: number, z: number, m = 0): boolean => x > r.minX - m && x < r.maxX + m && z > r.minZ - m && z < r.maxZ + m;

/** Building district of a point: floors and look (§2.6). */
interface DistrictSpec {
  name: string;
  floors: [number, number];
  district: District;
  /** Looks with weights (LOOK_*). */
  looks: Array<[number, number]>;
  /** Chance of a hip tile roof (small lots only), and of cumba bays on a street face. */
  hip: number;
  bay: number;
  /** Lit window share at night. */
  lit: [number, number];
}

function districtAt(x: number, z: number): DistrictSpec {
  if (inRect(LEVENT, x, z)) return { name: 'levent', floors: [36, 70], district: D_DOWNTOWN, looks: [[LOOK_GLASS, 1]], hip: 0, bay: 0, lit: [0.45, 0.75] };
  if (x > 600) return { name: 'uskudar', floors: [3, 7], district: D_LOW, looks: [[LOOK_WOODEN, 0.6], [LOOK_APARTMENT, 0.4]], hip: 0.8, bay: 0.5, lit: [0.35, 0.6] };
  if (z > -60) {
    // Historic peninsula.
    if (x > -60 && z > 230) return { name: 'sultanahmet', floors: [2, 5], district: D_LOW, looks: [[LOOK_WOODEN, 0.75], [LOOK_STONE, 0.25]], hip: 0.85, bay: 0.6, lit: [0.4, 0.65] };
    if (x > -250 && z < 250) return { name: 'eminonu', floors: [4, 7], district: D_LOW, looks: [[LOOK_STONE, 0.7], [LOOK_APARTMENT, 0.3]], hip: 0.45, bay: 0.1, lit: [0.25, 0.5] };
    return { name: 'fatih', floors: [3, 6], district: D_LOW, looks: [[LOOK_WOODEN, 0.5], [LOOK_APARTMENT, 0.5]], hip: 0.7, bay: 0.45, lit: [0.35, 0.6] };
  }
  if (z > -350 && x > -100) return { name: 'galata', floors: [6, 8], district: D_LOW, looks: [[LOOK_STONE, 0.65], [LOOK_APARTMENT, 0.35]], hip: 0.3, bay: 0.15, lit: [0.35, 0.6] };
  if (x < -150) return { name: 'kasimpasa', floors: [4, 7], district: D_LOW, looks: [[LOOK_APARTMENT, 0.8], [LOOK_WOODEN, 0.2]], hip: 0.5, bay: 0.2, lit: [0.4, 0.7] };
  if (z > -560) return { name: 'beyoglu', floors: [5, 8], district: D_LOW, looks: [[LOOK_APARTMENT, 0.85], [LOOK_STONE, 0.15]], hip: 0.45, bay: 0.4, lit: [0.45, 0.75] };
  return { name: 'taksim', floors: [6, 10], district: D_MID, looks: [[LOOK_APARTMENT, 0.8], [LOOK_STONE, 0.2]], hip: 0.3, bay: 0.2, lit: [0.45, 0.75] };
}

function pickLook(rng: Rng, d: DistrictSpec): number {
  let total = 0;
  for (const [, w] of d.looks) total += w;
  let r = rng.float() * total;
  for (const [look, w] of d.looks) {
    r -= w;
    if (r <= 0) return look;
  }
  return d.looks[0]![0];
}

/** Per-layout terrain (generation builds it once; rebuilt from the layout data when missing). */
const TERRAINS = new WeakMap<CityLayout, HeightfieldTerrain>();
/** Per-layout landmark and bridge parts (colliders and greybox geometry). */
const PARTS = new WeakMap<CityLayout, Part[]>();

export function istanbulParts(L: CityLayout): Part[] {
  const cached = PARTS.get(L);
  if (cached) return cached;
  const t = istanbulTerrain(L);
  const parts = buildIstanbulParts((x, z) => t.baseHeight(x, z), (x, z) => t.roads.isRoad(x, z));
  PARTS.set(L, parts);
  return parts;
}

export function istanbulTerrain(L: CityLayout): HeightfieldTerrain {
  const cached = TERRAINS.get(L);
  if (cached) return cached;
  const mask = new WaterMask(L.landPolygons ?? LAND_POLYGONS, IST_EXTENT);
  const grid = bakeIstanbulHeights(mask, IST_EXTENT);
  const t = makeTerrain(L, grid, mask);
  TERRAINS.set(L, t);
  return t;
}

function roadSegments(roads: readonly RoadPiece[], extra = 0): RoadSegment[] {
  const segs: RoadSegment[] = [];
  for (const r of roads) {
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i]!,
        b = r.pts[i + 1]!;
      segs.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], width: r.width + extra });
    }
  }
  return segs;
}

function makeTerrain(L: CityLayout, grid: ReturnType<typeof bakeIstanbulHeights>, mask: WaterMask): HeightfieldTerrain {
  const roads = new RoadIndex(roadSegments(L.roads ?? []), IST_EXTENT);
  const raised = new RectIndex([...L.blocks, ...L.plazas, ...(L.parks ?? [])], IST_EXTENT);
  return new HeightfieldTerrain(grid, mask, roads, L.parks ?? [], raised);
}

/**
 * Facade style of a look (Istanbul window atlas, render/textures.ts):
 * 0 glass curtain wall, 1 wooden sash with shutters, 2 tall 19th-century
 * window with a pediment, 3 arched stone window, 4 warehouse grid,
 * 6 modern apartment window, 7 shop front (5 is the roof tile pattern).
 */
function makeStyle(rng: Rng, d: DistrictSpec, look: number, shop: boolean): FacadeStyle {
  const lit = rng.range(d.lit[0], d.lit[1]);
  switch (look) {
    case LOOK_GLASS:
      return {
        window: 0,
        floorHeight: rng.range(3.8, 4.1),
        bayWidth: rng.range(2.6, 3.2),
        wall: hex(rng.pick(TOWER_WALLS)),
        trim: hex(rng.pick([0xc9c6be, 0xd8d6d0, 0x8d9499])),
        glass: hex(rng.pick([0x3d6f8f, 0x4a7f9a, 0x2f5f7a, 0x6d8fa3])),
        storefront: 0,
        litRatio: lit,
        pilasters: false,
        look,
      };
    case LOOK_WOODEN:
      return {
        window: 1,
        floorHeight: FLOOR,
        bayWidth: rng.range(2.2, 2.8),
        wall: hex(rng.pick(WOOD_WALLS)),
        trim: hex(rng.pick(WOOD_TRIMS)),
        glass: hex(0x34505f),
        storefront: shop ? SHOP_FLOOR : 0,
        litRatio: lit,
        pilasters: false,
        look,
      };
    case LOOK_STONE:
      return {
        window: rng.chance(0.6) ? 3 : 4,
        floorHeight: FLOOR,
        bayWidth: rng.range(3.0, 3.8),
        wall: hex(rng.pick(STONE_WALLS)),
        trim: hex(rng.pick([0xe7e0d0, 0xd8cfb8, 0xf2efe6])),
        glass: hex(rng.pick(GLASS)),
        storefront: shop ? SHOP_FLOOR : 0,
        litRatio: lit * 0.8,
        pilasters: rng.chance(0.45),
        look,
      };
    default: {
      const modern = d.name === 'kasimpasa' || d.name === 'taksim' ? 0.45 : 0.15;
      return {
        window: rng.chance(modern) ? 6 : 2,
        floorHeight: FLOOR,
        bayWidth: rng.range(2.6, 3.2),
        wall: hex(rng.pick(APT_WALLS)),
        trim: hex(rng.pick(TRIMS)),
        glass: hex(rng.pick(GLASS)),
        storefront: shop ? SHOP_FLOOR : 0,
        litRatio: lit,
        pilasters: rng.chance(0.4),
        look: LOOK_APARTMENT,
      };
    }
  }
}

/**
 * Hip roof colliders over a volume: boxes HIP_STEP_H tall, each inset by
 * HIP_STEP_H / HIP_PITCH (1.5 m) from the one below, so the tile planes
 * (rising from HIP_LIFT above the wall top) pass through the middle of every
 * step and stay within 0.3 m of it. Building and camera flags only: a roof
 * ledge is never a swing anchor.
 */
function hipRoofSteps(v: Volume): BoxSpec[] {
  const out: BoxSpec[] = [];
  const run = HIP_STEP_H / HIP_PITCH;
  const half = Math.min(v.maxX - v.minX, v.maxZ - v.minZ) / 2;
  for (let k = 0; k * run < half - 0.05; k++) {
    const i = k * run;
    out.push({ minX: v.minX + i, maxX: v.maxX - i, minY: v.maxY + k * HIP_STEP_H, maxY: v.maxY + (k + 1) * HIP_STEP_H, minZ: v.minZ + i, maxZ: v.maxZ - i });
  }
  return out;
}

/** Wall point and outward axis of a lot face (0 +X, 1 -X, 2 +Z, 3 -Z): centre, length, and the axis the face runs along. */
function faceGeom(r: Rect, face: number): { x: number; z: number; len: number; alongX: boolean } {
  if (face === 0) return { x: r.maxX, z: (r.minZ + r.maxZ) / 2, len: r.maxZ - r.minZ, alongX: false };
  if (face === 1) return { x: r.minX, z: (r.minZ + r.maxZ) / 2, len: r.maxZ - r.minZ, alongX: false };
  if (face === 2) return { x: (r.minX + r.maxX) / 2, z: r.maxZ, len: r.maxX - r.minX, alongX: true };
  return { x: (r.minX + r.maxX) / 2, z: r.minZ, len: r.maxX - r.minX, alongX: true };
}

/** Cumba depth (m): bays project this far over the sidewalk. */
const BAY_DEPTH = 0.8;

interface Ctx {
  rng: Rng;
  buildings: Building[];
  base: (x: number, z: number) => number;
}

/** Parapets around an exposed flat roof. */
function parapetsFor(v: Volume, rng: Rng): BoxSpec[] {
  const w = v.maxX - v.minX,
    d = v.maxZ - v.minZ;
  if (w * d < 110) return [];
  const PT = 0.3;
  const y0 = v.maxY,
    y1 = v.maxY + rng.range(0.95, 1.2);
  return [
    { minX: v.minX, maxX: v.maxX, minY: y0, maxY: y1, minZ: v.minZ, maxZ: v.minZ + PT },
    { minX: v.minX, maxX: v.maxX, minY: y0, maxY: y1, minZ: v.maxZ - PT, maxZ: v.maxZ },
    { minX: v.minX, maxX: v.minX + PT, minY: y0, maxY: y1, minZ: v.minZ + PT, maxZ: v.maxZ - PT },
    { minX: v.maxX - PT, maxX: v.maxX, minY: y0, maxY: y1, minZ: v.minZ + PT, maxZ: v.maxZ - PT },
  ];
}

/** Ground heights under a footprint: lowest and highest of corners, edge midpoints and centre. */
function footprintRange(ctx: Ctx, r: Rect): [number, number] {
  let lo = Infinity,
    hi = -Infinity;
  for (const fx of [0, 0.5, 1]) {
    for (const fz of [0, 0.5, 1]) {
      const h = ctx.base(r.minX + (r.maxX - r.minX) * fx, r.minZ + (r.maxZ - r.minZ) * fz);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  return [lo, hi];
}

/** A plain box building (or a Levent tower with setbacks) on a stone plinth that levels the slope. */
function addBuilding(ctx: Ctx, fp: Rect, floors: number, d: DistrictSpec, faces: number[], han = false): Building | null {
  const rng = ctx.rng;
  const w = fp.maxX - fp.minX,
    dd = fp.maxZ - fp.minZ;
  if (w < 6 || dd < 6) return null;
  const [lo, hi] = footprintRange(ctx, fp);
  const baseY = hi + CURB;
  const tower = d.district === D_DOWNTOWN;
  const shop = !tower && faces.length > 0 && rng.chance(0.6);
  // Hans and hotels at the corners are stone; everything else takes the district's looks.
  const look = han ? LOOK_STONE : pickLook(rng, d);
  const style = makeStyle(rng, d, look, shop);
  const volumes: Volume[] = [];
  let H: number;
  if (tower) {
    // Levent: a podium, one to three shaft tiers with setbacks, sometimes a crown.
    const target = clamp(floors * style.floorHeight, 120, 236);
    const podTop = baseY + style.floorHeight * rng.int(2, 3) + 1.2;
    volumes.push({ ...fp, minY: baseY, maxY: podTop, role: 0 });
    let rect: Rect = { ...fp };
    const inset = (r: Rect, k: number): Rect => ({ minX: r.minX + k, maxX: r.maxX - k, minZ: r.minZ + k, maxZ: r.maxZ - k });
    if (Math.min(w, dd) > 26) rect = inset(rect, rng.range(1.5, 3.5));
    const tiers = rng.int(1, 3);
    const fracs = tiers === 1 ? [1] : tiers === 2 ? [rng.range(0.6, 0.75), 1] : [rng.range(0.45, 0.6), rng.range(0.74, 0.86), 1];
    let y = podTop;
    for (let i = 0; i < fracs.length; i++) {
      const top = podTop + (baseY + target - podTop) * fracs[i]!;
      volumes.push({ ...rect, minY: y, maxY: top, role: 1 });
      y = top;
      const next = inset(rect, rng.range(2, 4));
      if (i < fracs.length - 1 && Math.min(next.maxX - next.minX, next.maxZ - next.minZ) >= 14) rect = next;
    }
    H = y;
    if (rng.chance(0.4) && Math.min(rect.maxX - rect.minX, rect.maxZ - rect.minZ) > 18) {
      const c = inset(rect, 3);
      volumes.push({ ...c, minY: H, maxY: H + rng.range(4, 7), role: 2 });
      H = volumes[volumes.length - 1]!.maxY;
    }
  } else {
    H = baseY + (shop ? SHOP_FLOOR : FLOOR) + (floors - 1) * FLOOR;
    volumes.push({ ...fp, minY: baseY, maxY: H, role: 1 });
  }
  const topV = volumes[volumes.length - 1]!;
  // Small lots get a hip roof of clay tiles (no parapets or roof props); larger ones a flat terrace.
  const hip = !tower && !han && w * dd < 400 && Math.min(w, dd) >= 7 && rng.chance(d.hip);
  const parapets: BoxSpec[] = [];
  const props: RoofProp[] = [];
  if (!hip) {
    for (let i = 0; i < volumes.length; i++) {
      const v = volumes[i]!;
      const above = volumes[i + 1];
      if (above && Math.abs(above.minX - v.minX) < 0.3 && Math.abs(above.maxX - v.maxX) < 0.3 && Math.abs(above.minZ - v.minZ) < 0.3 && Math.abs(above.maxZ - v.maxZ) < 0.3) continue;
      parapets.push(...parapetsFor(v, rng));
    }
    terraceProps(rng, topV, tower, props);
  }
  // Cumba bays on the street faces of wooden houses and apartments, from the first floor up to under the cornice.
  const bays: BoxSpec[] = [];
  if (!tower && (look === LOOK_WOODEN || look === LOOK_APARTMENT) && floors >= 3 && rng.chance(d.bay)) {
    const y0 = baseY + (shop ? SHOP_FLOOR : FLOOR) + 0.25,
      y1 = H - 0.7;
    if (y1 - y0 >= 2.8) {
      for (const face of faces.slice(0, 2)) {
        const g = faceGeom(fp, face);
        if (g.len < 7) continue;
        const bw = Math.min(g.len - 3, look === LOOK_WOODEN ? rng.range(2.8, 4.2) : rng.range(3.0, 4.6));
        const n = g.len > 16 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const c = n === 1 ? rng.range(-0.15, 0.15) * (g.len - bw - 2) : (k === 0 ? -1 : 1) * g.len * 0.25;
          const out = face === 0 || face === 2 ? 1 : -1;
          if (g.alongX) {
            const z0 = out > 0 ? g.z : g.z - BAY_DEPTH;
            bays.push({ minX: g.x + c - bw / 2, maxX: g.x + c + bw / 2, minY: y0, maxY: y1, minZ: z0, maxZ: z0 + BAY_DEPTH });
          } else {
            const x0 = out > 0 ? g.x : g.x - BAY_DEPTH;
            bays.push({ minX: x0, maxX: x0 + BAY_DEPTH, minY: y0, maxY: y1, minZ: g.z + c - bw / 2, maxZ: g.z + c + bw / 2 });
          }
        }
      }
    }
  }
  // Shop signs above the shop windows on the street faces (fictional Turkish trades).
  if (shop) {
    for (const face of faces.slice(0, 2)) {
      const g = faceGeom(fp, face);
      if (g.len < 5) continue;
      props.push({ type: PROP_WALL_SIGN, x: g.x, y: baseY + 2.95, z: g.z, sx: Math.min(g.len - 1.6, rng.range(3.4, 6)), sy: 0.85, sz: 0.12, face, variant: rng.int(0, 15) });
    }
  }
  const b: Building = {
    id: ctx.buildings.length,
    district: d.district,
    volumes,
    parapets,
    props,
    style,
    height: H,
    footprint: { ...fp },
    seed: rng.int(0, 1 << 30),
  };
  if (hip) {
    b.hipRoof = { color: hex(rng.pick(TILES)) };
    b.roofSteps = hipRoofSteps(topV);
  }
  if (bays.length > 0) b.bays = bays;
  // Stone plinth from below the low side up to the floor.
  if (baseY - (lo + CURB) > 0.05) b.plinth = { ...fp, minY: lo - 1, maxY: baseY };
  ctx.buildings.push(b);
  return b;
}

/** Terrace props: solar water heaters, plastic water tanks and a few air-conditioning boxes, apart from each other. */
function terraceProps(rng: Rng, v: Volume, tower: boolean, props: RoofProp[]): void {
  const rw = v.maxX - v.minX - 4,
    rd = v.maxZ - v.minZ - 4;
  if (rw < 3 || rd < 3) return;
  const free = (x: number, z: number, hx: number, hz: number): boolean => props.every((p) => Math.abs(p.x - x) > hx + p.sx / 2 + 1 || Math.abs(p.z - z) > hz + p.sz / 2 + 1);
  const place = (hx: number, hz: number): [number, number] | null => {
    for (let k = 0; k < 4; k++) {
      if (rw < 2 * hx || rd < 2 * hz) return null;
      const x = v.minX + 2 + hx + rng.float() * (rw - 2 * hx),
        z = v.minZ + 2 + hz + rng.float() * (rd - 2 * hz);
      if (free(x, z, hx, hz)) return [x, z];
    }
    return null;
  };
  if (!tower) {
    // Solar heaters face south (+z): sx along x, sz the collector's depth.
    const nSolar = rng.chance(0.65) ? rng.int(1, rw * rd > 200 ? 3 : 2) : 0;
    for (let i = 0; i < nSolar; i++) {
      const at = place(1.1, 1.2);
      if (at) props.push({ type: PROP_SOLAR, x: at[0], y: v.maxY, z: at[1], sx: 2.2, sy: 1.5, sz: 2.4, face: 2, variant: rng.int(0, 1) });
    }
    if (rng.chance(0.5)) {
      const r = rng.range(0.55, 0.75);
      const at = place(r, r);
      if (at) props.push({ type: PROP_ROOF_TANK, x: at[0], y: v.maxY, z: at[1], sx: 2 * r, sy: rng.range(1.1, 1.5), sz: 2 * r, face: 0, variant: rng.int(0, 2) });
    }
  }
  if (rng.chance(tower ? 0.6 : 0.3)) {
    const sx = rng.range(1.4, tower ? 3.2 : 2),
      sz = rng.range(1.2, tower ? 3.2 : 1.8);
    const at = place(sx / 2, sz / 2);
    if (at) props.push({ type: PROP_HVAC, x: at[0], y: v.maxY, z: at[1], sx, sy: rng.range(0.9, tower ? 1.8 : 1.2), sz, face: 0, variant: rng.int(0, 3) });
  }
}

/** Lots along the block's long axis, one or two rows deep; street faces recorded per lot. */
function makeLots(rng: Rng, inner: Rect, tower: boolean): Array<{ rect: Rect; faces: number[] }> {
  const out: Array<{ rect: Rect; faces: number[] }> = [];
  const longX = inner.maxX - inner.minX >= inner.maxZ - inner.minZ;
  const depth = longX ? inner.maxZ - inner.minZ : inner.maxX - inner.minX;
  const range: [number, number] = tower ? [30, 48] : [10, 22];
  const rows: Rect[] = [];
  if (depth > (tower ? 90 : 44)) {
    const split = depth / 2 + rng.range(-4, 4);
    if (longX) rows.push({ ...inner, maxZ: inner.minZ + split }, { ...inner, minZ: inner.minZ + split });
    else rows.push({ ...inner, maxX: inner.minX + split }, { ...inner, minX: inner.minX + split });
  } else rows.push({ ...inner });
  for (const row of rows) {
    const len = longX ? row.maxX - row.minX : row.maxZ - row.minZ;
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
      if (Math.abs(rect.maxX - inner.maxX) < 0.01) faces.push(0);
      if (Math.abs(rect.minX - inner.minX) < 0.01) faces.push(1);
      if (Math.abs(rect.maxZ - inner.maxZ) < 0.01) faces.push(2);
      if (Math.abs(rect.minZ - inner.minZ) < 0.01) faces.push(3);
      out.push({ rect, faces });
    }
  }
  return out;
}

const EMPTY_BRIDGE: BridgeSpec = {
  deck: { minX: 5000, maxX: 5001, minY: 0, maxY: 1, minZ: 5000, maxZ: 5001 },
  towers: [],
  beams: [],
  anchorages: [],
  suspenders: [],
  cable: [],
  cableZ: 0,
};

/**
 * Istanbul greybox (M13 C5): baked hills and shore, coastal roads as the
 * 22 m shore-distance iso line, hand-laid arterials plus a seeded BSP of
 * streets and lanes, blocks shrunk to valid ground, plain box buildings on
 * plinths, park and street trees, lamps, piers. Landmark sites stay paved.
 */
export function generateIstanbul(seed: number): CityLayout {
  const rng = new Rng((seed ^ 0x15a4b1) >>> 0);
  const E = IST_EXTENT,
    B = IST_BOUNDS;
  const mask = new WaterMask(LAND_POLYGONS, E);
  const grid = bakeIstanbulHeights(mask, E);
  const vx = grid.nx + 1,
    vz = grid.nz + 1;
  const bare = new HeightfieldTerrain(grid, mask, new RoadIndex([], E));
  const base = (x: number, z: number): number => bare.baseHeight(x, z);
  const coastRects = LANDMARKS.filter((l) => l.coastal).map((l) => grow(l.rect, 2));
  const coastF: GridField = { x0: E.minX, z0: E.minZ, cell: grid.cell, vx, vz, f: distanceField(grid.wet, vx, vz, grid.cell, E, coastRects) };
  const inBounds = (x: number, z: number, m: number): boolean => x > B.minX + m && x < B.maxX - m && z > B.minZ + m && z < B.maxZ - m;
  const parkRects = PARKS.map((p) => p.rect);
  const blocking = LANDMARKS.filter((l) => !l.passable);

  // --- Roads ---
  const roads: RoadPiece[] = [];
  for (const line of isoLines(coastF, COAST_ROAD_OFFSET)) {
    for (const run of clipPolyline(line, (x, z) => inBounds(x, z, 6) && !mask.isWater(x, z), 2, 30)) {
      roads.push({ pts: run, width: COAST_ROAD_WIDTH, cls: 3, cars: true });
    }
  }
  const streetOk = (x: number, z: number, half: number): boolean =>
    inBounds(x, z, 4) &&
    sampleField(coastF, x, z) >= COAST_ROAD_OFFSET - 0.5 &&
    !blocking.some((l) => inRect(l.rect, x, z, half + 2)) &&
    !parkRects.some((r) => inRect(r, x, z, half + 1));
  const arterialLine = (a: Arterial): Array<[number, number]> => (a.axis === 'x' ? [[a.at, a.from], [a.at, a.to]] : [[a.from, a.at], [a.to, a.at]]);
  for (const a of ARTERIALS) {
    for (const run of clipPolyline(arterialLine(a), (x, z) => streetOk(x, z, a.width / 2), 2, 12)) roads.push({ pts: run, width: a.width, cls: a.cls, cars: a.cars });
  }
  const leaves: Rect[] = [];
  for (const root of ROOTS) {
    const res = bsp(root, {
      rng,
      arterials: ARTERIALS,
      stopSize: (cx, cz) => (inRect(LEVENT, cx, cz) ? [80, 120] : [30, 90]),
      streetOk,
    });
    leaves.push(...res.leaves);
    roads.push(...res.roads);
  }
  const roadIdx = new RoadIndex(roadSegments(roads), E);
  const roadWide = new RoadIndex(roadSegments(roads, 2.4), E);

  // --- Blocks: the largest valid rectangle in each leaf ---
  const blockOk = (x: number, z: number): boolean =>
    inBounds(x, z, 8) &&
    sampleField(coastF, x, z) >= COAST_ROAD_OFFSET + COAST_ROAD_WIDTH / 2 + 1.5 &&
    !mask.isWater(x, z) &&
    !LANDMARKS.some((l) => inRect(l.rect, x, z, 2)) &&
    !parkRects.some((r) => inRect(r, x, z, 1.5)) &&
    !roadWide.isRoad(x, z);
  const blocks: Block[] = [];
  for (const leaf of leaves) {
    const r = largestValidRect(leaf, blockOk, 2, 14);
    if (!r) continue;
    const d = districtAt((r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2);
    blocks.push({ ...r, id: blocks.length, district: d.district, hasPlaza: false });
  }

  // --- Buildings ---
  const ctx: Ctx = { rng, buildings: [], base };
  for (const blk of blocks) {
    const d = districtAt((blk.minX + blk.maxX) / 2, (blk.minZ + blk.maxZ) / 2);
    const tower = d.district === D_DOWNTOWN;
    const inner: Rect = { minX: blk.minX + SIDEWALK, maxX: blk.maxX - SIDEWALK, minZ: blk.minZ + SIDEWALK, maxZ: blk.maxZ - SIDEWALK };
    if (inner.maxX - inner.minX < 8 || inner.maxZ - inner.minZ < 8) continue;
    let prev = rng.int(d.floors[0], d.floors[1]);
    const place = (rect: Rect, faces: number[], depth: number): void => {
      const [lo, hi] = footprintRange(ctx, rect);
      if (hi - lo > 6) {
        if (depth >= 2) return;
        const w = rect.maxX - rect.minX,
          dd = rect.maxZ - rect.minZ;
        if (Math.max(w, dd) < 12) return;
        if (w >= dd) {
          const m = (rect.minX + rect.maxX) / 2;
          place({ ...rect, maxX: m }, faces.filter((f) => f !== 0), depth + 1);
          place({ ...rect, minX: m }, faces.filter((f) => f !== 1), depth + 1);
        } else {
          const m = (rect.minZ + rect.maxZ) / 2;
          place({ ...rect, maxZ: m }, faces.filter((f) => f !== 2), depth + 1);
          place({ ...rect, minZ: m }, faces.filter((f) => f !== 3), depth + 1);
        }
        return;
      }
      let floors = clamp(prev + rng.int(-2, 2), d.floors[0], d.floors[1]);
      // Stone hans and hotels at block corners (about one lot in eight).
      // (Not next to a park: the park's trees stay the tallest things around it.)
      const han = !tower && faces.length >= 2 && rng.chance(0.12) && !parkRects.some((r) => rectGap(r, rect) < 45);
      if (han) floors = rng.int(10, 12);
      else prev = floors;
      addBuilding(ctx, rect, floors, d, faces, han);
    };
    for (const lot of makeLots(rng, inner, tower)) place(lot.rect, lot.faces, 0);
  }

  // --- Plazas: landmark sites (paved, raised) ---
  const plazas: Rect[] = LANDMARKS.filter((l) => !l.passable && !l.id.startsWith('halic')).map((l) => ({ ...l.rect }));
  const raised = new RectIndex([...blocks, ...plazas, ...parkRects], E);
  const groundY = (x: number, z: number): number => base(x, z) + (raised.contains(x, z) ? CURB : 0);
  const blockIdx = new RectIndex(blocks, E);
  const edgeDist = (r: Rect, x: number, z: number): number => Math.min(x - r.minX, r.maxX - x, z - r.minZ, r.maxZ - z);

  // --- Trees ---
  const trees: Tree[] = [];
  // Park species (§4h): plane trees (çınar) with cypresses (servi) and stone pines (fıstık çamı).
  const parkMix: Record<string, Array<[number, number, [number, number]]>> = {
    Gülhane: [[TREE_PLANE, 0.72, [18, 26]], [TREE_CYPRESS, 0.14, [14, 19]], [TREE_STONEPINE, 0.14, [14, 19]]],
    Sarayburnu: [[TREE_PLANE, 0.85, [19, 26]], [TREE_STONEPINE, 0.15, [14, 18]]],
    Sultanahmet: [[TREE_PLANE, 0.8, [16, 24]], [TREE_CYPRESS, 0.2, [13, 18]]],
    Gezi: [[TREE_PLANE, 0.85, [16, 23]], [TREE_STONEPINE, 0.15, [13, 18]]],
    Yıldız: [[TREE_STONEPINE, 0.42, [14, 20]], [TREE_PLANE, 0.48, [18, 26]], [TREE_CYPRESS, 0.1, [14, 19]]],
  };
  const pickTree = (mix: Array<[number, number, [number, number]]>): [number, number] => {
    let r = rng.float();
    for (const [sp, w, h] of mix) {
      r -= w;
      if (r <= 0) return [sp, rng.range(h[0], h[1])];
    }
    const last = mix[mix.length - 1]!;
    return [last[0], rng.range(last[2][0], last[2][1])];
  };
  for (const p of PARKS) {
    const [s0, s1] = p.spacing;
    const mix = parkMix[p.name] ?? parkMix.Gülhane!;
    for (let z = p.rect.minZ + 6; z < p.rect.maxZ - 4; z += rng.range(s0, s1)) {
      for (let x = p.rect.minX + 6; x < p.rect.maxX - 4; x += rng.range(s0, s1)) {
        const tx = x + rng.range(-2.5, 2.5),
          tz = z + rng.range(-2.5, 2.5);
        if (mask.isWater(tx, tz) || roadWide.isRoad(tx, tz) || sampleField(coastF, tx, tz) < 4) continue;
        // Gülhane's Sarayburnu end keeps to broad plane trees (the park route swings through it).
        const [sp, h] = p.name === 'Gülhane' && tx > 265 ? [TREE_PLANE, rng.range(20, 26)] : pickTree(mix);
        trees.push(makeTree(rng, sp, tx, tz, groundY(tx, tz), h, true));
      }
    }
  }
  // Plane trees in Topkapı's first court with a row of cypresses along its wall, and along the Hippodrome.
  for (let z = 226; z < 432; z += rng.range(11, 14)) {
    for (let x = 160; x < 197; x += rng.range(11, 14)) {
      if (z > 280 && z < 320) continue;
      trees.push(makeTree(rng, TREE_PLANE, x, z, groundY(x, z), rng.range(18, 26), true));
    }
  }
  for (let z = 222; z < 436; z += 9) {
    if (z > 282 && z < 318) continue;
    trees.push(makeTree(rng, TREE_CYPRESS, 149, z, groundY(149, z), rng.range(13, 17), true));
  }
  for (let z = 408; z < 616; z += 15) {
    for (const x of [-45, 5]) trees.push(makeTree(rng, TREE_PLANE, x, z, groundY(x, z), rng.range(13, 17), true));
  }
  // Street trees on the sidewalks of the arterials.
  for (const r of roads) {
    if (r.cls !== 2) continue;
    walkRoad(r, 13, (x, z, nx, nz) => {
      for (const side of [-1, 1]) {
        const tx = x + nx * side * (r.width / 2 + 1.6),
          tz = z + nz * side * (r.width / 2 + 1.6);
        const bi = blockIdx.find(tx, tz);
        if (bi < 0) continue;
        const e = edgeDist(blocks[bi]!, tx, tz);
        if (e < 0.9 || e > 2.3 || roadIdx.isRoad(tx, tz)) continue;
        trees.push(makeTree(rng, rng.chance(0.65) ? TREE_PLANE : TREE_OAK, tx, tz, groundY(tx, tz), rng.range(8, 12), false));
      }
    });
  }

  // --- Lamps along streets, arterials and the shore roads ---
  const props: StreetProp[] = [];
  const lampOk = (x: number, z: number): boolean => {
    if (!inBounds(x, z, 4) || mask.isWater(x, z) || roadIdx.isRoad(x, z)) return false;
    const bi = blockIdx.find(x, z);
    if (bi >= 0) return edgeDist(blocks[bi]!, x, z) < 1.4;
    return !LANDMARKS.some((l) => inRect(l.rect, x, z, 1)) && !parkRects.some((p) => inRect(p, x, z, 1));
  };
  for (const r of roads) {
    if (r.cls === 0) continue;
    let k = 0;
    walkRoad(r, r.cls === 3 ? 26 : 30, (x, z, nx, nz) => {
      const side = k++ % 2 === 0 ? 1 : -1;
      const lx = x + nx * side * (r.width / 2 + 0.7),
        lz = z + nz * side * (r.width / 2 + 0.7);
      if (!lampOk(lx, lz)) return;
      if (trees.some((t) => Math.abs(t.x - lx) < 2.5 && Math.abs(t.z - lz) < 2.5)) return;
      props.push({ type: SP_LAMP, x: lx, y: groundY(lx, lz), z: lz, rot: Math.atan2(-nx * side, -nz * side), variant: r.cls === 3 ? 1 : 0 });
    });
  }

  const piers: Pier[] = PIERS.map((p) => ({ ...p, top: CURB }));

  // Landmarks and bridges; trees and lamps keep clear of them.
  const parts = buildIstanbulParts(base, (x, z) => roadIdx.isRoad(x, z));
  const partIdx = new RectIndex(partFootprints(parts).map((r) => grow(r, 0.8)), E);
  const clearTrees = trees.filter((t) => !partIdx.contains(t.x, t.z) && !partIdx.contains(t.x + t.rx * 0.6, t.z) && !partIdx.contains(t.x - t.rx * 0.6, t.z) && !partIdx.contains(t.x, t.z + t.rx * 0.6) && !partIdx.contains(t.x, t.z - t.rx * 0.6));
  const parkTreesKept = clearTrees.filter((t) => t.park).length;
  const clearProps = props.filter((p) => !partIdx.contains(p.x, p.z));

  // Spawn on a low roof near Eminönü, looking over the old city.
  const buildings = ctx.buildings;
  let spawn: [number, number, number] = [0, groundY(0, 250) + 0.1, 250];
  {
    let best = Infinity;
    for (const b of buildings) {
      const top = b.volumes[b.volumes.length - 1]!;
      const ground = (b.plinth?.minY ?? top.minY - CURB) + 1;
      if (b.hipRoof || top.maxY - ground < 12 || top.maxY - ground > 34 || top.maxX - top.minX < 13 || top.maxZ - top.minZ < 13) continue;
      const cx = (top.minX + top.maxX) / 2,
        cz = (top.minZ + top.maxZ) / 2;
      const dd = Math.hypot(cx + 40, cz - 235);
      if (dd < best) {
        best = dd;
        spawn = [cx, top.maxY, cz];
      }
    }
  }

  const layout: CityLayout = {
    mapId: 'istanbul',
    seed,
    land: { ...B },
    islet: { minX: 5000, maxX: 5001, minZ: 5000, maxZ: 5001 },
    promenade: 0,
    avenues: [],
    streets: [],
    park: { ...PARKS[0]!.rect },
    pond: { cx: 5000, cz: 5000, rx: 1, rz: 1, level: -1.2 },
    paths: [],
    blocks,
    plazas,
    buildings,
    trees: clearTrees,
    props: clearProps,
    parkWalls: [],
    railings: [],
    piers,
    bridge: EMPTY_BRIDGE,
    bounds: { ...B },
    spawn,
    stats: {
      buildings: buildings.length,
      parkTrees: parkTreesKept,
      streetTrees: clearTrees.length - parkTreesKept,
      maxHeight: buildings.reduce((m, b) => Math.max(m, b.height), 0),
    },
    sidewalk: SIDEWALK,
    roads,
    landPolygons: LAND_POLYGONS.map((p) => p.map((q) => [q[0], q[1]] as [number, number])),
    parks: parkRects.map((r) => ({ ...r })),
    landmarks: LANDMARKS.map((l) => ({ id: l.id, rect: { ...l.rect } })),
  };
  TERRAINS.set(layout, makeTerrain(layout, grid, mask));
  PARTS.set(layout, parts);
  return layout;
}

/** Calls `fn` every `step` metres along a road with the point and the unit normal (left of travel). */
function walkRoad(r: RoadPiece, step: number, fn: (x: number, z: number, nx: number, nz: number) => void): void {
  let carry = step / 2;
  for (let i = 0; i + 1 < r.pts.length; i++) {
    const [ax, az] = r.pts[i]!;
    const [bx, bz] = r.pts[i + 1]!;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    const tx = (bx - ax) / len,
      tz = (bz - az) / len;
    let s = carry;
    while (s < len) {
      fn(ax + tx * s, az + tz * s, -tz, tx);
      s += step;
    }
    carry = s - len;
  }
}
