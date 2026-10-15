import type { GeomBuilder } from '../../render/geomBuilder';
import { LAMP_HEIGHT, PARK_LAMP_HEIGHT, TRAFFIC_LIGHT_HEIGHT } from '../cityCollision';
import { SP_BENCH, SP_BOLLARD, SP_CAR, SP_FOUNTAIN, SP_HYDRANT, SP_LAMP, SP_PARK_LAMP, SP_TRAFFIC_LIGHT, SP_TRASH, type StreetProp } from '../types';

const POLE: [number, number, number] = [0.16, 0.2, 0.2];

export const CAR_COLORS: Array<[number, number, number]> = [
  [0.85, 0.16, 0.18],
  [0.98, 0.78, 0.12],
  [0.12, 0.42, 0.78],
  [0.92, 0.92, 0.9],
  [0.14, 0.15, 0.17],
  [0.18, 0.6, 0.45],
  [0.95, 0.5, 0.15],
  [0.55, 0.58, 0.62],
];

/** Car body built around the origin, facing +Z, into builder `b` (then transformed by caller). */
export function carBody(b: GeomBuilder, color: [number, number, number], taxi: boolean): void {
  const [r, g, bl] = color;
  // Lower body
  b.setColor(r, g, bl);
  b.box(-0.9, 0.32, -2.2, 0.9, 0.95, 2.2, 63 & ~8);
  // Cabin
  b.setColor(r * 0.92, g * 0.92, bl * 0.92);
  b.box(-0.78, 0.95, -1.15, 0.78, 1.42, 0.85, 63 & ~8);
  // Windows (dark glass band)
  b.setColor(0.12, 0.16, 0.22);
  b.box(-0.8, 1.0, -1.1, 0.8, 1.36, 0.8, 1 | 2 | 16 | 32);
  // Bumpers
  b.setColor(0.18, 0.18, 0.2);
  b.box(-0.92, 0.3, 2.18, 0.92, 0.55, 2.3, 63 & ~8);
  b.box(-0.92, 0.3, -2.3, 0.92, 0.55, -2.18, 63 & ~8);
  // Wheels
  b.setColor(0.08, 0.08, 0.09);
  for (const wx of [-0.86, 0.86]) {
    for (const wz of [-1.35, 1.35]) {
      const start = b.vertexCount;
      b.cylinder(0, 0, -0.14, 0.14, 0.34, 0.34, 7, true);
      b.transformRange(start, (v, n) => {
        // Rotate the Y-axis cylinder onto the X axis.
        v.set(v.y + wx, v.x + 0.34, v.z + wz);
        n.set(n.y, n.x, n.z);
      });
    }
  }
  if (taxi) {
    b.setColor(0.15, 0.15, 0.16);
    b.box(-0.3, 1.42, -0.2, 0.3, 1.62, 0.2, 63 & ~8);
  }
}

/** Lights of a car (front white, back red) for the emissive builder. */
export function carLights(b: GeomBuilder): void {
  b.setColor(1, 0.95, 0.75);
  b.box(-0.8, 0.62, 2.2, -0.45, 0.8, 2.26, 16);
  b.box(0.45, 0.62, 2.2, 0.8, 0.8, 2.26, 16);
  b.setColor(1, 0.1, 0.08);
  b.box(-0.8, 0.62, -2.26, -0.5, 0.8, -2.2, 32);
  b.box(0.5, 0.62, -2.26, 0.8, 0.8, -2.2, 32);
}

/** Street furniture into the chunk's prop builder `P` and emissive builder `G`. */
export function addStreetProp(p: StreetProp, P: GeomBuilder, G: GeomBuilder): void {
  const s = Math.sin(p.rot),
    c = Math.cos(p.rot);
  switch (p.type) {
    case SP_LAMP: {
      const h = LAMP_HEIGHT;
      P.setColorArr(POLE);
      P.cylinder(p.x, p.z, p.y, p.y + 0.5, 0.24, 0.18, 6);
      P.cylinder(p.x, p.z, p.y + 0.5, p.y + h, 0.14, 0.1, 6, false);
      // Arm reaching over the street (direction rot points away from the block).
      const ax = p.x + s * 1.5,
        az = p.z + c * 1.5;
      const start = P.vertexCount;
      P.box(-0.07, -0.07, 0, 0.07, 0.07, 1.6);
      P.transformRange(start, (v, n) => {
        const x = v.x * c + v.z * s,
          z = -v.x * s + v.z * c;
        v.set(p.x + x, p.y + h + v.y - 0.1, p.z + z);
        n.set(n.x * c + n.z * s, n.y, -n.x * s + n.z * c);
      });
      P.setColor(0.2, 0.22, 0.24);
      P.box(ax - 0.35, p.y + h - 0.35, az - 0.35, ax + 0.35, p.y + h - 0.05, az + 0.35);
      G.setColor(1, 0.86, 0.55);
      G.box(ax - 0.25, p.y + h - 0.45, az - 0.25, ax + 0.25, p.y + h - 0.35, az + 0.25);
      break;
    }
    case SP_PARK_LAMP: {
      const h = PARK_LAMP_HEIGHT;
      P.setColor(0.12, 0.14, 0.13);
      P.cylinder(p.x, p.z, p.y, p.y + h, 0.12, 0.08, 8);
      P.box(p.x - 0.28, p.y + h, p.z - 0.28, p.x + 0.28, p.y + h + 0.12, p.z + 0.28);
      G.setColor(1, 0.88, 0.6);
      G.box(p.x - 0.22, p.y + h - 0.55, p.z - 0.22, p.x + 0.22, p.y + h, p.z + 0.22);
      P.setColor(0.12, 0.14, 0.13);
      P.cylinder(p.x, p.z, p.y + h + 0.12, p.y + h + 0.4, 0.3, 0.02, 8);
      break;
    }
    case SP_TRAFFIC_LIGHT: {
      const h = TRAFFIC_LIGHT_HEIGHT;
      P.setColor(0.2, 0.22, 0.2);
      P.cylinder(p.x, p.z, p.y, p.y + h, 0.16, 0.12, 8);
      const dx = p.variant === 0 ? 1 : -1;
      P.box(Math.min(p.x, p.x + dx * 5), p.y + h - 0.25, p.z - 0.08, Math.max(p.x, p.x + dx * 5), p.y + h - 0.1, p.z + 0.08);
      const hx = p.x + dx * 4.6;
      P.setColor(0.98, 0.78, 0.12);
      P.box(hx - 0.22, p.y + h - 1.5, p.z - 0.2, hx + 0.22, p.y + h - 0.2, p.z + 0.2);
      // Signal lamps (static set; colours set per variant).
      const lit = p.variant === 0 ? 2 : 0;
      for (let i = 0; i < 3; i++) {
        const y = p.y + h - 0.5 - i * 0.38;
        const col: [number, number, number] = i === 0 ? [1, 0.12, 0.08] : i === 1 ? [1, 0.75, 0.1] : [0.2, 1, 0.45];
        if (i === lit) G.setColorArr(col);
        else G.setColor(col[0] * 0.15, col[1] * 0.15, col[2] * 0.15);
        G.box(hx - 0.12, y - 0.13, p.z + 0.2, hx + 0.12, y + 0.13, p.z + 0.24, 16);
        G.box(hx - 0.12, y - 0.13, p.z - 0.24, hx + 0.12, y + 0.13, p.z - 0.2, 32);
      }
      break;
    }
    case SP_HYDRANT:
      P.setColor(0.86, 0.14, 0.12);
      P.cylinder(p.x, p.z, p.y, p.y + 0.62, 0.17, 0.15, 10);
      P.cylinder(p.x, p.z, p.y + 0.62, p.y + 0.78, 0.13, 0.06, 10);
      P.setColor(0.95, 0.85, 0.2);
      P.box(p.x - 0.26, p.y + 0.38, p.z - 0.06, p.x + 0.26, p.y + 0.5, p.z + 0.06);
      break;
    case SP_BOLLARD:
      P.setColor(0.16, 0.17, 0.18);
      P.cylinder(p.x, p.z, p.y, p.y + 0.55, 0.2, 0.18, 8);
      P.cylinder(p.x, p.z, p.y + 0.55, p.y + 0.62, 0.24, 0.24, 8);
      break;
    case SP_TRASH:
      P.setColor(0.13, 0.32, 0.22);
      P.cylinder(p.x, p.z, p.y, p.y + 0.9, 0.27, 0.3, 10);
      P.setColor(0.1, 0.12, 0.12);
      P.cylinder(p.x, p.z, p.y + 0.9, p.y + 0.97, 0.32, 0.3, 10);
      break;
    case SP_BENCH: {
      // Facing direction rot; length runs perpendicular.
      const wood: [number, number, number] = p.variant === 1 ? [0.55, 0.36, 0.2] : [0.48, 0.3, 0.18];
      P.setColorArr(wood);
      P.orientedBox(p.x, p.y + 0.45, p.z, 0.9, 0.05, 0.24, p.rot);
      P.orientedBox(p.x - s * 0.22, p.y + 0.78, p.z - c * 0.22, 0.9, 0.18, 0.04, p.rot);
      P.setColor(0.15, 0.15, 0.16);
      for (const k of [-0.75, 0.75]) {
        const lx = p.x + c * k,
          lz = p.z - s * k;
        P.orientedBox(lx, p.y + 0.22, lz, 0.05, 0.22, 0.22, p.rot);
      }
      break;
    }
    case SP_CAR: {
      const start = P.vertexCount;
      const col = CAR_COLORS[p.variant % CAR_COLORS.length]!;
      carBody(P, col, p.variant === 1);
      P.transformRange(start, (v, n) => {
        const x = v.x * c + v.z * s,
          z = -v.x * s + v.z * c;
        v.set(p.x + x, p.y + v.y, p.z + z);
        n.set(n.x * c + n.z * s, n.y, -n.x * s + n.z * c);
      });
      break;
    }
    case SP_FOUNTAIN: {
      P.setColor(0.66, 0.64, 0.6);
      P.cylinder(p.x, p.z, p.y, p.y + 0.75, 3.2, 3.2, 20);
      P.setColor(0.36, 0.62, 0.78);
      // Water stands 5 cm above the rim cap (1 cm z-fought at a distance).
      P.cylinder(p.x, p.z, p.y + 0.6, p.y + 0.8, 2.9, 2.9, 20, true);
      P.setColor(0.66, 0.64, 0.6);
      P.cylinder(p.x, p.z, p.y + 0.75, p.y + 2.2, 0.6, 0.45, 12);
      P.cylinder(p.x, p.z, p.y + 2.2, p.y + 2.6, 1.3, 1.5, 14);
      P.setColor(0.5, 0.78, 0.92);
      P.cylinder(p.x, p.z, p.y + 2.6, p.y + 3.4, 0.25, 0.05, 8);
      break;
    }
  }
}
