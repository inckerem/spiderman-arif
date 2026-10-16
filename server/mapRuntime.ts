/**
 * Builds the per-map data rooms share (layout, collision world and combat spawn points from the
 * map's fixed online seed). Built once per map and cached; PURE (the same
 * generator code the client runs). Server only: the client builds these from its own world.
 */
import { getMap } from '../src/maps/registry';
import { buildCollisionWorld } from '../src/world/cityCollision';
import { buildSpawnPoints } from '../src/combat/spawnPoints';
import { MAPS, type MapId } from '../src/net/maps';
import type { MapRuntime } from '../src/sim/types';

const cache = new Map<MapId, MapRuntime>();

export function buildMapRuntime(id: MapId): MapRuntime {
  const hit = cache.get(id);
  if (hit) return hit;
  const seed = MAPS[id].seed;
  const map = getMap(id);
  const layout = map.generate(seed);
  const world = buildCollisionWorld(layout, map);
  const spawns = buildSpawnPoints(layout, world);
  const rt: MapRuntime = { id, seed, layout, world, spawns };
  cache.set(id, rt);
  return rt;
}
