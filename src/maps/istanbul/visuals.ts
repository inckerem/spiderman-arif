import { Mesh, PlaneGeometry, Vector4 } from 'three';
import { Rng } from '../../core/rng';
import { GeomBuilder } from '../../render/geomBuilder';
import { waterMaterial } from '../../render/materials';
import { buildHeightfieldGround } from '../../world/render/terrainGeo';
import type { CityLayout } from '../../world/types';
import type { MapVisuals, WaterVisuals } from '../renderTypes';
import { istanbulTerrain } from './gen';
import { istanbulMinimapExtent, paintIstanbulMinimap } from './minimap';

/** The sea: one plane (shore foam comes with the signed-distance water in a later step). */
function buildWater(): WaterVisuals {
  const far = new Vector4(1e6, 1e6, 1e6 + 1, 1e6 + 1);
  const water = waterMaterial(far, far.clone());
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
  buildExtras: () => undefined,
  ground: (L) => buildHeightfieldGround(L, istanbulTerrain(L)),
  water: buildWater,
  backdrop: buildBackdrop,
  minimap: { extent: istanbulMinimapExtent, paint: paintIstanbulMinimap },
};
