import { DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, PlaneGeometry, ShaderMaterial, Vector3, type Camera } from 'three';
import type { CrimeEventInfo } from '../types';

/** Beacons drawn at once (more than the concurrency cap online). */
const MAX_BEACONS = 6;
/** Pillar height (m) and the minimum width; it widens with distance so it stays a few pixels wide far away. */
const HEIGHT = 420;
const MIN_WIDTH = 7;
const WIDTH_PER_M = 0.014;
/** The pillar fades out as the camera comes within this range of its foot (m). */
const NEAR_OUT = 30;
const NEAR_IN = 110;

/** Beacon colours by event type (match the HUD and minimap). */
const COLORS: Readonly<Record<string, [number, number, number]>> = {
  robbery: [1.0, 0.62, 0.05],
  gang: [1.0, 0.26, 0.2],
  drones: [0.2, 0.8, 1.0],
  boss: [0.72, 0.4, 1.0],
};

/**
 * Crime-event beacons: a tall light pillar over every active event, seen
 * from across the city (no fog; alpha-blended so its colour reads against a
 * bright day sky; depth-tested so buildings in front still hide its foot). One instanced draw call: each pillar is a quad that
 * turns about the vertical toward the camera in the vertex shader, widening
 * with distance, with a bright core, a glowing foot and bands rising through
 * it. Leaves the normal buffer alone (no outlines).
 */
export class EventBeacons {
  readonly mesh: InstancedMesh;
  private readonly pos: InstancedBufferAttribute;
  private readonly col: InstancedBufferAttribute;
  private readonly uniforms = { uTime: { value: 0 }, uCam: { value: new Vector3() } };
  private warm = false;

  constructor() {
    const geo = new PlaneGeometry(1, 1);
    // x in [-0.5, 0.5] across, y in [0, 1] up.
    geo.translate(0, 0.5, 0);
    this.pos = new InstancedBufferAttribute(new Float32Array(MAX_BEACONS * 4), 4);
    this.col = new InstancedBufferAttribute(new Float32Array(MAX_BEACONS * 4), 4);
    this.pos.setUsage(DynamicDrawUsage);
    this.col.setUsage(DynamicDrawUsage);
    geo.setAttribute('aPos', this.pos);
    geo.setAttribute('aCol', this.col);
    const mat = new ShaderMaterial({
      name: 'EventBeacon',
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: false,
      vertexShader: /* glsl */ `
        uniform vec3 uCam;
        attribute vec4 aPos; // base x, y, z; phase
        attribute vec4 aCol; // rgb, strength
        varying vec4 vCol;
        varying vec2 vUv;
        varying float vPhase;
        varying float vNear;
        void main() {
          vec3 base = aPos.xyz;
          vec3 to = uCam - base;
          to.y = 0.0;
          float d = length(to);
          vec3 side = d > 1e-3 ? normalize(vec3(-to.z, 0.0, to.x)) : vec3(1.0, 0.0, 0.0);
          float w = max(${MIN_WIDTH.toFixed(1)}, d * ${WIDTH_PER_M.toFixed(4)});
          vec3 p = base + side * position.x * w + vec3(0.0, position.y * ${HEIGHT.toFixed(1)}, 0.0);
          vCol = aCol;
          // Standing at the event the pillar would fill the view: it fades out within ~100 m.
          vNear = smoothstep(${NEAR_OUT.toFixed(1)}, ${NEAR_IN.toFixed(1)}, d);
          vUv = vec2(position.x * 2.0, position.y);
          vPhase = aPos.w;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        layout(location = 1) out highp vec4 gNormalOut;
        uniform float uTime;
        varying vec4 vCol;
        varying vec2 vUv;
        varying float vPhase;
        varying float vNear;
        void main() {
          float across = 1.0 - abs(vUv.x);
          float body = smoothstep(0.0, 0.85, across);
          float core = smoothstep(0.5, 1.0, across);
          float h = vUv.y;
          float fade = 1.0 - h * h;
          float foot = exp(-h * 40.0);
          // Bands rising through the pillar.
          float bands = 0.7 + 0.3 * sin(h * 70.0 - uTime * 4.0 + vPhase * 6.28);
          float pulse = 0.85 + 0.15 * sin(uTime * 3.0 + vPhase * 6.28);
          float a = min(0.95, (body * 0.95 + core * 0.3) * (fade * bands + foot) * pulse * vCol.a * vNear);
          if (a < 0.003) discard;
          vec3 c = mix(vCol.rgb, vec3(1.0, 0.97, 0.88), core * 0.25);
          gl_FragColor = vec4(c, a);
          gNormalOut = vec4(0.0);
        }`,
    });
    this.mesh = new InstancedMesh(geo, mat, MAX_BEACONS);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 18;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.name = 'event-beacons';
  }

  /** Show one beacon at (x, y, z) for `renderer.compile` and the first frame (the program compiles during loading). */
  warmup(x: number, y: number, z: number): void {
    this.warm = true;
    this.put(0, x, y, z, 'robbery', 0);
    this.mesh.count = 1;
    this.mesh.visible = true;
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
  }

  /** One pillar per active event (none when `events` is null: menu, combat off). */
  update(events: readonly CrimeEventInfo[] | null, camera: Camera, time: number): void {
    if (this.warm) {
      // Keep the warm-up beacon for the first frame after loading.
      this.warm = false;
      return;
    }
    const n = events ? Math.min(events.length, MAX_BEACONS) : 0;
    for (let i = 0; i < n; i++) {
      const ev = events![i]!;
      this.put(i, ev.x, ev.y, ev.z, ev.type, ev.id * 0.37);
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.pos.needsUpdate = true;
      this.col.needsUpdate = true;
      this.uniforms.uTime.value = time;
      camera.getWorldPosition(this.uniforms.uCam.value);
    }
  }

  private put(i: number, x: number, y: number, z: number, type: string, phase: number): void {
    const c = COLORS[type] ?? COLORS.robbery!;
    const P = this.pos.array as Float32Array,
      C = this.col.array as Float32Array;
    P[i * 4] = x;
    P[i * 4 + 1] = y;
    P[i * 4 + 2] = z;
    P[i * 4 + 3] = phase % 1;
    C[i * 4] = c[0];
    C[i * 4 + 1] = c[1];
    C[i * 4 + 2] = c[2];
    C[i * 4 + 3] = 1;
  }
}
