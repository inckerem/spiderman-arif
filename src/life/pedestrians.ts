import { Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshToonMaterial, Quaternion, Vector3 } from 'three';
import { GeomBuilder } from '../render/geomBuilder';
import { shared, toonGradient, withMRT } from '../render/materials';
import { Rng } from '../core/rng';
import { D_DOWNTOWN, D_LOW, D_MID, type CityLayout } from '../world/types';

const SHIRTS: Array<[number, number, number]> = [
  [0.82, 0.22, 0.2],
  [0.2, 0.45, 0.78],
  [0.95, 0.75, 0.2],
  [0.25, 0.62, 0.42],
  [0.9, 0.9, 0.86],
  [0.55, 0.3, 0.62],
  [0.95, 0.5, 0.25],
  [0.3, 0.3, 0.34],
  [0.62, 0.8, 0.86],
];

/** Sidewalk centre line inset from the block edge (curb), metres. */
const WALK_INSET = 3.8;

interface Loop {
  /** Polyline points (x, z); closed loops repeat the first point at the end. */
  pts: Array<[number, number]>;
  cum: number[];
  total: number;
  closed: boolean;
  weight: number;
  cx: number;
  cz: number;
}

interface Ped {
  loop: number;
  u: number;
  dir: number;
  speed: number;
}

/** A low-poly walker: legs, torso, arms, head; vertex attributes drive the walk cycle. */
function personGeometry(): ReturnType<GeomBuilder['build']> {
  const g = new GeomBuilder([
    { name: 'aPart', size: 1 }, // 0 skin, 1 shirt, 2 pants, 3 hair, 4 shoes
    { name: 'aLimb', size: 1 }, // 0 body, 1 left leg, 2 right leg, 3 left arm, 4 right arm
  ]);
  const part = (p: number, limb: number, draw: () => void): void => {
    g.setColor(1, 1, 1);
    g.setExtra('aPart', p);
    g.setExtra('aLimb', limb);
    draw();
  };
  part(2, 1, () => g.box(0.03, 0.1, -0.07, 0.17, 0.92, 0.07));
  part(2, 2, () => g.box(-0.17, 0.1, -0.07, -0.03, 0.92, 0.07));
  part(4, 1, () => g.box(0.03, 0.0, -0.08, 0.17, 0.1, 0.12));
  part(4, 2, () => g.box(-0.17, 0.0, -0.08, -0.03, 0.1, 0.12));
  part(1, 0, () => g.box(-0.2, 0.88, -0.12, 0.2, 1.48, 0.12));
  part(1, 3, () => g.box(0.2, 0.9, -0.06, 0.29, 1.46, 0.06));
  part(1, 4, () => g.box(-0.29, 0.9, -0.06, -0.2, 1.46, 0.06));
  part(0, 3, () => g.box(0.205, 0.78, -0.05, 0.285, 0.9, 0.05));
  part(0, 4, () => g.box(-0.285, 0.78, -0.05, -0.205, 0.9, 0.05));
  part(0, 0, () => g.box(-0.05, 1.48, -0.05, 0.05, 1.56, 0.05));
  part(0, 0, () => g.ellipsoid(0, 1.66, 0, 0.11, 0.13, 0.12, 8, 6));
  part(3, 0, () => g.ellipsoid(0, 1.71, -0.01, 0.115, 0.09, 0.125, 8, 5));
  return g.build();
}

/**
 * Instanced pedestrians strolling around block sidewalks and park paths with
 * a shader walk cycle. Walkers far from the player are moved to loops near
 * the player, so the visible density follows the quality preset. Visual only.
 */
export class Pedestrians {
  readonly mesh: InstancedMesh;
  private readonly loops: Loop[] = [];
  private readonly peds: Ped[] = [];
  private active = 0;
  private readonly rng: Rng;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3(1, 1, 1);
  private readonly up = new Vector3(0, 1, 0);
  private readonly look: InstancedBufferAttribute;
  private relocateCursor = 0;
  private relocateTimer = 0;

  constructor(
    layout: CityLayout,
    readonly capacity: number,
    seed: number,
    private readonly groundY: (x: number, z: number) => number,
  ) {
    this.rng = new Rng(seed * 97 + 3);
    this.buildLoops(layout);
    const geo = personGeometry();
    this.look = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    geo.setAttribute('iLook', this.look);
    const mat = new MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
    withMRT(mat, true, 'peds', (shader) => {
      shader.uniforms.uTime = shared.uTime;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute float aPart;
attribute float aLimb;
attribute vec4 iLook; // phase, skin tone, pants tone, stride rate
uniform float uTime;`,
        )
        .replace(
          '#include <color_vertex>',
          `vColor = vec4(1.0);
#ifdef USE_INSTANCING_COLOR
  vec3 skin = mix(vec3(0.96, 0.78, 0.62), vec3(0.42, 0.27, 0.18), iLook.y);
  vec3 pants = mix(vec3(0.12, 0.14, 0.2), vec3(0.45, 0.4, 0.33), iLook.z);
  vColor.rgb = aPart < 0.5 ? skin : aPart < 1.5 ? instanceColor.rgb : aPart < 2.5 ? pants : aPart < 3.5 ? vec3(0.12, 0.09, 0.07) : vec3(0.1, 0.1, 0.11);
#endif`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
float sw = sin(uTime * iLook.w + iLook.x);
if (aLimb > 0.5) {
  bool leg = aLimb < 2.5;
  float side = (aLimb < 1.5 || (aLimb > 2.5 && aLimb < 3.5)) ? 1.0 : -1.0;
  float ang = leg ? side * sw * 0.45 : -side * sw * 0.38;
  float pivot = leg ? 0.92 : 1.44;
  float y = transformed.y - pivot;
  float c = cos(ang), s = sin(ang);
  transformed.yz = vec2(pivot + y * c - transformed.z * s, y * s + transformed.z * c);
}
transformed.y += abs(sw) * 0.035;`,
        );
    });
    this.mesh = new InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'pedestrians';
    const col = new Color();
    for (let i = 0; i < capacity; i++) {
      const c = SHIRTS[this.rng.int(0, SHIRTS.length - 1)]!;
      this.mesh.setColorAt(i, col.setRGB(c[0], c[1], c[2]));
      const speed = 1.05 + this.rng.float() * 0.6;
      this.look.setXYZW(i, this.rng.float() * 6.28, this.rng.float(), this.rng.float(), 5.6 * (speed / 1.3));
      this.peds.push({ loop: -1, u: 0, dir: this.rng.chance(0.5) ? 1 : -1, speed });
    }
    this.mesh.count = 0;
  }

  get count(): number {
    return this.active;
  }

  get loopCount(): number {
    return this.loops.length;
  }

  private addLoop(pts: Array<[number, number]>, closed: boolean, weight: number): void {
    if (closed) pts.push([pts[0]![0], pts[0]![1]]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
    const total = cum[cum.length - 1]!;
    if (total < 20) return;
    let cx = 0,
      cz = 0;
    for (const p of pts) {
      cx += p[0];
      cz += p[1];
    }
    this.loops.push({ pts, cum, total, closed, weight, cx: cx / pts.length, cz: cz / pts.length });
  }

  private buildLoops(L: CityLayout): void {
    // Narrow sidewalks (Istanbul, 3 m) are walked down their middle.
    const inset = L.sidewalk !== undefined ? L.sidewalk / 2 : WALK_INSET;
    for (const b of L.blocks) {
      const w = b.maxX - b.minX,
        d = b.maxZ - b.minZ;
      if (w < inset * 3 || d < inset * 3) continue;
      const x0 = b.minX + inset,
        x1 = b.maxX - inset,
        z0 = b.minZ + inset,
        z1 = b.maxZ - inset;
      const weight = b.district === D_DOWNTOWN ? 3 : b.district === D_MID ? 2 : b.district === D_LOW ? 1 : 1.5;
      this.addLoop(
        [
          [x0, z0],
          [x1, z0],
          [x1, z1],
          [x0, z1],
        ],
        true,
        weight * ((w + d) / 200),
      );
    }
    for (const path of L.paths) {
      if (path.points.length < 2) continue;
      this.addLoop(
        path.points.map((p) => [p[0], p[1]] as [number, number]),
        false,
        1.2,
      );
    }
  }

  setCount(n: number, nearX: number, nearZ: number): void {
    n = Math.max(0, Math.min(this.capacity, Math.floor(n)));
    if (this.loops.length === 0) n = 0;
    while (this.active < n) {
      this.place(this.peds[this.active]!, nearX, nearZ, 0, 230);
      this.active++;
    }
    this.active = Math.min(this.active, n);
    this.mesh.count = this.active;
  }

  /** Put a walker on a random loop (weighted) whose centre lies within [minR, maxR] of the point. */
  private place(p: Ped, x: number, z: number, minR: number, maxR: number, viewX = 0, viewZ = 0): void {
    for (let tries = 0; tries < 40; tries++) {
      const li = this.rng.int(0, this.loops.length - 1);
      const l = this.loops[li]!;
      if (this.rng.float() * 3 > l.weight) continue;
      const u = this.rng.float() * l.total;
      const pt = this.pointAt(l, u);
      const d = Math.hypot(pt[0] - x, pt[1] - z);
      if (d < minR || d > maxR) continue;
      // Out of view: behind the camera, or far away.
      if ((viewX !== 0 || viewZ !== 0) && d < 160 && (pt[0] - x) * viewX + (pt[1] - z) * viewZ > -0.2 * d) continue;
      p.loop = li;
      p.u = u;
      return;
    }
    if (p.loop < 0) {
      p.loop = this.rng.int(0, this.loops.length - 1);
      p.u = this.rng.float() * this.loops[p.loop]!.total;
    }
  }

  private readonly pt: [number, number] = [0, 0];

  private pointAt(l: Loop, u: number): [number, number] {
    let seg = 0;
    while (seg < l.cum.length - 2 && l.cum[seg + 1]! < u) seg++;
    const a = l.pts[seg]!,
      b = l.pts[seg + 1]!;
    const t = (u - l.cum[seg]!) / (l.cum[seg + 1]! - l.cum[seg]! || 1);
    this.pt[0] = a[0] + (b[0] - a[0]) * t;
    this.pt[1] = a[1] + (b[1] - a[1]) * t;
    return this.pt;
  }

  update(dt: number, playerX: number, playerZ: number, viewX = 0, viewZ = 0): void {
    if (this.active === 0) return;
    dt = Math.min(dt, 0.1);
    // Keep the crowd around the player: re-home far walkers out of view.
    this.relocateTimer -= dt;
    if (this.relocateTimer <= 0) {
      this.relocateTimer = 0.2;
      for (let k = 0; k < 20; k++) {
        this.relocateCursor = (this.relocateCursor + 1) % this.active;
        const p = this.peds[this.relocateCursor]!;
        const l = this.loops[p.loop]!;
        if (Math.hypot(l.cx - playerX, l.cz - playerZ) > 300) this.place(p, playerX, playerZ, 30, 230, viewX, viewZ);
      }
    }
    const mesh = this.mesh;
    for (let i = 0; i < this.active; i++) {
      const p = this.peds[i]!;
      const l = this.loops[p.loop]!;
      p.u += p.dir * p.speed * dt;
      if (l.closed) {
        p.u = ((p.u % l.total) + l.total) % l.total;
      } else if (p.u < 0 || p.u > l.total) {
        p.dir = -p.dir;
        p.u = Math.max(0, Math.min(l.total, p.u));
      }
      // Locate the segment.
      let seg = 0;
      while (seg < l.cum.length - 2 && l.cum[seg + 1]! < p.u) seg++;
      const a = l.pts[seg]!,
        b = l.pts[seg + 1]!;
      const segLen = l.cum[seg + 1]! - l.cum[seg]! || 1;
      const t = (p.u - l.cum[seg]!) / segLen;
      const x = a[0] + (b[0] - a[0]) * t,
        z = a[1] + (b[1] - a[1]) * t;
      const dx = (b[0] - a[0]) * p.dir,
        dz = (b[1] - a[1]) * p.dir;
      this.q.setFromAxisAngle(this.up, Math.atan2(dx, dz));
      this.p.set(x, this.groundY(x, z), z);
      this.m.compose(this.p, this.q, this.s);
      mesh.setMatrixAt(i, this.m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}
