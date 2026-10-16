import {
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';

const MAX = 320;
const SHAPE_SOFT = 0;
const SHAPE_STAR = 1;
const SHAPE_RING = 2;

interface P {
  alive: boolean;
  pos: Vector3;
  vel: Vector3;
  size: number;
  grow: number;
  life: number;
  age: number;
  color: Color;
  alpha: number;
  gravity: number;
  drag: number;
  shape: number;
}

/**
 * Billboard particle pool (one draw call): landing dust, water splash,
 * release sparks, comic starburst, wall dust.
 */
export class Particles {
  readonly mesh: InstancedMesh;
  private readonly ps: P[] = [];
  private readonly alpha: InstancedBufferAttribute;
  private readonly shape: InstancedBufferAttribute;
  private readonly m = new Matrix4();
  private next = 0;

  constructor() {
    const mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        attribute float aShape;
        varying vec2 vUv;
        varying float vAlpha;
        varying float vShape;
        varying vec3 vColor;
        void main() {
          vUv = uv;
          vAlpha = aAlpha;
          vShape = aShape;
          vColor = instanceColor;
          vec3 c = instanceMatrix[3].xyz;
          float s = length(instanceMatrix[0].xyz);
          if (aShape > 1.5) {
            // Rings lie flat (splash ripples on the water surface).
            gl_Position = projectionMatrix * viewMatrix * vec4(c + vec3(position.x * s, 0.0, position.y * s), 1.0);
          } else {
            vec4 mv = viewMatrix * vec4(c, 1.0);
            mv.xy += position.xy * s;
            gl_Position = projectionMatrix * mv;
          }
        }`,
      fragmentShader: /* glsl */ `
        layout(location = 1) out highp vec4 gNormalOut;
        varying vec2 vUv;
        varying float vAlpha;
        varying float vShape;
        varying vec3 vColor;
        void main() {
          vec2 q = vUv * 2.0 - 1.0;
          float r = length(q);
          float a;
          if (vShape < 0.5) {
            a = smoothstep(1.0, 0.55, r);
          } else if (vShape < 1.5) {
            float ang = atan(q.y, q.x);
            float star = 0.55 + 0.4 * abs(cos(ang * 5.0));
            a = smoothstep(star, star - 0.06, r);
            // Ink rim
            float rim = smoothstep(star - 0.06, star - 0.14, r);
            gl_FragColor = vec4(mix(vec3(0.07, 0.08, 0.1), vColor, rim), a * vAlpha);
            gNormalOut = vec4(0.0);
            return;
          } else {
            a = smoothstep(0.12, 0.02, abs(r - 0.8)) * 0.9;
          }
          if (a * vAlpha < 0.01) discard;
          gl_FragColor = vec4(vColor, a * vAlpha);
          gNormalOut = vec4(0.0);
        }`,
    });
    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), mat, MAX);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.alpha = new InstancedBufferAttribute(new Float32Array(MAX), 1);
    this.alpha.setUsage(DynamicDrawUsage);
    this.shape = new InstancedBufferAttribute(new Float32Array(MAX), 1);
    this.shape.setUsage(DynamicDrawUsage);
    this.mesh.geometry.setAttribute('aAlpha', this.alpha);
    this.mesh.geometry.setAttribute('aShape', this.shape);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.name = 'particles';
    const col = new Color();
    for (let i = 0; i < MAX; i++) {
      this.ps.push({ alive: false, pos: new Vector3(), vel: new Vector3(), size: 1, grow: 0, life: 1, age: 0, color: new Color(), alpha: 1, gravity: 0, drag: 0, shape: 0 });
      this.m.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, col.setRGB(1, 1, 1));
    }
    this.mesh.count = MAX;
  }

  private spawn(pos: Vector3, vel: Vector3, size: number, grow: number, life: number, color: Color, alpha: number, gravity: number, drag: number, shape: number): void {
    const p = this.ps[this.next]!;
    this.next = (this.next + 1) % MAX;
    p.alive = true;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.size = size;
    p.grow = grow;
    p.life = life;
    p.age = 0;
    p.color.copy(color);
    p.alpha = alpha;
    p.gravity = gravity;
    p.drag = drag;
    p.shape = shape;
  }

  private readonly c = new Color();
  private readonly v = new Vector3();
  private readonly o = new Vector3();

  dust(at: Vector3, strength: number, night: number): void {
    const n = Math.round(10 + strength * 16);
    const k = 1 - night * 0.55;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const sp = 1.5 + strength * 4.5 * (0.5 + Math.random() * 0.5);
      this.v.set(Math.cos(a) * sp, 0.4 + Math.random() * 1.2, Math.sin(a) * sp);
      const size = 0.28 + strength * 0.3 * (0.6 + Math.random() * 0.4);
      // Start above the ground by the particle radius so billboards are not cut by the floor.
      this.o.set(at.x + Math.cos(a) * 0.25, at.y + size * 0.55, at.z + Math.sin(a) * 0.25);
      const g = 0.5 + Math.random() * 0.08;
      this.c.setRGB(g * 1.04 * k, g * k, g * 0.94 * k);
      this.spawn(this.o, this.v, size, 1.6, 0.55 + Math.random() * 0.35, this.c, 0.24, -0.6, 4.5, SHAPE_SOFT);
    }
  }

  splash(at: Vector3): void {
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random();
      this.v.set(Math.cos(a) * (2 + r * 5), 5 + Math.random() * 9, Math.sin(a) * (2 + r * 5));
      this.c.setRGB(0.85, 0.94, 1.0);
      this.spawn(at, this.v, 0.25 + Math.random() * 0.35, 0.2, 0.9 + Math.random() * 0.5, this.c, 0.9, 22, 0.3, SHAPE_SOFT);
    }
    this.c.setRGB(0.92, 0.97, 1.0);
    this.v.set(0, 0, 0);
    this.spawn(this.o.copy(at).setY(at.y + 0.05), this.v, 1.2, 6, 1.1, this.c, 0.85, 0, 0, SHAPE_RING);
    this.spawn(this.o.copy(at).setY(at.y + 0.04), this.v, 0.6, 9, 1.5, this.c, 0.6, 0, 0, SHAPE_RING);
  }

  /** Comic starburst and amber sparks that travel with the hero for a moment. */
  releaseBurst(at: Vector3, vel: Vector3): void {
    this.c.setRGB(1.0, 0.72, 0.14);
    this.v.copy(vel).multiplyScalar(0.92);
    this.spawn(at, this.v, 1.3, 2.2, 0.3, this.c, 0.9, 0, 0, SHAPE_STAR);
    for (let i = 0; i < 18; i++) {
      this.v.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize().multiplyScalar(5 + Math.random() * 5).addScaledVector(vel, 0.85);
      this.c.setRGB(1, 0.6 + Math.random() * 0.3, 0.12);
      this.spawn(at, this.v, 0.14, 0, 0.4 + Math.random() * 0.25, this.c, 1, 4, 0.6, SHAPE_SOFT);
    }
  }

  /**
   * Combat impact: a comic starburst and sparks flying away from the hitter
   * (`dir`, normalised horizontal). `blocked` is a cold blue-white clang off a
   * shield; `strength` (0..1) scales the burst (a KO is 1).
   */
  hitSpark(at: Vector3, dir: Vector3, strength: number, blocked: boolean): void {
    if (blocked) this.c.setRGB(0.75, 0.88, 1.0);
    else this.c.setRGB(1.0, 0.92, 0.55);
    this.v.set(0, 0, 0);
    this.spawn(at, this.v, 0.55 + strength * 0.6, 1.8, 0.16 + strength * 0.08, this.c, 0.95, 0, 0, SHAPE_STAR);
    const n = 6 + Math.round(strength * 10);
    for (let i = 0; i < n; i++) {
      this.v
        .set(Math.random() - 0.5, Math.random() * 0.8 - 0.1, Math.random() - 0.5)
        .normalize()
        .multiplyScalar(3 + Math.random() * 4)
        .addScaledVector(dir, 3 + strength * 3);
      if (blocked) this.c.setRGB(0.7, 0.85, 1);
      else this.c.setRGB(1, 0.55 + Math.random() * 0.35, 0.12);
      this.spawn(at, this.v, 0.08 + Math.random() * 0.05, 0, 0.22 + Math.random() * 0.2, this.c, 1, 9, 1.5, SHAPE_SOFT);
    }
  }

  /** A small coloured flash with a few sparks (muzzle flash, bolt impact, breaking bottle). */
  flash(at: Vector3, r: number, g: number, b: number, size: number, sparks: number): void {
    this.c.setRGB(r, g, b);
    this.v.set(0, 0, 0);
    this.spawn(at, this.v, size, 1.2, 0.09, this.c, 1, 0, 0, SHAPE_STAR);
    for (let i = 0; i < sparks; i++) {
      this.v.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 4);
      this.spawn(at, this.v, 0.07 + Math.random() * 0.05, 0, 0.18 + Math.random() * 0.2, this.c, 1, 8, 1.2, SHAPE_SOFT);
    }
  }

  wallDust(at: Vector3, normal: Vector3): void {
    for (let i = 0; i < 10; i++) {
      this.v.copy(normal).multiplyScalar(1 + Math.random() * 2).add(this.o.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2));
      this.c.setRGB(0.75, 0.72, 0.66);
      this.spawn(at, this.v, 0.3, 0.8, 0.5, this.c, 0.5, -0.5, 4, SHAPE_SOFT);
    }
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < MAX; i++) {
      const p = this.ps[i]!;
      if (!p.alive) continue;
      any = true;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        this.m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.m);
        this.alpha.setX(i, 0);
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.pos.addScaledVector(p.vel, dt);
      const u = p.age / p.life;
      const s = p.size * (1 + p.grow * u);
      this.m.makeScale(s, s, s);
      this.m.setPosition(p.pos);
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, p.color);
      this.alpha.setX(i, p.alpha * (1 - u * u));
      this.shape.setX(i, p.shape);
    }
    if (any) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
      this.alpha.needsUpdate = true;
      this.shape.needsUpdate = true;
    }
  }
}
