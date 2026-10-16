import {
  CanvasTexture,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  PlaneGeometry,
  type ShaderMaterial,
} from 'three';
import { GeomBuilder } from '../render/geomBuilder';
import { celMaterial, facadeMaterial, glowMaterial, shared } from '../render/materials';
import { makeSignAtlas, makeWindowAtlas } from '../render/textures';
import { CURB } from '../physics/terrain';
import { addBuildingGeometry, makeChunkBuilders, type ChunkBuilders } from './render/buildingsGeo';
import { addStreetProp } from './render/propsGeo';
import type { MapVisuals } from '../maps/renderTypes';
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

export async function buildCityVisuals(L: CityLayout, visuals: MapVisuals, onProgress?: (f: number) => void): Promise<CityVisuals> {
  let lastYield = performance.now();
  const step = async (f: number): Promise<void> => {
    if (performance.now() - lastYield < 30) return;
    onProgress?.(f);
    await yieldTask();
    lastYield = performance.now();
  };
  const group = new Group();
  group.name = 'city';
  shared.uWinAtlas.value = makeWindowAtlas(visuals.windowAtlas);
  const signAtlas = makeSignAtlas(visuals.signNames);
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
  // Map-specific static geometry (bridges, landmarks) into the chunk builders.
  visuals.buildExtras(L, getChunk);
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
  const gnd = visuals.ground(L);
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

  // --- Water (the map's sea and ponds) ---
  const water = visuals.water(L);
  for (const m of water.meshes) group.add(m);
  meshes += water.meshes.length;

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
    // Street lamps stand on the curb: the pool lies on the road level below.
    const y = p.y - CURB + (isPark ? CURB : 0) + 0.05 + (isPark ? 0.03 : 0.0);
    m.makeRotationX(-Math.PI / 2);
    m.premultiply(scaleM.makeScale(r, 1, r));
    m.setPosition(x, Math.max(y, p.y + 0.06), z);
    pools.setMatrixAt(i, m);
  });
  pools.instanceMatrix.needsUpdate = true;
  pools.computeBoundingSphere();
  pools.renderOrder = 5;
  pools.name = 'lampPools';
  group.add(pools);
  meshes++;

  // --- Distant backdrop (fogged silhouettes beyond the water) ---
  {
    const b = visuals.backdrop(L);
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
    water: water.materials,
    lampPools: poolMat,
    stats: { chunks: chunks.size, meshes, triangles },
    updateLod: trees.update,
  };
}
