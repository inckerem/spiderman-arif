/**
 * Map table shared by the client, the Room and the server. Online play always
 * uses the map's fixed seed (`?seed` only changes single player), so every
 * client and the server generate the same city. The ids themselves have one
 * source of truth, the dependency-free `src/maps/ids.ts` (the client's map
 * setting and `?harita=` use the same list).
 */
import { DEFAULT_MAP as IDS_DEFAULT, MAP_IDS as IDS, isMapId as isId, type MapId as Id } from '../maps/ids';

export type MapId = Id;

export interface MapDef {
  readonly id: MapId;
  /** City generator seed used online. */
  readonly seed: number;
}

export const MAPS: Readonly<Record<MapId, MapDef>> = {
  manhattan: { id: 'manhattan', seed: 1337 },
  istanbul: { id: 'istanbul', seed: 1337 },
};

export const MAP_IDS: readonly MapId[] = IDS;

export const DEFAULT_MAP: MapId = IDS_DEFAULT;

export function isMapId(v: unknown): v is MapId {
  return isId(v);
}
