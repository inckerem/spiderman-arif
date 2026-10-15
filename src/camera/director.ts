import { Vector3, type PerspectiveCamera } from 'three';
import { clamp, damp, dampFactor, smoothstep } from '../core/math';
import { Rng } from '../core/rng';
import { F_CAMERA, makeRayHit, type CollisionWorld } from '../physics/collision';

/** What the cinematic camera films: the hero's interpolated feet and velocity. */
export interface ShotSubject {
  pos: Vector3;
  vel: Vector3;
  /** Standing on a roof on purpose: the camera orbits. */
  perching: boolean;
}

export const SHOT_CHASE = 0;
export const SHOT_SIDE = 1;
export const SHOT_LOW = 2;
export const SHOT_AERIAL = 3;
export const SHOT_ORBIT = 4;
export const SHOT_NAMES = ['chase', 'side', 'low', 'aerial', 'orbit'] as const;

/** Vertical screen position of the hero (NDC, negative = below centre). */
const FRAME_Y = -0.18;
/** Camera sphere radius kept clear of geometry. */
const CAM_R = 0.45;
const UP = new Vector3(0, 1, 0);

/**
 * Keeps a camera position out of geometry: a sphere cast from `from` (the
 * subject) to `pos` stops in front of anything that blocks the camera, then
 * a sphere resolve pushes it clear of every collider, terrain and water.
 */
export function clearShot(world: CollisionWorld, from: Vector3, pos: Vector3, hit = makeRayHit()): void {
  const dx = pos.x - from.x,
    dy = pos.y - from.y,
    dz = pos.z - from.z;
  const d = Math.hypot(dx, dy, dz);
  if (d > 1e-3 && world.raycast(from.x, from.y, from.z, dx / d, dy / d, dz / d, d, hit, 0, -1, CAM_R, true, F_CAMERA)) {
    const t = Math.max(0.3, hit.t - 0.1);
    pos.set(from.x + (dx / d) * t, from.y + (dy / d) * t, from.z + (dz / d) * t);
  }
  world.resolveSphere(pos, CAM_R);
}

/**
 * The menu's cinematic camera. A director picks a shot every 6-12 s (chase
 * from behind, side tracking on a long lens, low angle looking up as the hero
 * passes, wide aerial, slow orbit while the hero perches) and cuts or blends
 * to it. Every shot is damped, kept out of geometry with a sphere cast from
 * the hero, and aims at the hero so it stays in frame.
 */
export class CinematicDirector {
  shot = SHOT_CHASE;
  readonly stats = { cuts: 0, blends: 0, shots: [0, 0, 0, 0, 0] };
  private shotT = 0;
  private shotLen = 8;
  /** Shot camera (damped) and look target. */
  private readonly pos = new Vector3();
  private readonly look = new Vector3();
  /** Look target relative to the hero (a damped lead), so the hero never drifts out of frame. */
  private readonly lookOff = new Vector3();
  private fov = 60;
  /** Output pose (after blending). */
  readonly outPos = new Vector3();
  private readonly outLook = new Vector3();
  private outFov = 60;
  private readonly fromPos = new Vector3();
  private readonly fromLook = new Vector3();
  private fromFov = 60;
  private blendT = 0;
  private blendLen = 0;
  private readonly heading = new Vector3(0, 0, -1);
  private readonly side = new Vector3(1, 0, 0);
  private sideSign = 1;
  /** Where the hero sits on screen (NDC): beside the centred menu column, a little low. */
  private frameX = 0.55;
  private frameXWant = 0.55;
  private readonly frameDir = new Vector3();
  private readonly frameRight = new Vector3();
  private readonly frameUp = new Vector3();
  private orbitA = 0;
  private lostT = 0;
  /** Seconds the shot has been squeezed by geometry to under 45 % of its distance. */
  private crampT = 0;
  private started = false;
  private readonly chest = new Vector3();
  private readonly want = new Vector3();
  private readonly wantLook = new Vector3();
  private readonly hit = makeRayHit();
  private readonly rng: Rng;

  constructor(
    private readonly world: CollisionWorld,
    seed: number,
  ) {
    this.rng = new Rng(seed ^ 0xc1a7);
  }

  /** Start over with a fresh chase shot (cut). */
  reset(): void {
    this.started = false;
  }

  update(dt: number, s: ShotSubject, cam: PerspectiveCamera): void {
    const chest = this.chest.set(s.pos.x, s.pos.y + 1.1, s.pos.z);
    const hs = Math.hypot(s.vel.x, s.vel.z);
    if (hs > 3) {
      this.heading.x = damp(this.heading.x, s.vel.x / hs, 1.6, dt);
      this.heading.z = damp(this.heading.z, s.vel.z / hs, 1.6, dt);
      this.heading.y = 0;
      if (this.heading.lengthSq() < 1e-4) this.heading.set(s.vel.x / hs, 0, s.vel.z / hs);
      this.heading.normalize();
    }
    this.side.crossVectors(this.heading, UP).normalize();
    if (!this.started) {
      this.started = true;
      this.begin(s.perching ? SHOT_ORBIT : SHOT_CHASE, s, false);
    }
    this.shotT += dt;
    // Shot changes: perching starts or ends, the shot ran its length, or a static shot lost the hero.
    const d = this.pos.distanceTo(chest);
    if (s.perching !== (this.shot === SHOT_ORBIT)) this.begin(s.perching ? SHOT_ORBIT : this.pickNext(hs), s, s.perching);
    else if (this.shot !== SHOT_ORBIT && this.shotT > this.shotLen) this.begin(this.pickNext(hs), s, this.rng.chance(0.35));
    else if (this.shot === SHOT_LOW && (this.lostT > 0.6 || d > 120 || (this.shotT > 2.5 && d > 75))) this.begin(this.pickNext(hs), s, false);
    else if (this.lostT > 1.2) {
      // An orbit that lost the hero jumps to the far side of it; other shots cut to a chase.
      if (this.shot === SHOT_ORBIT) this.orbitA += 2.4;
      this.begin(this.shot === SHOT_ORBIT ? SHOT_ORBIT : SHOT_CHASE, s, false);
    }

    if (this.shot === SHOT_ORBIT) this.orbitA += 0.16 * dt;
    this.desired(s, hs, false);
    if (this.shot !== SHOT_LOW) {
      const rate = this.shot === SHOT_AERIAL ? 1.4 : this.shot === SHOT_SIDE ? 2.4 : this.shot === SHOT_ORBIT ? 3 : 3.6;
      const k = dampFactor(rate, dt);
      this.pos.lerp(this.want, k);
      clearShot(this.world, chest, this.pos, this.hit);
      // Squeezed against walls or into a tree for a while: a cramped picture, change shots.
      const cramped = this.pos.distanceTo(chest) < this.want.distanceTo(chest) * 0.45;
      this.crampT = cramped ? this.crampT + dt : 0;
      if (this.crampT > 1.2) {
        this.crampT = 0;
        if (this.shot === SHOT_ORBIT) {
          this.orbitA += 2.4;
          this.begin(SHOT_ORBIT, s, false);
        } else this.begin(this.shot === SHOT_AERIAL ? SHOT_CHASE : SHOT_AERIAL, s, false);
      }
    }
    this.lookOff.lerp(this.wantLook.sub(chest), dampFactor(4, dt));
    this.look.copy(chest).add(this.lookOff);
    this.fov = damp(this.fov, this.shotFov(), 2, dt);
    // Line of sight to the hero (static shots lose it behind buildings).
    const lx = chest.x - this.pos.x,
      ly = chest.y - this.pos.y,
      lz = chest.z - this.pos.z;
    const ld = Math.hypot(lx, ly, lz);
    const blocked = ld > 1 && this.world.raycast(this.pos.x, this.pos.y, this.pos.z, lx / ld, ly / ld, lz / ld, ld - 0.8, this.hit, 0, -1, 0, false, F_CAMERA);
    // Lost: the hero is behind something, or geometry pushed the camera right up against it.
    this.lostT = blocked || ld < 2.5 ? this.lostT + dt : 0;

    // Blend from the previous shot's pose.
    if (this.blendT < this.blendLen) {
      this.blendT += dt;
      const w = smoothstep(0, 1, clamp(this.blendT / this.blendLen, 0, 1));
      this.outPos.lerpVectors(this.fromPos, this.pos, w);
      // The previous shot's aim stays on the hero while blending.
      this.outLook.copy(chest).add(this.fromLook).lerp(this.look, w);
      this.outFov = this.fromFov + (this.fov - this.fromFov) * w;
      clearShot(this.world, chest, this.outPos, this.hit);
    } else {
      this.outPos.copy(this.pos);
      this.outLook.copy(this.look);
      this.outFov = this.fov;
    }
    // Composition: turn the lens so the hero sits in the left or right third, clear of the menu.
    this.frameX = damp(this.frameX, this.frameXWant, 1.5, dt);
    const fd = this.frameDir.subVectors(this.outLook, this.outPos);
    const dist = fd.length();
    if (dist > 1e-3) {
      fd.multiplyScalar(1 / dist);
      const fr = this.frameRight.crossVectors(fd, UP);
      if (fr.lengthSq() > 1e-6) {
        fr.normalize();
        const fu = this.frameUp.crossVectors(fr, fd);
        const ty = Math.tan((this.outFov * Math.PI) / 360);
        this.outLook.addScaledVector(fr, -this.frameX * ty * cam.aspect * dist).addScaledVector(fu, -FRAME_Y * ty * dist);
      }
    }
    cam.position.copy(this.outPos);
    cam.fov = this.outFov;
    cam.up.set(0, 1, 0);
    cam.lookAt(this.outLook);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  private shotFov(): number {
    switch (this.shot) {
      case SHOT_SIDE:
        return 44;
      case SHOT_LOW:
        return 58;
      case SHOT_AERIAL:
        return 52;
      case SHOT_ORBIT:
        return 50;
      default:
        return 64;
    }
  }

  private pickNext(hs: number): number {
    const r = this.rng;
    for (let i = 0; i < 8; i++) {
      const n = r.weighted([SHOT_CHASE, SHOT_SIDE, SHOT_LOW, SHOT_AERIAL], [3, 2.5, hs > 12 ? 2 : 0, 1.5]);
      if (n !== this.shot) return n;
    }
    return this.shot === SHOT_CHASE ? SHOT_SIDE : SHOT_CHASE;
  }

  /** Switch shots: a cut snaps to the new pose, a blend eases over 1.2-1.8 s. */
  private begin(shot: number, s: ShotSubject, blend: boolean): void {
    this.fromPos.copy(this.outPos);
    this.fromLook.set(this.outLook.x - s.pos.x, this.outLook.y - s.pos.y - 1.1, this.outLook.z - s.pos.z);
    this.fromFov = this.outFov;
    const prevShot = this.shot;
    this.shot = shot;
    this.shotT = 0;
    this.shotLen = this.rng.range(6, 12);
    this.sideSign = this.rng.chance(0.5) ? 1 : -1;
    // The hero goes to the left or right third; a cut moves it at once, a blend eases it over.
    this.frameXWant = this.rng.chance(0.5) ? 0.52 : -0.52;
    if (!blend) this.frameX = this.frameXWant;
    this.lostT = 0;
    this.crampT = 0;
    const hs = Math.hypot(s.vel.x, s.vel.z);
    if (shot === SHOT_ORBIT && prevShot !== SHOT_ORBIT) {
      // Start the orbit where the camera already is around the hero.
      const ox = this.outPos.x - s.pos.x,
        oz = this.outPos.z - s.pos.z;
      this.orbitA = ox * ox + oz * oz > 1 ? Math.atan2(oz, ox) : this.rng.range(0, Math.PI * 2);
    }
    this.desired(s, hs, true);
    this.pos.copy(this.want);
    this.chest.set(s.pos.x, s.pos.y + 1.1, s.pos.z);
    clearShot(this.world, this.chest, this.pos, this.hit);
    this.look.copy(this.wantLook);
    this.lookOff.subVectors(this.wantLook, this.chest);
    this.fov = this.shotFov();
    this.stats.shots[shot]!++;
    if (blend) {
      this.blendT = 0;
      this.blendLen = this.rng.range(1.2, 1.8);
      this.stats.blends++;
    } else {
      this.blendT = 0;
      this.blendLen = 0;
      this.stats.cuts++;
    }
  }

  /** Target pose of the current shot into `want` / `wantLook`; `fresh` places a static shot. */
  private desired(s: ShotSubject, hs: number, fresh: boolean): void {
    const c = this.chest.set(s.pos.x, s.pos.y + 1.1, s.pos.z);
    const h = this.heading,
      sd = this.side;
    const w = this.want;
    const lead = clamp(hs * 0.12, 0, 6);
    this.wantLook.copy(c).addScaledVector(h, lead);
    switch (this.shot) {
      case SHOT_SIDE:
        w.copy(c).addScaledVector(sd, 15 * this.sideSign).addScaledVector(h, -3).addScaledVector(UP, 2.5);
        break;
      case SHOT_LOW:
        if (fresh) {
          // Ahead on the path, low near the ground (or a roof), looking up as the hero passes.
          const ahead = clamp(hs * 1.4, 22, 50);
          w.copy(c).addScaledVector(h, ahead).addScaledVector(sd, this.rng.range(-9, 9));
          const ground = this.world.supportHeight(w.x, w.z, c.y - 6, 0.3).y;
          const base = ground > -1e6 ? ground : -1;
          w.y = Math.max(base + 1.6, Math.min(c.y - 14, base + 4));
        } else w.copy(this.pos);
        this.wantLook.copy(c);
        break;
      case SHOT_AERIAL:
        w.copy(c).addScaledVector(h, -24).addScaledVector(sd, 20 * this.sideSign).addScaledVector(UP, 36);
        break;
      case SHOT_ORBIT: {
        w.set(c.x + Math.cos(this.orbitA) * 8.5, c.y + 2.2, c.z + Math.sin(this.orbitA) * 8.5);
        this.wantLook.copy(c).addScaledVector(UP, 0.2);
        break;
      }
      default:
        w.copy(c).addScaledVector(h, -8.5).addScaledVector(sd, 1.6).addScaledVector(UP, 2.2);
        break;
    }
  }
}
