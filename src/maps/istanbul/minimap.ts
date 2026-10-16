import type { CityLayout } from '../../world/types';
import { COL, TAU, paintPolygonMinimap, type Extent } from '../../ui/minimapPaint';
import { F_BRIDGE } from '../../physics/collision';
import { PART_BOX, PART_CYL, PART_ELL } from '../common/prims';
import { istanbulParts } from './gen';

/** Minimap extent: the hard bounds plus a margin. */
export function istanbulMinimapExtent(L: CityLayout): Extent {
  const b = L.bounds;
  const pad = 60;
  return { minX: b.minX - pad, minZ: b.minZ - pad, maxX: b.maxX + pad, maxZ: b.maxZ + pad };
}

/**
 * The generic polygon map, then the landmark glyphs from the landmark parts:
 * bridge decks, halls and towers as stone shapes, domes as lead circles and
 * minarets as dots.
 */
export function paintIstanbulMinimap(g: CanvasRenderingContext2D, L: CityLayout, e: Extent, px: number): void {
  paintPolygonMinimap(g, L, e, px);
  const parts = istanbulParts(L);
  g.lineWidth = 1.1 * px;
  g.strokeStyle = COL.ink;
  for (const p of parts) {
    if (p.noDraw || p.noCollide) continue;
    if (p.k === PART_BOX) {
      const deck = (p.flags & F_BRIDGE) !== 0;
      if ((!deck && p.e - p.b < 2.5) || Math.min(p.d - p.a, p.f - p.c) < 2) continue;
      g.fillStyle = deck ? COL.bridge : '#d8cfbd';
      g.fillRect(p.a, p.c, p.d - p.a, p.f - p.c);
      g.strokeRect(p.a, p.c, p.d - p.a, p.f - p.c);
    }
  }
  for (const p of parts) {
    if (p.noDraw || p.noCollide) continue;
    if (p.k === PART_ELL && p.d >= 4) {
      g.fillStyle = '#8d9499';
      g.beginPath();
      g.arc(p.a, p.c, p.d, 0, TAU);
      g.fill();
      g.stroke();
    } else if (p.k === PART_CYL && p.e >= 1 && p.e <= 2.5 && p.d - p.b > 20) {
      g.fillStyle = COL.paper;
      g.beginPath();
      g.arc(p.a, p.c, Math.max(2.4, p.e * 1.4), 0, TAU);
      g.fill();
      g.stroke();
    }
  }
}
