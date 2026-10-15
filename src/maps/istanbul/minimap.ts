import type { CityLayout } from '../../world/types';
import { COL, TAU, buildingShade, fillRect, strokeRect, type Extent } from '../../ui/minimapPaint';

/** Minimap extent: the hard bounds plus a margin. */
export function istanbulMinimapExtent(L: CityLayout): Extent {
  const b = L.bounds;
  const pad = 60;
  return { minX: b.minX - pad, minZ: b.minZ - pad, maxX: b.maxX + pad, maxZ: b.maxZ + pad };
}

/**
 * Generic painter for maps described by land polygons and road pieces:
 * water, shore band, land, parks with trees, plazas, roads at their width,
 * piers, then buildings low to tall.
 */
export function paintIstanbulMinimap(g: CanvasRenderingContext2D, L: CityLayout, e: Extent, px: number): void {
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
