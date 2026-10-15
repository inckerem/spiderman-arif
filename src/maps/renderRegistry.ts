import type { MapId } from './ids';
import type { MapVisuals } from './renderTypes';
import { MANHATTAN_VISUALS } from './manhattan/visuals';

/** Render side of every map (landmark geometry, ground, water, backdrop, minimap). */
const VISUALS: Partial<Record<MapId, MapVisuals>> = {
  manhattan: MANHATTAN_VISUALS,
};

export function getMapVisuals(id: MapId): MapVisuals {
  return VISUALS[id] ?? MANHATTAN_VISUALS;
}
