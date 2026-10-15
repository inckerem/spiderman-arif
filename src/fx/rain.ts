import { BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, ShaderMaterial, Vector3 } from 'three';
import { Rng } from '../core/rng';

/** Streaks in the buffer; the quality preset draws a share of them. */
export const RAIN_MAX = 4800;
/** The box of rain around the camera (m): width and depth, height. */
const BOX = 38;
const HEIGHT = 30;

/**
 * Rain streaks around the camera in one draw call. The geometry is built
 * once: each streak is a quad with a random seed. The vertex shader moves
 * every streak along the fall velocity with time, wraps it into a box that
 * follows the camera and turns it into a thin camera-facing line, so nothing
 * is updated per frame on the CPU but a few uniforms. Transparent, no depth
 * write, and it leaves the normal buffer alone (no outlines).
 */
export class Rain {
  readonly mesh: Mesh;
  readonly uniforms = {
    uCam: { value: new Vector3() },
    uTime: { value: 0 },
    uAmount: { value: 0 },
    uFall: { value: new Vector3(2.2, -21, 1.1) },
    uLength: { value: 1.0 },
    uWidth: { value: 0.012 },
    uPixel: { value: 0.002 },
    uColor: { value: new Color(0.6, 0.66, 0.78) },
    uOpacity: { value: 0.36 },
  };
  private time = 0;

  constructor(seed = 7) {
    const rng = new Rng(seed ^ 0x7a1);
    const n = RAIN_MAX;
    const corner = new Float32Array(n * 4 * 3);
    const seeds = new Float32Array(n * 4 * 4);
    const index = new Uint16Array(n * 6);
    for (let i = 0; i < n; i++) {
      const sx = rng.float(),
        sy = rng.float(),
        sz = rng.float(),
        sw = rng.float();
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        // x: side (-1/+1), y: 0 head .. 1 tail.
        corner[v * 3] = k & 1 ? 1 : -1;
        corner[v * 3 + 1] = k < 2 ? 0 : 1;
        corner[v * 3 + 2] = 0;
        seeds[v * 4] = sx;
        seeds[v * 4 + 1] = sy;
        seeds[v * 4 + 2] = sz;
        seeds[v * 4 + 3] = sw;
      }
      const a = i * 4;
      index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(corner, 3));
    geo.setAttribute('aSeed', new BufferAttribute(seeds, 4));
    geo.setIndex(new BufferAttribute(index, 1));
    const mat = new ShaderMaterial({
      name: 'Rain',
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      // The side offset can flip a quad's winding.
      side: DoubleSide,
      fog: false,
      vertexShader: /* glsl */ `
        uniform vec3 uCam;
        uniform float uTime;
        uniform float uAmount;
        uniform vec3 uFall;
        uniform float uLength;
        uniform float uWidth;
        uniform float uPixel;
        attribute vec4 aSeed;
        varying float vAlpha;
        varying float vTail;
        void main() {
          if (aSeed.w >= uAmount) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }
          vec3 box = vec3(${BOX.toFixed(1)}, ${HEIGHT.toFixed(1)}, ${BOX.toFixed(1)});
          vec3 vel = uFall * (0.82 + 0.36 * fract(aSeed.w * 7.31));
          // World position of the drop, wrapped into the box around the camera.
          vec3 rel = mod(aSeed.xyz * box + vel * uTime - uCam + 0.5 * box, box) - 0.5 * box;
          vec3 head = uCam + rel;
          vec3 tail = head - normalize(vel) * uLength;
          vec4 vh = viewMatrix * vec4(head, 1.0);
          vec4 vt = viewMatrix * vec4(tail, 1.0);
          vec4 mv = mix(vh, vt, position.y);
          // Side offset across the streak in view space (thin streaks need no perspective here).
          vec2 d = vt.xy - vh.xy;
          vec2 n = abs(d.x) + abs(d.y) > 1e-4 ? vec2(-d.y, d.x) / length(d) : vec2(1.0, 0.0);
          // At least about a pixel wide, so far streaks thin out in alpha rather than flicker.
          float w = max(uWidth, -mv.z * uPixel);
          mv.xy += n * w * position.x;
          gl_Position = projectionMatrix * mv;
          vec3 e = abs(rel) / box;
          float edge = (1.0 - smoothstep(0.36, 0.5, max(e.x, e.z))) * (1.0 - smoothstep(0.38, 0.5, e.y));
          vAlpha = edge * smoothstep(0.5, 2.5, -mv.z) * (uWidth / w);
          vTail = position.y;
        }`,
      fragmentShader: /* glsl */ `
        layout(location = 1) out highp vec4 gNormalOut;
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vAlpha;
        varying float vTail;
        void main() {
          float a = uOpacity * vAlpha * (1.0 - vTail * 0.85);
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor, a);
          gNormalOut = vec4(0.0);
        }`,
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 15;
    this.mesh.name = 'rain';
    this.mesh.visible = false;
  }

  /** Streaks drawn at full rain (scaled by the quality preset). */
  setDensity(streaks: number): void {
    const n = Math.max(0, Math.min(RAIN_MAX, Math.round(streaks)));
    this.mesh.geometry.setDrawRange(0, n * 6);
  }

  /**
   * Per frame: `level` 0..1 (0 hides the mesh), the camera position, the
   * size of a pixel at unit depth and a tint that follows the night.
   */
  update(dt: number, level: number, cam: Vector3, pixel: number, night: number): void {
    const u = this.uniforms;
    if (level <= 0.001) {
      this.mesh.visible = false;
      // Restart the clock between showers so the streak positions never lose precision.
      this.time = 0;
      return;
    }
    this.mesh.visible = true;
    this.time += dt;
    u.uTime.value = this.time;
    u.uAmount.value = level;
    u.uCam.value.copy(cam);
    u.uPixel.value = pixel;
    const k = 0.75 - 0.25 * night;
    u.uColor.value.setRGB(0.62 * k + 0.08, 0.68 * k + 0.08, 0.8 * k + 0.1);
  }
}
