import type { Rect } from '../../world/types';

/**
 * Istanbul, "compressed real" (docs/design/m13-istanbul.md §2): real
 * relative positions and orientation with shorter distances, buildings at
 * real size. x = east, z = south (north is -z), y = up; sea level -1.2.
 */

/** Hard bounds of the playable area. */
export const IST_BOUNDS: Rect = { minX: -780, maxX: 1000, minZ: -980, maxZ: 880 };
/** Collision grid (and terrain grid) extent. */
export const IST_EXTENT: Rect = { minX: -1000, maxX: 1200, minZ: -1100, maxZ: 1060 };

type P = Array<[number, number]>;

/** Historic Peninsula: Golden Horn south shore W→E, Sarayburnu, east coast, Marmara shore E→W. */
export const PENINSULA: P = [
  [-1000, -60], [-760, -70], [-500, -10], [-250, 45], [-100, 75], [0, 95], [120, 100], [230, 110], [300, 150],
  [335, 205], [320, 300], [300, 420], [280, 540], [235, 640], [100, 665], [-100, 675], [-300, 685], [-500, 695], [-760, 705], [-1000, 705],
];
/** European north: Golden Horn north shore W→E, Karaköy, Bosphorus west bank to the north. */
export const EUROPE_N: P = [
  [-1000, -220], [-760, -215], [-500, -165], [-250, -122], [-100, -100], [0, -95], [120, -100], [230, -110], [290, -135],
  [310, -230], [330, -340], [345, -430], [360, -500], [380, -570], [400, -625], [445, -645], [445, -690], [433, -700], [435, -780],
  [450, -880], [460, -1100], [-1000, -1100],
];
/** Asian shore: Harem, Salacak, Üsküdar, Kuzguncuk, Beylerbeyi. */
export const ASIA: P = [
  [1300, 960], [720, 960], [690, 600], [660, 400], [640, 260], [645, 150], [660, 40], [690, -80], [740, -250], [790, -420],
  [840, -580], [860, -700], [870, -800], [880, -1100], [1300, -1100],
];
/** Maiden's Tower islet. */
export const MAIDEN_ISLET: P = [[555, 195], [595, 195], [595, 228], [555, 228]];

export const LAND_POLYGONS: P[] = [PENINSULA, EUROPE_N, ASIA, MAIDEN_ISLET];

export interface Hill {
  name: string;
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  /** Height (m), already scaled by about 0.45 from the real elevations. */
  h: number;
  /** Plateau fraction of the radius. */
  p: number;
}

/** §2.5: H = smoothstep(8, 70, dShore) · max_k h_k (1 − smoothstep(p_k, 1, r_k)). */
export const HILLS: Hill[] = [
  { name: 'first', cx: 140, cz: 330, rx: 230, rz: 240, h: 26, p: 0.35 },
  { name: 'third', cx: -300, cz: 250, rx: 260, rz: 260, h: 32, p: 0.3 },
  { name: 'fatih', cx: -620, cz: 300, rx: 220, rz: 280, h: 30, p: 0.3 },
  { name: 'divanyolu', cx: -100, cz: 320, rx: 200, rz: 150, h: 22, p: 0.3 },
  { name: 'pera', cx: 60, cz: -330, rx: 220, rz: 230, h: 36, p: 0.25 },
  { name: 'taksim', cx: 120, cz: -600, rx: 300, rz: 220, h: 46, p: 0.4 },
  { name: 'kasimpasa', cx: -450, cz: -500, rx: 300, rz: 300, h: 40, p: 0.3 },
  { name: 'levent', cx: 100, cz: -880, rx: 350, rz: 200, h: 46, p: 0.4 },
  { name: 'yildiz', cx: 330, cz: -640, rx: 120, rz: 90, h: 30, p: 0.3 },
  { name: 'uskudar', cx: 820, cz: 100, rx: 200, rz: 300, h: 28, p: 0.3 },
  { name: 'beylerbeyi', cx: 1000, cz: -500, rx: 250, rz: 350, h: 45, p: 0.3 },
];

/** Flat quay along every shore (m), and where the hills reach full height. */
export const QUAY = 8;
export const SHORE_RISE = 70;
/** Steepest land slope allowed (rise over run), asserted by the self-test. */
export const MAX_SLOPE = 0.3;
