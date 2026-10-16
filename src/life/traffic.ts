import { InstancedBufferAttribute, InstancedMesh, Matrix4, MeshToonMaterial, Quaternion, Vector3, Color, DynamicDrawUsage } from 'three';
import { GeomBuilder } from '../render/geomBuilder';
import { shared, toonGradient, withMRT } from '../render/materials';
import { CAR_COLORS } from '../world/render/propsGeo';
import { Rng } from '../core/rng';
import type { CityLayout } from '../world/types';
import { SIGNAL_CYCLE, laneNetFor, type LaneLink, type LaneNode } from './roadNet';
import { getMap } from '../maps/registry';

const CAR_LEN = 4.6;
const MIN_GAP = 2.6;
const ACCEL = 3.2;
const DECEL = 6.5;
/** Traffic light cycle (s): north-south green, yellow, east-west green, yellow. */
const CYCLE = SIGNAL_CYCLE;
const GREEN = 11;
const YELLOW = 2;

/** A lane link with the cars on it, front first. */
interface Link extends LaneLink {
  cars: number[];
}

interface Car {
  link: number;
  s: number;
  speed: number;
  maxSpeed: number;
  braking: boolean;
  /** Inside an intersection: quadratic Bezier p0 -> c -> p1 toward link `next`. */
  turning: boolean;
  t: number;
  arc: number;
  next: number;
  p0x: number;
  p0z: number;
  cx: number;
  cz: number;
  p1x: number;
  p1z: number;
  x: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** Car geometry with per-vertex paint mask, light emission and taxi-sign flags. */
function carGeometry(): ReturnType<GeomBuilder['build']> {
  const g = new GeomBuilder([
    { name: 'aPaint', size: 1 },
    { name: 'aEmit', size: 1 },
    { name: 'aTaxi', size: 1 },
  ]);
  const part = (paint: number, emit: number, taxi: number, draw: () => void): void => {
    g.setExtra('aPaint', paint);
    g.setExtra('aEmit', emit);
    g.setExtra('aTaxi', taxi);
    draw();
  };
  part(1, 0, 0, () => {
    g.setColor(1, 1, 1);
    g.box(-0.9, 0.32, -2.2, 0.9, 0.95, 2.2, 63 & ~8);
    g.setColor(0.92, 0.92, 0.92);
    g.box(-0.78, 0.95, -1.15, 0.78, 1.42, 0.85, 63 & ~8);
  });
  part(0, 0, 0, () => {
    g.setColor(0.12, 0.16, 0.22);
    g.box(-0.8, 1.0, -1.1, 0.8, 1.36, 0.8, 1 | 2 | 16 | 32);
    g.setColor(0.18, 0.18, 0.2);
    g.box(-0.92, 0.3, 2.18, 0.92, 0.55, 2.3, 63 & ~8);
    g.box(-0.92, 0.3, -2.3, 0.92, 0.55, -2.18, 63 & ~8);
    g.setColor(0.08, 0.08, 0.09);
    for (const wx of [-0.86, 0.86]) {
      for (const wz of [-1.35, 1.35]) {
        const start = g.vertexCount;
        g.cylinder(0, 0, -0.14, 0.14, 0.34, 0.34, 7, true);
        g.transformRange(start, (v, n) => {
          v.set(v.y + wx, v.x + 0.34, v.z + wz);
          n.set(n.y, n.x, n.z);
        });
      }
    }
  });
  // Head lights (white) and tail lights (red, aEmit 2 marks brake lights).
  part(0, 1, 0, () => {
    g.setColor(1, 0.95, 0.75);
    g.box(-0.8, 0.62, 2.2, -0.45, 0.8, 2.31, 16);
    g.box(0.45, 0.62, 2.2, 0.8, 0.8, 2.31, 16);
  });
  part(0, 2, 0, () => {
    g.setColor(1, 0.1, 0.08);
    g.box(-0.8, 0.62, -2.31, -0.5, 0.8, -2.2, 32);
    g.box(0.5, 0.62, -2.31, 0.8, 0.8, -2.2, 32);
  });
  // Fictional cab roof sign (only shown on taxis).
  part(0, 1, 1, () => {
    g.setColor(1, 0.86, 0.3);
    g.box(-0.3, 1.42, -0.2, 0.3, 1.62, 0.2, 63 & ~8);
  });
  return g.build();
}

/**
 * Instanced traffic on the street grid. Cars follow their right-hand lane,
 * keep a gap to the car ahead, stop at red lights (north-south and east-west
 * phases with a green wave), and choose straight/right/left at intersections
 * (forced turns at the island edge and around the park). Visual only: the
 * player passes through cars.
 */
export class Traffic {
  readonly mesh: InstancedMesh;
  private readonly nodes: LaneNode[] = [];
  private readonly links: Link[] = [];
  /** Road level under a car (terrain of the map). */
  private readonly ground: (x: number, z: number) => number;
  private readonly q2 = new Quaternion();
  private readonly right = new Vector3(1, 0, 0);
  private readonly cars: Car[] = [];
  private active = 0;
  private time = 0;
  private readonly rng: Rng;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly sc = new Vector3(1, 1, 1);
  private readonly up = new Vector3(0, 1, 0);
  private readonly brake: InstancedBufferAttribute;
  private relocateTimer = 0;
  private relocateCursor = 0;
  private readonly taxi: InstancedBufferAttribute;

  constructor(
    private readonly layout: CityLayout,
    readonly capacity: number,
    seed: number,
  ) {
    this.rng = new Rng(seed * 31 + 7);
    const terrain = getMap(layout.mapId).createTerrain(layout);
    this.ground = (x, z) => terrain.baseHeight(x, z);
    this.buildGraph();
    const geo = carGeometry();
    this.brake = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.brake.setUsage(DynamicDrawUsage);
    this.taxi = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    geo.setAttribute('iBrake', this.brake);
    geo.setAttribute('iTaxi', this.taxi);
    const mat = new MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
    withMRT(mat, true, 'traffic', (shader) => {
      shader.uniforms.uNight = shared.uNight;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float aPaint;\nattribute float aEmit;\nattribute float aTaxi;\nattribute float iBrake;\nattribute float iTaxi;\nvarying float vEmit;',
        )
        .replace(
          '#include <color_vertex>',
          `vColor = vec4(1.0);
#ifdef USE_COLOR
  vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.rgb = mix(vColor.rgb, vColor.rgb * instanceColor.rgb, aPaint);
#endif
vEmit = aEmit > 1.5 ? 0.35 + 0.65 * iBrake + 0.01 : aEmit;`,
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nif (aTaxi > 0.5 && iTaxi < 0.5) transformed = vec3(0.0, 1.0, 0.0);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying float vEmit;')
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * vEmit * (0.25 + 1.5 * uNight);',
        );
    });
    this.mesh = new InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'traffic';
    const col = new Color();
    for (let i = 0; i < capacity; i++) {
      const isTaxi = this.rng.float() < 0.2;
      const c = isTaxi ? ([0.98, 0.78, 0.12] as [number, number, number]) : CAR_COLORS[this.rng.int(0, CAR_COLORS.length - 1)]!;
      this.mesh.setColorAt(i, col.setRGB(c[0], c[1], c[2]));
      this.taxi.setX(i, isTaxi ? 1 : 0);
      this.cars.push({
        link: -1,
        s: 0,
        speed: 0,
        maxSpeed: 8.5 + this.rng.float() * 5,
        braking: false,
        turning: false,
        t: 0,
        arc: 1,
        next: -1,
        p0x: 0,
        p0z: 0,
        cx: 0,
        cz: 0,
        p1x: 0,
        p1z: 0,
        x: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
      });
    }
    this.mesh.count = 0;
  }

  get count(): number {
    return this.active;
  }

  get nodeCount(): number {
    return this.nodes.length;
  }

  get linkCount(): number {
    return this.links.length;
  }

  /** The lane graph: the street grid on Manhattan, the road pieces on Istanbul (see roadNet.ts). */
  private buildGraph(): void {
    const net = laneNetFor(this.layout);
    for (const n of net.nodes) this.nodes.push(n);
    for (const l of net.links) this.links.push({ ...l, cars: [] });
  }

  /** Green for a link arriving at node `n` (north-south or east-west phase by its heading; yellow counts as stop). */
  private green(n: LaneNode, l: LaneLink): boolean {
    if (!n.signal) return true;
    const t = (this.time + n.offset) % CYCLE;
    const ns = t < GREEN;
    const ew = t >= GREEN + YELLOW && t < 2 * GREEN + YELLOW;
    return Math.abs(l.ez) >= Math.abs(l.ex) ? ns : ew;
  }

  /** Point and heading on a link at arc length s. */
  private along(l: Link, s: number, out: { x: number; z: number; hx: number; hz: number }): void {
    const n = l.cum.length;
    let i = 0;
    while (i < n - 2 && l.cum[i + 1]! < s) i++;
    const seg = l.cum[i + 1]! - l.cum[i]!;
    const t = seg > 0 ? Math.max(0, Math.min(1, (s - l.cum[i]!) / seg)) : 0;
    const ax = l.pts[i * 2]!,
      az = l.pts[i * 2 + 1]!,
      bx = l.pts[i * 2 + 2]!,
      bz = l.pts[i * 2 + 3]!;
    out.x = ax + (bx - ax) * t;
    out.z = az + (bz - az) * t;
    const d = Math.hypot(bx - ax, bz - az) || 1;
    out.hx = (bx - ax) / d;
    out.hz = (bz - az) / d;
  }

  private readonly ap = { x: 0, z: 0, hx: 0, hz: 1 };

  /** Set the number of active cars (quality preset); new cars spawn around the given point. */
  setCount(n: number, nearX = 0, nearZ = 0): void {
    n = Math.max(0, Math.min(this.capacity, Math.floor(n)));
    if (this.links.length === 0) n = 0;
    while (this.active < n) {
      const car = this.cars[this.active]!;
      if (!this.place(car, this.active, nearX, nearZ, 0, 340) && !this.place(car, this.active)) break;
      this.active++;
    }
    while (this.active > n) {
      this.active--;
      const car = this.cars[this.active]!;
      if (car.link >= 0 && !car.turning) {
        const list = this.links[car.link]!.cars;
        const k = list.indexOf(this.active);
        if (k >= 0) list.splice(k, 1);
      }
      car.link = -1;
      car.turning = false;
    }
    this.mesh.count = this.active;
  }

  private place(car: Car, id: number, nearX = 0, nearZ = 0, minR = 0, maxR = Infinity, viewX = 0, viewZ = 0): boolean {
    for (let tries = 0; tries < 60; tries++) {
      const li = this.rng.int(0, this.links.length - 1);
      const link = this.links[li]!;
      const s = this.rng.float() * Math.max(0, link.len - CAR_LEN);
      if (maxR < Infinity) {
        this.along(link, s, this.ap);
        const px = this.ap.x,
          pz = this.ap.z;
        const d = Math.hypot(px - nearX, pz - nearZ);
        if (d < minR || d > maxR) continue;
        // Out of view: behind the camera, or beyond 220 m.
        if ((viewX !== 0 || viewZ !== 0) && d < 220 && (px - nearX) * viewX + (pz - nearZ) * viewZ > -0.2 * d) continue;
      }
      let free = true;
      for (const o of link.cars) {
        if (Math.abs(this.cars[o]!.s - s) < CAR_LEN + MIN_GAP + 1) {
          free = false;
          break;
        }
      }
      if (!free) continue;
      car.link = li;
      car.s = s;
      car.speed = car.maxSpeed * 0.6;
      car.turning = false;
      link.cars.push(id);
      link.cars.sort((a, b) => this.cars[b]!.s - this.cars[a]!.s);
      this.pose(car);
      return true;
    }
    return false;
  }

  private pose(car: Car): void {
    if (car.turning) {
      const t = car.t,
        u = 1 - t;
      car.x = u * u * car.p0x + 2 * u * t * car.cx + t * t * car.p1x;
      car.z = u * u * car.p0z + 2 * u * t * car.cz + t * t * car.p1z;
      const dx = 2 * u * (car.cx - car.p0x) + 2 * t * (car.p1x - car.cx);
      const dz = 2 * u * (car.cz - car.p0z) + 2 * t * (car.p1z - car.cz);
      if (dx * dx + dz * dz > 1e-8) car.yaw = Math.atan2(dx, dz);
      return;
    }
    const l = this.links[car.link]!;
    this.along(l, car.s, this.ap);
    car.x = this.ap.x;
    car.z = this.ap.z;
    car.yaw = Math.atan2(this.ap.hx, this.ap.hz);
  }

  /**
   * Choose the next link at node `n` arriving with heading (hx, hz): straight
   * (within 30 degrees) 68 %, else right, else left; a U-turn only at a dead end.
   */
  private choose(n: LaneNode, hx: number, hz: number): number {
    let straight = -1,
      right = -1,
      left = -1,
      back = -1;
    let bs = -2;
    for (const li of n.out) {
      const o = this.links[li]!;
      const dot = hx * o.sx + hz * o.sz;
      const cross = hx * o.sz - hz * o.sx;
      if (dot > 0.866) {
        if (dot > bs) {
          bs = dot;
          straight = li;
        }
      } else if (dot < -0.866) back = li;
      else if (cross > 0) {
        if (right < 0) right = li;
      } else if (left < 0) left = li;
    }
    const r = this.rng.float();
    if (straight >= 0 && (r < 0.68 || (right < 0 && left < 0))) return straight;
    if (right >= 0 && (r < 0.9 || left < 0)) return right;
    if (left >= 0) return left;
    if (straight >= 0) return straight;
    return back; // dead end: U-turn
  }

  update(dt: number, playerX: number, playerZ: number, viewX = 0, viewZ = 0): void {
    if (this.active === 0) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    // Keep traffic around the player: cars far away move to free spots nearby,
    // either behind the camera or far enough that the swap is not noticed.
    this.relocateTimer -= dt;
    if (this.relocateTimer <= 0) {
      this.relocateTimer = 0.2;
      for (let k = 0; k < 16; k++) {
        this.relocateCursor = (this.relocateCursor + 1) % this.active;
        const id = this.relocateCursor;
        const car = this.cars[id]!;
        if (car.turning || Math.hypot(car.x - playerX, car.z - playerZ) < 380) continue;
        const list = this.links[car.link]!.cars;
        const at = list.indexOf(id);
        if (at >= 0) list.splice(at, 1);
        if (!this.place(car, id, playerX, playerZ, 50, 340, viewX, viewZ) && !this.place(car, id)) {
          list.push(id);
          list.sort((a, b) => this.cars[b]!.s - this.cars[a]!.s);
        }
      }
    }
    // Links: car following and red lights, front to back.
    for (let li = 0; li < this.links.length; li++) {
      const link = this.links[li]!;
      const list = link.cars;
      if (list.length === 0) continue;
      const node = this.nodes[link.to]!;
      const green = this.green(node, link);
      let leaderS = Infinity;
      for (let k = 0; k < list.length; k++) {
        const car = this.cars[list[k]!]!;
        let limit = car.maxSpeed;
        const gap = leaderS - car.s - CAR_LEN - MIN_GAP;
        if (gap < Infinity) limit = Math.min(limit, Math.sqrt(2 * DECEL * Math.max(0, gap)));
        // Stop line: only if the car can still stop before it.
        const toStop = link.len - car.s;
        if (!green && toStop > car.speed * car.speed / (2 * DECEL) * 0.6) limit = Math.min(limit, Math.sqrt(2 * DECEL * Math.max(0, toStop - 0.5)));
        const dv = limit - car.speed;
        car.braking = dv < -0.2 || (car.speed < 0.5 && limit < 0.5);
        car.speed = Math.max(0, car.speed + Math.max(-DECEL * dt, Math.min(ACCEL * dt, dv)));
        car.s += car.speed * dt;
        leaderS = car.s;
      }
      // Cars past the stop line enter the intersection (front of the list first).
      while (list.length > 0) {
        const id = list[0]!;
        const car = this.cars[id]!;
        if (car.s < link.len) break;
        list.shift();
        this.enterTurn(car, link, node);
      }
    }
    // Intersections.
    for (let i = 0; i < this.active; i++) {
      const car = this.cars[i]!;
      if (!car.turning) continue;
      car.speed = Math.min(car.maxSpeed * 0.8, car.speed + ACCEL * dt);
      car.t += (car.speed * dt) / car.arc;
      if (car.t >= 1) {
        car.turning = false;
        car.link = car.next;
        const l = this.links[car.link]!;
        car.s = Math.max(0, (car.t - 1) * car.arc);
        // Enter behind any car already on the link.
        let back = l.len;
        for (const o of l.cars) back = Math.min(back, this.cars[o]!.s);
        car.s = Math.min(car.s, Math.max(0, back - CAR_LEN - MIN_GAP));
        l.cars.push(i);
      }
    }
    // Instances.
    const mesh = this.mesh;
    for (let i = 0; i < this.active; i++) {
      const car = this.cars[i]!;
      this.pose(car);
      this.q.setFromAxisAngle(this.up, car.yaw);
      // On a slope the car follows the road level and pitches with it (0 on a flat map).
      const y = this.ground(car.x, car.z);
      const fx = Math.sin(car.yaw),
        fz = Math.cos(car.yaw);
      const rise = this.ground(car.x + fx * 1.6, car.z + fz * 1.6) - this.ground(car.x - fx * 1.6, car.z - fz * 1.6);
      if (rise !== 0) this.q.multiply(this.q2.setFromAxisAngle(this.right, -Math.atan2(rise, 3.2)));
      this.p.set(car.x, y, car.z);
      this.m.compose(this.p, this.q, this.sc);
      mesh.setMatrixAt(i, this.m);
      this.brake.setX(i, car.braking ? 1 : 0);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.brake.needsUpdate = true;
  }

  private enterTurn(car: Car, link: Link, node: LaneNode): void {
    const next = this.choose(node, link.ex, link.ez);
    if (next < 0) {
      // Isolated link (should not happen): wrap to its start.
      car.s = 0;
      link.cars.push(this.cars.indexOf(car));
      return;
    }
    const out = this.links[next]!;
    car.turning = true;
    car.next = next;
    car.t = 0;
    const n = link.pts.length;
    car.p0x = link.pts[n - 2]!;
    car.p0z = link.pts[n - 1]!;
    car.p1x = out.pts[0]!;
    car.p1z = out.pts[1]!;
    // Control point: where the arriving and the leaving lane lines meet (the corner of a turn), else the middle.
    const cross = link.ex * out.sz - link.ez * out.sx;
    car.cx = (car.p0x + car.p1x) / 2;
    car.cz = (car.p0z + car.p1z) / 2;
    if (Math.abs(cross) > 0.2) {
      const t = ((car.p1x - car.p0x) * out.sz - (car.p1z - car.p0z) * out.sx) / cross;
      const span = Math.hypot(car.p1x - car.p0x, car.p1z - car.p0z);
      if (t > 0 && t < span * 1.5) {
        car.cx = car.p0x + link.ex * t;
        car.cz = car.p0z + link.ez * t;
      }
    }
    car.arc = Math.max(1, (Math.hypot(car.cx - car.p0x, car.cz - car.p0z) + Math.hypot(car.p1x - car.cx, car.p1z - car.cz)) * 0.92);
  }

  /** Diagnostics for tests: cars per state and how many are stopped. */
  stats(): { active: number; turning: number; stopped: number; meanSpeed: number } {
    let turning = 0,
      stopped = 0,
      sum = 0;
    for (let i = 0; i < this.active; i++) {
      const c = this.cars[i]!;
      if (c.turning) turning++;
      if (c.speed < 0.3) stopped++;
      sum += c.speed;
    }
    return { active: this.active, turning, stopped, meanSpeed: this.active ? sum / this.active : 0 };
  }

  /** Positions of active cars (tests: never inside buildings, always on roads). */
  positions(out: Array<[number, number]>): void {
    out.length = 0;
    for (let i = 0; i < this.active; i++) out.push([this.cars[i]!.x, this.cars[i]!.z]);
  }
}
