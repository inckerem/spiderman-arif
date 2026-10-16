import { ClampToEdgeWrapping, Color, DataTexture, LinearFilter, Mesh, PlaneGeometry, RedFormat, UnsignedByteType, Vector4 } from 'three';
import { edt2d } from '../../core/edt';
import { IST_EXTENT } from './data';
import { Rng } from '../../core/rng';
import { GeomBuilder } from '../../render/geomBuilder';
import { waterMaterial } from '../../render/materials';
import { buildHeightfieldGround } from '../../world/render/terrainGeo';
import type { CityLayout } from '../../world/types';
import type { MapVisuals, WaterVisuals } from '../renderTypes';
import { istanbulParts, istanbulTerrain } from './gen';
import { drawParts } from '../common/partsGeo';
import { istanbulMinimapExtent, paintIstanbulMinimap } from './minimap';
import { tr } from '../../i18n/tr';

/** Shore distance texture size (texels per side, about 2.1 m each over the map extent). */
const SDF_SIZE = 1024;
/** Bosphorus teal against the day-night palette's sea blue (deep 0x1d5a78, shallow 0x3a9aa8). */
const ISTANBUL_TINT = new Color(0.7, 0.78, 0.66);

/**
 * Distance from the water to the nearest land over the map extent, as a
 * red-channel texture (metres / 16): an exact distance transform of the
 * rasterised land polygons, so the foam follows every quay and cape.
 */
function shoreTexture(L: CityLayout): DataTexture {
  const mask = istanbulTerrain(L).water;
  const E = IST_EXTENT;
  const n = SDF_SIZE;
  const sx = (E.maxX - E.minX) / n,
    sz = (E.maxZ - E.minZ) / n;
  const f = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = E.minZ + (j + 0.5) * sz;
    for (let i = 0; i < n; i++) f[j * n + i] = mask.isWater(E.minX + (i + 0.5) * sx, z) ? 1e20 : 0;
  }
  edt2d(f, n, n);
  const data = new Uint8Array(n * n);
  const texel = (sx + sz) / 2;
  for (let k = 0; k < f.length; k++) data[k] = Math.min(255, Math.round(((Math.sqrt(f[k]!) * texel) / 16) * 255));
  const tex = new DataTexture(data, n, n, RedFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** The sea: one plane with foam along the shore distance field and the Bosphorus tint. */
function buildWater(L: CityLayout): WaterVisuals {
  const far = new Vector4(1e6, 1e6, 1e6 + 1, 1e6 + 1);
  const E = IST_EXTENT;
  const water = waterMaterial(far, far.clone(), { texture: shoreTexture(L), extent: new Vector4(E.minX, E.minZ, E.maxX, E.maxZ), tint: ISTANBUL_TINT });
  const sea = new Mesh(new PlaneGeometry(9000, 9000, 1, 1), water);
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -1.2;
  sea.name = 'sea';
  return { meshes: [sea], materials: [water] };
}

/** Hills with low roofs and a few minaret silhouettes beyond the water. */
function buildBackdrop(L: CityLayout): GeomBuilder {
  const b = new GeomBuilder();
  const rng = new Rng(L.seed ^ 0x157b);
  const cx = 110,
    cz = -50;
  for (let i = 0; i < 220; i++) {
    const a = (i / 220) * Math.PI * 2 + rng.range(-0.01, 0.01);
    const r = rng.range(1500, 1900);
    const x = cx + Math.cos(a) * r,
      z = cz + Math.sin(a) * r;
    const w = rng.range(40, 110),
      h = rng.range(18, 60);
    const k = rng.range(0.85, 1);
    b.setColor(0.5 * k, 0.53 * k, 0.58 * k);
    b.box(x - w / 2, -2, z - w / 2, x + w / 2, h, z + w / 2, 63 & ~8);
    if (rng.chance(0.12)) b.box(x - 1.2, h, z - 1.2, x + 1.2, h + rng.range(30, 50), z + 1.2, 63 & ~8);
  }
  return b;
}

export const ISTANBUL_VISUALS: MapVisuals = {
  buildExtras: (L, getChunk) => drawParts(istanbulParts(L), getChunk),
  ground: (L) => buildHeightfieldGround(L, istanbulTerrain(L)),
  water: buildWater,
  backdrop: buildBackdrop,
  windowAtlas: 'istanbul',
  signNames: tr.signsIstanbul,
  minimap: { extent: istanbulMinimapExtent, paint: paintIstanbulMinimap },
};
