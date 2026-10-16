import { BufferGeometry, Group, InstancedMesh, Matrix4, Quaternion, Vector3, Color } from 'three';
import { GeomBuilder } from '../../render/geomBuilder';
import { foliageMaterial } from '../../render/materials';
import { Rng } from '../../core/rng';
import { TREE_CYPRESS, TREE_MAPLE, TREE_OAK, TREE_PINE, TREE_PLANE, TREE_POPLAR, TREE_STONEPINE, type Tree } from '../types';

/**
 * Tree species geometry, normalised to a total height of 1 (instance scale =
 * tree height). Proportions match `makeTree` in cityGen (collision trunk +
 * canopy ellipsoid). aSway holds the wind sway weight (0 at the root).
 */
function speciesGeometry(species: number, variant: number, detail: number): BufferGeometry {
  const b = new GeomBuilder([{ name: 'aSway', size: 1 }]);
  const rng = new Rng(1000 + species * 17 + variant);
  const trunk: [number, number, number] =
    species === TREE_PINE ? [0.36, 0.24, 0.16] : species === TREE_POPLAR ? [0.52, 0.46, 0.36] : species === TREE_PLANE ? [0.74, 0.7, 0.58] : species === TREE_STONEPINE ? [0.5, 0.32, 0.22] : [0.4, 0.27, 0.18];
  const sway = (y: number): number => Math.max(0, y - 0.25) * 1.6;
  const tr = 0.022;
  b.setColorArr(trunk);
  const trunkTop = species === TREE_PINE ? 0.6 : species === TREE_POPLAR ? 0.5 : species === TREE_CYPRESS ? 0.3 : species === TREE_STONEPINE ? 0.82 : 0.56;
  // Trunk (normalised radius; instances scale uniformly so radius = 0.022 * H)
  const t0 = b.vertexCount;
  b.cylinder(0, 0, 0, trunkTop, tr * 1.25, tr * 0.7, detail === 0 ? 4 : 6, false);
  for (let i = t0; i < b.vertexCount; i++) b.patchExtra('aSway', i, 0);
  const blob = (cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, col: [number, number, number]): void => {
    b.setColorArr(col);
    const s = b.vertexCount;
    if (detail === 0) b.ellipsoid(cx, cy, cz, rx, ry, rz, 5, 3);
    else b.ellipsoid(cx, cy, cz, rx, ry, rz, 7, 5);
    for (let i = s; i < b.vertexCount; i++) {
      // Height of this vertex for sway weight (approximate from centre).
      b.patchExtra('aSway', i, sway(cy));
    }
  };
  const cone = (y0: number, y1: number, r: number, col: [number, number, number]): void => {
    b.setColorArr(col);
    const s = b.vertexCount;
    b.cylinder(0, 0, y0, y1, r, 0.0, detail === 0 ? 5 : 8, true, rng.range(0, 1));
    for (let i = s; i < b.vertexCount; i++) b.patchExtra('aSway', i, sway((y0 + y1) / 2));
  };
  switch (species) {
    case TREE_OAK: {
      if (detail === 0) {
        blob(0, 0.64, 0, 0.33, 0.26, 0.33, [0.24, 0.55, 0.21]);
        break;
      }
      const greens: Array<[number, number, number]> = [
        [0.2, 0.5, 0.2],
        [0.26, 0.58, 0.22],
        [0.32, 0.64, 0.26],
      ];
      const shift = variant === 1 ? 0.06 : 0;
      blob(0, 0.63, 0, 0.3, 0.22, 0.3, greens[1]!);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + rng.range(-0.3, 0.3);
        blob(Math.cos(a) * 0.17, 0.6 + rng.range(-0.05, 0.08), Math.sin(a) * 0.17, 0.17, 0.14, 0.17, greens[i % 3]!.map((c, k) => c + (k === 0 ? shift : 0)) as [number, number, number]);
      }
      blob(0, 0.8, 0, 0.18, 0.12, 0.18, greens[2]!);
      break;
    }
    case TREE_MAPLE: {
      const palettes: Array<Array<[number, number, number]>> = [
        [
          [0.85, 0.33, 0.14],
          [0.93, 0.5, 0.16],
          [0.78, 0.22, 0.12],
        ],
        [
          [0.95, 0.62, 0.72],
          [0.98, 0.74, 0.8],
          [0.9, 0.52, 0.64],
        ],
        [
          [0.36, 0.64, 0.24],
          [0.44, 0.7, 0.26],
          [0.3, 0.58, 0.22],
        ],
      ];
      const pal = palettes[variant % 3]!;
      blob(0, 0.64, 0, 0.29, 0.2, 0.29, pal[0]!);
      if (detail === 0) {
        blob(0, 0.7, 0, 0.3, 0.2, 0.3, pal[1]!);
        break;
      }
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        blob(Math.cos(a) * 0.16, 0.66, Math.sin(a) * 0.16, 0.16, 0.13, 0.16, pal[(i + 1) % 3]!);
      }
      break;
    }
    case TREE_PINE: {
      const g1: [number, number, number] = [0.12, 0.38, 0.24];
      const g2: [number, number, number] = [0.16, 0.45, 0.28];
      if (detail === 0) {
        cone(0.24, 1.0, 0.22, g1);
        break;
      }
      cone(0.24, 0.56, 0.22, g1);
      cone(0.42, 0.74, 0.18, g2);
      cone(0.6, 0.9, 0.13, g1);
      cone(0.76, 1.0, 0.08, g2);
      break;
    }
    case TREE_PLANE: {
      // Çınar: a broad crown of layered, flattened clumps.
      const greens: Array<[number, number, number]> = [
        [0.28, 0.52, 0.2],
        [0.34, 0.6, 0.24],
        [0.4, 0.66, 0.28],
      ];
      blob(0, 0.6, 0, 0.34, 0.21, 0.34, greens[1]!);
      if (detail === 0) {
        blob(0, 0.76, 0, 0.24, 0.13, 0.24, greens[2]!);
        break;
      }
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + rng.range(-0.25, 0.25);
        blob(Math.cos(a) * 0.21, 0.54 + rng.range(-0.03, 0.06), Math.sin(a) * 0.21, 0.17, 0.13, 0.17, greens[i % 3]!);
      }
      blob(0.05, 0.77, -0.03, 0.21, 0.12, 0.21, greens[2]!);
      blob(-0.04, 0.88, 0.04, 0.12, 0.07, 0.12, greens[0]!);
      break;
    }
    case TREE_CYPRESS: {
      // Servi: a dark green column with a pointed top.
      const g1: [number, number, number] = [0.13, 0.32, 0.17];
      const g2: [number, number, number] = [0.16, 0.37, 0.2];
      if (detail === 0) {
        blob(0, 0.54, 0, 0.1, 0.46, 0.1, g1);
        break;
      }
      blob(0, 0.42, 0, 0.11, 0.32, 0.11, g1);
      blob(0, 0.66, 0, 0.09, 0.26, 0.09, g2);
      cone(0.8, 1.0, 0.06, g1);
      break;
    }
    case TREE_STONEPINE: {
      // Fıstık çamı: a bare trunk under a flat umbrella crown.
      const g1: [number, number, number] = [0.2, 0.4, 0.2];
      const g2: [number, number, number] = [0.26, 0.46, 0.22];
      blob(0, 0.86, 0, 0.35, 0.1, 0.35, g1);
      if (detail === 0) break;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.5;
        blob(Math.cos(a) * 0.17, 0.9, Math.sin(a) * 0.17, 0.18, 0.08, 0.18, i % 2 ? g1 : g2);
      }
      blob(0, 0.94, 0, 0.16, 0.06, 0.16, g2);
      break;
    }
    case TREE_POPLAR: {
      const g1: [number, number, number] = [0.3, 0.55, 0.2];
      const g2: [number, number, number] = [0.4, 0.62, 0.22];
      if (detail === 0) {
        blob(0, 0.66, 0, 0.13, 0.34, 0.13, g1);
        break;
      }
      blob(0, 0.5, 0, 0.13, 0.18, 0.13, g1);
      blob(0, 0.68, 0, 0.12, 0.2, 0.12, g2);
      blob(0, 0.86, 0, 0.08, 0.13, 0.08, g1);
      break;
    }
  }
  return b.build();
}

export interface TreeLodChunk {
  x: number;
  z: number;
  near: InstancedMesh[];
  far: InstancedMesh[];
}

/** Instanced trees, chunked for culling, with a near and a far LOD per chunk. */
export function buildTrees(trees: Tree[], chunk = 320): { group: Group; chunks: TreeLodChunk[]; update: (camX: number, camZ: number) => void } {
  const group = new Group();
  group.name = 'trees';
  const mat = foliageMaterial();
  const geos = new Map<string, BufferGeometry>();
  const key = (t: Tree, i: number): string => {
    const variant = t.species === TREE_MAPLE ? i % 3 : 0;
    return `${t.species}-${variant}`;
  };
  const geo = (k: string, detail: number): BufferGeometry => {
    const gk = `${k}-${detail}`;
    let g = geos.get(gk);
    if (!g) {
      const [sp, v] = k.split('-').map(Number) as [number, number];
      g = speciesGeometry(sp, v, detail);
      geos.set(gk, g);
    }
    return g;
  };
  const buckets = new Map<string, Map<string, Tree[]>>();
  trees.forEach((t, i) => {
    const k = key(t, i);
    const ck = `${Math.floor(t.x / chunk)},${Math.floor(t.z / chunk)}`;
    let byKind = buckets.get(ck);
    if (!byKind) buckets.set(ck, (byKind = new Map()));
    let arr = byKind.get(k);
    if (!arr) byKind.set(k, (arr = []));
    arr.push(t);
  });
  const m = new Matrix4();
  const q = new Quaternion();
  const s = new Vector3();
  const p = new Vector3();
  const up = new Vector3(0, 1, 0);
  const tint = new Color();
  const chunks: TreeLodChunk[] = [];
  for (const [ck, byKind] of buckets) {
    const [cx, cz] = ck.split(',').map(Number) as [number, number];
    const lod: TreeLodChunk = { x: (cx + 0.5) * chunk, z: (cz + 0.5) * chunk, near: [], far: [] };
    for (const [k, list] of byKind) {
      for (const detail of [1, 0]) {
        const mesh = new InstancedMesh(geo(k, detail), mat, list.length);
        list.forEach((t, i) => {
          q.setFromAxisAngle(up, t.rot);
          s.setScalar(t.height);
          p.set(t.x, t.y, t.z);
          m.compose(p, q, s);
          mesh.setMatrixAt(i, m);
          const h = Math.abs(Math.sin(t.x * 12.9898 + t.z * 78.233) * 43758.5453) % 1;
          const kk = 0.88 + h * 0.24;
          tint.setRGB(kk, kk, kk);
          mesh.setColorAt(i, tint);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.castShadow = detail === 1;
        mesh.receiveShadow = true;
        mesh.visible = detail === 1;
        group.add(mesh);
        (detail === 1 ? lod.near : lod.far).push(mesh);
      }
    }
    chunks.push(lod);
  }
  const NEAR = 300;
  const update = (camX: number, camZ: number): void => {
    for (const c of chunks) {
      const d = Math.hypot(c.x - camX, c.z - camZ) - chunk * 0.7;
      const near = d < NEAR;
      for (const mm of c.near) mm.visible = near;
      for (const mm of c.far) mm.visible = !near;
    }
  };
  return { group, chunks, update };
}
