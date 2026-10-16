import { tuning, DEG } from '../config/tuning';
import { BOX, CollisionWorld, F_ANCHOR, F_CAMERA, F_CANOPY, makeRayHit, type RayHit } from '../physics/collision';

export interface AnchorResult {
  valid: boolean;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  id: number;
  dist: number;
  assisted: boolean;
}

export function makeAnchorResult(): AnchorResult {
  return { valid: false, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, id: -1, dist: 0, assisted: false };
}

export function copyAnchor(dst: AnchorResult, src: AnchorResult): void {
  dst.valid = src.valid;
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.nx = src.nx;
  dst.ny = src.ny;
  dst.nz = src.nz;
  dst.id = src.id;
  dst.dist = src.dist;
  dst.assisted = src.assisted;
}

const MAX_CANDS = 40;
/** Magnetism rings around the aim: [fraction of magnetismDeg, rays, phase]. */
const RINGS: ReadonlyArray<readonly [number, number, number]> = [
  [0.5, 4, Math.PI / 4],
  [1, 8, 0],
];

/**
 * Web targeting. Gameplay aims with the crosshair (`aim`): a line goes where
 * the camera centre ray hits, and when that point is unusable a ring of rays
 * within `tuning.aim.magnetismDeg` catches edges and thin trunks; with nothing
 * usable there is no line. `plan` is the wide search: the best anchorable
 * point in a forward and upward biased cone, never through geometry. Test bots
 * use it to decide where to look before they click.
 */
export class Targeting {
  /** Aiming with touch controls: the magnetism rings use `tuning.aim.touchMagnetismDeg`. */
  touchAim = false;
  private readonly hit: RayHit = makeRayHit();
  private readonly los: RayHit = makeRayHit();
  private readonly pt = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
  private readonly candBuf = new Int32Array(4096);
  private readonly cand = new Float64Array(MAX_CANDS * 8);
  private nCand = 0;
  /** Diagnostics for tests. */
  lastCandidates = 0;
  lastScored = 0;
  debug = false;
  readonly debugLog: Array<Record<string, number>> = [];

  private readonly ideals = new Float64Array(12);

  constructor(private readonly world: CollisionWorld) {}

  private insertCandidate(cost: number, id: number, x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    // Skip near-duplicates of the same collider.
    for (let c = 0; c < this.nCand; c++) {
      const o = c * 8;
      if (this.cand[o + 1] === id && Math.abs(this.cand[o + 2]! - x) + Math.abs(this.cand[o + 3]! - y) + Math.abs(this.cand[o + 4]! - z) < 1.5) {
        if (cost >= this.cand[o]!) return;
      }
    }
    let slot = this.nCand;
    if (slot >= MAX_CANDS) {
      if (cost >= this.cand[(MAX_CANDS - 1) * 8]!) return;
      slot = MAX_CANDS - 1;
    } else this.nCand++;
    while (slot > 0 && this.cand[(slot - 1) * 8]! > cost) {
      this.cand.copyWithin(slot * 8, (slot - 1) * 8, slot * 8);
      slot--;
    }
    const o = slot * 8;
    this.cand[o] = cost;
    this.cand[o + 1] = id;
    this.cand[o + 2] = x;
    this.cand[o + 3] = y;
    this.cand[o + 4] = z;
    this.cand[o + 5] = nx;
    this.cand[o + 6] = ny;
    this.cand[o + 7] = nz;
  }

  /** Line of sight from (ax,ay,az) to the anchor point, ignoring foliage and thin props. */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number, anchorId: number): boolean {
    const dx = bx - ax,
      dy = by - ay,
      dz = bz - az;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 0.5) return true;
    const w = this.world;
    // Skip canopies (porous) and colliders that do not block the camera (thin props).
    const hit = w.raycast(ax, ay, az, dx / d, dy / d, dz / d, d - 0.35, this.los, F_CANOPY, anchorId, 0, false, F_CAMERA);
    if (!hit) return true;
    return false;
  }

  /**
   * Swing (`swing`) and pull-line (`zip`) targets under the crosshair; one set
   * of rays serves both. `p*` is the player's feet, `ao*`/`ad*` the camera
   * centre ray.
   */
  aim(
    px: number,
    py: number,
    pz: number,
    aox: number,
    aoy: number,
    aoz: number,
    adx: number,
    ady: number,
    adz: number,
    swing: AnchorResult,
    zip: AnchorResult,
  ): void {
    swing.valid = false;
    zip.valid = false;
    this.aimRay(px, py, pz, aox, aoy, aoz, adx, ady, adz, false, swing, zip);
    const mag = (this.touchAim ? tuning.aim.touchMagnetismDeg : tuning.aim.magnetismDeg) * DEG;
    if ((swing.valid && zip.valid) || mag <= 0) return;
    // Basis perpendicular to the aim (u horizontal unless looking straight up or down).
    let ux = -adz,
      uy = 0,
      uz = adx;
    let ul = Math.hypot(ux, uz);
    if (ul < 1e-3) {
      ux = 1;
      uz = 0;
      ul = 1;
    }
    ux /= ul;
    uz /= ul;
    const wx = ady * uz - adz * uy,
      wy = adz * ux - adx * uz,
      wz = adx * uy - ady * ux;
    // Inner ring of 4, outer ring of 8: the closest usable ray wins.
    for (const [frac, n, phase] of RINGS) {
      const ca = Math.cos(mag * frac),
        sa = Math.sin(mag * frac);
      for (let k = 0; k < n; k++) {
        const th = phase + (k / n) * Math.PI * 2;
        const ct = Math.cos(th),
          st = Math.sin(th);
        this.aimRay(
          px,
          py,
          pz,
          aox,
          aoy,
          aoz,
          adx * ca + (ux * ct + wx * st) * sa,
          ady * ca + (uy * ct + wy * st) * sa,
          adz * ca + (uz * ct + wz * st) * sa,
          true,
          swing,
          zip,
        );
      }
      if (swing.valid && zip.valid) return;
    }
  }

  /** One aim ray: fills whichever of the two results is still empty if the hit point suits it. */
  private aimRay(
    px: number,
    py: number,
    pz: number,
    aox: number,
    aoy: number,
    aoz: number,
    dx: number,
    dy: number,
    dz: number,
    magnet: boolean,
    swing: AnchorResult,
    zip: AnchorResult,
  ): void {
    const w = this.world;
    const hy = py + tuning.body.ropeOffset;
    const camToHand = Math.hypot(px - aox, hy - aoy, pz - aoz);
    const range = camToHand + Math.max(tuning.swing.maxRange, tuning.zip.maxRange);
    if (!w.raycast(aox, aoy, aoz, dx, dy, dz, range, this.hit)) return;
    const h = this.hit;
    if (h.id < 0 || (w.flags[h.id]! & F_ANCHOR) === 0) return;
    let los = -1;
    for (const mode of [0, 1] as const) {
      const out = mode === 0 ? swing : zip;
      if (out.valid || !this.usable(mode, h, px, py, pz)) continue;
      if (los < 0) los = this.lineOfSight(px, hy, pz, h.x, h.y, h.z, h.id) ? 1 : 0;
      if (los === 0) return;
      out.valid = true;
      out.x = h.x;
      out.y = h.y;
      out.z = h.z;
      out.nx = h.nx;
      out.ny = h.ny;
      out.nz = h.nz;
      out.id = h.id;
      out.dist = Math.hypot(h.x - px, h.y - hy, h.z - pz);
      out.assisted = magnet;
    }
  }

  /** Range, height, steepness, facing and face rules for a hit point (line of sight is checked separately). */
  private usable(mode: 0 | 1, h: RayHit, px: number, py: number, pz: number): boolean {
    const S = tuning.swing;
    const hy = py + tuning.body.ropeOffset;
    const d = Math.hypot(h.x - px, h.y - hy, h.z - pz);
    if (d > (mode === 0 ? S.maxRange : tuning.zip.maxRange) || d < 2.5 || h.y - this.world.terrain.baseHeight(h.x, h.z) <= 1.6) return false;
    if (h.nx * (px - h.x) + h.ny * (hy - h.y) + h.nz * (pz - h.z) <= -0.2) return false;
    if (mode === 1) return true;
    return h.ny < 0.7 && h.y >= py + S.minHeightAbove && h.y - hy >= Math.sin(S.minElevationDeg * DEG) * d;
  }

  /**
   * Wide anchor search: the centre ray if it is usable, otherwise the best
   * point in the assist cone. `p*` is the player's feet, the hand is above it.
   * `mode` 0 = swing, 1 = zip.
   */
  plan(
    mode: 0 | 1,
    px: number,
    py: number,
    pz: number,
    aox: number,
    aoy: number,
    aoz: number,
    adx: number,
    ady: number,
    adz: number,
    out: AnchorResult,
  ): boolean {
    out.valid = false;
    const S = tuning.swing;
    const A = tuning.assist;
    const w = this.world;
    const hx = px,
      hy = py + tuning.body.ropeOffset,
      hz = pz;
    const maxRange = mode === 0 ? S.maxRange : tuning.zip.maxRange;
    const minAbove = mode === 0 ? S.minHeightAbove : -1e9;

    // 1. Primary: camera centre ray.
    const camToHand = Math.hypot(hx - aox, hy - aoy, hz - aoz);
    if (w.raycast(aox, aoy, aoz, adx, ady, adz, camToHand + maxRange, this.hit)) {
      const h = this.hit;
      if (h.id >= 0 && (w.flags[h.id]! & F_ANCHOR) !== 0 && this.usable(mode, h, px, py, pz) && this.lineOfSight(hx, hy, hz, h.x, h.y, h.z, h.id)) {
        out.valid = true;
        out.x = h.x;
        out.y = h.y;
        out.z = h.z;
        out.nx = h.nx;
        out.ny = h.ny;
        out.nz = h.nz;
        out.id = h.id;
        out.dist = Math.hypot(h.x - hx, h.y - hy, h.z - hz);
        out.assisted = false;
        return true;
      }
    }

    // 2. Assist: biased cone search.
    let fx = adx,
      fz = adz;
    const fl = Math.hypot(fx, fz);
    if (fl < 1e-4) {
      fx = 0;
      fz = -1;
    } else {
      fx /= fl;
      fz /= fl;
    }
    const pitch = Math.asin(Math.max(-1, Math.min(1, ady)));
    let bx: number, by: number, bz: number, ideal: number;
    if (mode === 0) {
      const elev = Math.min(75 * DEG, Math.max(pitch + 30 * DEG, A.idealElevationDeg * DEG));
      bx = fx * Math.cos(elev);
      by = Math.sin(elev);
      bz = fz * Math.cos(elev);
      ideal = A.idealDistance;
    } else {
      bx = adx;
      by = ady;
      bz = adz;
      ideal = 30;
    }
    // Several ideal points (high/far, mid, low/near) give each collider a few
    // candidate points; at street level the nearest walls often hide the
    // highest choice, so variety keeps the assist robust.
    const R = Math.min(A.range, maxRange);
    const n = w.gatherAabb(hx - R, py - 20, hz - R, hx + R, hy + R, hz + R, this.candBuf, F_ANCHOR);
    this.lastCandidates = n;
    this.nCand = 0;
    const maxAim = A.maxAimAngleDeg * DEG;
    const cosMaxAim = Math.cos(maxAim);
    const sinMinElev = Math.sin(S.minElevationDeg * DEG);
    const pt = this.pt;
    const ideals = this.ideals;
    const nIdeal = mode === 0 ? 4 : 3;
    for (let q = 0; q < nIdeal; q++) {
      const scale = q === 0 ? 1 : q === 1 ? 0.62 : q === 2 ? 1.35 : 0.3;
      let ex = bx,
        ey = by,
        ez = bz;
      if (mode === 0 && q === 2) {
        // Far and flatter: along the aim, 30 degrees up.
        ex = fx * 0.866;
        ey = 0.5;
        ez = fz * 0.866;
      }
      ideals[q * 3] = hx + ex * ideal * scale;
      ideals[q * 3 + 1] = hy + ey * ideal * scale;
      ideals[q * 3 + 2] = hz + ez * ideal * scale;
    }
    for (let k = 0; k < n; k++) {
      const id = this.candBuf[k]!;
      for (let q = 0; q < nIdeal; q++) {
        if (!w.closestAnchorPoint(id, ideals[q * 3]!, ideals[q * 3 + 1]!, ideals[q * 3 + 2]!, hx, hz, pt)) break;
        const tx = pt.x - hx,
          ty = pt.y - hy,
          tz = pt.z - hz;
        const d = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (d > R || d < A.minDistance) continue;
        if (pt.y < py + minAbove || pt.y - w.terrain.baseHeight(pt.x, pt.z) < 1.6) continue;
        if (mode === 0 && ty < sinMinElev * d) continue;
        // Surface must face the player.
        if (pt.nx * -tx + pt.ny * -ty + pt.nz * -tz < -0.05 * d) continue;
        const dx = tx / d,
          dy = ty / d,
          dz = tz / d;
        // Horizontal cone relative to the aim yaw.
        const hl = Math.hypot(dx, dz);
        if (hl > 0.15) {
          const cy = (dx * fx + dz * fz) / hl;
          if (cy < cosMaxAim) continue;
        }
        const cosB = dx * bx + dy * by + dz * bz;
        const ang = Math.acos(Math.max(-1, Math.min(1, cosB)));
        let cost = A.weightAngle * (ang / maxAim) + A.weightDistance * (Math.abs(d - ideal) / ideal);
        if (d < 14) cost += 0.25 * (14 - d) / 14;
        if (mode === 0) cost += A.weightHeight * Math.max(0, Math.min(1, (18 - (pt.y - py)) / 18));
        this.insertCandidate(cost, id, pt.x, pt.y, pt.z, pt.nx, pt.ny, pt.nz);
      }
    }
    this.lastScored = this.nCand;
    const checks = Math.min(this.nCand, Math.max(1, Math.round(A.losChecks)));
    if (this.debug) this.debugLog.length = 0;
    for (let c = 0; c < checks; c++) {
      const o = c * 8;
      const id = this.cand[o + 1]!;
      const x = this.cand[o + 2]!,
        y = this.cand[o + 3]!,
        z = this.cand[o + 4]!;
      if (!this.lineOfSight(hx, hy, hz, x, y, z, id)) {
        if (this.debug)
          this.debugLog.push({ cost: this.cand[o]!, id, x, y, z, blocker: this.los.id, bt: this.los.t, bflags: this.los.id >= 0 ? w.flags[this.los.id]! : -1, owner: w.owner[id]!, bowner: this.los.id >= 0 ? w.owner[this.los.id]! : -1 });
        // Fallback: the wall that blocked the line is in front of us; anchor
        // on that face a few metres above the minimum height.
        const bid = this.los.id;
        if (bid >= 0 && w.kind[bid] === BOX && (w.flags[bid]! & F_ANCHOR) !== 0 && Math.abs(this.los.ny) < 0.3) {
          const bo = bid * 6;
          const lo = Math.max(w.p[bo + 1]! + 0.3, mode === 0 ? py + minAbove + 3 : hy + 3);
          const fy = Math.min(lo, w.p[bo + 4]!);
          const fx = this.los.x,
            fz = this.los.z;
          const fd = Math.hypot(fx - hx, fy - hy, fz - hz);
          const fElevOk = mode === 1 || fy - hy >= sinMinElev * fd;
          if (fElevOk && fy >= py + minAbove && fy - w.terrain.baseHeight(fx, fz) > 1.6 && fd >= A.minDistance && fd <= R && this.lineOfSight(hx, hy, hz, fx, fy, fz, bid)) {
            out.valid = true;
            out.x = fx;
            out.y = fy;
            out.z = fz;
            out.nx = this.los.nx;
            out.ny = 0;
            out.nz = this.los.nz;
            out.id = bid;
            out.dist = fd;
            out.assisted = true;
            return true;
          }
        }
        continue;
      }
      out.valid = true;
      out.x = x;
      out.y = y;
      out.z = z;
      out.nx = this.cand[o + 5]!;
      out.ny = this.cand[o + 6]!;
      out.nz = this.cand[o + 7]!;
      out.id = id;
      out.dist = Math.hypot(x - hx, y - hy, z - hz);
      out.assisted = true;
      return true;
    }
    return false;
  }
}
