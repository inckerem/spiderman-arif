import type { Game } from '../game';
import { anchorAvailability, attractTest, cityRoute, fuzz, parkRoute, traversalBot } from './testDrivers';

/**
 * Golden digest (M13 C0): hashes of the generated layout, the collider
 * arrays and the outputs of the deterministic drivers, so a refactor that
 * must not change behaviour (Manhattan behind the map abstraction, the
 * terrain interface) can be checked bit for bit. Timing fields are left out.
 * Run it on a freshly loaded page in manual mode: the drivers share the
 * player, so their order matters.
 */

/** Layout fields that describe the Manhattan city (later additions to CityLayout stay out of the hash). */
const LAYOUT_KEYS = [
  'seed',
  'land',
  'islet',
  'promenade',
  'avenues',
  'streets',
  'park',
  'pond',
  'paths',
  'blocks',
  'plazas',
  'buildings',
  'trees',
  'props',
  'parkWalls',
  'railings',
  'piers',
  'bridge',
  'bounds',
  'spawn',
  'stats',
] as const;

/** 53-bit string hash (cyrb53), hex. */
export function hashString(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Same hash over raw bytes of typed arrays (exact float bits). */
function hashBytes(arrays: ArrayBufferView[]): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (const a of arrays) {
    const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < u.length; i++) {
      const c = u[i]!;
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

function strip(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  for (const k of keys) delete o[k];
  return o;
}

export interface GoldenDigest {
  layout: string;
  colliders: string;
  fuzz: string;
  anchors: string;
  city: string;
  park: string;
  attract: string;
  /** A few readable numbers to locate a difference. */
  summary: Record<string, number | boolean>;
}

export function goldenDigest(game: Game, attractSeconds = 120): GoldenDigest {
  const L = game.layout as unknown as Record<string, unknown>;
  const lay: Record<string, unknown> = {};
  for (const k of LAYOUT_KEYS) lay[k] = L[k];
  const w = game.world;
  const n = w.count;
  const colliders = hashBytes([
    new Int32Array([n]),
    w.kind.subarray(0, n),
    w.flags.subarray(0, n),
    w.surface.subarray(0, n),
    w.owner.subarray(0, n),
    w.p.subarray(0, n * 6),
  ]);
  const fz = strip(fuzz(game, 1, 30) as unknown as Record<string, unknown>, ['msPerTick']);
  const an = strip(anchorAvailability(game, 2024, 200) as unknown as Record<string, unknown>, ['msPerQuery']);
  const city = traversalBot(game, 'city', cityRoute(game), 120) as unknown as Record<string, unknown>;
  const park = traversalBot(game, 'park', parkRoute(game), 90) as unknown as Record<string, unknown>;
  const at = strip(attractTest(game, attractSeconds, 1), ['msPerTick']);
  return {
    layout: hashString(JSON.stringify(lay)),
    colliders,
    fuzz: hashString(JSON.stringify(fz)),
    anchors: hashString(JSON.stringify(an)),
    city: hashString(JSON.stringify(city)),
    park: hashString(JSON.stringify(park)),
    attract: hashString(JSON.stringify(at)),
    summary: {
      buildings: game.layout.buildings.length,
      trees: game.layout.trees.length,
      colliders: n,
      fuzzInside: fz.insideGeometry as number,
      fuzzSplashes: fz.splashes as number,
      anchorsInRange: an.inRange as number,
      anchorsFound: an.found as number,
      cityReached: city.reached as boolean,
      cityDistance: +(city.distance as number).toFixed(3),
      parkReached: park.reached as boolean,
      parkDistance: +(park.distance as number).toFixed(3),
      attractDistance: +(at.distance as number).toFixed(3),
      attractSwings: at.swings as number,
    },
  };
}
