import {
  BackSide,
  Color,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { Rng } from '../core/rng';
import { celMaterial } from '../render/materials';

/** Gradient sky dome with cel sun, moon with phase shading and twinkling stars. */
export class Sky {
  readonly mesh: Mesh;
  readonly uniforms = {
    uZenith: { value: new Color(0x2f7fdc) },
    uHorizon: { value: new Color(0xb8dcf5) },
    uGround: { value: new Color(0x3b4a5a) },
    uSunDir: { value: new Vector3(0, 1, 0) },
    uMoonDir: { value: new Vector3(0, -1, 0) },
    uSunColor: { value: new Color(0xfff2d0) },
    uStars: { value: 0 },
    uTime: { value: 0 },
    /** 0..1 overcast: hides the sun, moon and stars. */
    uCover: { value: 0 },
  };
  /** 0..1 overcast: the clouds grow, merge and sink (set by the day-night cycle). */
  cover = 0;
  readonly clouds: InstancedMesh;
  private readonly cloudData: Array<{ x: number; y: number; z: number; puffs: Array<[number, number, number, number, number]> }> = [];
  private cloudOffset = 0;
  private readonly cloudMat = celMaterial({ color: 0xffffff, key: 'cloud' });

  constructor(seed: number) {
    const mat = new ShaderMaterial({
      uniforms: this.uniforms,
      side: BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * viewMatrix * wp;
          gl_Position.z = gl_Position.w * 0.99999;
        }`,
      fragmentShader: /* glsl */ `
        layout(location = 1) out highp vec4 gNormalOut;
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uGround;
        uniform vec3 uSunDir;
        uniform vec3 uMoonDir;
        uniform vec3 uSunColor;
        uniform float uStars;
        uniform float uTime;
        uniform float uCover;
        varying vec3 vDir;
        float hash13(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.zyx + 31.32);
          return fract((p.x + p.y) * p.z);
        }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.02, 0.6, h), 0.75));
          col = mix(col, uGround, smoothstep(0.0, -0.25, h));
          // Sun: hard cel disk + soft halo.
          float sd = dot(d, normalize(uSunDir));
          float sunVis = smoothstep(-0.12, 0.02, uSunDir.y) * (1.0 - uCover);
          col += uSunColor * (pow(max(sd, 0.0), 220.0) * 0.6 + pow(max(sd, 0.0), 12.0) * 0.18) * sunVis;
          col = mix(col, uSunColor * 1.35 + 0.15, smoothstep(0.99935, 0.99955, sd) * sunVis);
          // Moon: disk with a simple phase terminator and maria.
          vec3 md = normalize(uMoonDir);
          float mdot = dot(d, md);
          float moonVis = smoothstep(-0.1, 0.05, md.y) * (1.0 - uCover);
          float disk = smoothstep(0.99955, 0.99968, mdot);
          if (disk > 0.0) {
            vec3 rel = d - md * mdot;
            float lit = smoothstep(-0.004, 0.004, dot(rel, normalize(cross(md, vec3(0.0, 1.0, 0.0)))) + 0.006);
            float maria = hash13(floor(rel * 2600.0)) > 0.62 ? 0.82 : 1.0;
            vec3 mc = mix(vec3(0.25, 0.27, 0.36), vec3(0.95, 0.93, 0.85) * maria, lit);
            col = mix(col, mc, disk * moonVis);
          }
          col += vec3(0.6, 0.65, 0.8) * pow(max(mdot, 0.0), 400.0) * 0.25 * moonVis;
          // Stars
          if (uStars > 0.01 && h > 0.0) {
            vec3 p = d * 260.0;
            vec3 c = floor(p);
            float s = hash13(c);
            if (s > 0.993) {
              vec3 f = fract(p) - 0.5;
              float star = smoothstep(0.22, 0.0, length(f));
              float tw = 0.65 + 0.35 * sin(uTime * (2.0 + s * 4.0) + s * 40.0);
              col += vec3(1.0, 0.96, 0.9) * star * tw * uStars * smoothstep(0.0, 0.2, h);
            }
          }
          gl_FragColor = vec4(col, 1.0);
          gNormalOut = vec4(0.0);
        }`,
    });
    this.mesh = new Mesh(new SphereGeometry(2900, 32, 20), mat);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'sky';

    // Stylised clouds: instanced puffs.
    const rng = new Rng(seed ^ 0x51ed);
    const count = 34;
    let puffs = 0;
    for (let i = 0; i < count; i++) {
      const n = rng.int(4, 8);
      const list: Array<[number, number, number, number, number]> = [];
      const len = rng.range(60, 140);
      for (let k = 0; k < n; k++) {
        const t = k / (n - 1) - 0.5;
        const r = rng.range(16, 30) * (1 - Math.abs(t) * 0.9);
        list.push([t * len + rng.range(-6, 6), rng.range(-3, 6), rng.range(-12, 12), r, r * rng.range(0.45, 0.6)]);
      }
      this.cloudData.push({ x: rng.range(-2200, 2200), y: rng.range(420, 620), z: rng.range(-2000, 2000), puffs: list });
      puffs += n;
    }
    this.clouds = new InstancedMesh(new IcosahedronGeometry(1, 1), this.cloudMat, puffs);
    this.clouds.frustumCulled = false;
    this.clouds.name = 'clouds';
    this.updateClouds(0);
  }

  get group(): Group {
    const g = new Group();
    g.add(this.mesh, this.clouds);
    return g;
  }

  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();

  updateClouds(dt: number): void {
    this.cloudOffset += dt * 4;
    let i = 0;
    for (const c of this.cloudData) {
      let x = c.x + this.cloudOffset;
      x = ((((x + 2400) % 4800) + 4800) % 4800) - 2400;
      // Overcast: puffs swell into a low, continuous deck.
      const k = 1 + 1.4 * this.cover;
      const y = c.y - 170 * this.cover;
      for (const [px, py, pz, r, ry] of c.puffs) {
        this.p.set(x + px * k, y + py, c.z + pz * k);
        this.s.set(r * k, ry * (1 + 0.6 * this.cover), r * 0.9 * k);
        this.m.compose(this.p, this.q, this.s);
        this.clouds.setMatrixAt(i++, this.m);
      }
    }
    this.clouds.instanceMatrix.needsUpdate = true;
  }

  setCloudTint(c: Color): void {
    this.cloudMat.color.copy(c);
  }

  get cloudTint(): Color {
    return this.cloudMat.color;
  }

  follow(x: number, z: number): void {
    this.mesh.position.set(x, 0, z);
  }
}
