import type { CityLayout, Rect } from '../world/types';
import { clamp } from './dom';

/** Shared minimap palette and painting helpers (the per-map painters live with each map). */

export const TAU = Math.PI * 2;

export const COL = {
  water: '#123d50',
  shore: '#1d5a70',
  ground: '#2c3138',
  plaza: '#3c434c',
  road: '#17191d',
  park: '#3d7a3a',
  parkTree: '#2b5f2a',
  path: '#97b06e',
  pond: '#2f86a6',
  pier: '#77695a',
  bridge: '#cfc5b2',
  bridgeTower: '#f4efe6',
  ink: '#0b0c0e',
  amber: '#ffb020',
  paper: '#f4efe6',
  done: 'rgba(150,158,166,0.55)',
};

/** Building shade by height: low = teal, tall = paper white. */
const B_LOW: [number, number, number] = [62, 112, 120];
const B_HIGH: [number, number, number] = [244, 239, 230];
export interface Extent {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function grow(r: Rect, d: number): Rect {
  return { minX: r.minX - d, maxX: r.maxX + d, minZ: r.minZ - d, maxZ: r.maxZ + d };
}

export function fillRect(g: CanvasRenderingContext2D, r: Rect): void {
  g.fillRect(r.minX, r.minZ, r.maxX - r.minX, r.maxZ - r.minZ);
}

export function strokeRect(g: CanvasRenderingContext2D, r: Rect): void {
  g.strokeRect(r.minX, r.minZ, r.maxX - r.minX, r.maxZ - r.minZ);
}

export function buildingShade(height: number): string {
  const t = Math.pow(clamp((height - 12) / 190, 0, 1), 0.7);
  const c = (i: number): number => Math.round(B_LOW[i]! + (B_HIGH[i]! - B_LOW[i]!) * t);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}

/**
 * Generic painter for maps described by land polygons and road pieces:
 * water, shore band, land, parks with trees, plazas, roads at their width,
 * piers, then buildings low to tall.
 */
export function paintPolygonMinimap(g: CanvasRenderingContext2D, L: CityLayout, e: Extent, px: number): void {
  g.fillStyle = COL.water;
  g.fillRect(e.minX, e.minZ, e.maxX - e.minX, e.maxZ - e.minZ);
  const polys = L.landPolygons ?? [];
  const path = (): void => {
    g.beginPath();
    for (const p of polys) {
      p.forEach(([x, z], i) => (i === 0 ? g.moveTo(x, z) : g.lineTo(x, z)));
      g.closePath();
    }
  };
  // Shallow band along the shores, then the land.
  path();
  g.strokeStyle = COL.shore;
  g.lineJoin = 'round';
  g.lineWidth = 18;
  g.stroke();
  g.fillStyle = COL.ground;
  g.fill();
  g.strokeStyle = COL.ink;
  g.lineWidth = 2.2 * px;
  g.stroke();
  g.fillStyle = COL.park;
  for (const p of L.parks ?? []) fillRect(g, p);
  g.fillStyle = COL.parkTree;
  for (const t of L.trees) {
    if (!t.park) continue;
    g.beginPath();
    g.arc(t.x, t.z, Math.max(2.2, t.rx * 0.72), 0, TAU);
    g.fill();
  }
  g.fillStyle = COL.plaza;
  for (const p of L.plazas) fillRect(g, p);
  g.strokeStyle = COL.road;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const r of L.roads ?? []) {
    if (r.pts.length < 2) continue;
    g.lineWidth = Math.max(r.width, 2.5 * px);
    g.beginPath();
    r.pts.forEach(([x, z], i) => (i === 0 ? g.moveTo(x, z) : g.lineTo(x, z)));
    g.stroke();
  }
  g.lineCap = 'butt';
  g.lineJoin = 'miter';
  g.strokeStyle = COL.ink;
  for (const p of L.piers) {
    g.fillStyle = COL.pier;
    fillRect(g, p);
    g.lineWidth = 1.4 * px;
    strokeRect(g, p);
  }
  const sorted = [...L.buildings].sort((a, b) => a.height - b.height);
  g.lineWidth = 1.1 * px;
  for (const b of sorted) {
    const fp = b.footprint;
    const ground = b.plinth ? b.plinth.minY + 1 : b.volumes[0]!.minY;
    g.fillStyle = buildingShade(b.height - ground);
    fillRect(g, fp);
    g.strokeStyle = COL.ink;
    strokeRect(g, fp);
  }
}
