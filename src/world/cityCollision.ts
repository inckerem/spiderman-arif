import {
  CollisionWorld,
  F_ANCHOR,
  F_BUILDING,
  F_CAMERA,
  F_CANOPY,
  F_CLIMB,
  F_LOW,
  F_PROP,
  F_TREE,
  SURF_CONCRETE,
  SURF_FOLIAGE,
  SURF_GLASS,
  SURF_GRAVEL,
  SURF_METAL,
  SURF_STONE,
  SURF_WOOD,
} from '../physics/collision';
import type { MapDefinition } from '../maps/types';
import {
  D_DOWNTOWN,
  PROP_ANTENNA,
  PROP_BILLBOARD,
  PROP_BLADE_SIGN,
  PROP_HVAC,
  PROP_TANK,
  SP_BENCH,
  SP_BOLLARD,
  SP_CAR,
  SP_FOUNTAIN,
  SP_HYDRANT,
  SP_LAMP,
  SP_PARK_LAMP,
  SP_TRAFFIC_LIGHT,
  SP_TRASH,
  type CityLayout,
} from './types';

/** Water tank geometry shared by collision and rendering. */
export const TANK_LEG_R = 0.16;
export const LAMP_HEIGHT = 7.2;
export const PARK_LAMP_HEIGHT = 4.4;
export const TRAFFIC_LIGHT_HEIGHT = 6.4;
export const BILLBOARD_POST = 2.6;

/** Register every collider of the generated city: buildings, trees and props, then the map's own. */
export function buildCollisionWorld(layout: CityLayout, map: MapDefinition): CollisionWorld {
  const terrain = map.createTerrain(layout);
  const e = map.collisionExtent;
  const w = new CollisionWorld(terrain, e.minX, e.minZ, e.maxX, e.maxZ, 32768);
  const BLD = F_BUILDING | F_ANCHOR | F_CLIMB | F_CAMERA;
  for (const b of layout.buildings) {
    const surf = b.district === D_DOWNTOWN ? SURF_GLASS : SURF_CONCRETE;
    for (const v of b.volumes) w.addBox(v.minX, v.minY, v.minZ, v.maxX, v.maxY, v.maxZ, BLD, surf, b.id);
    for (const p of b.parapets) w.addBox(p.minX, p.minY, p.minZ, p.maxX, p.maxY, p.maxZ, BLD, SURF_STONE, b.id);
    for (const pr of b.props) {
      switch (pr.type) {
        case PROP_HVAC:
          w.addBox(pr.x - pr.sx / 2, pr.y, pr.z - pr.sz / 2, pr.x + pr.sx / 2, pr.y + pr.sy, pr.z + pr.sz / 2, F_PROP | F_ANCHOR | F_CAMERA, SURF_METAL, b.id);
          break;
        case PROP_TANK: {
          const r = pr.sx,
            stand = pr.sz,
            th = pr.sy;
          const lr = r * 0.72;
          for (let i = 0; i < 4; i++) {
            const a = Math.PI / 4 + (i * Math.PI) / 2;
            w.addCylinder(pr.x + Math.cos(a) * lr, pr.z + Math.sin(a) * lr, pr.y, pr.y + stand, TANK_LEG_R, F_PROP | F_ANCHOR, SURF_WOOD, b.id);
          }
          w.addCylinder(pr.x, pr.z, pr.y + stand, pr.y + stand + th + 0.6, r, F_PROP | F_ANCHOR | F_CAMERA, SURF_WOOD, b.id);
          break;
        }
        case PROP_ANTENNA:
          w.addBox(pr.x - 1.1, pr.y, pr.z - 1.1, pr.x + 1.1, pr.y + 1.6, pr.z + 1.1, F_PROP | F_ANCHOR | F_CAMERA, SURF_METAL, b.id);
          w.addCylinder(pr.x, pr.z, pr.y + 1.6, pr.y + pr.sy, pr.sx, F_PROP | F_ANCHOR, SURF_METAL, b.id);
          break;
        case PROP_BILLBOARD: {
          const y0 = pr.y + BILLBOARD_POST,
            y1 = y0 + pr.sy;
          const half = pr.sx / 2;
          if (pr.face <= 1) {
            w.addBox(pr.x - 0.18, y0, pr.z - half, pr.x + 0.18, y1, pr.z + half, F_PROP | F_ANCHOR | F_CAMERA, SURF_METAL, b.id);
            w.addCylinder(pr.x, pr.z - half * 0.7, pr.y, y0, 0.2, F_PROP | F_ANCHOR, SURF_METAL, b.id);
            w.addCylinder(pr.x, pr.z + half * 0.7, pr.y, y0, 0.2, F_PROP | F_ANCHOR, SURF_METAL, b.id);
          } else {
            w.addBox(pr.x - half, y0, pr.z - 0.18, pr.x + half, y1, pr.z + 0.18, F_PROP | F_ANCHOR | F_CAMERA, SURF_METAL, b.id);
            w.addCylinder(pr.x - half * 0.7, pr.z, pr.y, y0, 0.2, F_PROP | F_ANCHOR, SURF_METAL, b.id);
            w.addCylinder(pr.x + half * 0.7, pr.z, pr.y, y0, 0.2, F_PROP | F_ANCHOR, SURF_METAL, b.id);
          }
          break;
        }
        case PROP_BLADE_SIGN: {
          const o = pr.sx;
          const t = pr.sz / 2;
          const half = 0.15;
          void t;
          if (pr.face === 0) w.addBox(pr.x, pr.y, pr.z - half, pr.x + o, pr.y + pr.sy, pr.z + half, F_PROP | F_ANCHOR, SURF_METAL, b.id);
          if (pr.face === 1) w.addBox(pr.x - o, pr.y, pr.z - half, pr.x, pr.y + pr.sy, pr.z + half, F_PROP | F_ANCHOR, SURF_METAL, b.id);
          if (pr.face === 2) w.addBox(pr.x - half, pr.y, pr.z, pr.x + half, pr.y + pr.sy, pr.z + o, F_PROP | F_ANCHOR, SURF_METAL, b.id);
          if (pr.face === 3) w.addBox(pr.x - half, pr.y, pr.z - o, pr.x + half, pr.y + pr.sy, pr.z, F_PROP | F_ANCHOR, SURF_METAL, b.id);
          break;
        }
        default:
          break;
      }
    }
  }
  // Trees: trunk cylinder + canopy ellipsoid, both anchors.
  layout.trees.forEach((t, i) => {
    w.addCylinder(t.x, t.z, t.y, t.trunkTop, t.trunkRadius, F_TREE | F_ANCHOR, SURF_WOOD, 100000 + i);
    w.addEllipsoid(t.x, t.cy, t.z, t.rx, t.ry, t.rx, F_TREE | F_CANOPY | F_ANCHOR | F_CAMERA, SURF_FOLIAGE, 100000 + i);
  });
  // Street props.
  for (const p of layout.props) {
    switch (p.type) {
      case SP_LAMP:
        w.addCylinder(p.x, p.z, p.y, p.y + LAMP_HEIGHT, 0.14, F_PROP | F_ANCHOR, SURF_METAL);
        break;
      case SP_PARK_LAMP:
        w.addCylinder(p.x, p.z, p.y, p.y + PARK_LAMP_HEIGHT, 0.12, F_PROP, SURF_METAL);
        break;
      case SP_TRAFFIC_LIGHT:
        w.addCylinder(p.x, p.z, p.y, p.y + TRAFFIC_LIGHT_HEIGHT, 0.16, F_PROP | F_ANCHOR, SURF_METAL);
        break;
      case SP_HYDRANT:
        w.addCylinder(p.x, p.z, p.y, p.y + 0.78, 0.24, F_PROP | F_LOW, SURF_METAL);
        break;
      case SP_BOLLARD:
        w.addCylinder(p.x, p.z, p.y, p.y + 0.62, 0.24, F_PROP | F_LOW, SURF_METAL);
        break;
      case SP_TRASH:
        w.addCylinder(p.x, p.z, p.y, p.y + 0.95, 0.3, F_PROP | F_LOW, SURF_METAL);
        break;
      case SP_BENCH: {
        const ax = Math.sin(p.rot),
          az = Math.cos(p.rot);
        // Bench length runs perpendicular to its facing direction.
        const lx = az,
          lz = -ax;
        w.addCylinder(p.x + lx * 0.55, p.z + lz * 0.55, p.y, p.y + 0.85, 0.34, F_PROP | F_LOW, SURF_WOOD);
        w.addCylinder(p.x - lx * 0.55, p.z - lz * 0.55, p.y, p.y + 0.85, 0.34, F_PROP | F_LOW, SURF_WOOD);
        break;
      }
      case SP_CAR: {
        const along = Math.abs(Math.sin(p.rot)) > 0.7; // runs along X
        const hl = 2.2,
          hw = 0.9;
        if (along) w.addBox(p.x - hl, p.y, p.z - hw, p.x + hl, p.y + 1.45, p.z + hw, F_PROP | F_LOW | F_CAMERA, SURF_METAL);
        else w.addBox(p.x - hw, p.y, p.z - hl, p.x + hw, p.y + 1.45, p.z + hl, F_PROP | F_LOW | F_CAMERA, SURF_METAL);
        break;
      }
      case SP_FOUNTAIN:
        w.addCylinder(p.x, p.z, p.y, p.y + 0.75, 3.2, F_PROP | F_LOW | F_CAMERA, SURF_STONE);
        w.addCylinder(p.x, p.z, p.y + 0.75, p.y + 2.6, 0.6, F_PROP | F_LOW, SURF_STONE);
        break;
      default:
        break;
    }
  }
  for (const b of layout.parkWalls) w.addBox(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, F_PROP | F_LOW | F_CAMERA, SURF_STONE);
  for (const b of layout.railings) w.addBox(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, F_PROP | F_LOW, SURF_METAL);
  for (const p of layout.piers) w.addBox(p.minX, -4, p.minZ, p.maxX, p.top, p.maxZ, F_PROP | F_CAMERA, SURF_WOOD);
  // Map-specific colliders (bridges, landmarks) come last, as before the map abstraction.
  map.addColliders(w, layout);
  w.build();
  void SURF_GRAVEL;
  return w;
}
