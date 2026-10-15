import { Color, DynamicDrawUsage, InstancedMesh, Matrix4, MeshToonMaterial, Quaternion, TorusGeometry, Vector3 } from 'three';
import { shared, toonGradient, withMRT } from '../render/materials';
import type { CollisionWorld } from '../physics/collision';
import type { CityLayout } from '../world/types';
import { loadBestTimes, saveBestTimes } from '../ui/settings';

export const RING_RADIUS = 5;
/** A run is quietly dropped when the next ring is not reached in this time (no fail screen). */
const RING_TIMEOUT = 45;
/** Time the finish banner stays on the HUD. */
const FINISH_SHOW = 5;

export interface Ring {
  x: number;
  y: number;
  z: number;
  /** Unit normal, pointing along the route. */
  nx: number;
  ny: number;
  nz: number;
  route: number;
  index: number;
}

export interface RouteInfo {
  id: 'park' | 'downtown' | 'waterfront';
  rings: Ring[];
}

export type RingEvent = { type: 'start'; route: number } | { type: 'pass'; route: number; index: number } | { type: 'finish'; route: number; time: number; best: number; newBest: boolean };

export interface RingHud {
  route: number;
  index: number;
  total: number;
  time: number;
  best: number | null;
  finished: null | { time: number; best: number; newBest: boolean };
}

/**
 * Three optional ring routes (park, downtown towers, waterfront). Flying
 * through the first ring of a route starts a timed run; rings must be passed
 * in order; best times persist in localStorage. Never forced: an abandoned
 * run simply ends.
 */
export class RingRaces {
  readonly routes: RouteInfo[] = [];
  readonly mesh: InstancedMesh;
  private readonly all: Ring[] = [];
  private nearTrees: CityLayout['trees'] = [];
  private nearBuildings: CityLayout['buildings'] = [];
  private active = -1;
  private next = 0;
  private elapsed = 0;
  private sinceRing = 0;
  private finished: RingHud['finished'] = null;
  private finishedRoute = -1;
  private finishT = 0;
  private best: Record<string, number>;
  private time = 0;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly sc = new Vector3();
  private readonly z = new Vector3(0, 0, 1);
  private readonly col = new Color();
  onEvent: ((e: RingEvent) => void) | null = null;

  constructor(
    private readonly layout: CityLayout,
    private readonly world: CollisionWorld,
  ) {
    this.best = loadBestTimes();
    this.buildRoutes();
    for (const r of this.routes) for (const g of r.rings) this.all.push(g);
    const mat = new MeshToonMaterial({ vertexColors: false, gradientMap: toonGradient() });
    withMRT(mat, true, 'rings', (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n#ifdef USE_INSTANCING_COLOR\ntotalEmissiveRadiance += vColor.rgb * 0.85;\n#endif',
      );
    });
    this.mesh = new InstancedMesh(new TorusGeometry(RING_RADIUS, 0.42, 10, 56), mat, Math.max(1, this.all.length));
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.name = 'rings';
    for (let i = 0; i < this.all.length; i++) this.mesh.setColorAt(i, this.col.setRGB(1, 0.7, 0.15));
    this.mesh.count = this.all.length;
    this.refresh();
  }

  get ringCount(): number {
    return this.all.length;
  }

  /** Route id by index. */
  routeId(i: number): RouteInfo['id'] {
    return this.routes[i]!.id;
  }

  // ------------------------------------------------------------------ layout

  private buildRoutes(): void {
    const L = this.layout;
    // Park: south edge to north edge, skirting the pond; each ring sits in a
    // gap between canopies with tall trees ahead to swing from.
    {
      const P = L.park;
      const pd = L.pond;
      const cx = (P.minX + P.maxX) / 2;
      const side = pd.cx - pd.rx - P.minX > P.maxX - (pd.cx + pd.rx) ? (P.minX + pd.cx - pd.rx) / 2 : (P.maxX + pd.cx + pd.rx) / 2;
      const pts: Array<[number, number, number]> = [];
      for (let i = 0; i < 7; i++) {
        const u = i / 6;
        const z = P.maxZ - 14 - u * (P.maxZ - P.minZ - 28);
        const x = i === 0 || i === 6 ? cx : side + Math.sin(i * 1.7) * 18;
        pts.push([x, 9 + (i % 2) * 2, z]);
      }
      this.addRoute('park', pts);
    }
    // Downtown towers: along the avenue through the tallest buildings.
    {
      const tall = [...L.buildings].sort((a, b) => b.height - a.height).slice(0, 16);
      let bx = 0,
        bz = 0;
      for (const b of tall) {
        bx += (b.footprint.minX + b.footprint.maxX) / 2;
        bz += (b.footprint.minZ + b.footprint.maxZ) / 2;
      }
      bx /= tall.length;
      bz /= tall.length;
      let ave = L.avenues[0]!;
      for (const a of L.avenues) if (!a.perimeter && Math.abs(a.center - bx) < Math.abs(ave.center - bx)) ave = a;
      const zMax = Math.min(L.land.maxZ - 80, bz + 240),
        zMin = Math.max(L.land.minZ + 80, zMax - 480);
      const pts: Array<[number, number, number]> = [];
      for (let i = 0; i < 7; i++) {
        const z = zMax - (i / 6) * (zMax - zMin);
        pts.push([ave.center + (i % 2 === 0 ? -3 : 3), 34 + (i % 3) * 12, z]);
      }
      this.addRoute('downtown', pts);
    }
    // Waterfront: along the east promenade toward the bridge.
    {
      // Over the waterfront drive, between the last row of buildings and the promenade.
      const edge = L.avenues[L.avenues.length - 1]!;
      const x = edge.center;
      const pts: Array<[number, number, number]> = [];
      for (let i = 0; i < 5; i++) pts.push([x, 10 + (i % 2) * 3, -420 + i * 80]);
      const deck = L.bridge.deck;
      const tower = L.bridge.towers[0];
      pts.push([tower ? tower.minX - 14 : deck.minX + 40, deck.maxY + 9, (deck.minZ + deck.maxZ) / 2]);
      this.addRoute('waterfront', pts);
    }
  }

  private addRoute(id: RouteInfo['id'], pts: Array<[number, number, number]>): void {
    const route = this.routes.length;
    const rings: Ring[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      // Find a spot whose whole disc is clear of solid geometry near the wanted
      // point, preferring spots with tall anchors (trees, buildings) ahead.
      const prev = pts[Math.max(0, i - 1)]!,
        nxt = pts[Math.min(pts.length - 1, i + 1)]!;
      let dx = nxt[0] - prev[0],
        dz = nxt[2] - prev[2];
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl;
      dz /= dl;
      // Candidate anchors near this waypoint only (keeps the search cheap).
      this.nearTrees = this.layout.trees.filter((t) => Math.abs(t.x - p[0]) < 80 && Math.abs(t.z - p[2]) < 80);
      this.nearBuildings = this.layout.buildings.filter((b) => {
        const f = b.footprint;
        return f.maxX > p[0] - 85 && f.minX < p[0] + 85 && f.maxZ > p[2] - 85 && f.minZ < p[2] + 85;
      });
      let best: [number, number, number] | null = null;
      let bestScore = -1;
      for (const r of [0, 6, 12, 18, 24, 30]) {
        const n = r === 0 ? 1 : 10;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + i;
          const x = p[0] + Math.cos(a) * r,
            z = p[2] + Math.sin(a) * r;
          for (const dy of [0, 2, -2, 4]) {
            const y = p[1] + dy;
            if (!this.clear(x, y, z)) continue;
            const score = this.anchorScore(x, y, z, dx, dz) - r * 0.02;
            if (score > bestScore) {
              bestScore = score;
              best = [x, y, z];
            }
          }
        }
      }
      if (!best) {
        let y = p[1];
        for (let k = 0; k < 12 && !this.clear(p[0], y, p[2]); k++) y += 3;
        best = [p[0], y, p[2]];
      }
      rings.push({ x: best[0], y: best[1], z: best[2], nx: 0, ny: 0, nz: 1, route, index: i });
    }
    for (let i = 0; i < rings.length; i++) {
      const a = rings[Math.max(0, i - 1)]!,
        b = rings[Math.min(rings.length - 1, i + 1)]!;
      const r = rings[i]!;
      let dx = b.x - a.x,
        dy = (b.y - a.y) * 0.3,
        dz = b.z - a.z;
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l;
      dy /= l;
      dz /= l;
      r.nx = dx;
      r.ny = dy;
      r.nz = dz;
    }
    this.routes.push({ id, rings });
  }

  /** How many tall anchors (tree tops, roofs) stand ahead of a ring at swinging distance. */
  private anchorScore(x: number, y: number, z: number, dx: number, dz: number): number {
    let n = 0;
    for (const t of this.nearTrees) {
      const ox = t.x - x,
        oz = t.z - z;
      const d = Math.hypot(ox, oz);
      if (d < 8 || d > 40 || t.y + t.height < y + 9 || ox * dx + oz * dz < -4) continue;
      n++;
    }
    for (const b of this.nearBuildings) {
      const f = b.footprint;
      const ox = Math.max(f.minX - x, 0, x - f.maxX),
        oz = Math.max(f.minZ - z, 0, z - f.maxZ);
      const d = Math.hypot(ox, oz);
      if (d < 4 || d > 45 || b.height < y + 9) continue;
      const cx = (f.minX + f.maxX) / 2 - x,
        cz = (f.minZ + f.maxZ) / 2 - z;
      if (cx * dx + cz * dz < -10) continue;
      n += 2;
    }
    return Math.min(n, 12);
  }

  /** True when a sphere slightly larger than the ring is free of colliders (foliage counts as solid here). */
  clear(x: number, y: number, z: number): boolean {
    return this.world.spherePenetration(x, y, z, RING_RADIUS + 0.6, 0) <= 0;
  }

  // -------------------------------------------------------------------- race

  /** Segment test for one simulation tick (player chest point from p0 to p1). */
  check(p0: Vector3, p1: Vector3, dt: number): void {
    this.time += dt;
    if (this.active >= 0) {
      this.elapsed += dt;
      this.sinceRing += dt;
      if (this.sinceRing > RING_TIMEOUT) this.active = -1;
    }
    if (this.finished) {
      this.finishT += dt;
      if (this.finishT > FINISH_SHOW) {
        this.finished = null;
        this.finishedRoute = -1;
      }
    }
    // Start rings of every route, plus the next ring of the active run.
    for (let r = 0; r < this.routes.length; r++) {
      const ring = this.routes[r]!.rings[0]!;
      if (this.crosses(ring, p0, p1)) {
        this.active = r;
        this.next = 1;
        this.elapsed = 0;
        this.sinceRing = 0;
        this.finished = null;
        this.onEvent?.({ type: 'start', route: r });
        this.onEvent?.({ type: 'pass', route: r, index: 0 });
        return;
      }
    }
    if (this.active < 0) return;
    const rings = this.routes[this.active]!.rings;
    const ring = rings[this.next]!;
    if (!this.crosses(ring, p0, p1)) return;
    this.next++;
    this.sinceRing = 0;
    this.onEvent?.({ type: 'pass', route: this.active, index: ring.index });
    if (this.next >= rings.length) {
      const id = this.routes[this.active]!.id;
      const prev = this.best[id];
      const newBest = prev === undefined || this.elapsed < prev;
      if (newBest) {
        this.best[id] = this.elapsed;
        saveBestTimes(this.best);
      }
      this.finished = { time: this.elapsed, best: this.best[id]!, newBest };
      this.finishedRoute = this.active;
      this.finishT = 0;
      this.onEvent?.({ type: 'finish', route: this.active, time: this.elapsed, best: this.best[id]!, newBest });
      this.active = -1;
    }
  }

  private crosses(r: Ring, p0: Vector3, p1: Vector3): boolean {
    const s0 = (p0.x - r.x) * r.nx + (p0.y - r.y) * r.ny + (p0.z - r.z) * r.nz;
    const s1 = (p1.x - r.x) * r.nx + (p1.y - r.y) * r.ny + (p1.z - r.z) * r.nz;
    // Forward crossing only (route direction).
    if (!(s0 <= 0 && s1 > 0)) return false;
    const t = s0 === s1 ? 0 : s0 / (s0 - s1);
    const x = p0.x + (p1.x - p0.x) * t - r.x,
      y = p0.y + (p1.y - p0.y) * t - r.y,
      z = p0.z + (p1.z - p0.z) * t - r.z;
    return x * x + y * y + z * z < RING_RADIUS * RING_RADIUS;
  }

  /** Ends a run in progress without a result (a new game from the main menu). */
  abandon(): void {
    this.active = -1;
    this.finished = null;
    this.finishedRoute = -1;
  }

  /** HUD state (null when no run is active or being shown). */
  hud(): RingHud | null {
    if (this.active >= 0) {
      const id = this.routes[this.active]!.id;
      return { route: this.active, index: this.next, total: this.routes[this.active]!.rings.length, time: this.elapsed, best: this.best[id] ?? null, finished: null };
    }
    if (this.finished && this.finishedRoute >= 0) {
      const n = this.routes[this.finishedRoute]!.rings.length;
      return { route: this.finishedRoute, index: n, total: n, time: this.finished.time, best: this.finished.best, finished: this.finished };
    }
    return null;
  }

  /** Minimap markers: route start rings when idle, the active run's rings otherwise. */
  markers(out: Array<{ x: number; z: number; next: boolean; done: boolean; route: number }>): void {
    out.length = 0;
    for (const r of this.all) {
      const activeRoute = this.active === r.route;
      if (this.active >= 0 && !activeRoute) continue;
      if (this.active < 0 && r.index !== 0) continue;
      out.push({ x: r.x, z: r.z, next: activeRoute ? r.index === this.next : r.index === 0, done: activeRoute && r.index < this.next, route: r.route });
    }
  }

  bestTime(id: RouteInfo['id']): number | null {
    return this.best[id] ?? null;
  }

  get activeRoute(): number {
    return this.active;
  }

  // ----------------------------------------------------------------- visuals

  /** Per-frame look: next ring pulses, passed rings shrink away, idle routes show their start ring brightest. */
  refresh(): void {
    const t = shared.uTime.value;
    for (let i = 0; i < this.all.length; i++) {
      const r = this.all[i]!;
      let scale = 1;
      let k = 0.55;
      if (this.active >= 0) {
        if (r.route === this.active) {
          if (r.index < this.next) scale = 0.001;
          else if (r.index === this.next) {
            scale = 1 + 0.06 * Math.sin(t * 6);
            k = 1;
          } else k = 0.7;
        } else k = 0.25;
      } else if (r.index === 0) {
        scale = 1 + 0.05 * Math.sin(t * 3 + r.route);
        k = 1;
      }
      this.q.setFromUnitVectors(this.z, this.v.set(r.nx, r.ny, r.nz));
      this.v.set(r.x, r.y, r.z);
      this.m.compose(this.v, this.q, this.sc.set(scale, scale, scale));
      this.mesh.setMatrixAt(i, this.m);
      // Start rings: teal-amber accent per route; run rings amber.
      this.col.setRGB(1.0 * k, (0.62 + 0.1 * (r.index === 0 ? 1 : 0)) * k, 0.14 * k);
      this.mesh.setColorAt(i, this.col);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
