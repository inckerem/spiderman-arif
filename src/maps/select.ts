import { DEFAULT_MAP, MAP_PARAM, isMapId, type MapId } from './ids';

/**
 * Maps the client can build and play. A map id that is known but not yet
 * playable (still under construction) is treated like an unknown one.
 */
export const PLAYABLE_MAPS: readonly MapId[] = ['manhattan', 'istanbul'];

export const isPlayableMap = (v: unknown): v is MapId => isMapId(v) && PLAYABLE_MAPS.includes(v);

/**
 * Which map to boot: a valid `?harita=` wins, then the stored setting, then
 * the default. Invalid values are ignored silently (no console noise).
 */
export function resolveMapId(search: string, stored: unknown): MapId {
  let param: string | null = null;
  try {
    param = new URLSearchParams(search).get(MAP_PARAM);
  } catch {
    param = null;
  }
  if (isPlayableMap(param)) return param;
  if (isPlayableMap(stored)) return stored;
  return DEFAULT_MAP;
}

/** The current URL with `harita=<id>`; every other parameter (seed, room) is kept. */
export function mapSwitchUrl(href: string, id: MapId): string {
  const u = new URL(href);
  u.searchParams.set(MAP_PARAM, id);
  return u.toString();
}

/** Reloads the page on another map (the settings must already be saved). */
export function reloadWithMap(id: MapId): void {
  location.replace(mapSwitchUrl(location.href, id));
}
