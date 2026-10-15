import { Euler, Matrix4, Quaternion, Vector3, type Bone } from 'three';
import { clamp, dampAngle, dampFactor, smoothstep, Spring, wrapAngle } from '../core/math';
import { tuning } from '../config/tuning';
import { JOINTS, LIMB, type CharacterRig, type JointName } from './rig';
import { aimQuaternion, setWorldQuaternion, solveTwoBone } from './ik';
import { F_CANOPY, makeRayHit } from '../physics/collision';
import { MODE_AIR, MODE_GROUND, MODE_SWING, MODE_TRAVERSE, MODE_WALL, MODE_ZIP, TRAV_VAULT, type Player, type PlayerEvent } from '../player/player';

const S_IDLE = 0;
const S_RUN = 1;
const S_AIR = 2;
const S_SWING = 3;
const S_DIVE = 4;
const S_ZIP = 5;
const S_WALL = 6;
const S_TRAV = 7;
const S_ROLL = 8;
const S_RELEASE = 9;
const NSTATE = 10;
/** Air tricks after letting go of a line. */
const TRICK_SPREAD = 0;
const TRICK_FLIP = 1;
const TRICK_TWIST = 2;
/** Strong releases cycle through these. */
const TRICK_CYCLE = [TRICK_FLIP, TRICK_TWIST, TRICK_SPREAD] as const;
const N = JOINTS.length;
const J = Object.fromEntries(JOINTS.map((n, i) => [n, i])) as Record<JointName, number>;

const UP = new Vector3(0, 1, 0);
/** Wall crawl limbs: height above the feet, lateral offset, gait phase. */
const WALL_LIMBS: ReadonlyArray<{ up: number; lat: number; phase: number; arm: boolean; side: number }> = [
  { up: 1.72, lat: 0.3, phase: 0, arm: true, side: 0 },
  { up: 1.72, lat: -0.3, phase: 0.5, arm: true, side: 1 },
  { up: 0.32, lat: 0.2, phase: 0.5, arm: false, side: 0 },
  { up: 0.32, lat: -0.2, phase: 0, arm: false, side: 1 },
];
/** Extremities checked for clipping (hands use the palm point). */
const CLIP_JOINTS: JointName[] = ['head', 'handL', 'handR', 'foreArmL', 'foreArmR', 'shinL', 'shinR', 'footL', 'footR', 'toeL', 'toeR'];
const _e = new Euler();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix4();
const _v = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _bodyUp = new Vector3();
const _pole = new Vector3();
const _goal = new Vector3();
const _qp = new Quaternion();
const _la = new Vector3();
const _lw = new Vector3();
const _lp = new Vector3();
const _ld = new Vector3();
const _lt = new Vector3();
const _lm = new Vector3();
const _xAxis = new Vector3(1, 0, 0);
const _ct = new Vector3();
const _keep = [new Quaternion(), new Quaternion(), new Quaternion()];

interface FootPlant {
  planted: boolean;
  /** Ground contact point (world) while planted; current ground point while stepping. */
  pos: Vector3;
  from: Vector3;
  to: Vector3;
  /** Step progress (seconds) and duration while the foot is in the air. */
  t: number;
  dur: number;
  /** Gait cycle position last frame. */
  prevCyc: number;
  /** Seconds since this foot last touched down. */
  landT: number;
}

/** Hip joint height above the feet at rest, ankle height above the ground, usable leg length. */
const HIP_H = 0.98 - 0.045;
const ANKLE_H = LIMB.ankle + 0.015;
const LEG = (LIMB.thigh + LIMB.shin) * 0.985;

export interface FootstepEvent {
  side: 0 | 1;
  surface: number;
  intensity: number;
}

/**
 * Procedural animation. Each frame: pick the active state from the player
 * simulation, ease state weights with critically damped springs, compute the
 * body (root) orientation, then each weighted state's local joint pose
 * (legs on the ground use world-planted feet + two-bone IK, so stance feet
 * never slide), and blend the joint rotations by weight.
 */
export class CharacterAnimator {
  private readonly weights: Spring[] = Array.from({ length: NSTATE }, (_, i) => new Spring(i === S_IDLE ? 1 : 0));
  private readonly poses: Quaternion[][] = Array.from({ length: NSTATE }, () => Array.from({ length: N }, () => new Quaternion()));
  private readonly blended: Quaternion[] = Array.from({ length: N }, () => new Quaternion());
  private readonly rootQ = new Quaternion();
  private readonly rootTarget = new Quaternion();
  private yaw = 0;
  private hipsDrop = new Spring(0);
  private time = 0;
  private phase = 0;
  private readonly feet: FootPlant[] = [
    { planted: false, pos: new Vector3(), from: new Vector3(), to: new Vector3(), t: 0, dur: 0, prevCyc: 0, landT: 1 },
    { planted: false, pos: new Vector3(), from: new Vector3(), to: new Vector3(), t: 0, dur: 0, prevCyc: 0, landT: 1 },
  ];
  /** Fore-aft position of each foot relative to the hips (-1 behind .. 1 ahead), drives arm swing. */
  private readonly footFwd = [0, 0];
  private gaitDrop = 0;
  private gaitDuty = 0.5;
  private gaitFrame = 0;
  private legsSolvedFrame = -1;
  private readonly legQ: Quaternion[] = Array.from({ length: 6 }, () => new Quaternion());
  private feetReady = false;
  private readonly wallRay = makeRayHit();
  private sinceRelease = 99;
  private trick = TRICK_SPREAD;
  private trickCount = 0;
  private sinceLand = 99;
  /** Strength of the landing crouch set by the last landing, and its weight this frame. */
  private crouch = 0;
  private crouchW = 0;
  /** Perched crouch while standing still on a roof (rooftop moment, menu hero): target 0..1, eased in and out. */
  perch = 0;
  private perchW = 0;
  private crawl = 0;
  private wallRunT = 0;
  private initialized = false;
  private readonly lastPos = new Vector3();
  /** Active animation state (diagnostics). */
  state = S_IDLE;
  /** Footstep callback (audio). */
  onFootstep: ((e: FootstepEvent) => void) | null = null;
  /** World position of the hand holding the line (for the web visual). */
  readonly handPos = [new Vector3(), new Vector3()];
  /** Diagnostics: horizontal movement of planted feet (after blending) this frame, metres. */
  plantSlide = 0;
  /** Enable per-frame limb clipping diagnostics (tests only). */
  diagnostics = false;
  /** Diagnostics: deepest limb penetration into solid geometry this frame (m). */
  limbPenetration = 0;
  /** Diagnostics: joint with the deepest penetration this frame. */
  limbPenetrationJoint = '';
  /** Diagnostics: release tricks started (spread, flip, corkscrew) and the deepest landing crouch. */
  readonly tricks = [0, 0, 0];
  crouchPeak = 0;
  private readonly prevFoot = [new Vector3(), new Vector3()];
  private readonly prevPlant = [new Vector3(), new Vector3()];
  private readonly prevPlanted = [false, false];

  constructor(
    private readonly rig: CharacterRig,
    private readonly player: Player,
  ) {}

  /** Forget foot plants, blends and tricks (the hero was moved or another animator posed it). */
  reset(): void {
    this.initialized = false;
    this.feetReady = false;
    this.sinceRelease = 99;
    this.crouch = 0;
    this.crouchW = 0;
    this.perchW = 0;
  }

  /** Feed simulation events (landing, release) once per tick. */
  onEvent(e: PlayerEvent): void {
    if (e.type === 'release') {
      this.sinceRelease = 0;
      // A good release always flips; other strong, fast releases take turns
      // between a flip, a corkscrew and the spread; weak ones spread.
      const strong = !e.broken && e.power > 0.6 && this.player.vel.length() > 12;
      this.trick = e.good ? TRICK_FLIP : strong ? TRICK_CYCLE[this.trickCount++ % TRICK_CYCLE.length]! : TRICK_SPREAD;
      this.tricks[this.trick]!++;
    } else if (e.type === 'land') {
      this.sinceLand = 0;
      // The trick ends on landing, so a jump right after never replays it.
      this.sinceRelease = 99;
      if (e.impact > 6) this.hipsDrop.velocity -= Math.min(4, e.impact * 0.09);
      // Hard landings without a roll drop into a crouch with one hand on the ground.
      this.crouch = !e.roll && e.impact > 9 ? clamp((e.impact - 9) / 12, 0.45, 1) : 0;
    } else if (e.type === 'attach' || e.type === 'zipStart' || e.type === 'wallGrab') {
      this.sinceRelease = 99;
    }
  }

  private activeState(): number {
    const p = this.player;
    switch (p.mode) {
      case MODE_GROUND:
        if (p.rollTimer > 0) return S_ROLL;
        return Math.hypot(p.vel.x, p.vel.z) > 0.6 ? S_RUN : S_IDLE;
      case MODE_AIR:
        if (p.diving) return S_DIVE;
        if (this.sinceRelease < 0.75) return S_RELEASE;
        return S_AIR;
      case MODE_SWING:
        return p.rope.attached ? S_SWING : S_AIR;
      case MODE_ZIP:
        return S_ZIP;
      case MODE_WALL:
        return S_WALL;
      case MODE_TRAVERSE:
        return S_TRAV;
      default:
        return S_AIR;
    }
  }

  update(dt: number, feetPos: Vector3, camYaw: number): void {
    const p = this.player;
    const rig = this.rig;
    const mesh = rig.mesh;
    dt = Math.min(dt, 0.05);
    this.time += dt;
    this.sinceRelease += dt;
    this.sinceLand += dt;
    const state = this.activeState();
    this.state = state;
    if (!this.initialized) {
      for (let i = 0; i < NSTATE; i++) this.weights[i]!.reset(i === state ? 1 : 0);
      this.yaw = wrapAngle(p.facing + Math.PI);
      this.initialized = true;
      this.lastPos.copy(feetPos);
    }
    const blendRate = state === S_ROLL || state === S_TRAV || state === S_WALL ? 22 : 14;
    for (let i = 0; i < NSTATE; i++) {
      const w = this.weights[i]!;
      w.update(i === state ? 1 : 0, blendRate, dt);
      if (w.value < 0) w.value = 0;
    }

    // ---- Root orientation -------------------------------------------------
    const v = p.vel;
    const hs = Math.hypot(v.x, v.z);
    const ct = this.sinceLand;
    this.crouchW =
      (state === S_IDLE || state === S_RUN) && this.crouch > 0
        ? this.crouch * (ct < 0.08 ? smoothstep(0, 0.08, ct) : 1 - smoothstep(0.32, 0.8, ct)) * (1 - smoothstep(1.5, 6, hs))
        : 0;
    // A perch is the same crouch held: one hand down, head up, eased in over a second or so.
    this.perchW += ((state === S_IDLE ? this.perch : 0) - this.perchW) * dampFactor(this.perch > 0 ? 2.2 : 5, dt);
    this.crouchW = Math.max(this.crouchW, this.perchW * 0.8);
    this.crouchPeak = Math.max(this.crouchPeak, this.crouchW);
    let targetYaw = this.yaw;
    if (state === S_WALL) targetYaw = Math.atan2(-p.wall.nx, -p.wall.nz);
    else if (hs > 0.8) targetYaw = Math.atan2(v.x, v.z);
    // The simulation's facing uses the camera convention (forward = -Z at 0).
    else targetYaw = wrapAngle(p.facing + Math.PI);
    this.yaw = dampAngle(this.yaw, targetYaw, state === S_WALL ? 25 : 12, dt);
    _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    _bodyUp.copy(UP);
    let flip = 0;
    let twist = 0;
    if (state === S_SWING) {
      const a = p.rope.anchor;
      _v.set(a.x - feetPos.x, a.y - (feetPos.y + 1.1), a.z - feetPos.z).normalize();
      _bodyUp.copy(UP).lerp(_v, 0.72).normalize();
    } else if (state === S_DIVE) {
      const sp = v.length();
      if (sp > 1) _bodyUp.copy(v).multiplyScalar(-1 / sp).lerp(UP, 0.18).normalize();
    } else if (state === S_ZIP) {
      _v.set(p.zip.ex - feetPos.x, p.zip.ey - feetPos.y, p.zip.ez - feetPos.z).normalize();
      _bodyUp.copy(UP).lerp(_v, 0.6).normalize();
    } else if (state === S_AIR || state === S_RELEASE) {
      // Lean into the flight path a little.
      const sp = v.length();
      if (sp > 4) _bodyUp.copy(UP).addScaledVector(_v.copy(v).multiplyScalar(1 / sp), 0.35).normalize();
      if (state === S_RELEASE && this.trick === TRICK_FLIP) flip = smoothstep(0, 0.6, this.sinceRelease) * Math.PI * 2;
      else if (state === S_RELEASE && this.trick === TRICK_TWIST) twist = smoothstep(0.02, 0.7, this.sinceRelease) * Math.PI * 2;
    } else if (state === S_RUN) {
      const lean = 0.07 + 0.26 * smoothstep(3, 16, hs);
      _bodyUp.copy(UP).addScaledVector(_fwd, lean).normalize();
    } else if (state === S_ROLL) {
      const rp = 1 - p.rollTimer / tuning.ground.rollDuration;
      flip = smoothstep(0, 1, rp) * Math.PI * 2;
    }
    // Landing crouch: the body pitches forward over the knees.
    if (this.crouchW > 0) _bodyUp.addScaledVector(_fwd, 0.55 * this.crouchW).normalize();
    // Basis: up = bodyUp, forward = fwd projected.
    _v2.copy(_fwd).addScaledVector(_bodyUp, -_fwd.dot(_bodyUp));
    if (_v2.lengthSq() < 1e-6) _v2.copy(_fwd);
    _v2.normalize();
    _right.crossVectors(_bodyUp, _v2).normalize();
    _m.makeBasis(_right, _bodyUp, _v2);
    this.rootTarget.setFromRotationMatrix(_m);
    if (flip !== 0) {
      _q.setFromAxisAngle(_right, flip);
      this.rootTarget.premultiply(_q);
    }
    if (twist !== 0) {
      // Corkscrew around the flight direction.
      _q.setFromAxisAngle(_v2, twist);
      this.rootTarget.premultiply(_q);
    }
    const snap = state === S_ROLL || (state === S_RELEASE && this.trick !== TRICK_SPREAD);
    // Settle upright quickly on a wall so a tilted swing pose never leans into it.
    this.rootQ.slerp(this.rootTarget, snap ? 1 : dampFactor(state === S_WALL ? 30 : 16, dt));

    // Hips height: crouch on landings, lower while running so the legs can reach.
    this.hipsDrop.update(0, 9, dt);
    let hipsY = 0.98 + Math.max(-0.42, this.hipsDrop.value) * 0.18 - 0.34 * this.crouchW;
    if (state === S_ROLL) hipsY -= 0.42 * Math.sin(Math.PI * clamp(1 - p.rollTimer / tuning.ground.rollDuration, 0, 1));
    const loco = this.weights[S_IDLE]!.value + this.weights[S_RUN]!.value;
    if (loco > 0.002 || state === S_IDLE || state === S_RUN) {
      this.gait(dt, feetPos, hs);
      // Lowest at mid-stance, highest in the flight phase.
      const bob = hs > 0.6 ? -(0.02 + 0.025 * smoothstep(6, 16, hs)) * smoothstep(2, 8, hs) * Math.cos((this.phase - this.gaitDuty * 0.5) * Math.PI * 4) : 0;
      const gaitY = Math.min(hipsY - this.gaitDrop + bob, this.hipsLimit(feetPos));
      hipsY += (gaitY - hipsY) * clamp(loco, 0, 1);
    } else this.feetReady = false;

    mesh.position.copy(feetPos);
    mesh.quaternion.identity();
    // The hips bone carries the body orientation (pivot at the pelvis).
    const hips = rig.bones.hips;
    const wallW = clamp(this.weights[S_WALL]!.value, 0, 1);
    if (state === S_WALL && wallW > 0) {
      // Pull the body flat against the wall as the cling pose blends in and the
      // body has turned upright (a tilted body would push its shoulders in).
      _v.set(0, 1, 0).applyQuaternion(this.rootQ);
      const upright = smoothstep(0.9, 0.99, _v.y);
      mesh.position.x -= p.wall.nx * 0.16 * wallW * upright;
      mesh.position.z -= p.wall.nz * 0.16 * wallW * upright;
    }
    hips.position.set(0, hipsY, 0);
    hips.quaternion.copy(this.rootQ);
    mesh.updateMatrixWorld(true);

    // ---- State poses ------------------------------------------------------
    for (let s = 0; s < NSTATE; s++) {
      const w = this.weights[s]!.value;
      if (w < 0.002 && s !== state) continue;
      this.computePose(s, dt, feetPos, camYaw);
    }
    // ---- Blend ----------------------------------------------------------
    let total = 0;
    for (let s = 0; s < NSTATE; s++) total += Math.max(0, this.weights[s]!.value);
    if (total < 1e-4) total = 1;
    for (let j = 1; j < N; j++) {
      const out = this.blended[j]!;
      out.set(0, 0, 0, 0);
      for (let s = 0; s < NSTATE; s++) {
        const w = Math.max(0, this.weights[s]!.value) / total;
        if (w < 0.002) continue;
        const q = this.poses[s]![j]!;
        const sign = out.x * q.x + out.y * q.y + out.z * q.z + out.w * q.w < 0 ? -1 : 1;
        out.x += q.x * w * sign;
        out.y += q.y * w * sign;
        out.z += q.z * w * sign;
        out.w += q.w * w * sign;
      }
      out.normalize();
      rig.bones[JOINTS[j]!].quaternion.copy(out);
    }
    mesh.updateMatrixWorld(true);
    this.resolveLimbs();
    rig.bones.handL.getWorldPosition(this.handPos[0]!);
    rig.bones.handR.getWorldPosition(this.handPos[1]!);
    this.handPos[0]!.addScaledVector(_v.set(0, -0.08, 0).applyQuaternion(rig.bones.handL.getWorldQuaternion(_q)), 1);
    this.handPos[1]!.addScaledVector(_v.set(0, -0.08, 0).applyQuaternion(rig.bones.handR.getWorldQuaternion(_q)), 1);
    this.measureFeet(state);
    if (this.diagnostics) this.measureLimbs();
    this.lastPos.copy(feetPos);
  }

  /** Limb clipping diagnostic: small spheres at the extremities vs solid geometry (foliage excluded). */
  private measureLimbs(): void {
    const w = this.player.world;
    let worst = 0;
    let name = '';
    for (let i = 0; i < CLIP_JOINTS.length; i++) {
      const j = CLIP_JOINTS[i]!;
      if (j === 'handL' || j === 'handR') _v.copy(this.handPos[j === 'handL' ? 0 : 1]!);
      else this.rig.bones[j].getWorldPosition(_v);
      const d = w.spherePenetration(_v.x, _v.y, _v.z, 0.03, F_CANOPY);
      if (d > worst) {
        worst = d;
        name = j;
      }
    }
    this.limbPenetration = worst;
    this.limbPenetrationJoint = name;
  }

  /**
   * Limb collision on the final pose: arms and legs that would reach into solid
   * geometry are pulled back along their reach line (sphere cast from the
   * shoulder / hip), and feet are lifted so heel and toe stay above the ground.
   */
  private resolveLimbs(): void {
    const w = this.player.world;
    const b = this.rig.bones;
    const ray = this.wallRay;
    for (let limb = 0; limb < 4; limb++) {
      const arm = limb < 2;
      const side = limb & 1;
      const root = arm ? (side === 0 ? b.upperArmL : b.upperArmR) : side === 0 ? b.thighL : b.thighR;
      const mid = arm ? (side === 0 ? b.foreArmL : b.foreArmR) : side === 0 ? b.shinL : b.shinR;
      const end = arm ? (side === 0 ? b.handL : b.handR) : side === 0 ? b.footL : b.footR;
      root.getWorldPosition(_la);
      if (w.spherePenetration(_la.x, _la.y, _la.z, 0.02, F_CANOPY) > 0) {
        // Shoulder or hip pressed into a ledge: cast from the chest (or pelvis) instead.
        (arm ? b.chest : b.hips).getWorldPosition(_la);
        if (w.spherePenetration(_la.x, _la.y, _la.z, 0.02, F_CANOPY) > 0) continue;
      }
      end.getWorldPosition(_lw);
      // Extremity point: palm for hands, front of the toe cap (sole level) for feet.
      end.getWorldQuaternion(_q);
      _lp.set(0, arm ? -0.08 : -0.075, arm ? 0 : 0.215).applyQuaternion(_q).add(_lw);
      // Walls and props: cast from the shoulder to the palm, or from the hip to the
      // toe cap (ground contact under the feet is handled separately below).
      // Planted feet are left where they are.
      _ld.subVectors(_lp, _la);
      const len = _ld.length();
      if (len < 1e-3) continue;
      _ld.multiplyScalar(1 / len);
      let shift = 0;
      const plantedFoot = !arm && this.feet[side]!.planted && this.weights[S_IDLE]!.value + this.weights[S_RUN]!.value > 0.5;
      if (!plantedFoot && w.raycast(_la.x, _la.y, _la.z, _ld.x, _ld.y, _ld.z, len + 0.03, ray, F_CANOPY, -1, arm ? 0.035 : 0.03, false)) {
        if (arm || ray.ny < 0.7) shift = Math.max(0, Math.min(len - 0.25, len + 0.03 - ray.t));
      }
      _lt.copy(_lw).addScaledVector(_ld, -shift);
      if (!arm) {
        // Ground: ankle, heel and toe cap stay above the support under each.
        const gA = this.groundAt(_lt.x, _lt.y + 0.4, _lt.z);
        const gT = this.groundAt(_lp.x, _lp.y + 0.4, _lp.z);
        _lm.set(0, -0.075, -0.06).applyQuaternion(_q).add(_lw);
        const gH = this.groundAt(_lm.x, _lm.y + 0.4, _lm.z);
        const drop = shift * _ld.y;
        const lift = Math.max(gA + ANKLE_H - 0.02 - _lt.y, gT - 0.008 - (_lp.y - drop), gH - 0.008 - (_lm.y - drop));
        if (lift > 0 && lift < 0.6) _lt.y += lift + 0.01;
        else if (shift <= 0) continue;
      } else if (shift <= 0) continue;
      mid.getWorldPosition(_lm);
      _lm.sub(_la);
      solveTwoBone(root, mid, arm ? LIMB.upperArm : LIMB.thigh, arm ? LIMB.foreArm : LIMB.shin, _lt, _lm);
      end.updateWorldMatrix(false, true);
    }
    // Knees and elbows: bend the limb plane away from any surface they would enter.
    for (let limb = 0; limb < 4; limb++) {
      const arm = limb < 2;
      const side = limb & 1;
      const root = arm ? (side === 0 ? b.upperArmL : b.upperArmR) : side === 0 ? b.thighL : b.thighR;
      const mid = arm ? (side === 0 ? b.foreArmL : b.foreArmR) : side === 0 ? b.shinL : b.shinR;
      const end = arm ? (side === 0 ? b.handL : b.handR) : side === 0 ? b.footL : b.footR;
      mid.getWorldPosition(_lm);
      if (w.spherePenetration(_lm.x, _lm.y, _lm.z, 0.05, F_CANOPY) <= 0) continue;
      root.getWorldPosition(_la);
      if (w.spherePenetration(_la.x, _la.y, _la.z, 0.02, F_CANOPY) > 0) continue;
      w.resolveSphere(_lm, 0.07, F_CANOPY, 3);
      _lm.sub(_la);
      end.getWorldPosition(_lt);
      solveTwoBone(root, mid, arm ? LIMB.upperArm : LIMB.thigh, arm ? LIMB.foreArm : LIMB.shin, _lt, _lm);
      end.updateWorldMatrix(false, true);
    }
  }

  /** Foot-slide diagnostic on the final (blended) pose: planted feet must stay put. */
  private measureFeet(state: number): void {
    const b = this.rig.bones;
    const loco = this.weights[S_IDLE]!.value + this.weights[S_RUN]!.value;
    const grounded = (state === S_IDLE || state === S_RUN) && loco > 0.98;
    let slide = 0;
    for (let side = 0; side < 2; side++) {
      const f = this.feet[side]!;
      const fb = side === 0 ? b.footL : b.footR;
      fb.getWorldPosition(_v);
      const same = this.prevPlanted[side] && f.planted && this.prevPlant[side]!.distanceToSquared(f.pos) < 1e-10;
      if (grounded && same) slide = Math.max(slide, Math.hypot(_v.x - this.prevFoot[side]!.x, _v.z - this.prevFoot[side]!.z));
      this.prevFoot[side]!.copy(_v);
      this.prevPlant[side]!.copy(f.pos);
      this.prevPlanted[side] = f.planted && grounded;
    }
    this.plantSlide = slide;
  }

  // ---------------------------------------------------------------------------

  private setE(s: number, joint: JointName, x: number, y: number, z: number): void {
    _e.set(x, y, z, 'XYZ');
    this.poses[s]![J[joint]]!.setFromEuler(_e);
  }

  /** Pose for state s. FK joints via Euler; IK limbs solve on the live bones, then copy. */
  private computePose(s: number, dt: number, feet: Vector3, camYaw: number): void {
    const p = this.player;
    const t = this.time;
    const v = p.vel;
    const hs = Math.hypot(v.x, v.z);
    // Defaults: neutral spine/head
    this.setE(s, 'spine', 0, 0, 0);
    this.setE(s, 'chest', 0, 0, 0);
    this.setE(s, 'neck', 0, 0, 0);
    const headYaw = clamp(wrapAngle(camYaw + Math.PI - this.yaw), -0.7, 0.7) * 0.5;
    this.setE(s, 'head', 0, headYaw, 0);
    this.setE(s, 'shoulderL', 0, 0, 0);
    this.setE(s, 'shoulderR', 0, 0, 0);
    this.setE(s, 'toeL', 0, 0, 0);
    this.setE(s, 'toeR', 0, 0, 0);
    switch (s) {
      case S_IDLE: {
        const br = Math.sin(t * 1.7);
        this.setE(s, 'chest', br * 0.025, 0, 0);
        this.setE(s, 'spine', 0.02, 0, Math.sin(t * 0.5) * 0.02);
        this.setE(s, 'upperArmL', 0.05 + br * 0.02, 0, 0.14);
        this.setE(s, 'upperArmR', 0.05 + br * 0.02, 0, -0.14);
        this.setE(s, 'foreArmL', -0.25, 0, 0);
        this.setE(s, 'foreArmR', -0.25, 0, 0);
        this.setE(s, 'handL', 0, 0, 0.1);
        this.setE(s, 'handR', 0, 0, -0.1);
        this.groundLegs(s);
        this.crouchPose(s, feet, headYaw);
        break;
      }
      case S_RUN: {
        const sprint = smoothstep(9, 16, hs);
        this.groundLegs(s);
        const ph = this.phase * Math.PI * 2;
        const amp = 0.3 + 0.6 * sprint + 0.25 * smoothstep(1, 6, hs);
        // Arms counter-swing the same-side leg (positive X = arm back).
        // Opposite arm to leg: the arm swings back as its own leg reaches forward.
        const aL = clamp((this.footFwd[0]! - this.footFwd[1]!) * 0.6, -1, 1),
          aR = -aL;
        this.setE(s, 'upperArmL', aL * amp, 0, 0.12);
        this.setE(s, 'upperArmR', aR * amp, 0, -0.12);
        this.setE(s, 'foreArmL', -0.6 - 0.7 * sprint - Math.max(0, -aL) * 0.35, 0, 0);
        this.setE(s, 'foreArmR', -0.6 - 0.7 * sprint - Math.max(0, -aR) * 0.35, 0, 0);
        this.setE(s, 'handL', 0, 0, 0);
        this.setE(s, 'handR', 0, 0, 0);
        this.setE(s, 'chest', 0.05 * sprint, (aL - aR) * 0.12, 0);
        this.setE(s, 'spine', 0.04 + 0.02 * Math.cos(ph * 2), -(aL - aR) * 0.05, 0);
        this.crouchPose(s, feet, headYaw);
        break;
      }
      case S_AIR: {
        const rising = clamp(v.y / 10, -1, 1);
        const tuck = Math.max(0, rising);
        const fall = Math.max(0, -rising);
        this.setE(s, 'thighL', -0.9 * tuck - 0.2 * fall, 0, 0.08 + 0.1 * fall);
        this.setE(s, 'shinL', 1.3 * tuck + 0.35 * fall, 0, 0);
        this.setE(s, 'thighR', -0.3 * tuck + 0.25 * fall, 0, -0.08 - 0.1 * fall);
        this.setE(s, 'shinR', 0.6 * tuck + 0.6 * fall, 0, 0);
        this.setE(s, 'footL', 0.3, 0, 0);
        this.setE(s, 'footR', 0.3, 0, 0);
        const flail = Math.sin(t * 6) * 0.1 * fall;
        this.setE(s, 'upperArmL', -0.3 * tuck, 0, 1.0 + 0.35 * fall + flail);
        this.setE(s, 'upperArmR', -0.3 * tuck, 0, -1.0 - 0.35 * fall - flail);
        this.setE(s, 'foreArmL', -0.5, 0, 0.2);
        this.setE(s, 'foreArmR', -0.5, 0, -0.2);
        this.setE(s, 'handL', 0, 0, 0);
        this.setE(s, 'handR', 0, 0, 0);
        break;
      }
      case S_RELEASE: {
        const k = smoothstep(0, 0.25, this.sinceRelease);
        if (this.trick === TRICK_TWIST) {
          // Corkscrew: arms folded to the chest, legs long and together, toes pointed.
          const tw = Math.sin(Math.PI * clamp(this.sinceRelease / 0.7, 0, 1));
          this.setE(s, 'thighL', -0.1 * tw, 0, 0.02);
          this.setE(s, 'thighR', -0.05 * tw, 0, -0.02);
          this.setE(s, 'shinL', 0.15 + 0.3 * tw, 0, 0);
          this.setE(s, 'shinR', 0.1, 0, 0);
          this.setE(s, 'upperArmL', -0.5 * tw, 0, 0.25 + 0.9 * (1 - tw));
          this.setE(s, 'upperArmR', -0.5 * tw, 0, -0.25 - 0.9 * (1 - tw));
          this.setE(s, 'foreArmL', -2.1 * tw - 0.25, 0, 0);
          this.setE(s, 'foreArmR', -2.1 * tw - 0.25, 0, 0);
          this.setE(s, 'footL', 0.8, 0, 0);
          this.setE(s, 'footR', 0.8, 0, 0);
          this.setE(s, 'handL', 0, 0, 0);
          this.setE(s, 'handR', 0, 0, 0);
          this.setE(s, 'chest', -0.1 * k, 0, 0);
          break;
        }
        if (this.trick === TRICK_FLIP) {
          // Tucked flip
          const tk = Math.sin(Math.PI * clamp(this.sinceRelease / 0.6, 0, 1));
          this.setE(s, 'thighL', -1.6 * tk - 0.3, 0, 0.1);
          this.setE(s, 'thighR', -1.6 * tk - 0.3, 0, -0.1);
          this.setE(s, 'shinL', 2.0 * tk + 0.4, 0, 0);
          this.setE(s, 'shinR', 2.0 * tk + 0.4, 0, 0);
          this.setE(s, 'upperArmL', -1.2 * tk, 0, 0.6 + 0.8 * (1 - tk));
          this.setE(s, 'upperArmR', -1.2 * tk, 0, -0.6 - 0.8 * (1 - tk));
        } else {
          // Superhero spread
          this.setE(s, 'thighL', -0.75 * k, 0, 0.15);
          this.setE(s, 'shinL', 0.4, 0, 0);
          this.setE(s, 'thighR', 0.55 * k, 0, -0.15);
          this.setE(s, 'shinR', 0.9, 0, 0);
          this.setE(s, 'upperArmL', -0.2, 0, 1.45 * k);
          this.setE(s, 'upperArmR', -0.2, 0, -1.45 * k);
        }
        this.setE(s, 'footL', 0.35, 0, 0);
        this.setE(s, 'footR', 0.35, 0, 0);
        this.setE(s, 'foreArmL', -0.25, 0, 0);
        this.setE(s, 'foreArmR', -0.25, 0, 0);
        this.setE(s, 'handL', 0, 0, 0);
        this.setE(s, 'handR', 0, 0, 0);
        this.setE(s, 'chest', -0.15 * k, 0, 0);
        break;
      }
      case S_SWING: {
        const hand = p.rope.hand; // 0 left, 1 right
        const a = p.rope.anchor;
        const swingUp = clamp(v.y / 14, -1, 1);
        // Knees together and bent like a seat through the bottom of the arc, pulled
        // up into a tuck as it rises, stretched back on the drop.
        const tuck = Math.max(0, swingUp);
        const trail = Math.max(0, -swingUp);
        const fast = smoothstep(10, 30, Math.hypot(v.x, v.y, v.z));
        this.setE(s, 'thighL', -0.5 - 0.95 * tuck + 0.6 * trail, 0, 0.03);
        this.setE(s, 'shinL', 0.95 + 0.85 * tuck - 0.35 * trail, 0, 0);
        this.setE(s, 'thighR', -0.25 - 0.65 * tuck + 0.75 * trail, 0, -0.03);
        this.setE(s, 'shinR', 1.3 + 0.55 * tuck - 0.3 * trail, 0, 0);
        this.setE(s, 'footL', 0.6, 0, 0);
        this.setE(s, 'footR', 0.7, 0, 0);
        // Chest turns toward the line hand.
        this.setE(s, 'chest', -0.12, hand === 0 ? 0.16 : -0.16, hand === 0 ? -0.12 : 0.12);
        // Free arm flung out and back for balance, higher with speed.
        if (hand === 0) {
          this.setE(s, 'upperArmR', 0.55 + 0.3 * fast, 0, -1.2 - 0.3 * fast);
          this.setE(s, 'foreArmR', -0.25, 0, 0);
          this.setE(s, 'handR', 0, 0, -0.2);
        } else {
          this.setE(s, 'upperArmL', 0.55 + 0.3 * fast, 0, 1.2 + 0.3 * fast);
          this.setE(s, 'foreArmL', -0.25, 0, 0);
          this.setE(s, 'handL', 0, 0, 0.2);
        }
        // Active arm reaches up the line (IK, nearly straight).
        this.armIK(s, hand, _v3.set(a.x, a.y, a.z), 0.98);
        break;
      }
      case S_DIVE: {
        this.setE(s, 'thighL', 0.05, 0, 0.04);
        this.setE(s, 'thighR', 0.05, 0, -0.04);
        this.setE(s, 'shinL', 0.12, 0, 0);
        this.setE(s, 'shinR', 0.12, 0, 0);
        this.setE(s, 'footL', 0.9, 0, 0);
        this.setE(s, 'footR', 0.9, 0, 0);
        this.setE(s, 'upperArmL', 0.35, 0, 0.32);
        this.setE(s, 'upperArmR', 0.35, 0, -0.32);
        this.setE(s, 'foreArmL', -0.1, 0, 0);
        this.setE(s, 'foreArmR', -0.1, 0, 0);
        this.setE(s, 'handL', 0, 0, 0);
        this.setE(s, 'handR', 0, 0, 0);
        this.setE(s, 'head', -0.5, 0, 0);
        break;
      }
      case S_ZIP: {
        const target = _v3.set(p.zip.tx, p.zip.ty, p.zip.tz);
        this.armIK(s, 0, target, 0.95);
        this.armIK(s, 1, target, 0.95);
        // Knees drawn up together behind the pull.
        this.setE(s, 'thighL', -0.55, 0, 0.04);
        this.setE(s, 'thighR', -0.25, 0, -0.04);
        this.setE(s, 'shinL', 1.45, 0, 0);
        this.setE(s, 'shinR', 1.1, 0, 0);
        this.setE(s, 'footL', 0.6, 0, 0);
        this.setE(s, 'footR', 0.6, 0, 0);
        break;
      }
      case S_WALL:
        this.wallPose(s, feet, dt);
        break;
      case S_TRAV: {
        const tr = p.trav;
        const u = clamp(tr.t / Math.max(1e-3, tr.dur), 0, 1);
        if (tr.kind === TRAV_VAULT) {
          const k = Math.sin(Math.PI * u);
          this.setE(s, 'thighL', -1.3 * k - 0.2, 0, 0.5 * k);
          this.setE(s, 'thighR', -1.1 * k - 0.1, 0, 0.3 * k);
          this.setE(s, 'shinL', 1.6 * k + 0.2, 0, 0);
          this.setE(s, 'shinR', 1.3 * k + 0.2, 0, 0);
          this.setE(s, 'upperArmL', -1.0 + 0.4 * u, 0, 0.3);
          this.setE(s, 'upperArmR', -0.8 + 0.4 * u, 0, -0.5);
          this.setE(s, 'foreArmL', -0.2, 0, 0);
          this.setE(s, 'foreArmR', -0.2, 0, 0);
          this.setE(s, 'spine', 0.25 * k, 0, 0);
        } else {
          // Mantle: reach up, then push down while a knee comes up.
          const reach = 1 - smoothstep(0.2, 0.7, u);
          const knee = Math.sin(Math.PI * clamp((u - 0.3) / 0.6, 0, 1));
          this.setE(s, 'upperArmL', -2.6 * reach - 0.6 * (1 - reach), 0, 0.25);
          this.setE(s, 'upperArmR', -2.6 * reach - 0.6 * (1 - reach), 0, -0.25);
          this.setE(s, 'foreArmL', -0.3 - 0.9 * (1 - reach), 0, 0);
          this.setE(s, 'foreArmR', -0.3 - 0.9 * (1 - reach), 0, 0);
          this.setE(s, 'thighL', -1.5 * knee, 0, 0.1);
          this.setE(s, 'shinL', 1.8 * knee + 0.2, 0, 0);
          this.setE(s, 'thighR', -0.3 * knee, 0, -0.1);
          this.setE(s, 'shinR', 0.6 * knee + 0.2, 0, 0);
          this.setE(s, 'spine', 0.3 * (1 - reach), 0, 0);
        }
        this.setE(s, 'footL', 0.2, 0, 0);
        this.setE(s, 'footR', 0.2, 0, 0);
        this.setE(s, 'handL', 0, 0, 0);
        this.setE(s, 'handR', 0, 0, 0);
        break;
      }
      case S_ROLL: {
        this.setE(s, 'thighL', -2.1, 0, 0.1);
        this.setE(s, 'thighR', -2.1, 0, -0.1);
        this.setE(s, 'shinL', 2.3, 0, 0);
        this.setE(s, 'shinR', 2.3, 0, 0);
        this.setE(s, 'upperArmL', -1.4, 0, 0.3);
        this.setE(s, 'upperArmR', -1.4, 0, -0.3);
        this.setE(s, 'foreArmL', -1.2, 0, 0);
        this.setE(s, 'foreArmR', -1.2, 0, 0);
        this.setE(s, 'spine', 0.5, 0, 0);
        this.setE(s, 'chest', 0.4, 0, 0);
        this.setE(s, 'head', 0.5, 0, 0);
        this.setE(s, 'footL', 0.3, 0, 0);
        this.setE(s, 'footR', 0.3, 0, 0);
        this.setE(s, 'handL', 0, 0, 0);
        this.setE(s, 'handR', 0, 0, 0);
        break;
      }
    }
  }

  /**
   * Landing crouch on top of a ground pose: back and chest bent forward, head
   * up, the right hand down on the ground ahead and the left arm out behind.
   */
  private crouchPose(s: number, feet: Vector3, headYaw: number): void {
    const c = this.crouchW;
    if (c < 0.01) return;
    this.setE(s, 'spine', 0.35 * c, 0, 0);
    this.setE(s, 'chest', 0.22 * c, 0, 0);
    this.setE(s, 'head', -0.8 * c, headYaw * (1 - c), 0);
    this.setE(s, 'upperArmL', 0.05 + 0.6 * c, 0, 0.14 + 0.85 * c);
    this.setE(s, 'foreArmL', -0.25 - 0.25 * c, 0, 0);
    const P = this.poses[s]!;
    const joints = [J.upperArmR, J.foreArmR, J.handR] as const;
    for (let i = 0; i < 3; i++) _keep[i]!.copy(P[joints[i]]!);
    const sy = Math.sin(this.yaw),
      cy = Math.cos(this.yaw);
    // Ahead of the feet and a little to the right (the hero's right is -X at yaw 0).
    const x = feet.x + sy * 0.42 - cy * 0.2,
      z = feet.z + cy * 0.42 + sy * 0.2;
    _ct.set(x, this.groundAt(x, feet.y + 0.5, z) + 0.1, z);
    this.armIK(s, 1, _ct, 1);
    for (let i = 0; i < 3; i++) P[joints[i]]!.slerpQuaternions(_keep[i]!, _q.copy(P[joints[i]]!), c);
  }

  /** Arm IK toward a world point at `reach` of full arm length; result copied into pose s. */
  private armIK(s: number, side: number, target: Vector3, reach: number): void {
    const b = this.rig.bones;
    const ua = side === 0 ? b.upperArmL : b.upperArmR;
    const fa = side === 0 ? b.foreArmL : b.foreArmR;
    const hd = side === 0 ? b.handL : b.handR;
    ua.updateWorldMatrix(true, false);
    ua.getWorldPosition(_v);
    const dir = _v2.subVectors(target, _v);
    const len = dir.length();
    if (len < 1e-4) return;
    dir.multiplyScalar(1 / len);
    const armLen = (LIMB.upperArm + LIMB.foreArm) * reach;
    const goal = _goal.copy(_v).addScaledVector(dir, Math.min(len, armLen));
    // Elbow points backward/outward.
    const poleV = _pole.set(side === 0 ? 0.4 : -0.4, -0.3, -1).applyQuaternion(this.rootQ);
    solveTwoBone(ua, fa, LIMB.upperArm, LIMB.foreArm, goal, poleV);
    this.poses[s]![J[side === 0 ? 'upperArmL' : 'upperArmR']]!.copy(ua.quaternion);
    this.poses[s]![J[side === 0 ? 'foreArmL' : 'foreArmR']]!.copy(fa.quaternion);
    this.poses[s]![J[side === 0 ? 'handL' : 'handR']]!.identity();
    void hd;
  }

  /**
   * Gait (once per frame while a ground state has weight). Each foot is either
   * planted at a fixed world point or stepping along an arc to its next plant.
   * A cycle phase alternates the feet; the stance length is limited to what the
   * legs can reach at the current hip height, so planted feet never slide.
   */
  private gait(dt: number, feetPos: Vector3, hs: number): void {
    const p = this.player;
    const moving = hs > 0.6;
    this.gaitFrame++;
    this.gaitDrop += ((moving ? 0.05 + 0.09 * smoothstep(3, 16, hs) : 0) - this.gaitDrop) * dampFactor(10, dt);
    const vertical = HIP_H - this.gaitDrop - ANKLE_H;
    const reach = Math.sqrt(Math.max(0, LEG * LEG - vertical * vertical));
    const hl = Math.max(0.12, 0.85 * reach);
    const stride = 2 * clamp(0.35 + 0.12 * hs, 0.45, 2.4);
    const duty = clamp((2 * hl) / stride, 0.15, 0.62);
    this.gaitDuty = duty;
    if (moving) this.phase = (this.phase + (hs * dt) / stride) % 1;
    const cycleTime = stride / Math.max(0.6, hs);
    const leftV = _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const vx = p.vel.x,
      vz = p.vel.z;
    const dirX = hs > 1e-3 ? vx / hs : Math.sin(this.yaw),
      dirZ = hs > 1e-3 ? vz / hs : Math.cos(this.yaw);
    const lift = 0.1 + 0.34 * smoothstep(4, 16, hs);
    // Teleports and respawns: re-seat the feet under the body.
    for (const f of this.feet) {
      if (Math.abs(f.pos.x - feetPos.x) + Math.abs(f.pos.z - feetPos.z) > 3 || Math.abs(f.pos.y - feetPos.y) > 2) this.feetReady = false;
    }
    if (!this.feetReady) {
      for (let side = 0; side < 2; side++) {
        const f = this.feet[side]!;
        const lat = side === 0 ? 0.1 : -0.1;
        const x = feetPos.x + leftV.x * lat,
          z = feetPos.z + leftV.z * lat;
        f.pos.set(x, this.groundAt(x, feetPos.y, z), z);
        f.planted = true;
      }
      this.feetReady = true;
    }
    for (let side = 0; side < 2; side++) {
      const f = this.feet[side]!;
      const other = this.feet[1 - side]!;
      const lat = side === 0 ? 0.1 - 0.025 * smoothstep(3, 12, hs) : -0.1 + 0.025 * smoothstep(3, 12, hs);
      const restX = feetPos.x + leftV.x * lat,
        restZ = feetPos.z + leftV.z * lat;
      const cyc = (this.phase + side * 0.5) % 1;
      const hipX = restX,
        hipZ = restZ;
      if (f.planted) {
        f.landT += dt;
        const d = Math.hypot(f.pos.x - hipX, f.pos.z - hipZ);
        let liftNow = false;
        let dur = 0;
        if (moving) {
          // Lift in the first part of this foot's swing window (level-triggered, so a
          // start from idle or a speed change never leaves a foot behind).
          const into = cyc - duty;
          if (into >= 0 && into < (1 - duty) * 0.6 && f.landT > 0.08) {
            liftNow = true;
            dur = Math.max(0.07, (1 - cyc) * cycleTime);
          } else if (d > reach * 0.97 && (other.planted || d > reach * 1.12)) {
            // Overstretched (start, sharp turn): take a quick step.
            liftNow = true;
            dur = clamp(0.5 * cycleTime, 0.08, 0.2);
          }
        } else if (other.planted && Math.hypot(f.pos.x - restX, f.pos.z - restZ) > 0.16) {
          // Idle: shuffle back under the hips after turns or stops.
          const od = Math.hypot(other.pos.x - (feetPos.x - leftV.x * lat), other.pos.z - (feetPos.z - leftV.z * lat));
          if (Math.hypot(f.pos.x - restX, f.pos.z - restZ) >= od) {
            liftNow = true;
            dur = 0.22;
          }
        }
        if (liftNow) {
          f.planted = false;
          f.from.copy(f.pos);
          f.t = 0;
          f.dur = dur;
        }
      }
      if (!f.planted) {
        f.t += dt;
        const left = Math.max(0, f.dur - f.t);
        if (moving) {
          // Land half a stance ahead of where the hips will be at touchdown.
          f.to.set(restX + vx * left + dirX * hl * 0.92, 0, restZ + vz * left + dirZ * hl * 0.92);
        } else {
          // Stopped mid-step: finish the step under the hips.
          f.to.set(restX, 0, restZ);
          if (f.dur - f.t < 0.1 && f.t < 0.3) f.dur = Math.max(f.dur, Math.min(f.t + 0.1, 0.4));
        }
        const u = clamp(f.t / Math.max(1e-3, f.dur), 0, 1);
        // Running swing: the heel kicks up behind first, then the foot reaches forward and down.
        const kick = moving ? smoothstep(3, 10, hs) : 0;
        const uh = clamp((u - 0.08 * kick) / (1 - 0.08 * kick), 0, 1);
        const e = uh * uh * (3 - 2 * uh);
        const x = f.from.x + (f.to.x - f.from.x) * e;
        const z = f.from.z + (f.to.z - f.from.z) * e;
        const gy = this.groundAt(x, feetPos.y, z);
        const arc = Math.sin(Math.PI * Math.pow(u, 1 - 0.35 * kick));
        const y = Math.max(gy, f.from.y + (gy - f.from.y) * e) + arc * (moving ? lift : 0.06);
        f.pos.set(x, y, z);
        if (u >= 1) {
          f.pos.y = gy;
          f.planted = true;
          f.landT = 0;
          this.onFootstep?.({ side: side as 0 | 1, surface: p.groundSurface, intensity: moving ? smoothstep(2, 16, hs) : 0.15 });
        }
      }
      f.prevCyc = cyc;
      // Fore-aft offset relative to the hips, for arm swing.
      const fwdOff = (f.pos.x - hipX) * dirX + (f.pos.z - hipZ) * dirZ;
      this.footFwd[side] = moving ? clamp(fwdOff / Math.max(0.2, hl * 1.4), -1, 1) : 0;
    }
  }

  /** Lowest hip height (relative to the feet) at which both feet stay within leg reach. */
  private hipsLimit(feetPos: Vector3): number {
    let lim = Infinity;
    const leftV = _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    for (let side = 0; side < 2; side++) {
      const f = this.feet[side]!;
      // Only planted feet constrain the hips; a stepping foot simply reaches.
      if (!f.planted) continue;
      const lat = side === 0 ? 0.1 : -0.1;
      const dh = Math.hypot(f.pos.x - (feetPos.x + leftV.x * lat), f.pos.z - (feetPos.z + leftV.z * lat));
      const v = Math.sqrt(Math.max(0.04, LEG * LEG - dh * dh));
      lim = Math.min(lim, f.pos.y + ANKLE_H - feetPos.y + v + 0.045);
    }
    // Never squat deeper than a lunge; beyond that a step is taken instead.
    return lim === Infinity ? 2 : Math.max(lim, 0.7);
  }

  /** Two-bone IK to the gait's foot targets (solved once per frame, shared by idle and run). */
  private groundLegs(s: number): void {
    const b = this.rig.bones;
    if (this.legsSolvedFrame !== this.gaitFrame) {
      this.legsSolvedFrame = this.gaitFrame;
      const pole = _v3.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      for (let side = 0; side < 2; side++) {
        const f = this.feet[side]!;
        const thigh = side === 0 ? b.thighL : b.thighR;
        const shin = side === 0 ? b.shinL : b.shinR;
        const foot = side === 0 ? b.footL : b.footR;
        _v.set(f.pos.x, f.pos.y + ANKLE_H, f.pos.z);
        solveTwoBone(thigh, shin, LIMB.thigh, LIMB.shin, _v, pole);
        // Foot follows the ground slope under heel and toe (curbs, park hills).
        const fx = Math.sin(this.yaw),
          fz = Math.cos(this.yaw);
        const gHeel = this.groundAt(f.pos.x - fx * 0.06, f.pos.y + 0.3, f.pos.z - fz * 0.06);
        const gToe = this.groundAt(f.pos.x + fx * 0.17, f.pos.y + 0.3, f.pos.z + fz * 0.17);
        const pitch = f.planted || f.t / Math.max(1e-3, f.dur) > 0.8 ? clamp(Math.atan2(gToe - gHeel, 0.23), -0.6, 0.6) : 0;
        shin.updateWorldMatrix(true, false);
        shin.getWorldQuaternion(_q);
        _q2.setFromAxisAngle(UP, this.yaw).multiply(_qp.setFromAxisAngle(_xAxis, -pitch));
        foot.quaternion.copy(_q.invert().multiply(_q2));
        this.legQ[side * 3]!.copy(thigh.quaternion);
        this.legQ[side * 3 + 1]!.copy(shin.quaternion);
        this.legQ[side * 3 + 2]!.copy(foot.quaternion);
      }
    }
    const P = this.poses[s]!;
    P[J.thighL]!.copy(this.legQ[0]!);
    P[J.shinL]!.copy(this.legQ[1]!);
    P[J.footL]!.copy(this.legQ[2]!);
    P[J.thighR]!.copy(this.legQ[3]!);
    P[J.shinR]!.copy(this.legQ[4]!);
    P[J.footR]!.copy(this.legQ[5]!);
  }

  private groundAt(x: number, y: number, z: number): number {
    const g = this.player.groundBelow(x, y, z);
    return g > -1e6 ? g : y;
  }

  /** Wall cling and crawl: hands and feet on the wall plane in a diagonal gait. */
  private wallPose(s: number, feetPos: Vector3, dt: number): void {
    const p = this.player;
    const b = this.rig.bones;
    const n = _v2.set(p.wall.nx, 0, p.wall.nz);
    const rightW = _right.set(-n.z, 0, n.x); // along the wall
    const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
    const moving = speed > 0.4;
    const stride = 0.42;
    const duty = 0.55;
    if (moving) this.crawl = (this.crawl + (speed * dt * duty) / stride) % 1;
    this.wallRunT = p.wall.run > 2 ? this.wallRunT + dt : 0;
    // Movement direction on the wall plane (unit), default up.
    const md = _v3.set(p.vel.x, p.vel.y, p.vel.z);
    md.addScaledVector(n, -md.dot(n));
    if (md.lengthSq() < 1e-4) md.set(0, 1, 0);
    md.normalize();
    const w = p.world;
    const R = tuning.body.radius;
    const limbs = WALL_LIMBS;
    for (const l of limbs) {
      const c = (this.crawl + l.phase) % 1;
      let off: number, away: number;
      if (!moving) {
        off = 0;
        away = 0;
      } else if (c < duty) {
        // Stance: moves backward relative to the body at body speed (no slide).
        off = stride * (0.5 - c / duty);
        away = 0;
      } else {
        const u = (c - duty) / (1 - duty);
        off = stride * (-0.5 + u);
        away = Math.sin(Math.PI * u) * 0.12;
      }
      // Probe the real surface under this limb (pilasters, cornices, corners) so
      // palms and soles rest on it instead of sinking in.
      const bx = feetPos.x + rightW.x * l.lat + md.x * off;
      const by = feetPos.y + l.up + md.y * off;
      const bz = feetPos.z + rightW.z * l.lat + md.z * off;
      const gap = l.arm ? 0.045 : 0.095;
      const surf = w.raycast(bx, by, bz, -n.x, 0, -n.z, R + 0.6, this.wallRay, F_CANOPY) ? this.wallRay.t : R;
      const d = Math.max(0.05, surf - gap - away);
      _v.set(bx - n.x * d, by, bz - n.z * d);
      w.resolveSphere(_v, 0.05, F_CANOPY, 2);
      if (l.arm) {
        const ua = l.side === 0 ? b.upperArmL : b.upperArmR;
        const fa = l.side === 0 ? b.foreArmL : b.foreArmR;
        const hd = l.side === 0 ? b.handL : b.handR;
        const pole = _pole.set(l.side === 0 ? 1 : -1, -0.6, -0.3).applyQuaternion(this.rootQ);
        solveTwoBone(ua, fa, LIMB.upperArm, LIMB.foreArm, _v, pole);
        this.poses[s]![J[l.side === 0 ? 'upperArmL' : 'upperArmR']]!.copy(ua.quaternion);
        this.poses[s]![J[l.side === 0 ? 'foreArmL' : 'foreArmR']]!.copy(fa.quaternion);
        // Palm flat on the wall, fingers up and splayed outward.
        _goal.set(0, 1, 0).addScaledVector(rightW, l.side === 0 ? -0.35 : 0.35).normalize();
        aimQuaternion(_goal, n, _q);
        hd.updateWorldMatrix(true, false);
        setWorldQuaternion(hd, _q);
        this.poses[s]![J[l.side === 0 ? 'handL' : 'handR']]!.copy(hd.quaternion);
      } else {
        const th = l.side === 0 ? b.thighL : b.thighR;
        const sh = l.side === 0 ? b.shinL : b.shinR;
        const ft = l.side === 0 ? b.footL : b.footR;
        // Knees point outward and away from the wall, frog-like.
        const pole = _pole.set(l.side === 0 ? 0.9 : -0.9, 0.2, -0.7).applyQuaternion(this.rootQ);
        solveTwoBone(th, sh, LIMB.thigh, LIMB.shin, _v, pole);
        this.poses[s]![J[l.side === 0 ? 'thighL' : 'thighR']]!.copy(th.quaternion);
        this.poses[s]![J[l.side === 0 ? 'shinL' : 'shinR']]!.copy(sh.quaternion);
        // Sole against the wall, toes down.
        _goal.copy(n).multiplyScalar(-1);
        aimQuaternion(_goal, _pole.set(0, -1, 0), _q);
        ft.updateWorldMatrix(true, false);
        setWorldQuaternion(ft, _q);
        this.poses[s]![J[l.side === 0 ? 'footL' : 'footR']]!.copy(ft.quaternion);
      }
    }
    this.setE(s, 'spine', 0.12, 0, 0);
    this.setE(s, 'chest', 0.08, 0, 0);
    this.setE(s, 'head', -0.25, 0, 0);
  }

  /** Bones for external use (web line hand). */
  bone(name: JointName): Bone {
    return this.rig.bones[name];
  }
}
