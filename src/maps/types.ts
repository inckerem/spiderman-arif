import type { Rng } from '../core/rng';
import type { CollisionWorld } from '../physics/collision';
import type { TerrainModel } from '../physics/terrain';
import type { CityLayout, Rect } from '../world/types';
import type { MapId } from './ids';

/**
 * Simulation side of a map: generation, terrain, extra colliders and the
 * map-specific data the bots, rings and tests need. No rendering imports,
 * so the simulation (and a future server) can build a map headless.
 */

export type XZ = [number, number];

/** Autopilot waypoint kinds. */
export const WP_ROOF = 0;
export const WP_PARK = 1;
export const WP_WATERFRONT = 2;

export interface Waypoint {
  x: number;
  z: number;
  kind: number;
  /** Building id for roofs, -1 otherwise. */
  building: number;
  /** Roof height (roofs only). */
  roofY: number;
}

/** Ring route ids; Istanbul routes carry an `ist-` prefix so stored best times never mix. */
export type RingRouteId = 'park' | 'downtown' | 'waterfront' | 'ist-minare' | 'ist-halic' | 'ist-bogaz';

export interface RingRouteSpec {
  id: RingRouteId;
  /** Wanted ring centres; the ring placer searches a clear spot near each. */
  pts: Array<[number, number, number]>;
}

export interface MapDefinition {
  id: MapId;
  /** Seed used when the URL has none. */
  defaultSeed: number;
  /** Collision grid extent. */
  collisionExtent: Rect;
  /** Pure data: the whole city layout. */
  generate(seed: number): CityLayout;
  createTerrain(layout: CityLayout): TerrainModel;
  /** Map-specific colliders (bridges, landmarks), added after the generic buildings, trees and props. */
  addColliders(w: CollisionWorld, layout: CityLayout): void;
  /** Random test positions (x, y, z) before the safe-spot search: street level and park. */
  testSpots: {
    street(rng: Rng, L: CityLayout, t: TerrainModel): [number, number, number];
    park(rng: Rng, L: CityLayout): [number, number, number];
  };
  /** Traversal bot routes (test d). */
  routes: {
    city(L: CityLayout): XZ[];
    park(L: CityLayout): XZ[];
    expect: { minDistance: number; treeOnlyPark: boolean };
  };
  autopilot: {
    waypoints(L: CityLayout, t: TerrainModel): Waypoint[];
    /**
     * Route of a leg from (ax, az) to (bx, bz) into `out` (preallocated
     * points); `variant` picks between two shapes. Returns the point count.
     */
    route(L: CityLayout, ax: number, az: number, bx: number, bz: number, variant: boolean, out: XZ[]): number;
    /** Whether a goal at (bx, bz) may be picked from (ax, az); absent = any. */
    goalOk?(L: CityLayout, ax: number, az: number, bx: number, bz: number): boolean;
  };
  ringRoutes(L: CityLayout): RingRouteSpec[];
}
