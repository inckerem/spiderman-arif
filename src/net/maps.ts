/**
 * Map table shared by the client, the Room and the server. Online play always
 * uses the map's fixed seed (`?seed` only changes single player), so every
 * client and the server generate the same city.
 */
export type MapId = 'manhattan'; // M13 adds 'istanbul'

export interface MapDef {
  readonly id: MapId;
  /** City generator seed used online. */
  readonly seed: number;
}

export const MAPS: Readonly<Record<MapId, MapDef>> = {
  manhattan: { id: 'manhattan', seed: 1337 },
};

export const MAP_IDS: readonly MapId[] = Object.keys(MAPS) as MapId[];

export const DEFAULT_MAP: MapId = 'manhattan';

export function isMapId(v: unknown): v is MapId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(MAPS, v);
}
