import { Euler, Quaternion, Vector3 } from 'three';
import { tuning } from '../../config/tuning';
import { clamp, smoothstep } from '../../core/math';
import { ANIM, EF, ES } from '../types';
import type { ViewEnemy } from '../client/combatView';
import { ARCH, J, type RigDef } from './enemyRigs';

/** Bones per pose slot (the texture row holds up to 32). */
export const MAX_BONES = 32;

/**
 * Render-side state of one enemy (pooled, keyed by enemy id): the smoothed
 * joint angles, the walk phase, the last skinning matrices (reused by the
 * cheap LOD) and one-shot effect flags.
 */
export interface PoseSlot {
  id: number;
  arch: number;
  /** Joint angles (Euler XYZ per bone), eased toward the pose's targets. */
  readonly cur: Float32Array;
  /** Hips offset (y, z) eased like the angles. */
  readonly root: Float32Array;
  /** Skinning rows: 12 floats per bone (3x4, row-major). */
  readonly skin: Float32Array;
  phase: number;
  spin: number;
  speed: number;
  /** Smoothed horizontal velocity (drone tilt). */
  vx: number;
  vz: number;
  px: number;
  py: number;
  pz: number;
  fresh: boolean;
  /** Render time of the last pose evaluation (LOD skips frames). */
  posedAt: number;
  /** Frame the slot was last listed (unseen slots go back to the pool). */
  seen: number;
  /** Stagger for the LOD frame skipping. */
  lodPhase: number;
  /** Render-only hit flash until this render time. */
  flashUntil: number;
  /** The pose's anim id and start the effects below belong to. */
  fxAnim: number;
  fxT0: number;
  /** One-shot effects of the current pose already fired (bits: 1 knockdown dust, 2 slam dust). */
  fxDone: number;
  /** Aim pitch toward the target (radians, up positive), for gunmen and drones. */
  aim: number;
}

export function makePoseSlot(): PoseSlot {
  return {
    id: 0,
    arch: 0,
    cur: new Float32Array(MAX_BONES * 3),
    root: new Float32Array(2),
    skin: new Float32Array(MAX_BONES * 12),
    phase: 0,
    spin: 0,
    speed: 0,
    vx: 0,
    vz: 0,
    px: 0,
    py: 0,
    pz: 0,
    fresh: true,
    posedAt: 0,
    seen: 0,
    lodPhase: 0,
    flashUntil: -1e9,
    fxAnim: -1,
    fxT0: 0,
    fxDone: 0,
    aim: 0,
  };
}

const TAU = Math.PI * 2;
const _e = new Euler();
const _q = new Quaternion();
const _qW: Quaternion[] = [];
const _pW: Vector3[] = [];
for (let i = 0; i < MAX_BONES; i++) {
  _qW.push(new Quaternion());
  _pW.push(new Vector3());
}

/**
 * FK pose library for the enemy rigs (not the hero animator): per archetype
 * and replicated pose id (`ANIM`) a set of joint angle targets, eased per
 * frame (fast for strikes, slower for falls), then forward kinematics into
 * skinning rows. Poses: idle (relaxed, or a guard when alerted), walk, run
 * and strafe cycles driven by the measured speed, alert, wind-up (thug fist
 * cocked, bat raised overhead, gun aimed, brute slam or charge crouch, drone
 * nose-up) with its tell glow, strike (punch, bat follow-through, recoil,
 * slam), stagger, knockdown, get-up, pinned (arms clamped, struggling),
 * yanked (tumbling toward the hero), KO (limp on the back), taunt, block,
 * charge and throw; the drone tilts with its velocity and spins its rotors.
 * No allocation per call.
 */
export class EnemyAnimator {
  private readonly tgt = new Float32Array(MAX_BONES * 3);
  private readonly rootT = new Float32Array(2);

  /**
   * Pose one enemy: `t` is the render time, `dt` the time since its last
   * pose, `full` false for the far LOD (no secondary motion). Writes
   * `slot.skin`.
   */
  pose(slot: PoseSlot, def: RigDef, e: ViewEnemy, t: number, dt: number): void {
    const age = Math.max(0, t - e.animT0);
    // Speed from the interpolated motion (the replicated state carries no velocity).
    if (slot.fresh) {
      slot.px = e.x;
      slot.py = e.y;
      slot.pz = e.z;
      slot.fresh = false;
      slot.speed = 0;
      slot.vx = slot.vz = 0;
    } else if (dt > 1e-4) {
      const vx = (e.x - slot.px) / dt,
        vz = (e.z - slot.pz) / dt;
      const k = 1 - Math.exp(-dt * 8);
      slot.vx += (vx - slot.vx) * k;
      slot.vz += (vz - slot.vz) * k;
      slot.speed = Math.min(15, Math.hypot(slot.vx, slot.vz));
      slot.px = e.x;
      slot.py = e.y;
      slot.pz = e.z;
    }
    const tg = this.tgt;
    tg.fill(0);
    this.rootT[0] = 0;
    this.rootT[1] = 0;
    let rate = 12;
    if (def.arch === ARCH.DRONE) rate = this.drone(slot, e, age, dt);
    else rate = this.humanoid(slot, def, e, age, dt, t);
    // Ease toward the targets.
    const k = 1 - Math.exp(-dt * rate);
    const n = def.bones * 3;
    const cur = slot.cur;
    for (let i = 0; i < n; i++) cur[i]! += (tg[i]! - cur[i]!) * k;
    slot.root[0]! += (this.rootT[0]! - slot.root[0]!) * k;
    slot.root[1]! += (this.rootT[1]! - slot.root[1]!) * k;
    this.fk(slot, def);
  }

  /** Snap to the rest pose (warm-up, a reused slot). */
  rest(slot: PoseSlot, def: RigDef): void {
    slot.cur.fill(0);
    slot.root.fill(0);
    this.fk(slot, def);
  }

  private set(j: number, x: number, y: number, z: number): void {
    const tg = this.tgt;
    tg[j * 3] = x;
    tg[j * 3 + 1] = y;
    tg[j * 3 + 2] = z;
  }

  private add(j: number, x: number, y: number, z: number): void {
    const tg = this.tgt;
    tg[j * 3]! += x;
    tg[j * 3 + 1]! += y;
    tg[j * 3 + 2]! += z;
  }

  /** Humanoid targets; returns the easing rate. */
  private humanoid(slot: PoseSlot, def: RigDef, e: ViewEnemy, age: number, dt: number, t: number): number {
    const a = def.arch;
    const s = def.scale;
    const hipsY = def.offset[1]!;
    const alerted = (e.flags & EF.ALERTED) !== 0;
    const id = e.id;
    // Locomotion phase (cycles per metre travelled, slower strides for the brute).
    const v = slot.speed;
    slot.phase = (slot.phase + (dt * v) / ((1.05 + 0.22 * v) * s)) % 1;
    let rate = 12;
    const anim = e.anim;
    const breathe = Math.sin(t * 2.1 + id) * 0.03;
    // Relaxed stance.
    this.set(J.upperArmL, 0.05, 0, 0.12);
    this.set(J.upperArmR, 0.05, 0, -0.12);
    this.set(J.foreArmL, -0.18, 0, 0);
    this.set(J.foreArmR, -0.18, 0, 0);
    this.set(J.chest, breathe, 0, 0);
    if (anim === ANIM.KNOCKDOWN || anim === ANIM.KO) {
      // Flat on the back; the KO pose is limper with the head turned.
      const ko = anim === ANIM.KO;
      this.set(J.hips, -1.48, 0, ko ? 0.08 : 0);
      this.rootT[0] = -(hipsY - 0.16 * s);
      this.rootT[1] = -0.5 * s;
      this.set(J.spine, -0.05, 0, 0);
      this.set(J.head, ko ? 0.1 : 0.35, ko ? 0.6 : 0, 0);
      this.set(J.upperArmL, ko ? 0.2 : -0.4, 0, ko ? 1.35 : 1.0);
      this.set(J.upperArmR, ko ? 0.1 : -0.5, 0, ko ? -1.2 : -0.9);
      this.set(J.foreArmL, ko ? -0.3 : -0.9, 0, 0);
      this.set(J.foreArmR, ko ? -0.5 : -0.9, 0, 0);
      this.set(J.thighL, ko ? -0.15 : -0.4, 0, 0.12);
      this.set(J.thighR, ko ? -0.35 : -0.2, 0, -0.1);
      this.set(J.shinL, ko ? 0.2 : 0.6, 0, 0);
      this.set(J.shinR, ko ? 0.6 : 0.3, 0, 0);
      if (a === ARCH.BRUTE) this.shieldGuard(0.4);
      return ko ? 7 : 11;
    }
    if (anim === ANIM.GETUP) {
      const u = clamp(age / 0.5, 0, 1);
      if (u < 0.55) {
        // Sit up onto one knee.
        this.set(J.hips, -0.35, 0, 0);
        this.rootT[0] = -(hipsY - 0.42 * s);
        this.set(J.spine, 0.4, 0, 0);
        this.set(J.thighL, -1.5, 0, 0.1);
        this.set(J.shinL, 2.1, 0, 0);
        this.set(J.thighR, -0.3, 0, -0.1);
        this.set(J.shinR, 1.9, 0, 0);
        this.set(J.upperArmR, 0.5, 0, -0.35);
        this.set(J.upperArmL, -0.6, 0, 0.3);
      }
      if (a === ARCH.BRUTE) this.shieldGuard(0.6);
      return 13;
    }
    if (anim === ANIM.PINNED || e.state === ES.PINNED) {
      // Wrapped: arms clamped to the sides, legs together, struggling inside the webbing.
      const w = Math.sin(t * 13 + id);
      this.set(J.upperArmL, 0.08, 0, 0.06);
      this.set(J.upperArmR, 0.08, 0, -0.06);
      this.set(J.foreArmL, -0.25, 0, 0);
      this.set(J.foreArmR, -0.25, 0, 0);
      this.set(J.thighL, 0, 0, -0.03);
      this.set(J.thighR, 0, 0, 0.03);
      this.set(J.chest, -0.05, w * 0.14, Math.sin(t * 9 + id) * 0.06);
      this.set(J.head, -0.15, -w * 0.3, 0);
      return 16;
    }
    if (anim === ANIM.YANKED) {
      // Tumbling toward the hero: pitched forward, arms reaching, legs trailing.
      this.set(J.hips, 0.75, 0, 0);
      this.rootT[0] = 0.12 * s;
      this.set(J.upperArmL, -2.1, 0, 0.4);
      this.set(J.upperArmR, -2.0, 0, -0.4);
      this.set(J.thighL, 0.7, 0, 0.1);
      this.set(J.thighR, 0.4, 0, -0.1);
      this.set(J.shinL, 1.1, 0, 0);
      this.set(J.shinR, 0.9, 0, 0);
      this.set(J.head, -0.4, 0, 0);
      return 22;
    }

    // Upright poses: locomotion first, then the upper body.
    const moving = anim === ANIM.WALK || anim === ANIM.RUN || anim === ANIM.STRAFE || anim === ANIM.CHARGE || (v > 0.6 && anim !== ANIM.STRIKE && anim !== ANIM.SHOOT);
    if (moving && v > 0.15) {
      const run = clamp((v - 1.8) / 2.5, 0, 1);
      const amp = clamp(v / 2.2, 0, 1) * (0.42 + 0.35 * run) * (anim === ANIM.STRAFE ? 0.6 : 1);
      const ph = slot.phase * TAU;
      const sn = Math.sin(ph),
        cs = Math.cos(ph);
      this.set(J.thighL, -sn * amp, 0, 0);
      this.set(J.thighR, sn * amp, 0, 0);
      this.set(J.shinL, (0.15 + 0.9 * Math.max(0, cs)) * amp * 1.4, 0, 0);
      this.set(J.shinR, (0.15 + 0.9 * Math.max(0, -cs)) * amp * 1.4, 0, 0);
      this.set(J.footL, -0.2 * sn * amp, 0, 0);
      this.set(J.footR, 0.2 * sn * amp, 0, 0);
      this.set(J.upperArmL, sn * amp * 0.9, 0, 0.14);
      this.set(J.upperArmR, -sn * amp * 0.9, 0, -0.14);
      this.set(J.foreArmL, -0.3 - 0.9 * run, 0, 0);
      this.set(J.foreArmR, -0.3 - 0.9 * run, 0, 0);
      this.set(J.spine, 0.05 + 0.16 * run, 0, 0);
      this.set(J.chest, breathe, sn * 0.12 * amp, 0);
      this.set(J.hips, 0, -sn * 0.1 * amp, 0);
      this.rootT[0] = -Math.abs(cs) * 0.05 * amp * s;
    } else {
      // Standing: feet a little apart, knees soft when ready to fight.
      this.set(J.thighL, alerted ? -0.22 : 0, 0, 0.06);
      this.set(J.thighR, alerted ? 0.12 : 0, 0, -0.06);
      this.set(J.shinL, alerted ? 0.35 : 0.04, 0, 0);
      this.set(J.shinR, alerted ? 0.25 : 0.04, 0, 0);
      if (alerted) this.rootT[0] = -0.05 * s;
    }
    rate = 12;
    // Ready stance of the upper body while engaged (also while moving in a fight). The brute never lowers his shield.
    const ready = alerted && anim !== ANIM.IDLE ? 1 : alerted ? 0.8 : 0;
    if (ready > 0) this.guard(a, ready, slot.aim);
    else if (a === ARCH.BRUTE) this.shieldGuard(0.85);

    switch (anim) {
      case ANIM.ALERT: {
        const k = Math.sin(Math.PI * clamp(age / 0.35, 0, 1));
        this.add(J.spine, -0.18 * k, 0, 0);
        this.add(J.head, -0.25 * k, 0, 0);
        this.add(J.upperArmL, -0.5 * k, 0, 0.2 * k);
        this.add(J.upperArmR, -0.5 * k, 0, -0.2 * k);
        break;
      }
      case ANIM.WINDUP:
        rate = this.windup(a, clamp(age / Math.max(0.1, this.telegraphOf(a)), 0, 1), slot, t);
        break;
      case ANIM.AIM:
        this.aimPose(slot.aim, 1);
        rate = 16;
        break;
      case ANIM.SHOOT: {
        this.aimPose(slot.aim, 1);
        const gap = tuning.enemies.gunman.burstGap;
        let kick = 0;
        for (let k = 0; k < 3; k++) {
          const dtk = age - k * gap;
          if (dtk >= 0) kick += Math.exp(-dtk * 28);
        }
        this.add(J.foreArmR, -0.35 * kick, 0, 0);
        this.add(J.upperArmR, -0.15 * kick, 0, 0);
        this.add(J.chest, -0.05 * kick, 0, 0);
        rate = 30;
        break;
      }
      case ANIM.STRIKE:
        rate = this.strike(a, age);
        break;
      case ANIM.STAGGER: {
        const k = 1 - smoothstep(0.15, 0.45, age);
        this.add(J.spine, -0.3 * k, 0, 0.1 * k);
        this.add(J.chest, -0.22 * k, 0.2 * k, 0);
        this.add(J.head, -0.35 * k, 0, 0);
        this.add(J.upperArmL, 0.3 * k, 0, 0.5 * k);
        this.add(J.upperArmR, 0.3 * k, 0, -0.5 * k);
        this.add(J.thighR, 0.3 * k, 0, 0);
        rate = 24;
        break;
      }
      case ANIM.TAUNT: {
        const k = 0.5 + 0.5 * Math.sin(age * 6);
        this.set(J.upperArmL, -0.4, 0, 0.9);
        this.set(J.upperArmR, -0.4, 0, -0.9);
        this.set(J.foreArmL, -0.6 - 0.6 * k, 0, 0);
        this.set(J.foreArmR, -0.6 - 0.6 * k, 0, 0);
        this.add(J.chest, -0.15, 0, 0);
        this.add(J.head, -0.15, 0, 0);
        break;
      }
      case ANIM.BLOCK: {
        const k = Math.sin(Math.PI * clamp(age / 0.35, 0, 1));
        this.shieldGuard(1);
        this.add(J.upperArmL, -0.35 * k, 0, 0);
        this.add(J.spine, -0.12 * k, 0, 0);
        this.rootT[1] = -0.08 * k * s;
        rate = 24;
        break;
      }
      case ANIM.CHARGE:
        // Head down, shield first; the run cycle above drives the legs.
        this.add(J.spine, 0.35, 0, 0);
        this.add(J.chest, 0.2, 0, 0);
        this.add(J.head, -0.3, 0, 0);
        if (e.state === ES.TELEGRAPH) {
          // The wind-up: a low crouch, pawing the ground.
          this.rootT[0] = -0.16 * s;
          this.add(J.thighL, -0.5, 0, 0);
          this.add(J.shinL, 0.8, 0, 0);
          this.add(J.thighR, 0.4 + 0.25 * Math.sin(t * 9), 0, 0);
          this.add(J.shinR, 0.6, 0, 0);
        }
        this.shieldGuard(1);
        rate = 16;
        break;
      case ANIM.THROW: {
        // Bottle wind-up overhead, then the throw (the brain's strike follows).
        const u = clamp(age / Math.max(0.1, tuning.enemies.thug.telegraph * 1.2), 0, 1);
        this.set(J.upperArmR, -2.6 * u, 0, -0.3);
        this.set(J.foreArmR, -1.3 * u, 0, 0);
        this.add(J.chest, -0.15 * u, -0.45 * u, 0);
        this.add(J.spine, -0.12 * u, 0, 0);
        rate = 18;
        break;
      }
      default:
        break;
    }
    // Render-only flinch (predicted hit) and the confirmed hit flash rock the torso.
    const fl = clamp((e.flinchUntil - t) / 0.2, 0, 1);
    if (fl > 0) {
      this.add(J.spine, -0.22 * fl, 0, 0);
      this.add(J.head, -0.3 * fl, 0, 0);
      rate = Math.max(rate, 24);
    }
    return rate;
  }

  /** Ready stance per archetype: fists up, bat on the shoulder, pistol at low ready, shield up. */
  private guard(a: number, k: number, aim: number): void {
    switch (a) {
      case ARCH.THUG:
        this.set(J.upperArmL, -0.65 * k, 0, 0.32 * k);
        this.set(J.upperArmR, -0.5 * k, 0, -0.32 * k);
        this.set(J.foreArmL, -1.9 * k, 0, 0);
        this.set(J.foreArmR, -2.0 * k, 0, 0);
        this.add(J.spine, 0.1 * k, 0, 0);
        break;
      case ARCH.BAT:
        this.set(J.upperArmR, -0.8 * k, 0, -0.35 * k);
        this.set(J.foreArmR, -2.1 * k, 0, 0);
        this.set(J.upperArmL, -0.45 * k, 0, 0.2 * k);
        this.set(J.foreArmL, -1.5 * k, 0, 0);
        break;
      case ARCH.GUNMAN:
        this.set(J.upperArmR, (-0.55 - aim * 0.5) * k, 0, -0.1 * k);
        this.set(J.foreArmR, -0.55 * k, 0, 0);
        this.set(J.upperArmL, -0.2 * k, 0, 0.18 * k);
        this.set(J.foreArmL, -0.9 * k, 0, 0);
        break;
      case ARCH.BRUTE:
        this.shieldGuard(k);
        this.set(J.upperArmR, -0.45 * k, 0, -0.3 * k);
        this.set(J.foreArmR, -1.3 * k, 0, 0);
        this.add(J.spine, 0.12 * k, 0, 0);
        break;
      default:
        break;
    }
  }

  /** Brute's shield arm: forearm up in front of the chest (the shield faces forward). */
  private shieldGuard(k: number): void {
    this.set(J.upperArmL, -1.25 * k, -0.15 * k, 0.12 * k);
    this.set(J.foreArmL, -1.7 * k, 0, 0);
  }

  /** Gunman's aim: right arm straight at the target (pitch `aim`), left hand supporting. */
  private aimPose(aim: number, k: number): void {
    this.set(J.upperArmR, (-1.5 - aim) * k, 0, 0.05 * k);
    this.set(J.foreArmR, -0.05 * k, 0, 0);
    this.set(J.handR, 0.05, 0, 0);
    this.set(J.upperArmL, (-1.35 - aim) * k, 0, -0.5 * k);
    this.set(J.foreArmL, -0.55 * k, 0, 0);
    this.add(J.chest, 0, -0.28 * k, 0);
    this.add(J.head, 0.05, -0.2 * k, 0);
  }

  private telegraphOf(a: number): number {
    const E = tuning.enemies;
    return a === ARCH.THUG ? E.thug.telegraph : a === ARCH.BAT ? E.bat.telegraph : a === ARCH.GUNMAN ? E.gunman.telegraph : a === ARCH.BRUTE ? E.brute.telegraph : E.drone.telegraph;
  }

  /** Wind-up (u = progress 0..1 of the telegraph). */
  private windup(a: number, u: number, slot: PoseSlot, t: number): number {
    const shake = Math.sin(t * 40) * 0.03 * u;
    switch (a) {
      case ARCH.THUG:
        // Right fist cocked back, shoulders turned, weight on the back foot.
        this.set(J.upperArmR, 0.45 * u, 0, -0.35);
        this.set(J.foreArmR, -2.0, 0, 0);
        this.set(J.upperArmL, -0.9, 0, 0.3);
        this.set(J.foreArmL, -1.3, 0, 0);
        this.add(J.chest, -0.06 * u, -0.5 * u + shake, 0);
        this.add(J.spine, -0.08 * u, -0.15 * u, 0);
        this.set(J.thighL, -0.3, 0, 0.06);
        this.set(J.thighR, 0.28, 0, -0.06);
        return 14;
      case ARCH.BAT:
        // The bat goes up over the right shoulder, both hands on it.
        this.set(J.upperArmR, -2.5 * u, 0, -0.35);
        this.set(J.foreArmR, -1.1, 0, 0);
        this.set(J.upperArmL, -2.1 * u, 0, -0.35 * u);
        this.set(J.foreArmL, -1.3, 0, 0);
        this.add(J.chest, -0.12 * u, -0.6 * u + shake, 0);
        this.add(J.spine, -0.1 * u, 0, 0);
        this.set(J.thighL, -0.35, 0, 0.08);
        this.set(J.thighR, 0.3, 0, -0.08);
        this.set(J.shinL, 0.3, 0, 0);
        return 12;
      case ARCH.GUNMAN:
        this.aimPose(slot.aim, smoothstep(0, 0.35, u));
        return 16;
      case ARCH.BRUTE:
        // Gauntlet raised high for the slam, shield still up.
        this.shieldGuard(1);
        this.set(J.upperArmR, -2.75 * u, 0, -0.25);
        this.set(J.foreArmR, -0.5, 0, 0);
        this.add(J.spine, -0.22 * u, 0, 0);
        this.add(J.chest, shake, 0, 0);
        this.set(J.shinL, 0.35 * u, 0, 0);
        this.set(J.shinR, 0.35 * u, 0, 0);
        this.rootT[0] = -0.1 * u;
        return 10;
      default:
        return 12;
    }
  }

  private strike(a: number, age: number): number {
    // Snap out, hold, ease back.
    const k = smoothstep(0, 0.07, age) * (1 - smoothstep(0.22, 0.45, age));
    switch (a) {
      case ARCH.THUG:
        this.set(J.upperArmR, -1.5 * k - 0.4 * (1 - k), 0, -0.08);
        this.set(J.foreArmR, -0.08 * k - 1.9 * (1 - k), 0, 0);
        this.set(J.upperArmL, -0.5, 0, 0.3);
        this.set(J.foreArmL, -1.9, 0, 0);
        this.add(J.chest, 0, 0.45 * k, 0);
        this.add(J.spine, 0.14 * k, 0.1 * k, 0);
        this.set(J.thighL, -0.35, 0, 0.06);
        this.set(J.thighR, 0.3, 0, -0.06);
        return 30;
      case ARCH.BAT:
        // Follow-through across the body.
        this.set(J.upperArmR, -1.35, 0, 0.55 * k);
        this.set(J.foreArmR, -0.35, 0, 0);
        this.set(J.upperArmL, -1.2, 0, 0.25 * k);
        this.set(J.foreArmL, -0.5, 0, 0);
        this.add(J.chest, 0, 0.85 * k, 0);
        this.add(J.spine, 0.15 * k, 0.2 * k, 0);
        this.set(J.thighL, -0.35, 0, 0.08);
        this.set(J.thighR, 0.3, 0, -0.08);
        return 26;
      case ARCH.GUNMAN:
        this.aimPose(0, 1);
        this.add(J.foreArmR, -0.4 * k, 0, 0);
        return 28;
      case ARCH.BRUTE:
        // The slam: gauntlet down in front, deep crouch.
        this.shieldGuard(1);
        this.set(J.upperArmR, -1.0 * k, 0, -0.1);
        this.set(J.foreArmR, -0.2, 0, 0);
        this.add(J.spine, 0.5 * k, 0, 0);
        this.add(J.chest, 0.25 * k, 0, 0);
        this.set(J.thighL, -0.6 * k, 0, 0.1);
        this.set(J.thighR, -0.2 * k, 0, -0.1);
        this.set(J.shinL, 0.8 * k, 0, 0);
        this.set(J.shinR, 0.6 * k, 0, 0);
        this.rootT[0] = -0.2 * k;
        return 28;
      default:
        return 20;
    }
  }

  /** Drone: hover bob, tilt with the velocity, rotors spinning; nose up toward the target in the wind-up; falls limp when KO. */
  private drone(slot: PoseSlot, e: ViewEnemy, age: number, dt: number): number {
    const ko = e.state === ES.KO || e.state === ES.PINNED || e.anim === ANIM.KO;
    if (!ko) slot.spin = (slot.spin + dt * (e.state === ES.STAGGER ? 22 : 38)) % TAU;
    else slot.spin = (slot.spin + dt * 4 * Math.max(0, 1 - age)) % TAU;
    const c = Math.cos(e.yaw),
      s = Math.sin(e.yaw);
    // Velocity in the drone's frame (forward = -sin/-cos yaw, right = cos/-sin).
    const fwd = -slot.vx * s - slot.vz * c;
    const side = slot.vx * c - slot.vz * s;
    let pitch = clamp(fwd * 0.05, -0.4, 0.4);
    let roll = clamp(-side * 0.05, -0.4, 0.4);
    const t = slot.posedAt;
    this.rootT[0] = ko ? 0 : Math.sin(t * 2.3 + e.id) * 0.07;
    if (ko) {
      pitch = 0.55;
      roll = 0.5;
    } else if (e.anim === ANIM.WINDUP) {
      pitch -= slot.aim * 0.7 + 0.08 * Math.sin(t * 50) * clamp(age / 0.6, 0, 1);
    } else if (e.state === ES.STAGGER) {
      roll += Math.sin(age * 25) * 0.5 * Math.max(0, 1 - age * 2);
      pitch -= 0.3 * Math.max(0, 1 - age * 2);
    } else if (e.anim === ANIM.STRIKE) {
      pitch += 0.25 * Math.max(0, 1 - age * 4);
    }
    this.set(0, pitch, 0, roll);
    for (let r = 1; r <= 4; r++) this.set(r, 0, slot.spin * (r & 1 ? 1 : -1) + r, 0);
    return 10;
  }

  /** Forward kinematics from `slot.cur`/`slot.root` into skinning rows. */
  private fk(slot: PoseSlot, def: RigDef): void {
    const cur = slot.cur,
      off = def.offset,
      bind = def.bind,
      par = def.parent,
      skin = slot.skin;
    for (let j = 0; j < def.bones; j++) {
      _e.set(cur[j * 3]!, cur[j * 3 + 1]!, cur[j * 3 + 2]!, 'XYZ');
      _q.setFromEuler(_e);
      const p = par[j]!;
      const qw = _qW[j]!,
        pw = _pW[j]!;
      pw.set(off[j * 3]!, off[j * 3 + 1]!, off[j * 3 + 2]!);
      if (p < 0) {
        qw.copy(_q);
        pw.y += slot.root[0]!;
        pw.z += slot.root[1]!;
      } else {
        qw.multiplyQuaternions(_qW[p]!, _q);
        pw.applyQuaternion(_qW[p]!).add(_pW[p]!);
      }
      // Rows of R(qw) and t = pw - R * bind.
      const x = qw.x,
        y = qw.y,
        z = qw.z,
        w = qw.w;
      const x2 = x + x,
        y2 = y + y,
        z2 = z + z;
      const xx = x * x2,
        xy = x * y2,
        xz = x * z2,
        yy = y * y2,
        yz = y * z2,
        zz = z * z2,
        wx = w * x2,
        wy = w * y2,
        wz = w * z2;
      const m00 = 1 - (yy + zz),
        m01 = xy - wz,
        m02 = xz + wy,
        m10 = xy + wz,
        m11 = 1 - (xx + zz),
        m12 = yz - wx,
        m20 = xz - wy,
        m21 = yz + wx,
        m22 = 1 - (xx + yy);
      const bx = bind[j * 3]!,
        by = bind[j * 3 + 1]!,
        bz = bind[j * 3 + 2]!;
      const o = j * 12;
      skin[o] = m00;
      skin[o + 1] = m01;
      skin[o + 2] = m02;
      skin[o + 3] = pw.x - (m00 * bx + m01 * by + m02 * bz);
      skin[o + 4] = m10;
      skin[o + 5] = m11;
      skin[o + 6] = m12;
      skin[o + 7] = pw.y - (m10 * bx + m11 * by + m12 * bz);
      skin[o + 8] = m20;
      skin[o + 9] = m21;
      skin[o + 10] = m22;
      skin[o + 11] = pw.z - (m20 * bx + m21 * by + m22 * bz);
    }
  }
}

/** A bind-space point carried by bone `j` of a posed slot, in model space (no allocation). */
export function posedPoint(slot: PoseSlot, j: number, bx: number, by: number, bz: number, out: Vector3): Vector3 {
  const s = slot.skin,
    o = j * 12;
  return out.set(
    s[o]! * bx + s[o + 1]! * by + s[o + 2]! * bz + s[o + 3]!,
    s[o + 4]! * bx + s[o + 5]! * by + s[o + 6]! * bz + s[o + 7]!,
    s[o + 8]! * bx + s[o + 9]! * by + s[o + 10]! * bz + s[o + 11]!,
  );
}
