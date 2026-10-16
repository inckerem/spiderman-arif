/**
 * Map ids. Dependency-free on purpose (no DOM, no three.js, no imports), so
 * the multiplayer server can import it from Node to key rooms by map.
 */
export const MAP_IDS = ['manhattan', 'istanbul'] as const;
export type MapId = (typeof MAP_IDS)[number];
export const DEFAULT_MAP: MapId = 'manhattan';
export const isMapId = (v: unknown): v is MapId => typeof v === 'string' && (MAP_IDS as readonly string[]).includes(v);
/** URL query parameter that picks the map (`?harita=istanbul`). */
export const MAP_PARAM = 'harita';
