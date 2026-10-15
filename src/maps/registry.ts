import type { MapId } from './ids';
import type { MapDefinition } from './types';
import { MANHATTAN } from './manhattan';
import { ISTANBUL } from './istanbul';

/** Simulation side of every map (generation, terrain, colliders, bot data). */
export const MAPS: Partial<Record<MapId, MapDefinition>> = {
  manhattan: MANHATTAN,
  istanbul: ISTANBUL,
};

/** The definition of a map; unknown or unfinished maps fall back to Manhattan. */
export function getMap(id: MapId): MapDefinition {
  return MAPS[id] ?? MANHATTAN;
}
