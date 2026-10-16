import { GeomBuilder } from '../../render/geomBuilder';
import { Rng } from '../../core/rng';
import {
  D_DOWNTOWN,
  D_WATERFRONT,
  HIP_EAVE,
  HIP_LIFT,
  HIP_PITCH,
  LOOK_APARTMENT,
  LOOK_GLASS,
  LOOK_STONE,
  LOOK_WOODEN,
  PROP_ROOF_TANK,
  PROP_SOLAR,
  PROP_ANTENNA,
  PROP_BILLBOARD,
  PROP_BLADE_SIGN,
  PROP_HELIPAD,
  PROP_HVAC,
  PROP_TANK,
  PROP_WALL_SIGN,
  type Building,
  type Volume,
} from '../types';
import { BILLBOARD_POST, SOLAR_STEP_TOPS, TANK_LEG_R } from '../cityCollision';
import { HELIPAD_RECT } from '../../render/textures';

export const FACADE_ATTRS = [
  { name: 'aFac', size: 2 },
  { name: 'aWin', size: 4 },
  { name: 'aWin2', size: 4 },
  { name: 'aGlass', size: 3 },
];

/**
 * All static chunk geometry goes into one builder with facade attributes;
 * `props`, `signs` and `glow` are views that set the per-vertex mode
 * (aWin.x: -1 plain, -2 emissive lamp, -3 sign texture) before emitting.
 */
export interface ChunkBuilders {
  facade: GeomBuilder;
  props: GeomBuilder;
  signs: GeomBuilder;
  glow: GeomBuilder;
}

/** A thin wrapper so prop/sign/glow emitters share the chunk's facade builder. */
export function makeChunkBuilders(): ChunkBuilders {
  const facade = new GeomBuilder(FACADE_ATTRS);
  const mode = (m: number): GeomBuilder =>
    new Proxy(facade, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== 'function') return v;
        if (prop === 'vertex' || prop === 'quad' || prop === 'box' || prop === 'cylinder' || prop === 'ellipsoid' || prop === 'orientedBox') {
          return (...args: unknown[]) => {
            target.setExtra('aWin', m, 3, 3, 0);
            target.setExtra('aWin2', 0, 0, 0, 0);
            if (m !== -3) target.setExtra('aFac', 0, 0);
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return v.bind(target);
      },
    }) as GeomBuilder;
  return { facade, props: mode(-1), signs: mode(-3), glow: mode(-2) };
}

type RGB = [number, number, number];

const CORNICE_H = 0.45;
const CORNICE_OUT = 0.25;
const PILASTER_OUT = 0.12;

/**
 * Emit one face of a volume with facade attributes. The bay width is
 * adjusted so every face holds a whole number of window bays.
 */
function facadeFace(
  b: GeomBuilder,
  face: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  style: number,
  floorH: number,
  bayW: number,
  seed: number,
  baseY: number,
  storefront: number,
  lit: number,
  glass: RGB,
): void {
  const width = face === 1 || face === 2 ? maxZ - minZ : maxX - minX;
  const bays = Math.max(1, Math.round(width / bayW));
  const bw = width / bays;
  const winStyle = width < 2.2 ? -1 : style;
  b.setExtra('aWin', winStyle, floorH, bw, seed);
  b.setExtra('aWin2', baseY, storefront, lit, 0);
  b.setExtra('aGlass', glass[0], glass[1], glass[2]);
  // u runs left->right as seen from outside; v = world height.
  const start = b.vertexCount;
  switch (face) {
    case 1:
      b.quad(maxX, minY, maxZ, maxX, minY, minZ, maxX, maxY, minZ, maxX, maxY, maxZ, 1, 0, 0);
      break;
    case 2:
      b.quad(minX, minY, minZ, minX, minY, maxZ, minX, maxY, maxZ, minX, maxY, minZ, -1, 0, 0);
      break;
    case 16:
      b.quad(minX, minY, maxZ, maxX, minY, maxZ, maxX, maxY, maxZ, minX, maxY, maxZ, 0, 0, 1);
      break;
    case 32:
      b.quad(maxX, minY, minZ, minX, minY, minZ, minX, maxY, minZ, maxX, maxY, minZ, 0, 0, -1);
      break;
  }
  // Fix up aFac per vertex: corner order is (left-bottom, right-bottom, right-top, left-top).
  setFac(b, start, 0, 0, minY);
  setFac(b, start, 1, width, minY);
  setFac(b, start, 2, width, maxY);
  setFac(b, start, 3, 0, maxY);
}

function setFac(b: GeomBuilder, start: number, k: number, u: number, v: number): void {
  b.patchExtra('aFac', start + k, u, v);
}

function noWindows(b: GeomBuilder): void {
  b.setExtra('aWin', -1, 3, 3, 0);
  b.setExtra('aWin2', 0, 0, 0, 0);
  b.setExtra('aGlass', 0.4, 0.5, 0.6);
  b.setExtra('aFac', 0, 0);
}

function mulRGB(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** Add one building (volumes, trims, parapets, roof props, signage) to the chunk builders. */
export function addBuildingGeometry(bld: Building, cb: ChunkBuilders, signRect: (i: number) => [number, number, number, number], boardRect: (i: number) => [number, number, number, number]): void {
  const st = bld.style;
  const f = cb.facade;
  const rng = new Rng(bld.seed);
  const vols = bld.volumes;
  const roofCol: RGB = bld.district === D_DOWNTOWN ? [0.5, 0.52, 0.55] : rng.chance(0.5) ? [0.34, 0.34, 0.37] : [0.42, 0.4, 0.38];
  const trim = st.trim as RGB;
  const wall = st.wall as RGB;
  // Stone plinth on a slope: plain sides, no windows (its top is under the building).
  if (bld.plinth) {
    const p = bld.plinth;
    noWindows(f);
    if (st.look) {
      // Istanbul: rough grey-ochre stone with a dressed cap course.
      const k = 0.92 + 0.08 * rng.float();
      f.setColor(0.66 * k, 0.6 * k, 0.5 * k);
      f.box(p.minX, p.minY, p.minZ, p.maxX, p.maxY - 0.3, p.maxZ, 1 | 2 | 16 | 32);
      f.setColor(0.8, 0.76, 0.68);
      f.box(p.minX - 0.08, p.maxY - 0.3, p.minZ - 0.08, p.maxX + 0.08, p.maxY, p.maxZ + 0.08, 1 | 2 | 16 | 32);
    } else {
      f.setColor(0.72, 0.68, 0.6);
      f.box(p.minX, p.minY, p.minZ, p.maxX, p.maxY, p.maxZ, 1 | 2 | 16 | 32);
    }
  } else if (st.look) {
    // A skirt below the floor line: the ground under a building is not drawn (terrainGeo).
    const v = vols[0]!;
    noWindows(f);
    f.setColor(0.6, 0.56, 0.5);
    f.box(v.minX, v.minY - 0.4, v.minZ, v.maxX, v.minY, v.maxZ, 1 | 2 | 16 | 32);
  }
  for (let i = 0; i < vols.length; i++) {
    const v = vols[i]!;
    const above = vols[i + 1];
    const isGround = v.minY <= bld.volumes[0]!.minY + 0.01;
    const storefront = isGround ? st.storefront : 0;
    const crown = v.role === 2;
    const style = crown && bld.district === D_DOWNTOWN ? (st.look === LOOK_GLASS ? 0 : 6) : st.window;
    const wallC: RGB = crown ? mulRGB(wall, 0.92) : v.role === 0 && bld.district === D_DOWNTOWN ? mulRGB(trim, 0.9) : wall;
    f.setColorArr(wallC);
    const seed = (bld.seed % 997) / 997 + i * 0.137;
    for (const face of [1, 2, 16, 32]) {
      facadeFace(f, face, v.minX, v.minY, v.minZ, v.maxX, v.maxY, v.maxZ, style, st.floorHeight, st.bayWidth, seed, bld.volumes[0]!.minY, storefront, st.litRatio, st.glass as RGB);
    }
    // Roof (unless fully covered by the next volume).
    const covered =
      above &&
      Math.abs(above.minX - v.minX) < 0.3 &&
      Math.abs(above.maxX - v.maxX) < 0.3 &&
      Math.abs(above.minZ - v.minZ) < 0.3 &&
      Math.abs(above.maxZ - v.maxZ) < 0.3;
    const hipped = bld.hipRoof !== undefined && !above;
    if (!covered && !hipped) {
      noWindows(f);
      f.setColorArr(st.look ? mulRGB(trim, 0.62) : roofCol);
      f.box(v.minX, v.minY, v.minZ, v.maxX, v.maxY, v.maxZ, 4);
    }
    if (st.look) districtTrim(f, bld, v, storefront, hipped);
    // Wooden houses under a hip roof show the eave, not a cornice.
    if (!(hipped && st.look === LOOK_WOODEN)) {
      // Cornice band at the top of the volume. Its top is only the outset ring:
      // the roof (or the volume above) covers the footprint at the same height,
      // and two faces there would z-fight into stripes. The ring is four
      // trapezoids (mitred at the corners) whose outer edges are the full top
      // edges of the side faces and whose inner edges are the roof's edges, so
      // every shared edge has the same two vertices on both sides (no
      // T-junctions, which crack into pinholes).
      noWindows(f);
      f.setColorArr(trim);
      const o = CORNICE_OUT;
      const cy = v.maxY - CORNICE_H;
      f.box(v.minX - o, cy, v.minZ - o, v.maxX + o, v.maxY, v.maxZ + o, 1 | 2 | 8 | 16 | 32);
      const x0 = v.minX,
        x1 = v.maxX,
        z0 = v.minZ,
        z1 = v.maxZ,
        y = v.maxY;
      f.quad(x0, y, z0, x1, y, z0, x1 + o, y, z0 - o, x0 - o, y, z0 - o, 0, 1, 0);
      f.quad(x0 - o, y, z1 + o, x1 + o, y, z1 + o, x1, y, z1, x0, y, z1, 0, 1, 0);
      f.quad(x0 - o, y, z1 + o, x0, y, z1, x0, y, z0, x0 - o, y, z0 - o, 0, 1, 0);
      f.quad(x1, y, z1, x1 + o, y, z1 + o, x1 + o, y, z0 - o, x1, y, z0, 0, 1, 0);
    }
    // Pilasters at the corners (and along long faces when the style uses them).
    if (st.pilasters && v.maxY - v.minY > 6) {
      f.setColorArr(mulRGB(trim, 0.95));
      const y0 = v.minY + (storefront > 0 ? storefront : 0),
        y1 = v.maxY - CORNICE_H;
      const pw = 0.55,
        po = PILASTER_OUT;
      const corners: Array<[number, number]> = [
        [v.minX, v.minZ],
        [v.maxX, v.minZ],
        [v.minX, v.maxZ],
        [v.maxX, v.maxZ],
      ];
      for (const [cx, cz] of corners) {
        const sx = cx === v.minX ? -1 : 1,
          sz = cz === v.minZ ? -1 : 1;
        const x0 = sx > 0 ? cx - pw : cx - po,
          x1 = sx > 0 ? cx + po : cx + pw;
        const z0 = sz > 0 ? cz - pw : cz - po,
          z1 = sz > 0 ? cz + po : cz + pw;
        f.box(x0, y0, z0, x1, y1, z1, 63 & ~8 & ~4);
      }
      // Intermediate pilasters every 4 bays on faces wide enough.
      const bays = (len: number): number => Math.max(1, Math.round(len / st.bayWidth));
      const wx = v.maxX - v.minX,
        wz = v.maxZ - v.minZ;
      const nx = bays(wx),
        nz = bays(wz);
      for (let k = 4; k < nx; k += 4) {
        const x = v.minX + (wx / nx) * k;
        f.box(x - pw / 2, y0, v.maxZ, x + pw / 2, y1, v.maxZ + po, 63 & ~8 & ~32);
        f.box(x - pw / 2, y0, v.minZ - po, x + pw / 2, y1, v.minZ, 63 & ~8 & ~16);
      }
      for (let k = 4; k < nz; k += 4) {
        const z = v.minZ + (wz / nz) * k;
        f.box(v.maxX, y0, z - pw / 2, v.maxX + po, y1, z + pw / 2, 63 & ~8 & ~2);
        f.box(v.minX - po, y0, z - pw / 2, v.minX, y1, z + pw / 2, 63 & ~8 & ~1);
      }
    }
    // Storefront awning line (a thin trim band above the shop windows).
    if (storefront > 0) {
      f.setColorArr(mulRGB(trim, 0.85));
      const y = v.minY + storefront;
      f.box(v.minX - 0.2, y - 0.25, v.minZ - 0.2, v.maxX + 0.2, y + 0.05, v.maxZ + 0.2, 63 & ~4);
    }
  }
  if (bld.hipRoof) hipRoof(f, vols[vols.length - 1]!, bld.hipRoof.color, trim);
  if (bld.bays) {
    for (const by of bld.bays) {
      f.setColorArr(st.look === LOOK_WOODEN ? mulRGB(wall, 0.94) : wall);
      const seed = (bld.seed % 991) / 991;
      // Window faces on the three outward sides (the side against the wall is hidden).
      for (const face of [1, 2, 16, 32]) {
        const fp = bld.footprint;
        const against = face === 1 ? Math.abs(by.maxX - fp.minX) : face === 2 ? Math.abs(by.minX - fp.maxX) : face === 16 ? Math.abs(by.maxZ - fp.minZ) : Math.abs(by.minZ - fp.maxZ);
        if (against < 0.01) continue;
        facadeFace(f, face, by.minX, by.minY, by.minZ, by.maxX, by.maxY, by.maxZ, st.window, st.floorHeight, Math.min(st.bayWidth, 1.5), seed, vols[0]!.minY, st.storefront, st.litRatio, st.glass as RGB);
      }
      noWindows(f);
      f.setColorArr(mulRGB(trim, 0.9));
      f.box(by.minX, by.minY, by.minZ, by.maxX, by.maxY, by.maxZ, 4 | 8);
      // Corbel line under the bay and a cap on top.
      f.setColorArr(mulRGB(trim, 0.8));
      f.box(by.minX - 0.05, by.minY - 0.2, by.minZ - 0.05, by.maxX + 0.05, by.minY, by.maxZ + 0.05, 63 & ~4);
      f.setColorArr(trim);
      f.box(by.minX - 0.1, by.maxY, by.minZ - 0.1, by.maxX + 0.1, by.maxY + 0.18, by.maxZ + 0.1, 63 & ~8);
    }
  }
  // Parapets
  noWindows(f);
  f.setColorArr(mulRGB(trim, 0.97));
  for (const p of bld.parapets) f.box(p.minX, p.minY, p.minZ, p.maxX, p.maxY, p.maxZ, 63 & ~8);

  // Roof props and signs
  const P = cb.props;
  for (const pr of bld.props) {
    switch (pr.type) {
      case PROP_HVAC: {
        const c = 0.62 + (pr.variant % 3) * 0.06;
        P.setColor(c, c, c * 1.02);
        P.box(pr.x - pr.sx / 2, pr.y, pr.z - pr.sz / 2, pr.x + pr.sx / 2, pr.y + pr.sy, pr.z + pr.sz / 2, 63 & ~8);
        P.setColor(c * 0.55, c * 0.56, c * 0.6);
        P.box(pr.x - pr.sx / 2 + 0.2, pr.y + pr.sy, pr.z - pr.sz / 2 + 0.2, pr.x + pr.sx / 2 - 0.2, pr.y + pr.sy + 0.12, pr.z + pr.sz / 2 - 0.2, 63 & ~8);
        if (pr.variant === 0) {
          P.setColor(0.3, 0.32, 0.35);
          P.cylinder(pr.x, pr.z, pr.y + pr.sy + 0.12, pr.y + pr.sy + 0.45, Math.min(pr.sx, pr.sz) * 0.32, Math.min(pr.sx, pr.sz) * 0.32, 10);
        }
        break;
      }
      case PROP_TANK: {
        const r = pr.sx,
          th = pr.sy,
          stand = pr.sz;
        const lr = r * 0.72;
        P.setColor(0.25, 0.22, 0.2);
        for (let i = 0; i < 4; i++) {
          const a = Math.PI / 4 + (i * Math.PI) / 2;
          P.cylinder(pr.x + Math.cos(a) * lr, pr.z + Math.sin(a) * lr, pr.y, pr.y + stand, TANK_LEG_R, TANK_LEG_R, 6, false);
        }
        P.box(pr.x - r * 0.95, pr.y + stand - 0.18, pr.z - r * 0.95, pr.x + r * 0.95, pr.y + stand, pr.z + r * 0.95);
        const wood: RGB = pr.variant === 0 ? [0.55, 0.36, 0.22] : pr.variant === 1 ? [0.47, 0.31, 0.2] : [0.6, 0.42, 0.27];
        P.setColorArr(wood);
        P.cylinder(pr.x, pr.z, pr.y + stand, pr.y + stand + th, r, r, 14);
        P.setColorArr(mulRGB(wood, 0.6));
        for (const t of [0.25, 0.6, 0.9]) P.cylinder(pr.x, pr.z, pr.y + stand + th * t - 0.08, pr.y + stand + th * t + 0.08, r + 0.04, r + 0.04, 14, false);
        P.setColor(0.32, 0.3, 0.3);
        P.cylinder(pr.x, pr.z, pr.y + stand + th, pr.y + stand + th + 1.0, r + 0.15, 0.08, 14);
        break;
      }
      case PROP_ANTENNA: {
        P.setColor(0.42, 0.44, 0.48);
        P.box(pr.x - 1.1, pr.y, pr.z - 1.1, pr.x + 1.1, pr.y + 1.6, pr.z + 1.1, 63 & ~8);
        P.setColor(0.72, 0.74, 0.78);
        P.cylinder(pr.x, pr.z, pr.y + 1.6, pr.y + pr.sy, pr.sx, pr.sx * 0.35, 8);
        // Guy rings
        P.setColor(0.86, 0.3, 0.25);
        for (const t of [0.35, 0.65]) {
          const y = pr.y + 1.6 + (pr.sy - 1.6) * t;
          const rr = pr.sx * (1 - 0.65 * t) + 0.08;
          P.cylinder(pr.x, pr.z, y, y + 0.6, rr, rr, 8, false);
        }
        cb.glow.setColor(1, 0.15, 0.1);
        cb.glow.box(pr.x - 0.3, pr.y + pr.sy, pr.z - 0.3, pr.x + 0.3, pr.y + pr.sy + 0.6, pr.z + 0.3);
        break;
      }
      case PROP_HELIPAD: {
        const S = cb.signs;
        S.setColor(1, 1, 1);
        const [u, v, w, h] = HELIPAD_RECT;
        const y = pr.y + 0.04;
        const s = pr.sx / 2;
        const i0 = S.vertex(pr.x - s, y, pr.z + s, 0, 1, 0);
        S.patchExtra('aFac', i0, u, v + h);
        const i1 = S.vertex(pr.x + s, y, pr.z + s, 0, 1, 0);
        S.patchExtra('aFac', i1, u + w, v + h);
        const i2 = S.vertex(pr.x + s, y, pr.z - s, 0, 1, 0);
        S.patchExtra('aFac', i2, u + w, v);
        const i3 = S.vertex(pr.x - s, y, pr.z - s, 0, 1, 0);
        S.patchExtra('aFac', i3, u, v);
        S.tri(i0, i1, i2);
        S.tri(i0, i2, i3);
        break;
      }
      case PROP_BILLBOARD: {
        const y0 = pr.y + BILLBOARD_POST,
          y1 = y0 + pr.sy;
        const half = pr.sx / 2;
        P.setColor(0.24, 0.25, 0.28);
        const alongZ = pr.face <= 1;
        for (const s of [-0.7, 0.7]) {
          const px = alongZ ? pr.x : pr.x + half * s,
            pz = alongZ ? pr.z + half * s : pr.z;
          P.cylinder(px, pz, pr.y, y0, 0.2, 0.2, 8, false);
        }
        if (alongZ) P.box(pr.x - 0.18, y0 - 0.2, pr.z - half - 0.2, pr.x + 0.18, y1 + 0.2, pr.z + half + 0.2);
        else P.box(pr.x - half - 0.2, y0 - 0.2, pr.z - 0.18, pr.x + half + 0.2, y1 + 0.2, pr.z + 0.18);
        const rect = boardRect(pr.variant);
        signQuad(cb.signs, pr.x, pr.z, y0, y1, half, pr.face, 0.19, rect, true);
        break;
      }
      case PROP_BLADE_SIGN: {
        const o = pr.sx;
        P.setColor(0.18, 0.19, 0.22);
        let cx = pr.x,
          cz = pr.z;
        if (pr.face === 0) cx += o / 2;
        if (pr.face === 1) cx -= o / 2;
        if (pr.face === 2) cz += o / 2;
        if (pr.face === 3) cz -= o / 2;
        const alongX = pr.face <= 1;
        const hx = alongX ? o / 2 : 0.15,
          hz = alongX ? 0.15 : o / 2;
        P.box(cx - hx, pr.y, cz - hz, cx + hx, pr.y + pr.sy, cz + hz);
        // Rotated sign texture on both sides (vertical text panel).
        const rect = signRect(pr.variant);
        bladeQuads(cb.signs, cx, cz, pr.y + 0.15, pr.y + pr.sy - 0.15, alongX ? o / 2 - 0.08 : 0, alongX ? 0 : o / 2 - 0.08, alongX, rect);
        break;
      }
      case PROP_SOLAR: {
        // Collector facing south on a frame, a lying tank on top at the back (sizes as in the collider steps).
        const hx = pr.sx / 2,
          t = pr.sz / 6;
        const zb = pr.z - 3 * t,
          zf = pr.z + 3 * t;
        const yBack = pr.y + pr.sy * SOLAR_STEP_TOPS[1]! + 0.12,
          yFront = pr.y + pr.sy * SOLAR_STEP_TOPS[2]! - 0.3;
        P.setColor(0.62, 0.64, 0.66);
        for (const x of [pr.x - hx + 0.1, pr.x + hx - 0.1]) {
          P.box(x - 0.04, pr.y, zf - 0.15, x + 0.04, yFront, zf - 0.07, 63 & ~8);
          P.box(x - 0.04, pr.y, pr.z - t, x + 0.04, yBack, pr.z - t + 0.08, 63 & ~8);
        }
        P.setColor(0.13, 0.19, 0.3);
        P.quad(pr.x - hx, yFront, zf, pr.x + hx, yFront, zf, pr.x + hx, yBack, pr.z - t, pr.x - hx, yBack, pr.z - t, 0, 0.95, 0.31);
        P.setColor(0.7, 0.72, 0.74);
        P.quad(pr.x + hx, yFront - 0.06, zf, pr.x - hx, yFront - 0.06, zf, pr.x - hx, yBack - 0.06, pr.z - t, pr.x + hx, yBack - 0.06, pr.z - t, 0, -0.95, -0.31);
        // The tank lies along x: a cylinder turned onto its side.
        const r = Math.min(0.42, (pr.sy - pr.sy * SOLAR_STEP_TOPS[1]!) / 2 + 0.05);
        const start = P.vertexCount;
        P.setColor(0.86, 0.87, 0.88);
        P.cylinder(0, 0, -hx, hx, r, r, 10, true);
        // Rotate -90 degrees about z (y onto x) and move onto the back of the frame.
        P.transformRange(start, (vv, nn) => {
          vv.set(pr.x + vv.y, pr.y + pr.sy - r - vv.x, (zb + pr.z - t) / 2 + vv.z);
          nn.set(nn.y, -nn.x, nn.z);
        });
        break;
      }
      case PROP_ROOF_TANK: {
        const r = pr.sx / 2;
        const c = pr.variant === 0 ? [0.92, 0.92, 0.9] : pr.variant === 1 ? [0.35, 0.5, 0.7] : [0.85, 0.82, 0.62];
        P.setColorArr(c);
        P.cylinder(pr.x, pr.z, pr.y, pr.y + pr.sy - 0.15, r, r, 12, false);
        P.cylinder(pr.x, pr.z, pr.y + pr.sy - 0.15, pr.y + pr.sy, r, r * 0.55, 12, true);
        break;
      }
      case PROP_WALL_SIGN: {
        P.setColor(0.16, 0.16, 0.18);
        const half = pr.sx / 2;
        const d = pr.sz;
        let x0 = pr.x - half,
          x1 = pr.x + half,
          z0 = pr.z - half,
          z1 = pr.z + half;
        if (pr.face === 0) {
          x0 = pr.x;
          x1 = pr.x + d;
        } else if (pr.face === 1) {
          x0 = pr.x - d;
          x1 = pr.x;
        } else if (pr.face === 2) {
          z0 = pr.z;
          z1 = pr.z + d;
        } else {
          z0 = pr.z - d;
          z1 = pr.z;
        }
        if (pr.face <= 1) P.box(x0, pr.y, z0, x1, pr.y + pr.sy, z1);
        else P.box(x0, pr.y, z0, x1, pr.y + pr.sy, z1);
        const rect = signRect(pr.variant);
        const off = d + 0.01;
        const fx = pr.face === 0 ? pr.x + off : pr.face === 1 ? pr.x - off : pr.x;
        const fz = pr.face === 2 ? pr.z + off : pr.face === 3 ? pr.z - off : pr.z;
        // Istanbul wall signs wind their face toward the street (front-facing); Manhattan's keep their original order.
        signQuad(cb.signs, fx, fz, pr.y + 0.08, pr.y + pr.sy - 0.08, half - 0.08, pr.face, 0, rect, false, st.look !== undefined);
        break;
      }
    }
  }
  void D_WATERFRONT;
}

/**
 * Istanbul district detail on a volume (M13): string courses on apartments
 * and stone hans, a dentil band under the apartment cornice, a heavier
 * rusticated ground floor on stone buildings. Each band protrudes at most
 * 0.14 m (visuals stay within 0.3 m of the box collider).
 */
function districtTrim(f: GeomBuilder, bld: Building, v: Volume, storefront: number, hipped: boolean): void {
  const st = bld.style;
  const trim = st.trim as RGB;
  const band = (y0: number, y1: number, o: number, c: RGB): void => {
    f.setColorArr(c);
    f.box(v.minX - o, y0, v.minZ - o, v.maxX + o, y1, v.maxZ + o, 1 | 2 | 16 | 32);
  };
  noWindows(f);
  const ground = bld.volumes[0]!.minY;
  const first = ground + (storefront > 0 ? storefront : st.floorHeight);
  if (st.look === LOOK_APARTMENT || st.look === LOOK_STONE) {
    // A string course at every floor line above the ground floor.
    const c = mulRGB(trim, 0.93);
    for (let y = first; y < v.maxY - 1.2; y += st.floorHeight) {
      if (y <= v.minY + 0.3) continue;
      band(y - 0.09, y + 0.09, 0.08, c);
    }
    if (st.look === LOOK_APARTMENT && v.maxY - v.minY > 6) band(v.maxY - 0.9, v.maxY - 0.62, 0.14, mulRGB(trim, 0.88));
  }
  if (st.look === LOOK_STONE && v.minY <= ground + 0.01) {
    // Rusticated base: a darker plinth course and a heavy band over the ground floor.
    band(ground, ground + 0.6, 0.06, mulRGB(st.wall as RGB, 0.78));
    band(first - 0.25, first + 0.05, 0.12, mulRGB(trim, 0.85));
  }
  if (st.look === LOOK_WOODEN && !hipped && v.maxY - v.minY > 4) band(v.maxY - 1.0, v.maxY - 0.8, 0.06, mulRGB(trim, 0.9));
}

/**
 * Hip roof of clay tiles over a volume: four planes rising at HIP_PITCH from
 * HIP_LIFT above the wall top, a HIP_EAVE overhang with fascia and soffit,
 * a ridge cap. Tiles are the window atlas slot 5 (Istanbul), one barrel
 * tile per cell and one course per 0.115 m of height. The step colliders
 * (gen) follow the same planes within 0.3 m.
 */
function hipRoof(f: GeomBuilder, v: Volume, color: RGB, trim: RGB): void {
  const e = HIP_EAVE;
  const yE = v.maxY + HIP_LIFT - HIP_PITCH * e;
  const X0 = v.minX - e,
    X1 = v.maxX + e,
    Z0 = v.minZ - e,
    Z1 = v.maxZ + e;
  const W = X1 - X0,
    D = Z1 - Z0;
  const alongX = W >= D;
  const half = (alongX ? D : W) / 2;
  const yR = yE + HIP_PITCH * half;
  const cx = (X0 + X1) / 2,
    cz = (Z0 + Z1) / 2;
  // Ridge ends.
  const ra: [number, number] = alongX ? [X0 + half, cz] : [cx, Z0 + half];
  const rb: [number, number] = alongX ? [X1 - half, cz] : [cx, Z1 - half];
  f.setColorArr(color);
  f.setExtra('aWin', 5, 0.115, 0.24, 0);
  f.setExtra('aWin2', 0, 0, 0, 0);
  f.setExtra('aGlass', 0.3, 0.3, 0.3);
  const ny = 1 / Math.hypot(1, HIP_PITCH),
    nh = HIP_PITCH * ny;
  const vtx = (x: number, y: number, z: number, nx: number, nz: number, u: number): number => {
    const i = f.vertex(x, y, z, nx, ny, nz);
    f.patchExtra('aFac', i, u, y);
    return i;
  };
  const poly = (pts: Array<[number, number, number]>, nx: number, nz: number, uAlongX: boolean): void => {
    const ids = pts.map(([x, y, z]) => vtx(x, y, z, nx, nz, uAlongX ? x : z));
    for (let k = 1; k + 1 < ids.length; k++) f.tri(ids[0]!, ids[k]!, ids[k + 1]!);
  };
  // South (+z), north (-z), east (+x), west (-x); counter-clockwise seen from outside.
  const [ax, az] = ra,
    [bx, bz] = rb;
  if (alongX) {
    poly([[X0, yE, Z1], [X1, yE, Z1], [bx, yR, bz], [ax, yR, az]], 0, nh, true);
    poly([[X1, yE, Z0], [X0, yE, Z0], [ax, yR, az], [bx, yR, bz]], 0, -nh, true);
    poly([[X1, yE, Z1], [X1, yE, Z0], [bx, yR, bz]], nh, 0, false);
    poly([[X0, yE, Z0], [X0, yE, Z1], [ax, yR, az]], -nh, 0, false);
  } else {
    poly([[X0, yE, Z1], [X1, yE, Z1], [bx, yR, bz]], 0, nh, true);
    poly([[X1, yE, Z0], [X0, yE, Z0], [ax, yR, az]], 0, -nh, true);
    poly([[X1, yE, Z1], [X1, yE, Z0], [ax, yR, az], [bx, yR, bz]], nh, 0, false);
    poly([[X0, yE, Z0], [X0, yE, Z1], [bx, yR, bz], [ax, yR, az]], -nh, 0, false);
  }
  noWindows(f);
  // Fascia board round the eave and the soffit back to the wall top.
  const yF = yE - 0.14;
  f.setColorArr(mulRGB(trim, 0.85));
  f.box(X0, yF, Z0, X1, yE, Z1, 1 | 2 | 16 | 32);
  f.setColorArr(mulRGB(trim, 0.7));
  f.quad(X0, yF, Z0, X1, yF, Z0, v.maxX, v.maxY, v.minZ, v.minX, v.maxY, v.minZ, 0, -1, 0);
  f.quad(X1, yF, Z1, X0, yF, Z1, v.minX, v.maxY, v.maxZ, v.maxX, v.maxY, v.maxZ, 0, -1, 0);
  f.quad(X0, yF, Z1, X0, yF, Z0, v.minX, v.maxY, v.minZ, v.minX, v.maxY, v.maxZ, 0, -1, 0);
  f.quad(X1, yF, Z0, X1, yF, Z1, v.maxX, v.maxY, v.maxZ, v.maxX, v.maxY, v.minZ, 0, -1, 0);
  // Ridge cap.
  if (Math.hypot(bx - ax, bz - az) > 0.4) {
    f.setColorArr(mulRGB(color, 0.8));
    const h = 0.14;
    if (alongX) f.box(ax - 0.1, yR - 0.06, cz - h, bx + 0.1, yR + 0.12, cz + h, 63 & ~8);
    else f.box(cx - h, yR - 0.06, az - 0.1, cx + h, yR + 0.12, bz + 0.1, 63 & ~8);
  }
}

/** Flat textured sign facing `face` (0 +X, 1 -X, 2 +Z, 3 -Z); `twoSided` adds the back. */
function signQuad(
  S: GeomBuilder,
  x: number,
  z: number,
  y0: number,
  y1: number,
  half: number,
  face: number,
  offset: number,
  rect: [number, number, number, number],
  twoSided: boolean,
  frontFacing = false,
): void {
  const [u, v, w, h] = rect;
  S.setColor(1, 1, 1);
  const emit = (fx: number, fz: number, nx: number, nz: number): void => {
    // Left/right as seen from the front (`frontFacing`: the text starts at the viewer's left and the face winds toward the viewer).
    const k = frontFacing ? -1 : 1;
    const lx = (nz !== 0 ? -nz : 0) * k,
      lz = (nx !== 0 ? nx : 0) * k;
    const ax = fx - lx * half,
      az = fz - lz * half;
    const bx = fx + lx * half,
      bz = fz + lz * half;
    const i0 = S.vertex(ax, y0, az, nx, 0, nz);
    S.patchExtra('aFac', i0, u, v + h);
    const i1 = S.vertex(bx, y0, bz, nx, 0, nz);
    S.patchExtra('aFac', i1, u + w, v + h);
    const i2 = S.vertex(bx, y1, bz, nx, 0, nz);
    S.patchExtra('aFac', i2, u + w, v);
    const i3 = S.vertex(ax, y1, az, nx, 0, nz);
    S.patchExtra('aFac', i3, u, v);
    S.tri(i0, i1, i2);
    S.tri(i0, i2, i3);
  };
  const n: [number, number] = face === 0 ? [1, 0] : face === 1 ? [-1, 0] : face === 2 ? [0, 1] : [0, -1];
  emit(x + n[0] * offset, z + n[1] * offset, n[0], n[1]);
  if (twoSided) emit(x - n[0] * offset, z - n[1] * offset, -n[0], -n[1]);
}

/** Vertical blade sign faces (text runs top to bottom). */
function bladeQuads(S: GeomBuilder, cx: number, cz: number, y0: number, y1: number, hx: number, hz: number, alongX: boolean, rect: [number, number, number, number]): void {
  const [u, v, w, h] = rect;
  S.setColor(1, 1, 1);
  for (const side of [1, -1]) {
    const nx = alongX ? 0 : side,
      nz = alongX ? side : 0;
    const fx = cx + nx * 0.16,
      fz = cz + nz * 0.16;
    const ax = fx - hx,
      az = fz - hz,
      bx = fx + hx,
      bz = fz + hz;
    // Rotate the texture 90 degrees so the text reads downward.
    const i0 = S.vertex(ax, y1, az, nx, 0, nz);
    S.patchExtra('aFac', i0, u, v);
    const i1 = S.vertex(bx, y1, bz, nx, 0, nz);
    S.patchExtra('aFac', i1, u, v + h);
    const i2 = S.vertex(bx, y0, bz, nx, 0, nz);
    S.patchExtra('aFac', i2, u + w, v + h);
    const i3 = S.vertex(ax, y0, az, nx, 0, nz);
    S.patchExtra('aFac', i3, u + w, v);
    if (side > 0 === alongX) {
      S.tri(i0, i2, i1);
      S.tri(i0, i3, i2);
    } else {
      S.tri(i0, i1, i2);
      S.tri(i0, i2, i3);
    }
  }
}
