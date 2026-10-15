import { Color, DirectionalLight, Fog, HemisphereLight, Vector3, type MeshBasicMaterial, type ShaderMaterial } from 'three';
import { clamp, smoothstep } from '../core/math';
import { shared } from '../render/materials';
import type { Sky } from './sky';

interface Key {
  t: number;
  zenith: number;
  horizon: number;
  sun: number;
  sunI: number;
  hemiSky: number;
  hemiGround: number;
  hemiI: number;
  fog: number;
  fogNear: number;
  fogFar: number;
  night: number;
  water: number;
  outline: number;
  cloud: number;
}

/** Keyframes over 24 h (sRGB hex colours). */
const KEYS: Key[] = [
  { t: 0, zenith: 0x070d22, horizon: 0x1a2648, sun: 0x8fa6ff, sunI: 0.42, hemiSky: 0x24345e, hemiGround: 0x0e1018, hemiI: 0.62, fog: 0x141d38, fogNear: 260, fogFar: 1700, night: 1, water: 0x0e2340, outline: 0x05070d, cloud: 0x39456a },
  { t: 4.6, zenith: 0x0b1430, horizon: 0x2a2f58, sun: 0x8fa6ff, sunI: 0.36, hemiSky: 0x2a3866, hemiGround: 0x10121a, hemiI: 0.6, fog: 0x1c2445, fogNear: 260, fogFar: 1700, night: 1, water: 0x10274a, outline: 0x05070d, cloud: 0x434c74 },
  { t: 5.6, zenith: 0x2a3f78, horizon: 0xc77b8a, sun: 0xffa070, sunI: 0.5, hemiSky: 0x6070a8, hemiGround: 0x30283a, hemiI: 0.62, fog: 0x8a6f8e, fogNear: 220, fogFar: 1500, night: 0.75, water: 0x2a4a78, outline: 0x10101a, cloud: 0xe7a3a0 },
  { t: 6.6, zenith: 0x4f86cf, horizon: 0xffbe8a, sun: 0xffc690, sunI: 1.6, hemiSky: 0xa9c4ea, hemiGround: 0x6b5a50, hemiI: 0.75, fog: 0xf0c4a2, fogNear: 240, fogFar: 1600, night: 0.25, water: 0x3a6fa0, outline: 0x141820, cloud: 0xffe0c8 },
  { t: 8.5, zenith: 0x3487e2, horizon: 0xc6e2f6, sun: 0xfff1da, sunI: 2.3, hemiSky: 0xbcdcff, hemiGround: 0x857560, hemiI: 0.82, fog: 0xc6e2f6, fogNear: 300, fogFar: 1900, night: 0, water: 0x2f78b0, outline: 0x141820, cloud: 0xffffff },
  { t: 12, zenith: 0x2a7cdc, horizon: 0xb4dbf6, sun: 0xfffaf0, sunI: 2.55, hemiSky: 0xc4e0ff, hemiGround: 0x8a7a66, hemiI: 0.85, fog: 0xb4dbf6, fogNear: 320, fogFar: 2000, night: 0, water: 0x2a7ab8, outline: 0x141820, cloud: 0xffffff },
  { t: 16, zenith: 0x3077d0, horizon: 0xc2dcf0, sun: 0xfff0d2, sunI: 2.35, hemiSky: 0xbcd6f5, hemiGround: 0x8a7462, hemiI: 0.82, fog: 0xc2dcf0, fogNear: 300, fogFar: 1900, night: 0, water: 0x2f74ac, outline: 0x141820, cloud: 0xfffaf0 },
  { t: 18.2, zenith: 0x3b5fa6, horizon: 0xff9a5a, sun: 0xff9a52, sunI: 1.7, hemiSky: 0xa6a8d0, hemiGround: 0x6a4a40, hemiI: 0.72, fog: 0xf2a878, fogNear: 240, fogFar: 1600, night: 0.25, water: 0x40609a, outline: 0x181418, cloud: 0xffc79a },
  { t: 19.3, zenith: 0x1f2b5e, horizon: 0xc0566a, sun: 0xff6a48, sunI: 0.55, hemiSky: 0x52548a, hemiGround: 0x2a2030, hemiI: 0.62, fog: 0x6a4060, fogNear: 220, fogFar: 1500, night: 0.7, water: 0x223a68, outline: 0x0c0a12, cloud: 0xb47a98 },
  { t: 20.5, zenith: 0x0b1230, horizon: 0x2a2a58, sun: 0x8fa6ff, sunI: 0.38, hemiSky: 0x283662, hemiGround: 0x101219, hemiI: 0.6, fog: 0x1a2142, fogNear: 260, fogFar: 1700, night: 1, water: 0x0f2545, outline: 0x05070d, cloud: 0x3c4670 },
  { t: 24, zenith: 0x070d22, horizon: 0x1a2648, sun: 0x8fa6ff, sunI: 0.42, hemiSky: 0x24345e, hemiGround: 0x0e1018, hemiI: 0.62, fog: 0x141d38, fogNear: 260, fogFar: 1700, night: 1, water: 0x0e2340, outline: 0x05070d, cloud: 0x39456a },
];

const ca = new Color();
const cb = new Color();

function lerpHex(out: Color, a: number, b: number, t: number): Color {
  ca.setHex(a);
  cb.setHex(b);
  return out.copy(ca).lerp(cb, t);
}

export interface DayNightTargets {
  sun: DirectionalLight;
  hemi: HemisphereLight;
  fog: Fog;
  sky: Sky;
  water: ShaderMaterial[];
  lampPools: MeshBasicMaterial;
  outline: (c: Color, strength: number) => void;
  fogRange: (near: number, far: number) => void;
}

/**
 * Continuous day-night cycle. Time is in hours [0, 24). Drives sun/moon
 * direction, light colours, hemisphere ambient, fog, sky, water, window and
 * lamp emission (gradual switch-on at dusk).
 */
export class DayNight {
  hour = 16.6;
  paused = false;
  /** Real minutes per full day. */
  dayLengthMinutes = 12;
  readonly sunDir = new Vector3(0, 1, 0);
  readonly moonDir = new Vector3(0, -1, 0);
  readonly lightDir = new Vector3(0, 1, 0);
  night = 0;
  private readonly col = new Color();
  private readonly fogCol = new Color();

  constructor(private readonly t: DayNightTargets) {}

  advance(dtSeconds: number, rate = 1): void {
    if (this.paused) return;
    const hoursPerSecond = 24 / (Math.max(0.5, this.dayLengthMinutes) * 60);
    this.hour = (this.hour + dtSeconds * hoursPerSecond * rate) % 24;
  }

  setHour(h: number): void {
    this.hour = ((h % 24) + 24) % 24;
  }

  apply(): void {
    const h = this.hour;
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1]!.t <= h) i++;
    const a = KEYS[i]!,
      b = KEYS[i + 1]!;
    const u = smoothstep(0, 1, clamp((h - a.t) / (b.t - a.t), 0, 1));
    // Sun path: rises in the east (+X), sets in the west, leaning south (+Z).
    const dayFrac = (h - 6) / 12; // 0 at sunrise, 1 at sunset
    const elev = Math.sin(dayFrac * Math.PI) * (68 * Math.PI) / 180;
    // 0 east -> pi west, turned a little so the noon sun never lights east and
    // west walls exactly edge-on (they would sit on a toon band edge and flicker).
    const az = Math.PI * dayFrac + 0.1;
    this.sunDir.set(Math.cos(az) * Math.cos(elev), Math.sin(elev), 0.42 * Math.cos(elev) + 0.15).normalize();
    if (h < 6 || h > 18) {
      // Below the horizon: mirror path.
      const nf = ((h + 6) % 24) / 12; // 0 at 18:00 .. 1 at 06:00
      const se = -Math.sin(nf * Math.PI) * 0.9;
      this.sunDir.set(-Math.cos(nf * Math.PI), se, 0.35).normalize();
    }
    // Moon roughly opposite, a little higher at night.
    this.moonDir.set(-this.sunDir.x * 0.9, Math.max(-0.9, -this.sunDir.y * 0.85 + 0.12), -this.sunDir.z + 0.25).normalize();
    const sunUp = smoothstep(-0.06, 0.06, this.sunDir.y);
    this.lightDir.copy(sunUp > 0.5 ? this.sunDir : this.moonDir);
    if (this.lightDir.y < 0.12) this.lightDir.y = 0.12;
    this.lightDir.normalize();
    // Fade the key light through the sun/moon swap so the direction change never pops.
    const swap = Math.abs(sunUp - 0.5) * 2;
    const key = this.t.sun;
    lerpHex(key.color, a.sun, b.sun, u);
    key.intensity = (a.sunI + (b.sunI - a.sunI) * u) * (0.15 + 0.85 * swap);
    lerpHex(this.t.hemi.color, a.hemiSky, b.hemiSky, u);
    lerpHex(this.t.hemi.groundColor, a.hemiGround, b.hemiGround, u);
    this.t.hemi.intensity = a.hemiI + (b.hemiI - a.hemiI) * u;
    lerpHex(this.fogCol, a.fog, b.fog, u);
    this.t.fog.color.copy(this.fogCol);
    this.t.fog.near = a.fogNear + (b.fogNear - a.fogNear) * u;
    this.t.fog.far = a.fogFar + (b.fogFar - a.fogFar) * u;
    this.t.fogRange(this.t.fog.near, this.t.fog.far);
    const su = this.t.sky.uniforms;
    lerpHex(su.uZenith.value, a.zenith, b.zenith, u);
    lerpHex(su.uHorizon.value, a.horizon, b.horizon, u);
    su.uGround.value.copy(this.fogCol).multiplyScalar(0.55);
    su.uSunDir.value.copy(this.sunDir);
    su.uMoonDir.value.copy(this.moonDir);
    lerpHex(su.uSunColor.value, a.sun, b.sun, u);
    if (this.sunDir.y < 0) su.uSunColor.value.setHex(0xffb070);
    this.night = a.night + (b.night - a.night) * u;
    su.uStars.value = smoothstep(0.55, 0.95, this.night);
    shared.uNight.value = this.night;
    shared.uSkyRefl.value.copy(su.uHorizon.value).lerp(su.uZenith.value, 0.35);
    for (const w of this.t.water) {
      lerpHex(w.uniforms.uDeep!.value as Color, a.water, b.water, u);
      (w.uniforms.uShallow!.value as Color).copy(w.uniforms.uDeep!.value as Color).multiplyScalar(1.5);
      (w.uniforms.uSky!.value as Color).copy(su.uHorizon.value);
      (w.uniforms.uSunDir!.value as Vector3).copy(sunUp > 0.5 ? this.sunDir : this.moonDir);
      (w.uniforms.uSunColor!.value as Color).copy(key.color);
    }
    // Street lamps and signs switch on with the night factor.
    const lamps = smoothstep(0.35, 0.75, this.night);
    this.t.lampPools.opacity = lamps * 0.85;
    shared.uLamp.value = lamps;
    this.t.lampPools.visible = lamps > 0.01;
    lerpHex(this.col, a.cloud, b.cloud, u);
    this.t.sky.setCloudTint(this.col);
    lerpHex(this.col, a.outline, b.outline, u);
    this.t.outline(this.col, 0.92);
  }

  /** Keep the shadow camera on the player, snapped to shadow texels to avoid shimmer. */
  placeShadow(light: DirectionalLight, focus: Vector3, extent: number, mapSize: number): void {
    const dist = 600;
    const texel = (extent * 2) / mapSize;
    // Snap the focus in light space.
    const ld = this.lightDir;
    const right = new Vector3(0, 1, 0).cross(ld).normalize();
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    const up = new Vector3().crossVectors(ld, right).normalize();
    const fr = focus.dot(right),
      fu = focus.dot(up),
      ff = focus.dot(ld);
    const sr = Math.round(fr / texel) * texel,
      su2 = Math.round(fu / texel) * texel;
    const snapped = new Vector3().addScaledVector(right, sr).addScaledVector(up, su2).addScaledVector(ld, ff);
    light.target.position.copy(snapped);
    light.position.copy(snapped).addScaledVector(ld, dist);
    light.target.updateMatrixWorld();
    const cam = light.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = dist + 400;
    cam.updateProjectionMatrix();
  }
}

