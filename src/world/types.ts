/** Plain-data description of the generated city. Rendering and physics are built from it. */

import type { MapId } from '../maps/ids';

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Road {
  center: number;
  width: number;
  /** Waterfront drive around the island edge. */
  perimeter: boolean;
}

export const D_LOW = 0;
export const D_MID = 1;
export const D_DOWNTOWN = 2;
export const D_WATERFRONT = 3;
export type District = 0 | 1 | 2 | 3;

export interface Block extends Rect {
  id: number;
  district: District;
  /** 0 = plain, 1 = has plaza. */
  hasPlaza: boolean;
}

export interface Volume {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** 0 base/podium, 1 body, 2 crown */
  role: 0 | 1 | 2;
}

export interface BoxSpec {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface FacadeStyle {
  /** Index into the window atlas (0..7). */
  window: number;
  floorHeight: number;
  bayWidth: number;
  /** Base wall colour (linear RGB 0-1). */
  wall: [number, number, number];
  /** Trim colour for cornices and pilasters. */
  trim: [number, number, number];
  /** Glass tint. */
  glass: [number, number, number];
  /** Storefront band height (0 = none). */
  storefront: number;
  /** Chance a window is lit at night. */
  litRatio: number;
  pilasters: boolean;
  /**
   * District look (Istanbul, M13): 1 Ottoman wooden house (clapboard, wide
   * eaves), 2 Beyoğlu apartment (ornate cornice, string courses), 3 stone
   * han or warehouse (rusticated ground floor), 4 glass tower. Absent: the
   * plain facade (Manhattan).
   */
  look?: number;
}

export const LOOK_WOODEN = 1;
export const LOOK_APARTMENT = 2;
export const LOOK_STONE = 3;
export const LOOK_GLASS = 4;

export const PROP_HVAC = 0;
export const PROP_TANK = 1;
export const PROP_ANTENNA = 2;
export const PROP_HELIPAD = 3;
export const PROP_BILLBOARD = 4;
export const PROP_BLADE_SIGN = 5;
export const PROP_WALL_SIGN = 6;
export const PROP_SPIRE_TOP = 7;
/** Solar water heater (Istanbul terraces): a tilted collector with a lying tank behind it. */
export const PROP_SOLAR = 8;
/** Plastic roof water tank (Istanbul terraces): a white upright cylinder. */
export const PROP_ROOF_TANK = 9;

export interface RoofProp {
  type: number;
  x: number;
  y: number;
  z: number;
  /** Size: width (x), height (y), depth (z), or radius for round props. */
  sx: number;
  sy: number;
  sz: number;
  /** Facing for signs: 0 +X, 1 -X, 2 +Z, 3 -Z. */
  face: number;
  /** Sign text index / colour variant. */
  variant: number;
}

export interface Building {
  id: number;
  district: District;
  volumes: Volume[];
  parapets: BoxSpec[];
  props: RoofProp[];
  style: FacadeStyle;
  height: number;
  /** Footprint of the ground volume. */
  footprint: Rect;
  seed: number;
  /** Stone plinth under a building on a slope (from below the low side up to the floor). */
  plinth?: BoxSpec;
  /**
   * Hip roof of clay tiles over the top volume (Istanbul): four planes at
   * `HIP_PITCH` rising from `HIP_LIFT` above the wall top, with a
   * `HIP_EAVE` overhang. `roofSteps` are its colliders (stepped boxes,
   * within 0.3 m of the planes; not anchors).
   */
  hipRoof?: { color: [number, number, number] };
  roofSteps?: BoxSpec[];
  /** Cumba bay windows: closed boxes projecting from the upper floors (colliders too). */
  bays?: BoxSpec[];
}

/** Hip roof geometry shared by the generator (step colliders) and the renderer (tile planes). */
export const HIP_PITCH = 0.4;
export const HIP_LIFT = 0.3;
export const HIP_EAVE = 0.3;
/** Step colliders: 0.6 m tall, each inset 1.5 m (= HIP_PITCH), so the planes pass through the middle of each step. */
export const HIP_STEP_H = 0.6;

export const TREE_OAK = 0;
export const TREE_PINE = 1;
export const TREE_POPLAR = 2;
export const TREE_MAPLE = 3;
/** Plane tree (çınar): broad layered canopy (Istanbul). */
export const TREE_PLANE = 4;
/** Cypress (servi): columnar. */
export const TREE_CYPRESS = 5;
/** Stone pine (fıstık çamı): tall bare trunk under a flat umbrella. */
export const TREE_STONEPINE = 6;

export interface Tree {
  species: number;
  x: number;
  z: number;
  /** Ground height at the trunk base. */
  y: number;
  height: number;
  trunkRadius: number;
  /** Trunk collider top. */
  trunkTop: number;
  /** Canopy collision ellipsoid. */
  cy: number;
  rx: number;
  ry: number;
  /** Visual scale factor and rotation. */
  scale: number;
  rot: number;
  park: boolean;
}

export const SP_LAMP = 0;
export const SP_HYDRANT = 1;
export const SP_BENCH = 2;
export const SP_CAR = 3;
export const SP_TRAFFIC_LIGHT = 4;
export const SP_PARK_LAMP = 5;
export const SP_FOUNTAIN = 6;
export const SP_BOLLARD = 7;
export const SP_TRASH = 8;

export interface StreetProp {
  type: number;
  x: number;
  y: number;
  z: number;
  /** Rotation around Y. */
  rot: number;
  variant: number;
}

export interface Pier extends Rect {
  top: number;
}

export interface PathPolyline {
  points: Array<[number, number]>;
  width: number;
}

export interface BridgeSpec {
  /** Deck extents. */
  deck: BoxSpec;
  towers: BoxSpec[];
  beams: BoxSpec[];
  anchorages: BoxSpec[];
  /** Suspender cable positions (x, z, bottom, top). */
  suspenders: Array<[number, number, number, number]>;
  /** Main cable curve samples per side: [x, y] with z = ±cableZ. */
  cable: Array<[number, number]>;
  cableZ: number;
}

export interface CityLayout {
  /** Map this layout belongs to (src/maps/ids.ts). */
  mapId: MapId;
  seed: number;
  land: Rect;
  islet: Rect;
  promenade: number;
  avenues: Road[];
  streets: Road[];
  park: Rect;
  pond: { cx: number; cz: number; rx: number; rz: number; level: number };
  paths: PathPolyline[];
  blocks: Block[];
  plazas: Rect[];
  buildings: Building[];
  trees: Tree[];
  props: StreetProp[];
  parkWalls: BoxSpec[];
  railings: BoxSpec[];
  piers: Pier[];
  bridge: BridgeSpec;
  /** World hard bounds for the player. */
  bounds: Rect;
  /** Spawn point on a sidewalk. */
  spawn: [number, number, number];
  stats: { buildings: number; parkTrees: number; streetTrees: number; maxHeight: number };
  /** Sidewalk width between the curb and the building fronts (m); 5 when absent (Manhattan). */
  sidewalk?: number;
  /** Maps without a street grid: road centre lines with widths (Istanbul). */
  roads?: RoadPiece[];
  /** Land polygons (water is everything outside them). */
  landPolygons?: Array<Array<[number, number]>>;
  /** Park rectangles (grass), all maps without a single central park. */
  parks?: Rect[];
  /** Reserved landmark footprints (paved; landmark geometry stands there). */
  landmarks?: Array<{ id: string; rect: Rect }>;
}

/** A road centre polyline with its full width and class (0 lane, 1 street, 2 arterial, 3 coastal). */
export interface RoadPiece {
  pts: Array<[number, number]>;
  width: number;
  cls: 0 | 1 | 2 | 3;
  cars: boolean;
}
