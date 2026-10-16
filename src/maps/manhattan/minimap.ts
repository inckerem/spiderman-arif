import type { CityLayout } from '../../world/types';
import { COL, TAU, buildingShade, fillRect, grow, strokeRect, type Extent } from '../../ui/minimapPaint';
import type { Rect } from '../../world/types';

export function manhattanMinimapExtent(L: CityLayout): Extent {
  const e: Extent = { minX: L.land.minX, minZ: L.land.minZ, maxX: L.land.maxX, maxZ: L.land.maxZ };
  const add = (r: { minX: number; maxX: number; minZ: number; maxZ: number }): void => {
    e.minX = Math.min(e.minX, r.minX);
    e.maxX = Math.max(e.maxX, r.maxX);
    e.minZ = Math.min(e.minZ, r.minZ);
    e.maxZ = Math.max(e.maxZ, r.maxZ);
  };
  add(L.islet);
  for (const p of L.piers) add(p);
  add(L.bridge.deck);
  for (const a of L.bridge.anchorages) add(a);
  for (const t of L.bridge.towers) add(t);
  const pad = 40;
  return { minX: e.minX - pad, minZ: e.minZ - pad, maxX: e.maxX + pad, maxZ: e.maxZ + pad };
}

/** Paints the static map in world units (x right = east, z down = south). `px` is one base pixel in metres. */
export function paintManhattanMinimap(g: CanvasRenderingContext2D, L: CityLayout, e: Extent, px: number): void {
  g.fillStyle = COL.water;
  g.fillRect(e.minX, e.minZ, e.maxX - e.minX, e.maxZ - e.minZ);

  // Shallow band along the shores.
  g.fillStyle = COL.shore;
  fillRect(g, grow(L.land, 9));
  fillRect(g, grow(L.islet, 9));

  g.strokeStyle = COL.ink;
  g.lineJoin = 'miter';
  for (const p of L.piers) {
    g.fillStyle = COL.pier;
    fillRect(g, p);
    g.lineWidth = 1.4 * px;
    strokeRect(g, p);
  }

  // Island ground and islet.
  g.fillStyle = COL.ground;
  fillRect(g, L.land);
  fillRect(g, L.islet);
  g.lineWidth = 2.2 * px;
  strokeRect(g, L.land);
  strokeRect(g, L.islet);

  // Road grid (inside the waterfront promenade).
  const inner: Rect = {
    minX: L.land.minX + L.promenade,
    maxX: L.land.maxX - L.promenade,
    minZ: L.land.minZ + L.promenade,
    maxZ: L.land.maxZ - L.promenade,
  };
  g.fillStyle = COL.road;
  for (const a of L.avenues) g.fillRect(a.center - a.width / 2, inner.minZ, a.width, inner.maxZ - inner.minZ);
  for (const s of L.streets) g.fillRect(inner.minX, s.center - s.width / 2, inner.maxX - inner.minX, s.width);

  g.fillStyle = COL.plaza;
  for (const p of L.plazas) fillRect(g, p);

  // Park with paths, trees and pond.
  g.fillStyle = COL.park;
  fillRect(g, L.park);
  g.strokeStyle = COL.path;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const path of L.paths) {
    if (path.points.length < 2) continue;
    g.lineWidth = Math.max(path.width, 2.5 * px);
    g.beginPath();
    const first = path.points[0]!;
    g.moveTo(first[0], first[1]);
    for (let i = 1; i < path.points.length; i++) {
      const p = path.points[i]!;
      g.lineTo(p[0], p[1]);
    }
    g.stroke();
  }
  g.fillStyle = COL.parkTree;
  for (const t of L.trees) {
    if (!t.park) continue;
    g.beginPath();
    g.arc(t.x, t.z, Math.max(2.2, t.rx * 0.72), 0, TAU);
    g.fill();
  }
  const pond = L.pond;
  g.fillStyle = COL.pond;
  g.beginPath();
  g.ellipse(pond.cx, pond.cz, pond.rx, pond.rz, 0, 0, TAU);
  g.fill();
  g.strokeStyle = COL.ink;
  g.lineWidth = 1.6 * px;
  g.stroke();
  g.lineJoin = 'miter';
  g.lineCap = 'butt';
  g.lineWidth = 1.8 * px;
  strokeRect(g, L.park);

  // Bridge: anchorages, deck, towers.
  const br = L.bridge;
  g.fillStyle = COL.bridge;
  g.lineWidth = 1.4 * px;
  for (const a of br.anchorages) {
    fillRect(g, a);
    strokeRect(g, a);
  }
  fillRect(g, br.deck);
  strokeRect(g, br.deck);
  g.fillStyle = COL.bridgeTower;
  for (const t of br.towers) {
    fillRect(g, t);
    strokeRect(g, t);
  }

  // Buildings, low to tall so towers sit on top.
  const sorted = [...L.buildings].sort((a, b) => a.height - b.height);
  g.lineWidth = 1.1 * px;
  for (const b of sorted) {
    const fp = b.footprint;
    g.fillStyle = buildingShade(b.height);
    fillRect(g, fp);
    // Setback towers: highlight the top tier for a stepped look.
    const top = b.volumes[b.volumes.length - 1];
    if (top && b.height > 45) {
      const fpArea = (fp.maxX - fp.minX) * (fp.maxZ - fp.minZ);
      const topArea = (top.maxX - top.minX) * (top.maxZ - top.minZ);
      if (topArea < fpArea * 0.82) {
        g.fillStyle = buildingShade(b.height + 70);
        g.fillRect(top.minX, top.minZ, top.maxX - top.minX, top.maxZ - top.minZ);
      }
    }
    g.strokeStyle = COL.ink;
    strokeRect(g, fp);
  }
}
