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

/** Hand-laid axis-aligned arterial (§2.7): a line at `at` along the other axis from `from` to `to`. */
export interface Arterial {
  name: string;
  /** 'x': the road runs north-south at x = at; 'z': east-west at z = at. */
  axis: 'x' | 'z';
  at: number;
  from: number;
  to: number;
  width: number;
  /** 0 lane, 1 street, 2 arterial, 3 coastal; pedestrian streets carry no cars. */
  cls: 0 | 1 | 2 | 3;
  cars: boolean;
}

export const ARTERIALS: Arterial[] = [
  { name: 'Atatürk Bulvarı', axis: 'x', at: -500, from: -520, to: 700, width: 20, cls: 2, cars: true },
  { name: 'Divanyolu / Ordu Caddesi', axis: 'z', at: 370, from: -780, to: 125, width: 16, cls: 2, cars: true },
  { name: 'Alemdar Caddesi', axis: 'x', at: 118, from: 100, to: 370, width: 12, cls: 1, cars: true },
  { name: 'Yüksek Kaldırım', axis: 'x', at: 40, from: -235, to: -95, width: 10, cls: 1, cars: false },
  { name: 'Tarlabaşı Bulvarı', axis: 'x', at: -40, from: -625, to: -95, width: 18, cls: 2, cars: true },
  { name: 'İstiklal Caddesi', axis: 'x', at: 70, from: -560, to: -320, width: 14, cls: 1, cars: false },
  { name: 'Sıraselviler Caddesi', axis: 'x', at: 180, from: -560, to: -300, width: 12, cls: 1, cars: true },
  { name: 'Cumhuriyet / Büyükdere Caddesi', axis: 'x', at: 90, from: -960, to: -620, width: 18, cls: 2, cars: true },
  { name: 'Barbaros Bulvarı (east)', axis: 'z', at: -600, from: 200, to: 390, width: 16, cls: 2, cars: true },
  { name: 'Barbaros Bulvarı (north)', axis: 'x', at: 200, from: -780, to: -600, width: 16, cls: 2, cars: true },
  { name: 'Üsküdar Hakimiyeti Milliye', axis: 'z', at: 100, from: 640, to: 1000, width: 14, cls: 2, cars: true },
  { name: 'Kuzguncuk yolu', axis: 'z', at: -320, from: 700, to: 1000, width: 12, cls: 1, cars: true },
  { name: 'Beylerbeyi yolu', axis: 'z', at: -660, from: 800, to: 1000, width: 12, cls: 1, cars: true },
];

/** Coastal roads follow the shore this far inland (centre line), §2.7. */
export const COAST_ROAD_OFFSET = 22;
export const COAST_ROAD_WIDTH = 14;

export type LandmarkId =
  | 'hagiaSophia'
  | 'blueMosque'
  | 'hippodrome'
  | 'topkapi'
  | 'yeniCami'
  | 'spiceBazaar'
  | 'suleymaniye'
  | 'beyazit'
  | 'grandBazaar'
  | 'aqueduct'
  | 'galataTower'
  | 'taksim'
  | 'dolmabahce'
  | 'ortakoy'
  | 'mihrimah'
  | 'semsiPasa'
  | 'bridgeWestAnchorage'
  | 'bridgeEastAnchorage'
  | 'halicSouth'
  | 'halicNorth';

export interface LandmarkSite {
  id: LandmarkId;
  rect: Rect;
  /** Next to the shore: the coastal road goes around its inland side. */
  coastal?: boolean;
  /** Streets may pass through (the aqueduct's arches); buildings still keep out. */
  passable?: boolean;
}

/** Landmark footprints (§2.6, adjusted by up to ±10 m so nothing overlaps a road or water). */
export const LANDMARKS: LandmarkSite[] = [
  { id: 'hagiaSophia', rect: { minX: 19, maxX: 101, minZ: 280, maxZ: 353 } },
  { id: 'blueMosque', rect: { minX: 28, maxX: 92, minZ: 420, maxZ: 556 } },
  { id: 'hippodrome', rect: { minX: -50, maxX: 10, minZ: 400, maxZ: 620 } },
  { id: 'topkapi', rect: { minX: 140, maxX: 262, minZ: 215, maxZ: 440 } },
  { id: 'yeniCami', rect: { minX: -110, maxX: -24, minZ: 128, maxZ: 171 } },
  { id: 'spiceBazaar', rect: { minX: -30, maxX: 60, minZ: 175, maxZ: 195 } },
  { id: 'suleymaniye', rect: { minX: -380, maxX: -220, minZ: 110, maxZ: 300 } },
  { id: 'beyazit', rect: { minX: -214, maxX: -186, minZ: 286, maxZ: 314 } },
  { id: 'grandBazaar', rect: { minX: -150, maxX: -50, minZ: 230, maxZ: 310 } },
  { id: 'aqueduct', rect: { minX: -720, maxX: -380, minZ: 255, maxZ: 265 }, passable: true },
  { id: 'galataTower', rect: { minX: 22, maxX: 58, minZ: -273, maxZ: -237 } },
  { id: 'taksim', rect: { minX: 40, maxX: 170, minZ: -620, maxZ: -560 } },
  { id: 'dolmabahce', rect: { minX: 318, maxX: 344, minZ: -530, maxZ: -440 }, coastal: true },
  { id: 'ortakoy', rect: { minX: 428, maxX: 452, minZ: -667, maxZ: -643 }, coastal: true },
  { id: 'mihrimah', rect: { minX: 684, maxX: 716, minZ: 44, maxZ: 76 }, coastal: true },
  { id: 'semsiPasa', rect: { minX: 652, maxX: 668, minZ: 162, maxZ: 178 }, coastal: true },
  { id: 'bridgeWestAnchorage', rect: { minX: 282, maxX: 318, minZ: -764, maxZ: -716 } },
  { id: 'bridgeEastAnchorage', rect: { minX: 972, maxX: 1000, minZ: -764, maxZ: -716 } },
  // Haliç Metro Bridge approaches: the south deck runs on into the hill (streets pass under), the north end ramps down.
  { id: 'halicSouth', rect: { minX: -285, maxX: -265, minZ: 36, maxZ: 140 }, passable: true },
  { id: 'halicNorth', rect: { minX: -285, maxX: -265, minZ: -215, maxZ: -122 } },
];

export interface ParkSite {
  name: string;
  rect: Rect;
  /** Plane-tree spacing range (m). */
  spacing: [number, number];
}

export const PARKS: ParkSite[] = [
  { name: 'Gülhane', rect: { minX: 130, maxX: 320, minZ: 115, maxZ: 205 }, spacing: [10, 15] },
  { name: 'Sultanahmet', rect: { minX: 10, maxX: 130, minZ: 380, maxZ: 418 }, spacing: [11, 16] },
  { name: 'Gezi', rect: { minX: 100, maxX: 190, minZ: -680, maxZ: -620 }, spacing: [9, 13] },
  { name: 'Yıldız', rect: { minX: 230, maxX: 390, minZ: -700, maxZ: -612 }, spacing: [9, 13] },
];

/** Piers and quays over the water (top at curb height). */
export const PIERS: Rect[] = [
  { minX: 140, maxX: 160, minZ: -104, maxZ: -62 },
  { minX: 190, maxX: 206, minZ: -108, maxZ: -70 },
  { minX: -132, maxX: -112, minZ: 36, maxZ: 74 },
  { minX: -190, maxX: -172, minZ: 22, maxZ: 62 },
  { minX: 314, maxX: 330, minZ: -300, maxZ: -160 },
  { minX: 618, maxX: 664, minZ: 22, maxZ: 38 },
  { minX: 300, maxX: 318, minZ: 150, maxZ: 168 },
];

/** BSP roots: one rectangle per landmass, inside the hard bounds. */
export const ROOTS: Rect[] = [
  { minX: -780, maxX: 340, minZ: -75, maxZ: 710 },
  { minX: -780, maxX: 470, minZ: -980, maxZ: -90 },
  { minX: 636, maxX: 1000, minZ: -980, maxZ: 880 },
];

/** Levent: the tower cluster ("downtown" for long swings). */
export const LEVENT: Rect = { minX: -80, maxX: 260, minZ: -940, maxZ: -780 };
