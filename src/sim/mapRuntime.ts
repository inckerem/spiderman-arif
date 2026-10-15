/**
 * Builds the per-map data rooms share (layout and collision world from the
 * map's fixed online seed). Built once per map and cached; PURE (the same
 * generator code the client runs).
 */
import { generateCity } from '../world/cityGen';
import { buildCollisionWorld } from '../world/cityCollision';
import { MAPS, type MapId } from '../net/maps';
import type { MapRuntime } from './types';

const cache = new Map<MapId, MapRuntime>();

export function buildMapRuntime(id: MapId): MapRuntime {
  const hit = cache.get(id);
  if (hit) return hit;
  const seed = MAPS[id].seed;
  const layout = generateCity(seed);
  const world = buildCollisionWorld(layout);
  const rt: MapRuntime = { id, seed, layout, world };
  cache.set(id, rt);
  return rt;
}
