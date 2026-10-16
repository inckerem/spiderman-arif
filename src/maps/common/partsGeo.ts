import type { GeomBuilder } from '../../render/geomBuilder';
import type { ChunkGetter } from '../renderTypes';
import { PART_BOX, PART_CYL, PART_ELL, PART_TUBE, type Part } from './prims';

/** Greybox geometry of landmark parts, merged into the prop builder of each part's chunk. */
export function drawParts(parts: readonly Part[], getChunk: ChunkGetter): void {
  for (const p of parts) {
    if (p.noDraw) continue;
    const cx = p.k === PART_BOX ? (p.a + p.d) / 2 : p.k === PART_TUBE ? (p.a + p.d) / 2 : p.a;
    const cz = p.k === PART_BOX ? (p.c + p.f) / 2 : p.k === PART_TUBE ? (p.c + p.f) / 2 : p.c;
    const g = getChunk(cx, cz).props;
    g.setColor(((p.color >> 16) & 255) / 255, ((p.color >> 8) & 255) / 255, (p.color & 255) / 255);
    if (p.k === PART_BOX) g.box(p.a, p.b, p.c, p.d, p.e, p.f, p.faces ?? 63 & ~8);
    else if (p.k === PART_CYL) g.cylinder(p.a, p.c, p.b, p.d, p.e, p.f, p.segs ?? 12, true);
    else if (p.k === PART_ELL) g.ellipsoid(p.a, p.b, p.c, p.d, p.e, p.f, 24, 10);
    else if (p.k === PART_TUBE) tube(g, p.a, p.b, p.c, p.d, p.e, p.f, p.r ?? 0.3);
  }
}

/** A cylinder from one point to another (cables, stays). */
function tube(g: GeomBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number): void {
  const dx = x1 - x0,
    dy = y1 - y0,
    dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return;
  const start = g.vertexCount;
  g.cylinder(0, 0, 0, len, r, r, 6, false);
  // Rotate +Y onto the segment direction (Rodrigues), then translate.
  const ux = dx / len,
    uy = dy / len,
    uz = dz / len;
  // Axis = Y x u, angle = acos(u.y).
  let ax = uz,
    az = -ux;
  const s = Math.hypot(ax, az);
  const c = uy;
  if (s < 1e-6) {
    ax = 1;
    az = 0;
  } else {
    ax /= s;
    az /= s;
  }
  const rot = (v: { x: number; y: number; z: number }): void => {
    // Rodrigues with axis (ax, 0, az).
    const kx = ax,
      kz = az;
    const kv = kx * v.x + kz * v.z;
    const cx = -kz * v.y,
      cy = kz * v.x - kx * v.z,
      cz = kx * v.y;
    const nx = v.x * c + cx * s + kx * kv * (1 - c);
    const ny = v.y * c + cy * s;
    const nz = v.z * c + cz * s + kz * kv * (1 - c);
    v.x = nx;
    v.y = ny;
    v.z = nz;
  };
  g.transformRange(start, (v, n) => {
    rot(v);
    v.x += x0;
    v.y += y0;
    v.z += z0;
    rot(n);
  });
}
