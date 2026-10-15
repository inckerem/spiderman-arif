import { CircleGeometry, Mesh, PlaneGeometry, Vector4 } from 'three';
import { Rng } from '../../core/rng';
import { GeomBuilder } from '../../render/geomBuilder';
import { waterMaterial } from '../../render/materials';
import { buildGround } from '../../world/render/groundGeo';
import type { CityLayout } from '../../world/types';
import type { ChunkGetter, MapVisuals, WaterVisuals } from '../renderTypes';
import { manhattanMinimapExtent, paintManhattanMinimap } from './minimap';

/** The suspension bridge to the islet, merged into its chunk's prop and glow builders. */
function buildBridge(L: CityLayout, getChunk: ChunkGetter): void {
  const br = L.bridge;
  const c = getChunk(850, 0);
  const P = c.props;
  // Deck top: walkways and road side by side at one height (never stacked, no z-fighting).
  P.setColor(0.6, 0.58, 0.55);
  P.box(br.deck.minX, br.deck.minY, br.deck.minZ, br.deck.maxX, br.deck.maxY, br.deck.maxZ, 63 & ~4);
  P.box(br.deck.minX, br.deck.minY, br.deck.minZ, br.deck.maxX, br.deck.maxY, br.deck.minZ + 1.2, 4);
  P.box(br.deck.minX, br.deck.minY, br.deck.maxZ - 1.2, br.deck.maxX, br.deck.maxY, br.deck.maxZ, 4);
  P.setColor(0.3, 0.31, 0.33);
  P.box(br.deck.minX, br.deck.minY, br.deck.minZ + 1.2, br.deck.maxX, br.deck.maxY, br.deck.maxZ - 1.2, 4);
  P.setColor(0.86, 0.32, 0.22);
  P.box(br.deck.minX, br.deck.maxY, br.deck.minZ, br.deck.maxX, br.deck.maxY + 1.1, br.deck.minZ + 0.3);
  P.box(br.deck.minX, br.deck.maxY, br.deck.maxZ - 0.3, br.deck.maxX, br.deck.maxY + 1.1, br.deck.maxZ);
  // Truss under the deck
  P.setColor(0.7, 0.26, 0.18);
  for (let x = br.deck.minX + 4; x < br.deck.maxX - 2; x += 8) {
    P.box(x - 0.3, br.deck.minY - 2.2, br.deck.minZ, x + 0.3, br.deck.minY, br.deck.maxZ);
  }
  P.box(br.deck.minX, br.deck.minY - 2.4, br.deck.minZ, br.deck.maxX, br.deck.minY - 2.0, br.deck.minZ + 0.6);
  P.box(br.deck.minX, br.deck.minY - 2.4, br.deck.maxZ - 0.6, br.deck.maxX, br.deck.minY - 2.0, br.deck.maxZ);
  P.setColor(0.74, 0.68, 0.6);
  for (const t of br.towers) P.box(t.minX, t.minY, t.minZ, t.maxX, t.maxY, t.maxZ);
  P.setColor(0.7, 0.64, 0.56);
  for (const t of br.beams) P.box(t.minX, t.minY, t.minZ, t.maxX, t.maxY, t.maxZ);
  P.setColor(0.6, 0.55, 0.5);
  for (const t of br.anchorages) P.box(t.minX, t.minY, t.minZ, t.maxX, t.maxY, t.maxZ);
  // Tower caps
  P.setColor(0.86, 0.32, 0.22);
  for (const t of br.towers) P.box(t.minX - 0.4, t.maxY, t.minZ - 0.4, t.maxX + 0.4, t.maxY + 1.2, t.maxZ + 0.4);
  // Main cables (thin segments along the curve on both sides).
  P.setColor(0.86, 0.32, 0.22);
  for (const side of [-1, 1]) {
    const z = side * br.cableZ;
    for (let i = 0; i < br.cable.length - 1; i++) {
      const [x0, y0] = br.cable[i]!;
      const [x1, y1] = br.cable[i + 1]!;
      const len = Math.hypot(x1 - x0, y1 - y0);
      const start = P.vertexCount;
      P.cylinder(0, 0, 0, len, 0.42, 0.42, 6, false);
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const ca = Math.cos(ang - Math.PI / 2),
        sa = Math.sin(ang - Math.PI / 2);
      P.transformRange(start, (v, n) => {
        // Rotate around Z so +Y points along the segment, then translate.
        const vx = v.x * ca - v.y * sa,
          vy = v.x * sa + v.y * ca;
        v.set(x0 + vx, y0 + vy, z + v.z);
        const nx = n.x * ca - n.y * sa,
          ny = n.x * sa + n.y * ca;
        n.set(nx, ny, n.z);
      });
    }
  }
  P.setColor(0.8, 0.8, 0.82);
  for (const s of br.suspenders) P.cylinder(s[0], s[1], s[2], s[3], 0.12, 0.12, 5, false);
  // Navigation lights on the towers.
  c.glow.setColor(1, 0.15, 0.1);
  for (const t of br.towers) c.glow.box((t.minX + t.maxX) / 2 - 0.4, t.maxY + 1.2, (t.minZ + t.maxZ) / 2 - 0.4, (t.minX + t.maxX) / 2 + 0.4, t.maxY + 2, (t.minZ + t.maxZ) / 2 + 0.4);

}

/** The sea plane (land and islet rectangles for the foam) and the park pond. */
function buildWater(L: CityLayout): WaterVisuals {
  const landV = new Vector4(L.land.minX, L.land.minZ, L.land.maxX, L.land.maxZ);
  const isletV = new Vector4(L.islet.minX, L.islet.minZ, L.islet.maxX, L.islet.maxZ);
  const water = waterMaterial(landV, isletV);
  const sea = new Mesh(new PlaneGeometry(9000, 9000, 1, 1), water);
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -1.2;
  sea.name = 'sea';
  const pondMat = waterMaterial(new Vector4(1e6, 1e6, 1e6 + 1, 1e6 + 1), new Vector4(1e6, 1e6, 1e6 + 1, 1e6 + 1));
  (pondMat.uniforms.uPondCenter!.value as Vector4).set(L.pond.cx, L.pond.cz, L.pond.rx, L.pond.rz);
  const pondGeo = new CircleGeometry(1, 64);
  const pond = new Mesh(pondGeo, pondMat);
  pond.rotation.x = -Math.PI / 2;
  pond.scale.set(L.pond.rx, L.pond.rz, 1);
  pond.position.set(L.pond.cx, L.pond.level, L.pond.cz);
  return { meshes: [sea, pond], materials: [water, pondMat] };
}

/** Distant skyline: fogged silhouettes on a ring beyond the water. */
function buildBackdrop(L: CityLayout): GeomBuilder {
  const b = new GeomBuilder();
  const rng = new Rng(L.seed ^ 0xbacd);
  for (let i = 0; i < 260; i++) {
    const a = (i / 260) * Math.PI * 2 + rng.range(-0.01, 0.01);
    // Leave an opening around the islet/bridge view to the east.
    const r = rng.range(1550, 1950);
    const x = Math.cos(a) * r,
      z = Math.sin(a) * r;
    const w = rng.range(30, 80),
      h = rng.chance(0.15) ? rng.range(120, 260) : rng.range(25, 110);
    const k = rng.range(0.85, 1);
    b.setColor(0.42 * k, 0.48 * k, 0.56 * k);
    b.box(x - w / 2, -2, z - w / 2, x + w / 2, h, z + w / 2, 63 & ~8);
  }
  return b;
}

export const MANHATTAN_VISUALS: MapVisuals = {
  buildExtras: buildBridge,
  ground: buildGround,
  water: buildWater,
  backdrop: buildBackdrop,
  minimap: { extent: manhattanMinimapExtent, paint: paintManhattanMinimap },
};
