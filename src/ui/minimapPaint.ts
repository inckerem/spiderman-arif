import type { Rect } from '../world/types';
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

