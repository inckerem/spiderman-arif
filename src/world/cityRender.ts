import {
  CanvasTexture,
  CircleGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  PlaneGeometry,
  Vector4,
  type ShaderMaterial,
} from 'three';
import { GeomBuilder } from '../render/geomBuilder';
import { celMaterial, facadeMaterial, glowMaterial, shared, waterMaterial } from '../render/materials';
import { makeSignAtlas, makeWindowAtlas } from '../render/textures';
import { Rng } from '../core/rng';
import { CURB } from '../physics/terrain';
import { addBuildingGeometry, makeChunkBuilders, type ChunkBuilders } from './render/buildingsGeo';
import { addStreetProp } from './render/propsGeo';
import { buildGround } from './render/groundGeo';
import { buildTrees } from './render/treeRender';
import { SP_LAMP, SP_PARK_LAMP, type CityLayout } from './types';

export interface CityVisuals {
  group: Group;
  water: ShaderMaterial[];
  lampPools: MeshBasicMaterial;
  stats: { chunks: number; meshes: number; triangles: number };
  /** Per-frame LOD update (camera position). */
  updateLod: (camX: number, camZ: number) => void;
}

const CHUNK = 240;

function radialTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  return t;
}

/** Build every static visual of the city from the layout. */
/** Yield to the browser so the loading screen can paint between build steps. */
function yieldTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function buildCityVisuals(L: CityLayout, onProgress?: (f: number) => void): Promise<CityVisuals> {
  let lastYield = performance.now();
  const step = async (f: number): Promise<void> => {
    if (performance.now() - lastYield < 30) return;
    onProgress?.(f);
    await yieldTask();
    lastYield = performance.now();
  };
  const group = new Group();
  group.name = 'city';
  shared.uWinAtlas.value = makeWindowAtlas();
  const signAtlas = makeSignAtlas();
  shared.uSignAtlas.value = signAtlas.texture;
  const matFacade = facadeMaterial();
  let triangles = 0;
  let meshes = 0;

  // --- Chunked buildings, roof props, street props, signs, bulbs ---
  const chunks = new Map<string, ChunkBuilders>();
  const getChunk = (x: number, z: number): ChunkBuilders => {
    const k = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let c = chunks.get(k);
    if (!c) {
      c = makeChunkBuilders();
      chunks.set(k, c);
    }
    return c;
  };
  for (let i = 0; i < L.buildings.length; i++) {
    const b = L.buildings[i]!;
    const fp = b.footprint;
    addBuildingGeometry(b, getChunk((fp.minX + fp.maxX) / 2, (fp.minZ + fp.maxZ) / 2), signAtlas.signRect, signAtlas.boardRect);
    await step((i / L.buildings.length) * 0.6);
  }
  for (const p of L.props) {
    const c = getChunk(p.x, p.z);
    addStreetProp(p, c.props, c.glow);
  }
  // Bridge into its own chunk builders.
  {
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
  for (const c of chunks.values()) {
    const add = (b: GeomBuilder, mat: MeshToonMaterial, shadows: boolean): void => {
      if (b.vertexCount === 0) return;
      const geo = b.build();
      const mesh = new Mesh(geo, mat);
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
      meshes++;
      triangles += b.triangleCount;
    };
    add(c.facade, matFacade, true);
    await step(0.6 + (meshes / Math.max(1, chunks.size)) * 0.1);
  }
  onProgress?.(0.7);
  await step(0.7);

  // --- Ground ---
  const gnd = buildGround(L);
  {
    const gm = new Mesh(gnd.ground.build(), celMaterial({ vertexColors: true, key: 'ground' }));
    gm.receiveShadow = true;
    gm.matrixAutoUpdate = false;
    group.add(gm);
    const dm = celMaterial({ vertexColors: true, key: 'decals' });
    dm.polygonOffset = true;
    dm.polygonOffsetFactor = -2;
    dm.polygonOffsetUnits = -4;
    const decals = new Mesh(gnd.decals.build(), dm);
    decals.receiveShadow = true;
    decals.matrixAutoUpdate = false;
    decals.renderOrder = 1;
    group.add(decals);
    meshes += 2;
    triangles += gnd.ground.triangleCount + gnd.decals.triangleCount;
  }
  onProgress?.(0.8);
  await step(0.8);

  // --- Water: big plane + pond ---
  const landV = new Vector4(L.land.minX, L.land.minZ, L.land.maxX, L.land.maxZ);
  const isletV = new Vector4(L.islet.minX, L.islet.minZ, L.islet.maxX, L.islet.maxZ);
  const water = waterMaterial(landV, isletV);
  const sea = new Mesh(new PlaneGeometry(9000, 9000, 1, 1), water);
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -1.2;
  sea.name = 'sea';
  group.add(sea);
  const pondMat = waterMaterial(new Vector4(1e6, 1e6, 1e6 + 1, 1e6 + 1), new Vector4(1e6, 1e6, 1e6 + 1, 1e6 + 1));
  (pondMat.uniforms.uPondCenter!.value as Vector4).set(L.pond.cx, L.pond.cz, L.pond.rx, L.pond.rz);
  const pondGeo = new CircleGeometry(1, 64);
  const pond = new Mesh(pondGeo, pondMat);
  pond.rotation.x = -Math.PI / 2;
  pond.scale.set(L.pond.rx, L.pond.rz, 1);
  pond.position.set(L.pond.cx, L.pond.level, L.pond.cz);
  group.add(pond);
  meshes += 2;

  // --- Trees ---
  const trees = buildTrees(L.trees);
  group.add(trees.group);
  meshes += trees.group.children.length;
  onProgress?.(0.9);
  await step(0.9);

  // --- Lamp light pools (night) ---
  const lamps = L.props.filter((p) => p.type === SP_LAMP || p.type === SP_PARK_LAMP);
  const poolMat = glowMaterial(radialTexture(), 0xffd79a, 'pools');
  poolMat.opacity = 0;
  const pools = new InstancedMesh(new PlaneGeometry(1, 1), poolMat, lamps.length);
  const m = new Matrix4();
  const scaleM = new Matrix4();
  lamps.forEach((p, i) => {
    const isPark = p.type === SP_PARK_LAMP;
    const r = isPark ? 9 : 14;
    const off = isPark ? 0 : 1.5;
    const x = p.x + Math.sin(p.rot) * off,
      z = p.z + Math.cos(p.rot) * off;
    const y = (isPark ? CURB : 0) + 0.05 + (isPark ? 0.03 : 0.0);
    m.makeRotationX(-Math.PI / 2);
    m.premultiply(scaleM.makeScale(r, 1, r));
    m.setPosition(x, Math.max(y, CURB + 0.06), z);
    pools.setMatrixAt(i, m);
  });
  pools.instanceMatrix.needsUpdate = true;
  pools.computeBoundingSphere();
  pools.renderOrder = 5;
  pools.name = 'lampPools';
  group.add(pools);
  meshes++;

  // --- Distant skyline backdrop (fogged silhouettes beyond the water) ---
  {
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
    const back = new Mesh(b.build(), celMaterial({ vertexColors: true, key: 'backdrop' }));
    back.matrixAutoUpdate = false;
    back.name = 'backdrop';
    group.add(back);
    meshes++;
    triangles += b.triangleCount;
  }
  onProgress?.(1);
  return {
    group,
    water: [water, pondMat],
    lampPools: poolMat,
    stats: { chunks: chunks.size, meshes, triangles },
    updateLod: trees.update,
  };
}
