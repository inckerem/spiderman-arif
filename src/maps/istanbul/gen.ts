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
  PROP_HVAC,
  PROP_TANK,
  SP_LAMP,
  TREE_MAPLE,
  TREE_OAK,
  TREE_POPLAR,
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

/** §2.6 palette: walls, trims, glass. */
const WALLS = [0xefe3c8, 0xd9a65b, 0xd49a8a, 0xb8613e, 0xa9c7b0, 0xc9c6be, 0xe2c99a, 0xe8cf7a, 0xf2efe6, 0x9eb9c9];
const TRIMS = [0xf2efe6, 0x7a5236, 0xe7e0d0, 0x8d9499];
const GLASS = [0x4a6f88, 0x3f6278, 0x557f99];
const TOWER_WALLS = [0x8aa7b8, 0x5a7d95, 0xc9c1ad, 0x3d6f8f, 0xd8cfb8];

const grow = (r: Rect, d: number): Rect => ({ minX: r.minX - d, maxX: r.maxX + d, minZ: r.minZ - d, maxZ: r.maxZ + d });
const inRect = (r: Rect, x: number, z: number, m = 0): boolean => x > r.minX - m && x < r.maxX + m && z > r.minZ - m && z < r.maxZ + m;

/** Building district of a point: floors and look (§2.6). */
interface DistrictSpec {
  name: string;
  floors: [number, number];
  district: District;
}

function districtAt(x: number, z: number): DistrictSpec {
  if (inRect(LEVENT, x, z)) return { name: 'levent', floors: [36, 70], district: D_DOWNTOWN };
  if (x > 600) return { name: 'uskudar', floors: [3, 7], district: D_LOW };
  if (z > -60) {
    // Historic peninsula.
    if (x > -60 && z > 230) return { name: 'sultanahmet', floors: [2, 5], district: D_LOW };
    if (x > -250 && z < 250) return { name: 'eminonu', floors: [4, 7], district: D_LOW };
    return { name: 'fatih', floors: [3, 6], district: D_LOW };
  }
  if (z > -350 && x > -100) return { name: 'galata', floors: [6, 8], district: D_LOW };
  if (x < -150) return { name: 'kasimpasa', floors: [4, 7], district: D_LOW };
  if (z > -560) return { name: 'beyoglu', floors: [5, 8], district: D_LOW };
  return { name: 'taksim', floors: [6, 10], district: D_MID };
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

/** A plain greybox facade style from the Istanbul palette. */
function makeStyle(rng: Rng, district: District, shop: boolean): FacadeStyle {
  const tower = district === D_DOWNTOWN;
  const window = tower ? rng.pick([0, 5, 6]) : rng.pick([1, 2, 3, 1]);
  return {
    window,
    floorHeight: tower ? rng.range(3.8, 4.1) : FLOOR,
    bayWidth: tower ? rng.range(2.6, 3.2) : rng.range(2.8, 3.6),
    wall: hex(tower ? rng.pick(TOWER_WALLS) : rng.pick(WALLS)),
    trim: hex(rng.pick(TRIMS)),
    glass: hex(rng.pick(GLASS)),
    storefront: shop && !tower ? SHOP_FLOOR : 0,
    litRatio: rng.range(0.3, 0.7),
    pilasters: !tower && rng.chance(0.3),
  };
}

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
function addBuilding(ctx: Ctx, fp: Rect, floors: number, d: DistrictSpec, faces: number[]): Building | null {
  const rng = ctx.rng;
  const w = fp.maxX - fp.minX,
    dd = fp.maxZ - fp.minZ;
  if (w < 6 || dd < 6) return null;
  const [lo, hi] = footprintRange(ctx, fp);
  const baseY = hi + CURB;
  const tower = d.district === D_DOWNTOWN;
  const shop = !tower && faces.length > 0 && rng.chance(0.6);
  const style = makeStyle(rng, d.district, shop);
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
  const parapets: BoxSpec[] = [];
  for (let i = 0; i < volumes.length; i++) {
    const v = volumes[i]!;
    const above = volumes[i + 1];
    if (above && Math.abs(above.minX - v.minX) < 0.3 && Math.abs(above.maxX - v.maxX) < 0.3 && Math.abs(above.minZ - v.minZ) < 0.3 && Math.abs(above.maxZ - v.maxZ) < 0.3) continue;
    parapets.push(...parapetsFor(v, rng));
  }
  // Roof props: a water tank on many flat roofs, a few HVAC boxes.
  const props: RoofProp[] = [];
  const roofY = topV.maxY;
  const rw = topV.maxX - topV.minX - 4,
    rd = topV.maxZ - topV.minZ - 4;
  if (!tower && rw > 6 && rd > 6 && rng.chance(0.4)) {
    const r = rng.range(1.2, 1.7);
    props.push({ type: PROP_TANK, x: topV.minX + 2 + r + rng.float() * (rw - 2 * r), y: roofY, z: topV.minZ + 2 + r + rng.float() * (rd - 2 * r), sx: r, sy: rng.range(2, 2.8), sz: rng.range(1.6, 2.2), face: 0, variant: rng.int(0, 2) });
  }
  if (rw > 8 && rd > 8 && rng.chance(0.5)) {
    const sx = rng.range(1.6, 3),
      sz = rng.range(1.6, 3);
    const x = topV.minX + 2 + sx / 2 + rng.float() * (rw - sx),
      z = topV.minZ + 2 + sz / 2 + rng.float() * (rd - sz);
    const clash = props.some((p) => Math.abs(p.x - x) < p.sx + sx / 2 + 1.2 && Math.abs(p.z - z) < p.sx + sz / 2 + 1.2);
    if (!clash) props.push({ type: PROP_HVAC, x, y: roofY, z, sx, sy: rng.range(1.1, 1.8), sz, face: 0, variant: rng.int(0, 3) });
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
  // Stone plinth from below the low side up to the floor.
  if (baseY - (lo + CURB) > 0.05) b.plinth = { ...fp, minY: lo - 1, maxY: baseY };
  ctx.buildings.push(b);
  return b;
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
      if (!tower && faces.length >= 2 && rng.chance(0.12)) floors = rng.int(10, 12);
      else prev = floors;
      addBuilding(ctx, rect, floors, d, faces);
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
  for (const p of PARKS) {
    const [s0, s1] = p.spacing;
    for (let z = p.rect.minZ + 6; z < p.rect.maxZ - 4; z += rng.range(s0, s1)) {
      for (let x = p.rect.minX + 6; x < p.rect.maxX - 4; x += rng.range(s0, s1)) {
        const tx = x + rng.range(-2.5, 2.5),
          tz = z + rng.range(-2.5, 2.5);
        if (mask.isWater(tx, tz) || roadWide.isRoad(tx, tz) || sampleField(coastF, tx, tz) < 4) continue;
        const sp = rng.chance(0.15) ? TREE_POPLAR : rng.chance(0.5) ? TREE_OAK : TREE_MAPLE;
        trees.push(makeTree(rng, sp, tx, tz, groundY(tx, tz), rng.range(15, 23), true));
      }
    }
  }
  // Plane trees in Topkapı's first court and along the Hippodrome.
  for (let z = 226; z < 432; z += rng.range(11, 14)) {
    for (let x = 160; x < 197; x += rng.range(11, 14)) {
      if (z > 280 && z < 320) continue;
      trees.push(makeTree(rng, rng.chance(0.5) ? TREE_OAK : TREE_MAPLE, x, z, groundY(x, z), rng.range(17, 24), true));
    }
  }
  for (let z = 408; z < 616; z += 15) {
    for (const x of [-45, 5]) trees.push(makeTree(rng, TREE_OAK, x, z, groundY(x, z), rng.range(12, 16), true));
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
        trees.push(makeTree(rng, rng.chance(0.6) ? TREE_MAPLE : TREE_OAK, tx, tz, groundY(tx, tz), rng.range(8, 12), false));
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
      if (top.maxY - ground < 12 || top.maxY - ground > 34 || top.maxX - top.minX < 13 || top.maxZ - top.minZ < 13) continue;
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
