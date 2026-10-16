import { AdditiveBlending, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, PlaneGeometry, ShaderMaterial } from 'three';

/** Beams drawn at once (laser sights, tracers, projectiles, web lines). */
export const MAX_BEAMS = 64;

/**
 * Combat beams (one draw call): every laser sight, tracer, bolt or bottle in
 * flight and web line of a yank or pin is a camera-facing strip between two
 * world points with a colour, an alpha and a width, drawn additively with a
 * soft edge. The renderer refills the list every frame (`begin`, `add`,
 * `end`); nothing is allocated per frame.
 */
export class CombatBeams {
  readonly mesh: InstancedMesh;
  private readonly a: InstancedBufferAttribute;
  private readonly b: InstancedBufferAttribute;
  private readonly col: InstancedBufferAttribute;
  private n = 0;

  constructor() {
    const geo = new PlaneGeometry(1, 1);
    // x in [0, 1] along the beam, y in [-0.5, 0.5] across.
    geo.translate(0.5, 0, 0);
    this.a = new InstancedBufferAttribute(new Float32Array(MAX_BEAMS * 3), 3);
    this.b = new InstancedBufferAttribute(new Float32Array(MAX_BEAMS * 4), 4);
    this.col = new InstancedBufferAttribute(new Float32Array(MAX_BEAMS * 4), 4);
    for (const at of [this.a, this.b, this.col]) at.setUsage(DynamicDrawUsage);
    geo.setAttribute('aA', this.a);
    geo.setAttribute('aB', this.b);
    geo.setAttribute('aCol', this.col);
    const mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      vertexShader: /* glsl */ `
        attribute vec3 aA;
        attribute vec4 aB; // end point, width
        attribute vec4 aCol;
        varying vec4 vCol;
        varying float vAcross;
        void main() {
          vec4 a = viewMatrix * vec4(aA, 1.0);
          vec4 b = viewMatrix * vec4(aB.xyz, 1.0);
          vec4 p = mix(a, b, position.x);
          vec2 d = b.xy - a.xy;
          float l = length(d);
          d = l > 1e-5 ? d / l : vec2(1.0, 0.0);
          p.xy += vec2(-d.y, d.x) * position.y * aB.w;
          vCol = aCol;
          vAcross = position.y * 2.0;
          gl_Position = projectionMatrix * p;
        }`,
      fragmentShader: /* glsl */ `
        layout(location = 1) out highp vec4 gNormalOut;
        varying vec4 vCol;
        varying float vAcross;
        void main() {
          float k = 1.0 - abs(vAcross);
          float core = smoothstep(0.0, 0.6, k);
          gl_FragColor = vec4(vCol.rgb * (0.55 + 0.45 * core), vCol.a * core);
          gNormalOut = vec4(0.0);
        }`,
    });
    this.mesh = new InstancedMesh(geo, mat, MAX_BEAMS);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 19;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.name = 'combat-beams';
  }

  begin(): void {
    this.n = 0;
  }

  /** A strip from (ax, ay, az) to (bx, by, bz), `width` metres wide. */
  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number, r: number, g: number, b: number, alpha: number): void {
    if (this.n >= MAX_BEAMS) return;
    const i = this.n++;
    const A = this.a.array as Float32Array,
      B = this.b.array as Float32Array,
      C = this.col.array as Float32Array;
    A[i * 3] = ax;
    A[i * 3 + 1] = ay;
    A[i * 3 + 2] = az;
    B[i * 4] = bx;
    B[i * 4 + 1] = by;
    B[i * 4 + 2] = bz;
    B[i * 4 + 3] = width;
    C[i * 4] = r;
    C[i * 4 + 1] = g;
    C[i * 4 + 2] = b;
    C[i * 4 + 3] = alpha;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) {
      this.a.needsUpdate = true;
      this.b.needsUpdate = true;
      this.col.needsUpdate = true;
    }
  }
}
