/**
 * Player settings and ring-race best times, persisted in localStorage.
 * Every read and write is wrapped in try/catch (storage can be disabled,
 * full or throw a SecurityError) and every loaded field is validated and
 * clamped, so a corrupt or hand-edited entry can never break the game.
 */

import { DEFAULT_BINDINGS, sanitizeBindings, type Bindings } from '../input/bindings';
import { DEFAULT_COSTUME, isCostumeId, type CostumeId } from '../character/costumes';
import { DEFAULT_MAP, isMapId, type MapId } from '../maps/ids';

export interface Settings {
  /** 0 Low, 1 Medium, 2 High, 3 Ultra. */
  quality: 0 | 1 | 2 | 3;
  /** Internal render scale, 0.5..1.5 (1 = native). */
  renderScale: number;
  dynamicResolution: boolean;
  /** Added to the camera FOV, degrees, -10..15. */
  fovOffset: number;
  /** Mouse sensitivity multiplier, 0.2..3. */
  sensitivity: number;
  /** Touch look-drag sensitivity multiplier, 0.2..3 (touch controls only). */
  touchSensitivity: number;
  invertY: boolean;
  /** Camera turns toward the travel direction while flying fast with the mouse idle. */
  cameraFollow: boolean;
  /** Volumes 0..1. */
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  /** Real-time minutes for one full day-night cycle, 2..60. */
  dayLengthMinutes: number;
  showFps: boolean;
  /** Crime events and roaming patrols in single player (M11). */
  crimeEvents: boolean;
  /** Key and mouse bindings (see src/input/bindings.ts); replaced, never mutated. */
  bindings: Bindings;
  /** Hero costume (src/character/costumes.ts). */
  costume: CostumeId;
  /** Map to boot (src/maps/ids.ts); `?harita=` in the URL overrides it. */
  map: MapId;
}

export const SETTINGS_KEY = 'skythread.settings.v1';
export const BEST_TIMES_KEY = 'skythread.bestTimes.v1';

/** Inclusive numeric ranges, shared by validation and the settings screen. */
export const SETTINGS_LIMITS = {
  renderScale: { min: 0.5, max: 1.5 },
  fovOffset: { min: -10, max: 15 },
  sensitivity: { min: 0.2, max: 3 },
  touchSensitivity: { min: 0.2, max: 3 },
  masterVolume: { min: 0, max: 1 },
  musicVolume: { min: 0, max: 1 },
  sfxVolume: { min: 0, max: 1 },
  dayLengthMinutes: { min: 2, max: 60 },
} as const;

export type NumericSettingKey = keyof typeof SETTINGS_LIMITS;
export type BooleanSettingKey = 'dynamicResolution' | 'invertY' | 'cameraFollow' | 'showFps' | 'crimeEvents';

/** Frozen at runtime so nothing can mutate the defaults by accident. */
export const DEFAULT_SETTINGS: Settings = Object.freeze<Settings>({
  quality: 1,
  renderScale: 1,
  dynamicResolution: true,
  fovOffset: 0,
  sensitivity: 1,
  touchSensitivity: 1,
  invertY: false,
  cameraFollow: true,
  masterVolume: 0.8,
  musicVolume: 0.6,
  sfxVolume: 0.8,
  dayLengthMinutes: 12,
  showFps: false,
  crimeEvents: true,
  bindings: DEFAULT_BINDINGS,
  costume: DEFAULT_COSTUME,
  map: DEFAULT_MAP,
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  if (!finiteNumber(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function qualityOr(v: unknown, fallback: Settings['quality']): Settings['quality'] {
  if (!finiteNumber(v)) return fallback;
  const q = Math.min(3, Math.max(0, Math.round(v)));
  return q === 0 ? 0 : q === 1 ? 1 : q === 2 ? 2 : 3;
}

/**
 * Builds a complete, valid Settings object from untrusted data: numbers are
 * clamped to their ranges, wrong or missing fields fall back to defaults.
 */
export function sanitizeSettings(data: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const o: Record<string, unknown> = isRecord(data) ? data : {};
  const num = (key: NumericSettingKey): number =>
    clampNumber(o[key], SETTINGS_LIMITS[key].min, SETTINGS_LIMITS[key].max, d[key]);
  return {
    quality: qualityOr(o.quality, d.quality),
    renderScale: num('renderScale'),
    dynamicResolution: boolOr(o.dynamicResolution, d.dynamicResolution),
    fovOffset: num('fovOffset'),
    sensitivity: num('sensitivity'),
    touchSensitivity: num('touchSensitivity'),
    invertY: boolOr(o.invertY, d.invertY),
    cameraFollow: boolOr(o.cameraFollow, d.cameraFollow),
    masterVolume: num('masterVolume'),
    musicVolume: num('musicVolume'),
    sfxVolume: num('sfxVolume'),
    dayLengthMinutes: num('dayLengthMinutes'),
    showFps: boolOr(o.showFps, d.showFps),
    crimeEvents: boolOr(o.crimeEvents, d.crimeEvents),
    bindings: sanitizeBindings(o.bindings),
    costume: isCostumeId(o.costume) ? o.costume : d.costume,
    map: isMapId(o.map) ? o.map : d.map,
  };
}

function readJson(key: string): unknown {
  try {
    const raw = globalThis.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    // Storage blocked, unavailable or holding invalid JSON: use defaults.
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked or full: the values stay valid in memory for this session.
  }
}

/**
 * Loads settings (key `skythread.settings.v1`), validated; defaults on any
 * problem. `firstRun` overrides defaults only when nothing is stored yet
 * (touch devices start on Low quality); once saved, the stored value wins.
 */
export function loadSettings(firstRun: Partial<Settings> = {}): Settings {
  const stored = readJson(SETTINGS_KEY);
  // Anything but an object (nothing stored, or a corrupt "x" or 5) counts as a first run.
  return sanitizeSettings(isRecord(stored) ? stored : { ...DEFAULT_SETTINGS, ...firstRun });
}

/** Saves a validated copy of the settings. Never throws. */
export function saveSettings(s: Settings): void {
  try {
    writeJson(SETTINGS_KEY, sanitizeSettings(s));
  } catch {
    // sanitizeSettings only reads plain fields; this guards exotic getters.
  }
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeTimes(data: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(data)) return out;
  for (const key of Object.keys(data)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const v = data[key];
    if (finiteNumber(v) && v > 0) out[key] = v;
  }
  return out;
}

/** Best ring-race times in seconds, keyed by route id. Invalid entries are dropped. */
export function loadBestTimes(): Record<string, number> {
  return sanitizeTimes(readJson(BEST_TIMES_KEY));
}

/** Saves best times (finite positive seconds only). Never throws. */
export function saveBestTimes(t: Record<string, number>): void {
  try {
    writeJson(BEST_TIMES_KEY, sanitizeTimes(t));
  } catch {
    // Guards exotic inputs; storage errors are already handled in writeJson.
  }
}
