import { Vector3 } from 'three';
import { tuning } from '../config/tuning';
import { clamp, moveToward } from '../core/math';
import {
  BOX,
  CYL,
  CollisionWorld,
  F_CANOPY,
  F_CLIMB,
  makeContactSummary,
  clearContactSummary,
  makeRayHit,
  SURF_CONCRETE,
  type ContactSummary,
} from '../physics/collision';
import type { TickInput } from '../input/input';
import { Targeting, makeAnchorResult, copyAnchor, type AnchorResult } from './targeting';
import type { CityLayout } from '../world/types';

export const MODE_GROUND = 0;
export const MODE_AIR = 1;
export const MODE_SWING = 2;
export const MODE_ZIP = 3;
export const MODE_WALL = 4;
export const MODE_TRAVERSE = 5;
export const MODE_NAMES = ['ground', 'air', 'swing', 'zip', 'wall', 'traverse'] as const;

export const TRAV_VAULT = 0;
export const TRAV_MANTLE = 1;
export const TRAV_LEDGE = 2;

export type PlayerEvent =
  | { type: 'jump' }
  | { type: 'land'; impact: number; surface: number; roll: boolean }
  | { type: 'webFire'; hand: number; x: number; y: number; z: number }
  | { type: 'attach'; hand: number; x: number; y: number; z: number; nx: number; ny: number; nz: number }
  /** power: 0..1 share of the release push (0 for a tap or a broken line). */
  | { type: 'release'; good: boolean; broken: boolean; power: number }
  | { type: 'boost' }
  | { type: 'dive' }
  | { type: 'zipStart'; x: number; y: number; z: number; hand: number }
  | { type: 'zipEnd' }
  | { type: 'wallGrab'; surface: number }
  | { type: 'wallJump' }
  | { type: 'vault' }
  | { type: 'mantle' }
  | { type: 'splash'; x: number; y: number; z: number }
  | { type: 'respawn' }
  | { type: 'recover' };

interface RopeState {
  firing: boolean;
  attached: boolean;
  fireT: number;
  fireDur: number;
  anchor: AnchorResult;
  length: number;
  targetLength: number;
  attachLength: number;
  hand: number;
  taut: boolean;
  wasTaut: boolean;
  tension: number;
  attachTime: number;
  goodWindow: boolean;
  losBlocked: number;
  groundTime: number;
  /** Fired from the ground or a wall: ground movement in flight, launch on attach. */
  fromGround: boolean;
  /** Fired from the ground (not a wall): Space jumps while the line is in flight. */
  onGround: boolean;
  /** Fired by the swing button: the line lasts only while the button is held. */
  byButton: boolean;
}

interface ZipState {
  tx: number;
  ty: number;
  tz: number;
  ex: number;
  ey: number;
  ez: number;
  nx: number;
  nz: number;
  speed: number;
  time: number;
  endAction: number; // 0 hop, 1 mantle, 2 land, 3 perch
  mantleX: number;
  mantleY: number;
  mantleZ: number;
  apex: number;
  ignoreA: number;
  ignoreB: number;
  lastDist: number;
  stall: number;
  hand: number;
}

interface WallState {
  id: number;
  nx: number;
  nz: number;
  run: number;
  time: number;
}

interface TraverseState {
  kind: number;
  t: number;
  dur: number;
  splitT: number;
  landY: number;
  p0: Vector3;
  p1: Vector3;
  p2: Vector3;
  exit: Vector3;
  ignoreA: number;
  ignoreB: number;
}

const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpC = new Vector3();

function rotateToward(v: Vector3, dir: Vector3, maxAngle: number): void {
  const len = v.length();
  if (len < 1e-4) return;
  const ax = v.x / len,
    ay = v.y / len,
    az = v.z / len;
  const dot = clamp(ax * dir.x + ay * dir.y + az * dir.z, -1, 1);
  const ang = Math.acos(dot);
  if (ang < 1e-5 || maxAngle <= 0) return;
  const t = Math.min(1, maxAngle / ang);
  const s = Math.sin(ang);
  if (s < 1e-3) return;
  const w1 = Math.sin((1 - t) * ang) / s;
  const w2 = Math.sin(t * ang) / s;
  v.set((ax * w1 + dir.x * w2) * len, (ay * w1 + dir.y * w2) * len, (az * w1 + dir.z * w2) * len);
}

/**
 * Player simulation: kinematic character controller and traversal state
 * machine. Pure simulation (no rendering), stepped at a fixed rate.
 */
export class Player {
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  mode = MODE_AIR;
  grounded = false;
  groundSurface = SURF_CONCRETE;
  /** Yaw the body faces (radians, same convention as the camera). */
  facing = 0;
  diving = false;
  boostTimer = 0;
  boostAvailable = false;
  coyote = 0;
  jumpBuffer = 0;
  zipCooldown = 0;
  lastHand = 1;
  rollTimer = 0;
  landTimer = 0;
  lastLandImpact = 0;
  airTime = 0;
  /** Left button held for a swing: fires as soon as the crosshair finds a usable point. */
  holdSwing = false;
  time = 0;
  tick = 0;
  /** Seconds since the last good release (for the HUD cue). */
  goodReleaseFlash = 99;
  readonly events: PlayerEvent[] = [];
  readonly rope: RopeState;
  readonly zip: ZipState;
  readonly wall: WallState;
  readonly trav: TraverseState;
  readonly swingTarget: AnchorResult = makeAnchorResult();
  readonly zipTarget: AnchorResult = makeAnchorResult();
  readonly targeting: Targeting;
  readonly contact: ContactSummary = makeContactSummary();
  private readonly subContact: ContactSummary = makeContactSummary();
  private readonly cands = new Int32Array(2048);
  private nCands = 0;
  private readonly wish = new Vector3();
  private readonly camFwd = new Vector3();
  private readonly camRight = new Vector3();
  private readonly ray = makeRayHit();
  /** Number of rope catches (diagnostics). */
  catchCount = 0;

  // Recovery / stuck detection
  private progressAnchor = new Vector3();
  private progressTimer = 0;
  private deepTicks = 0;
  /** Visual offset to blend teleports (render adds it, decays to zero). */
  readonly renderOffset = new Vector3();
  stats = { recoveries: 0, splashes: 0, nanResets: 0, stuckEvents: 0, maxStuckTime: 0 };
  private readonly lastGood = new Vector3();
  private readonly lastGoodVel = new Vector3();

  constructor(
    readonly world: CollisionWorld,
    readonly layout: CityLayout,
  ) {
    this.targeting = new Targeting(world);
    this.rope = {
      firing: false,
      attached: false,
      fireT: 0,
      fireDur: 0,
      anchor: makeAnchorResult(),
      length: 0,
      targetLength: 0,
      attachLength: 0,
      hand: 1,
      taut: false,
      wasTaut: false,
      tension: 0,
      attachTime: 0,
      goodWindow: false,
      losBlocked: 0,
      groundTime: 0,
      fromGround: false,
      onGround: false,
      byButton: false,
    };
    this.zip = {
      tx: 0,
      ty: 0,
      tz: 0,
      ex: 0,
      ey: 0,
      ez: 0,
      nx: 0,
      nz: 0,
      speed: 0,
      time: 0,
      endAction: 0,
      mantleX: 0,
      mantleY: 0,
      mantleZ: 0,
      apex: 0,
      ignoreA: -1,
      ignoreB: -1,
      lastDist: 0,
      stall: 0,
      hand: 1,
    };
    this.wall = { id: -1, nx: 0, nz: 0, run: 0, time: 0 };
    this.trav = {
      kind: 0,
      t: 0,
      dur: 0,
      splitT: 0,
      landY: 0,
      p0: new Vector3(),
      p1: new Vector3(),
      p2: new Vector3(),
      exit: new Vector3(),
      ignoreA: -1,
      ignoreB: -1,
    };
  }

  get speed(): number {
    return this.vel.length();
  }

  get ropeActive(): boolean {
    return this.mode === MODE_SWING;
  }

  teleport(x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): void {
    this.pos.set(x, y, z);
    this.vel.set(vx, vy, vz);
    this.mode = MODE_AIR;
    this.rope.attached = false;
    this.rope.firing = false;
    this.diving = false;
    this.progressAnchor.copy(this.pos);
    this.progressTimer = 0;
    this.deepTicks = 0;
    this.renderOffset.set(0, 0, 0);
    this.lastGood.copy(this.pos);
    this.lastGoodVel.copy(this.vel);
  }

  // ---------------------------------------------------------------------------
  // Main step
  // ---------------------------------------------------------------------------

  step(dt: number, inp: TickInput): void {
    this.events.length = 0;
    this.time += dt;
    this.tick++;
    const r = tuning.body.radius;
    this.zipCooldown = Math.max(0, this.zipCooldown - dt);
    this.boostTimer -= dt;
    this.coyote -= dt;
    this.jumpBuffer -= dt;
    this.rollTimer = Math.max(0, this.rollTimer - dt);
    this.landTimer += dt;
    this.goodReleaseFlash += dt;
    if (inp.jumpPressed) this.jumpBuffer = tuning.ground.jumpBuffer;

    // Camera-relative basis (camera looks along -Z at yaw 0).
    const sy = Math.sin(inp.yaw),
      cy = Math.cos(inp.yaw);
    this.camFwd.set(-sy, 0, -cy);
    this.camRight.set(cy, 0, -sy);
    this.wish.set(
      this.camFwd.x * inp.moveY + this.camRight.x * inp.moveX,
      0,
      this.camFwd.z * inp.moveY + this.camRight.z * inp.moveX,
    );
    if (this.wish.lengthSq() > 1) this.wish.normalize();

    // Targeting (reticle) at 60 Hz, fresh on presses and while a held button waits for a point.
    const waiting = this.holdSwing && this.mode !== MODE_SWING;
    if (inp.swingPressed || inp.zipPressed || waiting || this.tick % 2 === 0) this.updateTargets(inp);

    // Swing line: hold the left button to swing. It fires where the crosshair
    // points on the press, or as soon as the crosshair finds a point while
    // held; letting go releases the line with a push. A line fired by the
    // button ends whenever the button is up, so held state cleared without a
    // release edge (pause, lost focus) never leaves it attached, and a click
    // shorter than a tick still fires (and lets go on the next tick, a tap).
    // Space also cuts a line (the held button then waits for a new press),
    // except while a line fired from the ground (not a wall) is still in
    // flight: then it jumps and the line keeps flying. The right click starts a pull line,
    // which Space cuts.
    if (inp.swingPressed) this.holdSwing = true;
    else if (!inp.swing) this.holdSwing = false;
    const flightFromGround = this.mode === MODE_SWING && this.rope.firing && this.rope.onGround;
    if (inp.jumpPressed && flightFromGround && this.supportedFeet()) {
      this.jumpBuffer = 0;
      this.vel.y = Math.max(this.vel.y, tuning.ground.jumpSpeed);
      this.events.push({ type: 'jump' });
    } else if (inp.jumpPressed && (this.mode === MODE_SWING || this.mode === MODE_ZIP)) {
      this.cutLine();
      this.holdSwing = false;
    } else if (this.mode === MODE_SWING && (inp.swingReleased || (this.rope.byButton && !inp.swing))) {
      this.cutLine();
    } else if (this.holdSwing && this.mode !== MODE_SWING && this.mode !== MODE_TRAVERSE && this.swingTarget.valid) {
      this.fireRope(this.swingTarget);
    } else if (inp.zipPressed && this.zipCooldown <= 0 && this.mode !== MODE_TRAVERSE && this.zipTarget.valid) {
      this.startZip(this.zipTarget);
    }

    switch (this.mode) {
      case MODE_GROUND:
        this.groundStep(dt, inp);
        break;
      case MODE_AIR:
        this.airStep(dt, inp);
        break;
      case MODE_SWING:
        this.swingStep(dt, inp);
        break;
      case MODE_ZIP:
        this.zipStep(dt, inp);
        break;
      case MODE_WALL:
        this.wallStep(dt, inp);
        break;
      case MODE_TRAVERSE:
        this.traverseStep(dt);
        break;
    }

    if (this.mode !== MODE_GROUND) this.airTime += dt;
    else this.airTime = 0;
    if (this.mode !== MODE_GROUND && this.mode !== MODE_WALL) {
      if (this.vel.x * this.vel.x + this.vel.z * this.vel.z > 1) this.facing = Math.atan2(-this.vel.x, -this.vel.z);
    }

    this.postStep(dt, inp, r);
  }

  private updateTargets(inp: TickInput): void {
    const p = this.pos;
    const o = inp.aimOrigin,
      d = inp.aimDir;
    this.targeting.aim(p.x, p.y, p.z, o.x, o.y, o.z, d.x, d.y, d.z, this.swingTarget, this.zipTarget);
  }

  // ---------------------------------------------------------------------------
  // Integration helpers
  // ---------------------------------------------------------------------------

  private gather(dt: number, extra = 0): void {
    const r = tuning.body.radius,
      h = tuning.body.height;
    const p = this.pos,
      v = this.vel;
    const m = r + 0.3 + extra;
    const ex = Math.abs(v.x) * dt + m,
      ey = Math.abs(v.y) * dt + m,
      ez = Math.abs(v.z) * dt + m;
    this.nCands = this.world.gatherAabb(p.x - ex, p.y - ey, p.z - ez, p.x + ex, p.y + h + ey, p.z + ez, this.cands);
  }

  /**
   * Move with velocity for dt in substeps, resolving collisions. Optional
   * per-substep hook (rope constraint, gravity) runs before each move.
   */
  private integrate(dt: number, hook?: (h: number) => void): void {
    const r = tuning.body.radius,
      hgt = tuning.body.height;
    clearContactSummary(this.contact);
    this.gather(dt);
    const sp = this.vel.length();
    const n = clamp(Math.ceil((sp * dt) / tuning.sim.maxSubstepMove), 1, 16);
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (hook) hook(h);
      const roped = this.mode === MODE_SWING && this.rope.attached;
      if (roped) this.ropePreMove();
      this.pos.addScaledVector(this.vel, h);
      if (roped) this.ropePostMove();
      clearContactSummary(this.subContact);
      this.world.resolveCapsule(this.pos, this.vel, r, hgt, this.cands, this.nCands, this.subContact);
      this.mergeContacts();
    }
  }

  private mergeContacts(): void {
    const c = this.contact,
      s = this.subContact;
    if (s.ground && (!c.ground || s.groundNY > c.groundNY)) {
      c.ground = true;
      c.groundNY = s.groundNY;
      c.groundId = s.groundId;
      c.groundSurface = s.groundSurface;
    }
    if (s.wall && (!c.wall || (s.wallClimbable && !c.wallClimbable))) {
      c.wall = true;
      c.wallId = s.wallId;
      c.wallNX = s.wallNX;
      c.wallNZ = s.wallNZ;
      c.wallClimbable = s.wallClimbable;
    }
    if (s.ceiling) c.ceiling = true;
    if (s.anyId >= 0) c.anyId = s.anyId;
    if (s.maxDepth > c.maxDepth) c.maxDepth = s.maxDepth;
  }

  private applyAirDrag(dt: number): void {
    const A = tuning.air;
    const sp = this.vel.length();
    if (sp < 1e-4) return;
    let k = A.drag * sp;
    if (sp > A.softCap) k += A.capDrag * (sp - A.softCap);
    const f = Math.max(0, 1 - k * dt);
    this.vel.multiplyScalar(f);
    if (this.vel.y < -A.maxFallSpeed) this.vel.y = -A.maxFallSpeed;
  }

  // ---------------------------------------------------------------------------
  // Ground
  // ---------------------------------------------------------------------------

  private groundStep(dt: number, inp: TickInput): void {
    const G = tuning.ground;
    const v = this.vel;
    const wishLen = this.wish.length();
    // The touch stick at its rim sprints too, but only the sprint action clings to walls.
    const sprint = inp.sprint || inp.groundSprint;
    const maxSpeed = sprint ? G.sprintSpeed : G.runSpeed;
    const hs = Math.hypot(v.x, v.z);
    const rolling = this.rollTimer > 0;
    if (hs > maxSpeed + 0.05) {
      // Keep landing momentum, decay it smoothly and steer.
      const nhs = Math.max(maxSpeed, hs - G.overspeedDecel * dt * (wishLen > 0.1 ? 1 : 1.6));
      if (wishLen > 0.1 && !rolling) {
        tmpA.set(v.x, 0, v.z);
        tmpB.copy(this.wish).normalize();
        rotateToward(tmpA, tmpB, G.turnBlend * 0.25 * dt);
        v.x = tmpA.x;
        v.z = tmpA.z;
      }
      const s = nhs / Math.max(1e-6, Math.hypot(v.x, v.z));
      v.x *= s;
      v.z *= s;
    } else if (!rolling) {
      const tx = this.wish.x * maxSpeed,
        tz = this.wish.z * maxSpeed;
      const acc = wishLen > 0.01 ? (sprint ? G.sprintAccel : G.accel) : G.decel;
      const dx = tx - v.x,
        dz = tz - v.z;
      const dl = Math.hypot(dx, dz);
      const maxD = acc * dt;
      if (dl <= maxD) {
        v.x = tx;
        v.z = tz;
      } else {
        v.x += (dx / dl) * maxD;
        v.z += (dz / dl) * maxD;
      }
    }
    v.y = 0;
    if (Math.hypot(v.x, v.z) > 0.5) this.facing = Math.atan2(-v.x, -v.z);

    if (this.jumpBuffer > 0 && !rolling) {
      this.jumpBuffer = 0;
      v.y = G.jumpSpeed + (sprint && hs > G.runSpeed ? G.sprintJumpBonus : 0);
      this.setMode(MODE_AIR);
      this.coyote = 0;
      this.events.push({ type: 'jump' });
      this.integrate(dt);
      return;
    }

    this.integrate(dt);
    const c = this.contact;

    // Wall interactions: vault, mantle, step, cling.
    if (c.wall && c.wallId >= 0) {
      const into = -(this.wish.x * c.wallNX + this.wish.z * c.wallNZ);
      if (inp.sprint && c.wallClimbable && (into > 0.3 || -(v.x * c.wallNX + v.z * c.wallNZ) > 1) && this.canCling(c.wallId)) {
        this.enterWall(c.wallId, c.wallNX, c.wallNZ, true);
        return;
      }
      if (wishLen > 0.3 && into > 0.45) {
        if (this.tryStepUp(c.wallId, -c.wallNX, -c.wallNZ)) {
          /* stepped */
        } else if (this.tryVaultOrMantle(c.wallId, -c.wallNX, -c.wallNZ, Math.max(hs, 3))) return;
      }
    }

    // Stick to ground / walk off edges.
    const s = this.world.supportHeight(this.pos.x, this.pos.z, this.pos.y + 0.05, 0.12);
    if (s.y > -Infinity && s.y >= this.pos.y - G.snapDown) {
      if (!c.ground && s.y < this.pos.y) this.pos.y = s.y;
      this.grounded = true;
      if (s.id >= 0) this.groundSurface = this.world.surface[s.id]!;
      else this.groundSurface = this.world.terrain.surfaceAt(this.pos.x, this.pos.z);
    } else if (!c.ground) {
      this.setMode(MODE_AIR);
      this.coyote = G.coyoteTime;
    }
  }

  private tryStepUp(id: number, dx: number, dz: number): boolean {
    const top = this.world.topY(id);
    const h = top - this.pos.y;
    if (h <= 0.02 || h > tuning.ground.stepHeight) return false;
    const r = tuning.body.radius;
    const nx = this.pos.x + dx * 0.25,
      nz = this.pos.z + dz * 0.25;
    if (!this.world.capsuleFree(nx, top + 0.01, nz, r, tuning.body.height)) return false;
    this.pos.set(nx, top + 0.01, nz);
    return true;
  }

  /** Find the top of a ledge stack (box plus parapet) just inside a wall point. */
  private ledgeTop(x: number, z: number, startTop: number): { top: number; ids: [number, number] } {
    let top = startTop;
    const ids: [number, number] = [-1, -1];
    for (let pass = 0; pass < 3; pass++) {
      const n = this.world.gatherAabb(x - 0.05, top - 0.1, z - 0.05, x + 0.05, top + 3, z + 0.05);
      let found = -1;
      let best = top;
      for (let k = 0; k < n; k++) {
        const id = this.world.queryBuf[k]!;
        if (this.world.kind[id] !== BOX) continue;
        const o = id * 6;
        const p = this.world.p;
        if (x < p[o]! || x > p[o + 3]! || z < p[o + 2]! || z > p[o + 5]!) continue;
        if (p[o + 1]! > top + 0.1) continue;
        if (p[o + 4]! > best + 0.01) {
          best = p[o + 4]!;
          found = id;
        }
      }
      if (found < 0) break;
      top = best;
      ids[1] = found;
    }
    return { top, ids };
  }

  private tryVaultOrMantle(id: number, dx: number, dz: number, speed: number): boolean {
    const G = tuning.ground;
    const w = this.world;
    const r = tuning.body.radius,
      hgt = tuning.body.height;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    if (w.kind[id] !== BOX && w.kind[id] !== CYL) return false;
    const top = w.topY(id);
    const h = top - this.pos.y;
    if (h < G.vaultMinHeight || h > G.vaultMaxHeight) return false;
    // Obstacle depth along the move direction.
    let depth: number;
    const o = id * 6;
    const p = w.p;
    if (w.kind[id] === BOX) {
      // Exit distance through the footprint along (dx,dz) from the contact side.
      const cx = this.pos.x + dx * r,
        cz = this.pos.z + dz * r;
      let tExit = Infinity;
      if (Math.abs(dx) > 1e-6) tExit = Math.min(tExit, ((dx > 0 ? p[o + 3]! : p[o]!) - cx) / dx);
      if (Math.abs(dz) > 1e-6) tExit = Math.min(tExit, ((dz > 0 ? p[o + 5]! : p[o + 2]!) - cz) / dz);
      depth = Math.max(0, tExit);
    } else {
      depth = 2 * p[o + 4]!;
    }
    const sx = this.pos.x,
      sy = this.pos.y,
      sz = this.pos.z;
    if (depth <= G.vaultMaxDepth) {
      const land = r * 2 + depth + 0.5;
      const lx = sx + dx * land,
        lz = sz + dz * land;
      const sup = w.supportHeight(lx, lz, top - 0.2, 0.1);
      const endY = sup.y > sy - 0.6 && sup.y < top ? sup.y : sy;
      if (
        w.capsuleFree(lx, endY + 0.02, lz, r, hgt) &&
        this.startTraverse(TRAV_VAULT, lx, endY + 0.02, lz, top, G.vaultDuration, id, -1, dx * Math.max(speed, G.runSpeed * 0.8), 1.5, dz * Math.max(speed, G.runSpeed * 0.8))
      ) {
        this.events.push({ type: 'vault' });
        return true;
      }
    }
    const mx = sx + dx * (r + 0.55),
      mz = sz + dz * (r + 0.55);
    const ledge = this.ledgeTop(sx + dx * (r + 0.1), sz + dz * (r + 0.1), top);
    if (
      ledge.top - sy <= G.vaultMaxHeight + 0.1 &&
      w.capsuleFree(mx, ledge.top + 0.02, mz, r, hgt) &&
      this.startTraverse(TRAV_MANTLE, mx, ledge.top + 0.02, mz, ledge.top, G.mantleDuration, id, ledge.ids[1], dx * 3, 0, dz * 3)
    ) {
      this.events.push({ type: 'mantle' });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Air
  // ---------------------------------------------------------------------------

  private airControl(dt: number, inp: TickInput, scale = 1): void {
    const A = tuning.air;
    const v = this.vel;
    const wishLen = this.wish.length();
    if (wishLen < 0.01) return;
    const hs = Math.hypot(v.x, v.z);
    tmpB.copy(this.wish).multiplyScalar(1 / wishLen);
    if (hs < A.airControlSpeed) {
      // Accelerate along wish, capped at the air control speed.
      const along = v.x * tmpB.x + v.z * tmpB.z;
      const add = Math.min(A.airAccel * dt * wishLen * scale, Math.max(0, A.airControlSpeed - along));
      v.x += tmpB.x * add;
      v.z += tmpB.z * add;
    } else {
      // Above control speed: steer heading, brake when pulling back.
      tmpA.set(v.x, 0, v.z);
      const back = tmpA.x * tmpB.x + tmpA.z * tmpB.z < -0.5 * hs;
      if (back) {
        const nhs = Math.max(0, hs - A.airBrake * dt * scale);
        tmpA.multiplyScalar(nhs / hs);
      } else rotateToward(tmpA, tmpB, A.airSteerRate * dt * wishLen * scale);
      v.x = tmpA.x;
      v.z = tmpA.z;
    }
    void inp;
  }

  private airStep(dt: number, inp: TickInput): void {
    const A = tuning.air;
    const D = tuning.dive;
    const v = this.vel;
    // Jumps: coyote ground jump or post-release boost.
    if (this.jumpBuffer > 0) {
      if (this.coyote > 0) {
        this.jumpBuffer = 0;
        this.coyote = 0;
        v.y = Math.max(v.y, tuning.ground.jumpSpeed);
        this.events.push({ type: 'jump' });
      } else if (this.boostTimer > 0 && this.boostAvailable) {
        this.jumpBuffer = 0;
        this.boostAvailable = false;
        const B = tuning.boost;
        let hx = v.x,
          hz = v.z;
        const hl = Math.hypot(hx, hz);
        if (hl > 1) {
          hx /= hl;
          hz /= hl;
        } else {
          hx = this.camFwd.x;
          hz = this.camFwd.z;
        }
        v.x += hx * B.forward;
        v.z += hz * B.forward;
        v.y = Math.max(v.y, 0) + B.up;
        this.events.push({ type: 'boost' });
      }
    }
    // Dive
    const diving = inp.dive;
    if (diving && !this.diving) this.events.push({ type: 'dive' });
    this.diving = diving;
    const g = A.gravity * (diving ? D.gravityMul : 1);
    if (diving) {
      // Steer toward the camera heading and pitch the dive forward.
      tmpA.set(v.x, 0, v.z);
      rotateToward(tmpA, this.camFwd, D.steerRate * dt);
      const hl = tmpA.length();
      const add = D.forwardAccel * dt;
      v.x = tmpA.x + (hl > 0.1 ? (tmpA.x / hl) * add : this.camFwd.x * add);
      v.z = tmpA.z + (hl > 0.1 ? (tmpA.z / hl) * add : this.camFwd.z * add);
    } else this.airControl(dt, inp);
    // Kick-drift-kick: exact for constant gravity, no energy drift.
    v.y -= g * dt * 0.5;
    this.applyAirDrag(dt);
    const vyBefore = v.y - g * dt * 0.5;
    const hsBefore = Math.hypot(v.x, v.z);
    this.integrate(dt);
    v.y -= g * dt * 0.5;
    const c = this.contact;
    if (c.wall && c.wallClimbable && inp.sprint) {
      const into = -(v.x * c.wallNX + v.z * c.wallNZ);
      const wishInto = -(this.wish.x * c.wallNX + this.wish.z * c.wallNZ);
      if ((into > 0.5 || wishInto > 0.3 || hsBefore > 4) && this.canCling(c.wallId)) {
        this.enterWall(c.wallId, c.wallNX, c.wallNZ, true);
        return;
      }
    }
    if (c.ground && vyBefore <= 0.5) this.land(-vyBefore, hsBefore, c.groundSurface);
  }

  private land(impact: number, hs: number, surface: number): void {
    const G = tuning.ground;
    const roll = impact > G.hardLandingSpeed && hs > G.rollMinSpeed;
    if (roll) this.rollTimer = G.rollDuration;
    this.setMode(MODE_GROUND);
    this.vel.y = 0;
    this.grounded = true;
    this.diving = false;
    this.boostAvailable = false;
    this.landTimer = 0;
    this.lastLandImpact = impact;
    this.groundSurface = surface;
    this.events.push({ type: 'land', impact, surface, roll });
  }

  // ---------------------------------------------------------------------------
  // Swing
  // ---------------------------------------------------------------------------

  private fireRope(t: AnchorResult): void {
    const S = tuning.swing;
    const rope = this.rope;
    // A new line replaces a pull line in progress.
    if (this.mode === MODE_ZIP) this.events.push({ type: 'zipEnd' });
    copyAnchor(rope.anchor, t);
    rope.hand = 1 - this.lastHand;
    this.lastHand = rope.hand;
    rope.firing = true;
    rope.attached = false;
    rope.fireT = 0;
    rope.fireDur = Math.min(S.maxFireTime, t.dist / S.fireSpeed);
    rope.goodWindow = false;
    rope.losBlocked = 0;
    rope.groundTime = 0;
    rope.fromGround = this.mode === MODE_GROUND || this.mode === MODE_WALL;
    rope.onGround = this.mode === MODE_GROUND;
    rope.byButton = true;
    rope.tension = 0;
    this.holdSwing = false;
    this.diving = false;
    if (this.mode === MODE_WALL) this.vel.set(this.wall.nx * 3, 2, this.wall.nz * 3);
    this.setMode(MODE_SWING);
    this.events.push({ type: 'webFire', hand: rope.hand, x: t.x, y: t.y, z: t.z });
  }

  private attachRope(): void {
    const S = tuning.swing;
    const rope = this.rope;
    const a = rope.anchor;
    const hx = this.pos.x,
      hy = this.pos.y + tuning.body.ropeOffset,
      hz = this.pos.z;
    const d = Math.hypot(a.x - hx, a.y - hy, a.z - hz);
    rope.firing = false;
    rope.attached = true;
    rope.length = Math.max(3, d);
    rope.targetLength = clamp(d * S.attachLengthFactor, Math.min(d, S.minRope), S.maxRope);
    rope.attachLength = rope.targetLength;
    rope.attachTime = this.time;
    rope.taut = false;
    rope.wasTaut = false;
    if (rope.fromGround) {
      // Launch off the ground toward the anchor.
      const fx = a.x - hx,
        fz = a.z - hz;
      const fl = Math.hypot(fx, fz) || 1;
      this.vel.x += (fx / fl) * S.groundLaunchForward;
      this.vel.z += (fz / fl) * S.groundLaunchForward;
      this.vel.y = Math.max(this.vel.y, S.groundLaunchUp);
    }
    this.events.push({ type: 'attach', hand: rope.hand, x: a.x, y: a.y, z: a.z, nx: a.nx, ny: a.ny, nz: a.nz });
  }

  releaseRope(broken: boolean, power = 0): void {
    const S = tuning.swing;
    const rope = this.rope;
    let good = false;
    if (rope.attached && !broken && rope.goodWindow) {
      good = true;
      const sp = this.vel.length();
      const fade = 1 - Math.max(0, Math.min(1, (sp - S.goodReleaseFadeStart) / Math.max(1, S.goodReleaseFadeEnd - S.goodReleaseFadeStart)));
      if (sp > 1) {
        this.vel.addScaledVector(tmpA.copy(this.vel).multiplyScalar(1 / sp), S.goodReleaseBonus * fade);
      }
      this.vel.y += S.goodReleaseUp;
      this.goodReleaseFlash = 0;
    }
    rope.attached = false;
    rope.firing = false;
    rope.goodWindow = false;
    rope.taut = false;
    rope.tension = 0;
    this.boostTimer = tuning.boost.window;
    this.boostAvailable = true;
    this.setMode(MODE_AIR);
    this.events.push({ type: 'release', good, broken, power });
  }

  /**
   * Letting go of the swing button, or Space on a swing or pull line: release
   * with a push forward and up, like springing off the line. The push grows
   * with the time spent on the line (`cut.fullAfter`), so a tap gives none; a
   * swing release keeps its good-release bonus. The push replaces the air
   * boost, so it never doubles up.
   */
  private cutLine(): void {
    const C = tuning.cut;
    const rope = this.rope;
    this.jumpBuffer = 0;
    let swung: number;
    if (this.mode === MODE_ZIP) {
      swung = clamp(this.zip.time / C.fullAfter, 0, 1);
      this.events.push({ type: 'zipEnd' });
      this.events.push({ type: 'release', good: false, broken: false, power: swung });
      this.setMode(MODE_AIR);
    } else {
      swung = rope.attached ? clamp((this.time - rope.attachTime) / C.fullAfter, 0, 1) : 0;
      this.releaseRope(false, swung);
    }
    this.boostAvailable = false;
    if (swung <= 0) return;
    const v = this.vel;
    const hs = Math.hypot(v.x, v.z);
    if (hs > 1) {
      const fade = 1 - clamp((hs - C.fadeStart) / Math.max(1, C.fadeEnd - C.fadeStart), 0, 1);
      v.x += (v.x / hs) * C.forward * fade * swung;
      v.z += (v.z / hs) * C.forward * fade * swung;
    }
    // Cancel the fall in proportion, then lift.
    v.y += (Math.max(v.y, 0) - v.y) * swung + C.up * swung;
  }

  /**
   * Rope inequality constraint, split around each substep move (RATTLE-like):
   * before the move, outward radial velocity at the current position is
   * removed (rope tension); after the move, the position is projected back
   * onto the sphere and the velocity is rotated to the new tangent with its
   * speed preserved. The rotation makes the geometric correction lossless, so
   * an undriven pendulum keeps its energy (see tests/swing.spec.ts).
   * When the rope snaps taut with a large radial speed (a catch), most of that
   * speed is redirected tangentially instead of being lost: no stalls.
   */
  private ropePreMove(): void {
    const rope = this.rope;
    const a = rope.anchor;
    const qx = this.pos.x - a.x,
      qy = this.pos.y + tuning.body.ropeOffset - a.y,
      qz = this.pos.z - a.z;
    const d = Math.sqrt(qx * qx + qy * qy + qz * qz);
    if (d < rope.length - 1e-4 || d < 1e-6) {
      rope.taut = false;
      rope.wasTaut = false;
      return;
    }
    const ux = qx / d,
      uy = qy / d,
      uz = qz / d;
    const v = this.vel;
    const vr = v.x * ux + v.y * uy + v.z * uz;
    if (vr > 0) {
      if (!rope.wasTaut && vr > tuning.swing.catchThreshold) this.ropeCatch(ux, uy, uz, vr);
      else {
        v.x -= ux * vr;
        v.y -= uy * vr;
        v.z -= uz * vr;
      }
    }
    rope.taut = true;
    rope.wasTaut = true;
  }

  private ropePostMove(): void {
    const rope = this.rope;
    const a = rope.anchor;
    const qx = this.pos.x - a.x,
      qy = this.pos.y + tuning.body.ropeOffset - a.y,
      qz = this.pos.z - a.z;
    const d = Math.sqrt(qx * qx + qy * qy + qz * qz);
    if (d <= rope.length || d < 1e-6) return;
    const ux = qx / d,
      uy = qy / d,
      uz = qz / d;
    const excess = d - rope.length;
    this.pos.x -= ux * excess;
    this.pos.y -= uy * excess;
    this.pos.z -= uz * excess;
    const v = this.vel;
    const vr = v.x * ux + v.y * uy + v.z * uz;
    if (vr <= 0) {
      rope.taut = true;
      return;
    }
    if (!rope.wasTaut && vr > tuning.swing.catchThreshold) {
      this.ropeCatch(ux, uy, uz, vr);
    } else {
      // Rotate onto the tangent plane, preserving speed.
      const sp = v.length();
      v.x -= ux * vr;
      v.y -= uy * vr;
      v.z -= uz * vr;
      const tl = v.length();
      if (tl > 1e-6) v.multiplyScalar(sp / tl);
    }
    rope.taut = true;
    rope.wasTaut = true;
  }

  /** The rope snaps taut: keep most of the radial speed by redirecting it. */
  private ropeCatch(ux: number, uy: number, uz: number, vr: number): void {
    const S = tuning.swing;
    const v = this.vel;
    const rope = this.rope;
    v.x -= ux * vr;
    v.y -= uy * vr;
    v.z -= uz * vr;
    const tl = v.length();
    const target = Math.sqrt(tl * tl + (S.catchEfficiency * vr) ** 2);
    if (tl > 1.0) v.multiplyScalar(target / tl);
    else {
      // Falling straight onto the rope: swing toward the camera heading.
      tmpC.copy(this.camFwd);
      const cu = tmpC.x * ux + tmpC.y * uy + tmpC.z * uz;
      tmpC.x -= ux * cu;
      tmpC.y -= uy * cu;
      tmpC.z -= uz * cu;
      const cl = tmpC.length();
      if (cl > 1e-3) v.addScaledVector(tmpC, target / cl);
    }
    rope.tension = Math.min(1, rope.tension + vr * 0.05 + 0.2);
    this.catchCount++;
  }

  private swingStep(dt: number, inp: TickInput): void {
    const S = tuning.swing;
    const A = tuning.air;
    const rope = this.rope;
    const v = this.vel;
    if (rope.firing) {
      rope.fireT += dt;
      if (rope.fireT >= rope.fireDur) {
        const a = rope.anchor;
        if (this.targeting.lineOfSight(this.pos.x, this.pos.y + tuning.body.ropeOffset, this.pos.z, a.x, a.y, a.z, a.id)) this.attachRope();
        else {
          rope.firing = false;
          this.setMode(MODE_AIR);
          this.events.push({ type: 'release', good: false, broken: true, power: 0 });
          // Still holding: retry with the next point under the crosshair.
          this.holdSwing = inp.swing;
          return;
        }
      } else {
        // Ballistic while the line travels.
        if (this.rope.fromGround) {
          this.groundStepLite(dt, inp);
          return;
        }
        v.y -= A.gravity * dt * 0.5;
        this.airControl(dt, inp);
        this.integrate(dt);
        v.y -= A.gravity * dt * 0.5;
        return;
      }
    }

    const a = rope.anchor;
    const off = tuning.body.ropeOffset;
    // Reel (wheel) and automatic ground clearance.
    if (inp.reel !== 0) {
      rope.targetLength = clamp(
        rope.targetLength - inp.reel * S.reelStep,
        Math.max(4, rope.attachLength - S.reelRange),
        Math.min(S.maxRope, rope.attachLength + S.reelRange),
      );
    }
    // Clearance only against ground-like surfaces (terrain, roofs), not trunks or canopies.
    const sup = this.world.supportHeight(a.x + a.nx * 1.5, a.z + a.nz * 1.5, a.y - 1, 0.1, true);
    const groundY = sup.y > -Infinity ? sup.y : this.world.terrain.waterLevelAt(a.x, a.z);
    const clearLen = Math.max(3, a.y - groundY - S.groundClearance - off);
    const want = Math.min(rope.targetLength, clearLen);
    const rate = rope.length > S.maxRope + 0.5 ? S.pullInSpeed : S.reelSpeed;
    rope.length = moveToward(rope.length, want, rate * dt);

    // Geometry
    const qx = this.pos.x - a.x,
      qy = this.pos.y + off - a.y,
      qz = this.pos.z - a.z;
    const d = Math.sqrt(qx * qx + qy * qy + qz * qz) || 1;
    const ux = qx / d,
      uy = qy / d,
      uz = qz / d;
    const taut = d >= rope.length - 0.05;

    // Gravity (reduced while taut).
    const g = A.gravity * (taut ? S.gravityScale : 1) * (inp.dive ? tuning.dive.gravityMul : 1);
    v.y -= g * dt * 0.5;

    // Arcade forces in the tangent plane.
    const wishLen = this.wish.length();
    if (taut && wishLen > 0.05) {
      // Desired direction: wish projected into the tangent plane.
      tmpA.copy(this.wish).multiplyScalar(1 / wishLen);
      const wu = tmpA.x * ux + tmpA.y * uy + tmpA.z * uz;
      tmpA.x -= ux * wu;
      tmpA.y -= uy * wu;
      tmpA.z -= uz * wu;
      const tl = tmpA.length();
      if (tl > 1e-3) {
        tmpA.multiplyScalar(1 / tl);
        const fwdAmt = Math.max(0, inp.moveY);
        const sideAmt = Math.abs(inp.moveX);
        const sp = v.length();
        const fade = Math.max(0, Math.min(1, (S.pumpMaxSpeed + 10 - sp) / 10));
        const acc = (S.pumpAccel * fwdAmt + S.sideAccel * sideAmt) * fade;
        v.addScaledVector(tmpA, acc * dt);
        // Turn the swing plane toward the wish (speed preserving).
        rotateToward(v, tmpA, S.steerRate * dt * wishLen);
      }
      if (inp.moveY < -0.1) {
        const sp = v.length();
        if (sp > 2) v.multiplyScalar(Math.max(0, 1 - (S.brakeAccel * dt) / sp));
      }
    } else if (!taut) {
      this.airControl(dt, inp, 0.6);
    }
    this.applyAirDrag(dt);

    // Good-release window: rising part of the arc, ahead of the anchor.
    const below = -uy; // cos of angle from straight down
    const angDeg = (Math.acos(clamp(below, -1, 1)) * 180) / Math.PI;
    const ahead = v.x * -ux + v.z * -uz < 0; // moving away from the anchor horizontally
    rope.goodWindow =
      taut &&
      v.y > S.goodReleaseMinUp &&
      angDeg >= S.goodReleaseMinDeg &&
      angDeg <= S.goodReleaseMaxDeg &&
      uy < 0 &&
      ahead;

    rope.tension = Math.max(0, rope.tension - dt * 2);
    this.integrate(dt);
    v.y -= g * dt * 0.5;
    if (this.rope.taut) rope.tension = Math.max(rope.tension, 0.6);

    const c = this.contact;
    // Wall grab while swinging.
    if (c.wall && c.wallClimbable && inp.sprint && this.canCling(c.wallId)) {
      rope.attached = false;
      this.events.push({ type: 'release', good: false, broken: false, power: 0 });
      this.enterWall(c.wallId, c.wallNX, c.wallNZ, true);
      return;
    }
    // Landing releases the line after a short grace.
    if (c.ground) {
      rope.groundTime += dt;
      if (rope.groundTime > S.landReleaseTime) {
        const hs = Math.hypot(v.x, v.z);
        rope.attached = false;
        this.events.push({ type: 'release', good: false, broken: false, power: 0 });
        this.land(0, hs, c.groundSurface);
        return;
      }
    } else rope.groundTime = 0;

    // Line of sight: release gracefully when the line is blocked.
    {
      const hx = this.pos.x,
        hy = this.pos.y + off,
        hz = this.pos.z;
      if (!this.targeting.lineOfSight(hx, hy, hz, a.x, a.y, a.z, a.id)) {
        rope.losBlocked++;
        if (rope.losBlocked >= 3) {
          this.releaseRope(true);
          this.holdSwing = inp.swing;
          return;
        }
      } else rope.losBlocked = 0;
    }
  }

  /** Feet on (or within snapping distance of) a support. */
  private supportedFeet(): boolean {
    const s = this.world.supportHeight(this.pos.x, this.pos.z, this.pos.y + 0.05, 0.12);
    return s.y > -Infinity && s.y >= this.pos.y - tuning.ground.snapDown;
  }

  /** Ground movement while a line is in flight from the ground. */
  private groundStepLite(dt: number, inp: TickInput): void {
    const v = this.vel;
    const tx = this.wish.x * tuning.ground.runSpeed,
      tz = this.wish.z * tuning.ground.runSpeed;
    v.x = moveToward(v.x, tx, tuning.ground.accel * dt);
    v.z = moveToward(v.z, tz, tuning.ground.accel * dt);
    v.y -= tuning.air.gravity * dt;
    void inp;
    this.integrate(dt);
  }

  // ---------------------------------------------------------------------------
  // Zip
  // ---------------------------------------------------------------------------

  private startZip(t: AnchorResult): void {
    const Z = tuning.zip;
    const w = this.world;
    const r = tuning.body.radius;
    const z = this.zip;
    z.tx = t.x;
    z.ty = t.y;
    z.tz = t.z;
    z.ignoreA = t.id;
    z.ignoreB = -1;
    z.time = 0;
    z.stall = 0;
    let nx = t.nx,
      nz = t.nz;
    const nl = Math.hypot(nx, nz);
    // Default: hop off the surface.
    z.endAction = 0;
    if (t.ny > 0.7) {
      // Top surface: land on it.
      z.endAction = 2;
      z.ex = t.x;
      z.ey = t.y + 0.05;
      z.ez = t.z;
      nx = 0;
      nz = 0;
    } else if (nl > 0.5) {
      nx /= nl;
      nz /= nl;
      // Facade: is there a ledge within reach above the hit?
      const kind = w.kind[t.id];
      const top = w.topY(t.id);
      const ledge = kind === BOX ? this.ledgeTop(t.x - nx * 0.15, t.z - nz * 0.15, top) : { top, ids: [-1, -1] as [number, number] };
      const reach = ledge.top - t.y;
      if (kind === BOX && reach <= Z.mantleReach) {
        const inX = t.x - nx * (r + 0.85),
          inZ = t.z - nz * (r + 0.85);
        const s = w.supportHeight(inX, inZ, ledge.top + 0.05, 0.05);
        const landY = s.y > -Infinity ? s.y : ledge.top;
        if (w.capsuleFree(inX, landY + 0.02, inZ, r, tuning.body.height)) {
          z.endAction = 1;
          z.mantleX = inX;
          z.mantleY = landY + 0.02;
          z.mantleZ = inZ;
          z.apex = ledge.top;
          z.ignoreB = ledge.ids[1];
        }
      }
      z.ex = t.x + nx * (r + 0.15);
      z.ey = z.endAction === 1 ? Math.max(t.y, ledge.top - 1.7) : t.y - 1.3;
      z.ez = t.z + nz * (r + 0.15);
      if ((w.flags[t.id]! & F_CANOPY) !== 0 || w.kind[t.id] === CYL) z.endAction = z.endAction === 1 ? 1 : 3;
    } else {
      z.ex = t.x;
      z.ey = t.y - 1.3;
      z.ez = t.z;
      z.endAction = 3;
    }
    z.nx = nx;
    z.nz = nz;
    // Initial speed: keep momentum along the pull, then ease up to the top speed.
    const dx = z.ex - this.pos.x,
      dy = z.ey - this.pos.y,
      dz = z.ez - this.pos.z;
    const dl = Math.hypot(dx, dy, dz) || 1;
    z.speed = Math.max(Z.startSpeed, (this.vel.x * dx + this.vel.y * dy + this.vel.z * dz) / dl);
    z.lastDist = dl;
    z.hand = 1 - this.lastHand;
    this.lastHand = z.hand;
    this.zipCooldown = Z.cooldown;
    this.rope.attached = false;
    this.rope.firing = false;
    this.diving = false;
    this.setMode(MODE_ZIP);
    this.events.push({ type: 'zipStart', x: t.x, y: t.y, z: t.z, hand: z.hand });
  }

  private zipStep(dt: number, inp: TickInput): void {
    const Z = tuning.zip;
    const z = this.zip;
    z.time += dt;
    const dx = z.ex - this.pos.x,
      dy = z.ey - this.pos.y,
      dz = z.ez - this.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.6 || z.time > Z.maxTime) {
      this.finishZip(inp);
      return;
    }
    const desired = Math.min(Z.speed, Math.sqrt(2 * Z.decel * dist) + Z.endSpeed);
    z.speed = z.speed < desired ? Math.min(desired, z.speed + Z.accel * dt) : Math.max(desired, z.speed - Z.decel * 2 * dt);
    const s = Math.min(z.speed, dist / dt);
    this.vel.set((dx / dist) * s, (dy / dist) * s, (dz / dist) * s);
    clearContactSummary(this.contact);
    this.gather(dt);
    const n = clamp(Math.ceil((s * dt) / tuning.sim.maxSubstepMove), 1, 16);
    const h = dt / n;
    let touchedTarget = false;
    for (let i = 0; i < n; i++) {
      this.pos.addScaledVector(this.vel, h);
      clearContactSummary(this.subContact);
      this.world.resolveCapsule(this.pos, this.vel, tuning.body.radius, tuning.body.height, this.cands, this.nCands, this.subContact);
      this.mergeContacts();
      if (this.subContact.anyId >= 0 && this.subContact.anyId === z.ignoreA) touchedTarget = true;
    }
    // Arrived at the target surface (we never pass through it).
    if (touchedTarget) {
      this.finishZip(inp);
      return;
    }
    const nd = Math.hypot(z.ex - this.pos.x, z.ey - this.pos.y, z.ez - this.pos.z);
    if (z.lastDist - nd < s * dt * 0.25) z.stall += dt;
    else z.stall = 0;
    z.lastDist = nd;
    if (z.stall > 0.15) {
      // Blocked: drop out into the air with what we have.
      this.setMode(MODE_AIR);
      this.events.push({ type: 'zipEnd' });
    }
  }

  private finishZip(inp: TickInput): void {
    const Z = tuning.zip;
    const z = this.zip;
    this.events.push({ type: 'zipEnd' });
    if (z.endAction === 1) {
      if (this.startTraverse(TRAV_LEDGE, z.mantleX, z.mantleY, z.mantleZ, z.apex, tuning.ground.mantleDuration, z.ignoreA, z.ignoreB, -z.nx * 4, 0, -z.nz * 4)) {
        this.events.push({ type: 'mantle' });
        return;
      }
      z.endAction = 0;
    }
    if (z.endAction === 2) {
      this.vel.set(this.vel.x * 0.3, 2, this.vel.z * 0.3);
      this.setMode(MODE_AIR);
      return;
    }
    // Facade hit: grab if Shift is held, else hop up and back.
    if (z.endAction === 0 && inp.sprint && z.ignoreA >= 0 && this.canCling(z.ignoreA)) {
      this.enterWall(z.ignoreA, z.nx, z.nz, false);
      return;
    }
    this.vel.set(z.nx * Z.hopBack, Z.hopUp, z.nz * Z.hopBack);
    if (z.endAction === 3) this.vel.set(this.camFwd.x * 3, Z.hopUp, this.camFwd.z * 3);
    this.boostTimer = tuning.boost.window;
    this.boostAvailable = true;
    this.setMode(MODE_AIR);
  }

  // ---------------------------------------------------------------------------
  // Wall
  // ---------------------------------------------------------------------------

  /** A wall worth clinging to: a box rising well above the feet (not a parapet you can vault). */
  private canCling(id: number): boolean {
    const w = this.world;
    if (id < 0 || w.kind[id] !== BOX || (w.flags[id]! & F_CLIMB) === 0) return false;
    let top = w.topY(id);
    // A coplanar box stacked on top (parapet over a facade) extends the wall.
    if (top - this.pos.y < 1.9) {
      const o = id * 6;
      const p = w.p;
      const above = this.findCoplanarAny(id, p[o]!, p[o + 2]!, p[o + 3]!, p[o + 5]!, top);
      if (above >= 0) top = w.topY(above);
    }
    return top - this.pos.y >= 1.9;
  }

  /** Any climbable box sitting on top of box `id` (same footprint edge region). */
  private findCoplanarAny(id: number, minX: number, minZ: number, maxX: number, maxZ: number, top: number): number {
    const w = this.world;
    const n = w.gatherAabb(minX, top - 0.05, minZ, maxX, top + 0.05, maxZ, undefined, F_CLIMB);
    for (let k = 0; k < n; k++) {
      const o = w.queryBuf[k]!;
      if (o === id || w.kind[o] !== BOX) continue;
      if (Math.abs(w.p[o * 6 + 1]! - top) < 0.05) return o;
    }
    return -1;
  }

  private enterWall(id: number, nx: number, nz: number, carryMomentum: boolean): void {
    const W = tuning.wall;
    const w = this.world;
    if (!this.canCling(id)) return;
    // Snap the normal to the box face axis.
    if (Math.abs(nx) > Math.abs(nz)) {
      nx = Math.sign(nx);
      nz = 0;
    } else {
      nz = Math.sign(nz);
      nx = 0;
    }
    if (nx === 0 && nz === 0) return;
    const wall = this.wall;
    wall.id = id;
    wall.nx = nx;
    wall.nz = nz;
    wall.time = 0;
    const v = this.vel;
    const hs = Math.hypot(v.x, v.z);
    wall.run = carryMomentum ? clamp(hs * 0.7 + Math.max(0, v.y) * 0.6, 0, W.wallRunMax) : 0;
    v.set(0, 0, 0);
    this.diving = false;
    this.rope.attached = false;
    this.rope.firing = false;
    this.snapToWall();
    this.facing = Math.atan2(nx, nz);
    this.setMode(MODE_WALL);
    this.events.push({ type: 'wallGrab', surface: w.surface[id]! });
  }

  private wallPlane(id: number, nx: number, nz: number): number {
    const o = id * 6;
    const p = this.world.p;
    if (nx > 0) return p[o + 3]!;
    if (nx < 0) return p[o]!;
    if (nz > 0) return p[o + 5]!;
    return p[o + 2]!;
  }

  private snapToWall(): void {
    const wall = this.wall;
    const r = tuning.body.radius;
    const plane = this.wallPlane(wall.id, wall.nx, wall.nz);
    if (wall.nx !== 0) this.pos.x = plane + wall.nx * (r + 0.01);
    else this.pos.z = plane + wall.nz * (r + 0.01);
  }

  /** A climbable box whose face (normal n) lies on `plane` and contains (lat, y). */
  private findCoplanar(nx: number, nz: number, plane: number, x: number, y: number, z: number, exclude: number): number {
    const w = this.world;
    const n = w.gatherAabb(x - 0.6, y - 0.6, z - 0.6, x + 0.6, y + 0.6, z + 0.6, undefined, F_CLIMB);
    const p = w.p;
    for (let k = 0; k < n; k++) {
      const id = w.queryBuf[k]!;
      if (id === exclude || w.kind[id] !== BOX) continue;
      const o = id * 6;
      const fp = nx > 0 ? p[o + 3]! : nx < 0 ? p[o]! : nz > 0 ? p[o + 5]! : p[o + 2]!;
      if (Math.abs(fp - plane) > 0.3) continue;
      if (y < p[o + 1]! - 0.05 || y > p[o + 4]! + 0.05) continue;
      if (nx !== 0) {
        if (z < p[o + 2]! - 0.05 || z > p[o + 5]! + 0.05) continue;
      } else if (x < p[o]! - 0.05 || x > p[o + 3]! + 0.05) continue;
      return id;
    }
    return -1;
  }

  private wallStep(dt: number, inp: TickInput): void {
    const W = tuning.wall;
    const w = this.world;
    const wall = this.wall;
    const r = tuning.body.radius;
    wall.time += dt;
    const nx = wall.nx,
      nz = wall.nz;
    if (!inp.sprint) {
      this.vel.set(nx * W.letGoPush, 0, nz * W.letGoPush);
      this.setMode(MODE_AIR);
      return;
    }
    if (this.jumpBuffer > 0) {
      this.jumpBuffer = 0;
      const away = this.camFwd.x * nx + this.camFwd.z * nz;
      const fwd = away > 0.2 ? W.jumpForward : 0;
      this.vel.set(nx * W.jumpOut + this.camFwd.x * fwd, W.jumpUp, nz * W.jumpOut + this.camFwd.z * fwd);
      this.boostTimer = tuning.boost.window;
      this.boostAvailable = true;
      this.setMode(MODE_AIR);
      this.events.push({ type: 'wallJump' });
      return;
    }
    // Wall axes: right when facing the wall.
    const rx = nz,
      rz = -nx;
    const camDot = this.camRight.x * rx + this.camRight.z * rz;
    const latSign = Math.abs(camDot) < 0.2 ? 1 : Math.sign(camDot);
    const lat = inp.moveX * latSign;
    wall.run = Math.max(0, wall.run - W.wallRunDecay * dt);
    if (inp.moveY < 0) wall.run = 0;
    const up = inp.moveY * W.crawlSpeed + (inp.moveY >= 0 ? wall.run : 0);
    this.vel.set(rx * lat * W.crawlSpeed - nx * W.stick, up, rz * lat * W.crawlSpeed - nz * W.stick);
    this.integrate(dt);
    this.vel.set(rx * lat * W.crawlSpeed, up, rz * lat * W.crawlSpeed);

    // Keep the face: top, sides, bottom.
    const o = wall.id * 6;
    const p = w.p;
    const plane = this.wallPlane(wall.id, nx, nz);
    const latCoord = nx !== 0 ? this.pos.z : this.pos.x;
    const latMin = nx !== 0 ? p[o + 2]! : p[o]!;
    const latMax = nx !== 0 ? p[o + 5]! : p[o + 3]!;
    const top = p[o + 4]!;
    const reach = this.pos.y + 1.55;
    // Reached the top of this box.
    if (reach > top) {
      const fx = nx !== 0 ? plane : this.pos.x;
      const fz = nx !== 0 ? this.pos.z : plane;
      const above = this.findCoplanar(nx, nz, plane, fx, top + 0.3, fz, wall.id);
      if (above >= 0) {
        wall.id = above;
      } else {
        if (inp.moveY > 0 || wall.run > 0) {
          if (this.tryLedgeMantle(fx, fz, top)) return;
          // Could not mantle (blocked): pop up off the wall.
          this.vel.set(nx * 2, 7, nz * 2);
          this.setMode(MODE_AIR);
          return;
        }
        // Not climbing: hold just below the top (never into a floor).
        const holdY = top - 1.55;
        if (holdY < this.pos.y) {
          if (this.contact.ground || !w.capsuleFree(this.pos.x, holdY, this.pos.z, r, tuning.body.height)) {
            this.land(0, 0, this.contact.groundSurface);
            return;
          }
          this.pos.y = holdY;
        }
      }
    }
    // Lateral edges.
    if (latCoord > latMax + r * 0.5 || latCoord < latMin - r * 0.5) {
      const past = latCoord > latMax ? 1 : -1;
      const edge = past > 0 ? latMax : latMin;
      const fx = nx !== 0 ? plane : latCoord;
      const fz = nx !== 0 ? latCoord : plane;
      const nb = this.findCoplanar(nx, nz, plane, fx, this.pos.y + 1, fz, wall.id);
      if (nb >= 0) wall.id = nb;
      else {
        // Wrap around the outer corner onto the side face.
        const n2x = nx !== 0 ? 0 : past;
        const n2z = nx !== 0 ? past : 0;
        const cxp = nx !== 0 ? plane : edge;
        const czp = nx !== 0 ? edge : plane;
        const npx = cxp + n2x * (r + 0.02) - nx * 0.45;
        const npz = czp + n2z * (r + 0.02) - nz * 0.45;
        if ((n2x !== 0 || n2z !== 0) && w.capsuleFree(npx, this.pos.y, npz, r, tuning.body.height)) {
          this.pos.x = npx;
          this.pos.z = npz;
          wall.nx = n2x;
          wall.nz = n2z;
          this.facing = Math.atan2(n2x, n2z);
        } else {
          // Clamp at the edge.
          if (nx !== 0) this.pos.z = clamp(this.pos.z, latMin - r * 0.5, latMax + r * 0.5);
          else this.pos.x = clamp(this.pos.x, latMin - r * 0.5, latMax + r * 0.5);
        }
      }
    }
    // Inner corner: blocked by another climbable wall.
    const c = this.contact;
    if (c.wall && c.wallClimbable && c.wallId !== wall.id && w.kind[c.wallId] === BOX) {
      const cn = Math.abs(c.wallNX) > Math.abs(c.wallNZ) ? [Math.sign(c.wallNX), 0] : [0, Math.sign(c.wallNZ)];
      if (cn[0] !== nx || cn[1] !== nz) {
        if (Math.abs(lat) > 0.1) {
          wall.id = c.wallId;
          wall.nx = cn[0]!;
          wall.nz = cn[1]!;
          this.facing = Math.atan2(wall.nx, wall.nz);
        }
      }
    }
    // Bottom: reached the ground.
    if (c.ground && inp.moveY <= 0) {
      this.land(0, 0, c.groundSurface);
      return;
    }
    if (this.mode === MODE_WALL) this.snapToWall();
  }

  private tryLedgeMantle(fx: number, fz: number, top: number): boolean {
    const w = this.world;
    const wall = this.wall;
    const r = tuning.body.radius;
    const ledge = this.ledgeTop(fx - wall.nx * 0.15, fz - wall.nz * 0.15, top);
    const inX = fx - wall.nx * (r + 0.85),
      inZ = fz - wall.nz * (r + 0.85);
    const s = w.supportHeight(inX, inZ, ledge.top + 0.05, 0.05);
    const landY = (s.y > -Infinity ? s.y : ledge.top) + 0.02;
    if (!w.capsuleFree(inX, landY, inZ, r, tuning.body.height)) return false;
    if (!this.startTraverse(TRAV_LEDGE, inX, landY, inZ, ledge.top, tuning.ground.mantleDuration, wall.id, ledge.ids[1], -wall.nx * 3, 0, -wall.nz * 3)) return false;
    this.events.push({ type: 'mantle' });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Traverse (vault, mantle): kinematic Bezier with collision safety
  // ---------------------------------------------------------------------------

  /**
   * Start a vault / mantle. The path never enters the obstacle: phase A rises
   * vertically along the face until the feet clear `topY`, phase B moves
   * horizontally above the top to the end point. Returns false when the
   * swept path is not free (then nothing happens).
   */
  private startTraverse(
    kind: number,
    ex: number,
    ey: number,
    ez: number,
    topY: number,
    dur: number,
    ignoreA: number,
    ignoreB: number,
    vx: number,
    vy: number,
    vz: number,
  ): boolean {
    const t = this.trav;
    const w = this.world;
    const r = tuning.body.radius,
      hgt = tuning.body.height;
    const clear = kind === TRAV_VAULT ? 0.14 : 0.04;
    const liftY = Math.max(this.pos.y, topY + clear);
    // Check the swept path (corner and a few points along phase B).
    if (!w.capsuleFree(this.pos.x, liftY, this.pos.z, r, hgt, 0)) return false;
    for (let k = 1; k <= 4; k++) {
      const f = k / 4;
      const x = this.pos.x + (ex - this.pos.x) * f,
        z = this.pos.z + (ez - this.pos.z) * f;
      if (!w.capsuleFree(x, liftY, z, r, hgt, 0)) return false;
    }
    t.kind = kind;
    t.t = 0;
    t.p0.copy(this.pos);
    t.p1.set(this.pos.x, liftY, this.pos.z);
    t.p2.set(ex, liftY, ez);
    t.landY = ey;
    const rise = liftY - this.pos.y;
    const horiz = Math.hypot(ex - this.pos.x, ez - this.pos.z);
    // Split the duration between the rise and the crossing.
    const tA = Math.max(0.06, Math.min(dur * 0.6, rise / 6.5));
    const tB = Math.max(0.1, Math.min(dur, horiz / Math.max(4.5, Math.hypot(vx, vz))));
    t.dur = tA + tB;
    t.splitT = tA;
    t.exit.set(vx, vy, vz);
    t.ignoreA = ignoreA;
    t.ignoreB = ignoreB;
    this.rope.attached = false;
    this.rope.firing = false;
    this.diving = false;
    this.setMode(MODE_TRAVERSE);
    if (horiz > 0.05) this.facing = Math.atan2(-(ex - this.pos.x), -(ez - this.pos.z));
    return true;
  }

  private traverseStep(dt: number): void {
    const t = this.trav;
    t.t += dt;
    let nx: number, ny: number, nz: number;
    if (t.t < t.splitT) {
      const u = t.t / t.splitT;
      const s = 1 - (1 - u) * (1 - u); // ease-out rise
      nx = t.p0.x;
      nz = t.p0.z;
      ny = t.p0.y + (t.p1.y - t.p0.y) * s;
    } else {
      const u = Math.min(1, (t.t - t.splitT) / Math.max(1e-4, t.dur - t.splitT));
      const s = u * u * (3 - 2 * u);
      nx = t.p1.x + (t.p2.x - t.p1.x) * s;
      nz = t.p1.z + (t.p2.z - t.p1.z) * s;
      ny = t.p1.y + (t.p2.y - t.p1.y) * s;
      if (t.kind === TRAV_VAULT) ny += Math.sin(Math.PI * u) * 0.12;
    }
    this.vel.set((nx - this.pos.x) / dt, (ny - this.pos.y) / dt, (nz - this.pos.z) / dt);
    this.pos.set(nx, ny, nz);
    clearContactSummary(this.contact);
    this.gather(dt, 1);
    tmpA.copy(this.vel);
    this.world.resolveCapsule(this.pos, tmpA, tuning.body.radius, tuning.body.height, this.cands, this.nCands, this.contact);
    const dev = Math.hypot(this.pos.x - nx, this.pos.y - ny, this.pos.z - nz);
    if (dev > 0.3) {
      this.vel.copy(tmpA);
      this.setMode(MODE_AIR);
      return;
    }
    if (t.t >= t.dur) {
      this.vel.copy(t.exit);
      const sup = this.world.supportHeight(this.pos.x, this.pos.z, this.pos.y + 0.05, 0.12);
      if (t.kind !== TRAV_VAULT && sup.y > -Infinity && sup.y >= this.pos.y - 0.12) {
        this.pos.y = Math.max(this.pos.y, sup.y);
        this.setMode(MODE_GROUND);
        this.grounded = true;
      } else {
        // Landing is lower than the lift height: drop onto it.
        this.setMode(MODE_AIR);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Post step: water, bounds, NaN guard, stuck detection
  // ---------------------------------------------------------------------------

  private setMode(m: number): void {
    if (m !== MODE_GROUND) this.grounded = false;
    if (m !== MODE_SWING) {
      this.rope.attached = false;
      this.rope.firing = false;
    }
    this.mode = m;
  }

  private postStep(dt: number, inp: TickInput, r: number): void {
    const p = this.pos,
      v = this.vel;
    // NaN guard
    if (!Number.isFinite(p.x + p.y + p.z + v.x + v.y + v.z)) {
      this.stats.nanResets++;
      p.copy(this.lastGood);
      v.set(0, 0, 0);
      this.setMode(MODE_AIR);
    }
    // Water
    const terr = this.world.terrain;
    if (terr.isWater(p.x, p.z) && p.y < terr.waterLevelAt(p.x, p.z) + 0.05) {
      this.stats.splashes++;
      this.events.push({ type: 'splash', x: p.x, y: terr.waterLevelAt(p.x, p.z), z: p.z });
      this.respawnFromWater();
      return;
    }
    // Soft world boundary
    const b = this.layout.bounds;
    const m = tuning.world.softBoundaryMargin;
    const acc = tuning.world.softBoundaryAccel;
    const push = (over: number): number => acc * Math.min(4, (over / m) ** 2 + over / m);
    if (p.x < b.minX + m) v.x += push(b.minX + m - p.x) * dt;
    if (p.x > b.maxX - m) v.x -= push(p.x - (b.maxX - m)) * dt;
    if (p.z < b.minZ + m) v.z += push(b.minZ + m - p.z) * dt;
    if (p.z > b.maxZ - m) v.z -= push(p.z - (b.maxZ - m)) * dt;
    if (p.y > 420) v.y -= push(p.y - 420) * dt;
    if (p.x < b.minX) {
      p.x = b.minX;
      v.x = Math.max(0, v.x);
    }
    if (p.x > b.maxX) {
      p.x = b.maxX;
      v.x = Math.min(0, v.x);
    }
    if (p.z < b.minZ) {
      p.z = b.minZ;
      v.z = Math.max(0, v.z);
    }
    if (p.z > b.maxZ) {
      p.z = b.maxZ;
      v.z = Math.min(0, v.z);
    }

    // Deep penetration safety net.
    const pen = this.world.capsulePenetration(p.x, p.y, p.z, r, tuning.body.height);
    if (pen > tuning.recovery.deepPenetration && this.mode !== MODE_TRAVERSE) {
      this.deepTicks++;
      if (this.deepTicks >= tuning.recovery.deepTicks) {
        this.recover();
        return;
      }
    } else this.deepTicks = 0;

    // No-progress detection (3 s).
    this.progressTimer += dt;
    const moved = this.pos.distanceTo(this.progressAnchor);
    if (moved > tuning.recovery.minProgress) {
      this.progressAnchor.copy(this.pos);
      this.progressTimer = 0;
    } else {
      const trying = inp.moveX !== 0 || inp.moveY !== 0;
      const airborne = this.mode === MODE_AIR || this.mode === MODE_ZIP || this.mode === MODE_TRAVERSE;
      const suspicious = airborne || (trying && this.mode === MODE_GROUND);
      if (!suspicious) this.progressTimer = 0;
      if (this.progressTimer > this.stats.maxStuckTime) this.stats.maxStuckTime = this.progressTimer;
      if (suspicious && this.progressTimer >= tuning.recovery.stuckTime) {
        if (airborne || this.isTrapped()) {
          this.stats.stuckEvents++;
          this.recover();
          return;
        }
        this.progressTimer = 0;
      }
    }
    if (pen <= 0.01 && this.mode !== MODE_TRAVERSE) {
      this.lastGood.copy(p);
      this.lastGoodVel.copy(v);
    }
  }

  /** Tests: attach a rope to an arbitrary point with a given length (taut). */
  debugAttach(ax: number, ay: number, az: number, len: number): void {
    const rope = this.rope;
    const a = rope.anchor;
    a.valid = true;
    a.x = ax;
    a.y = ay;
    a.z = az;
    a.nx = 0;
    a.ny = -1;
    a.nz = 0;
    a.id = -1;
    a.dist = len;
    a.assisted = false;
    this.setMode(MODE_SWING);
    rope.firing = false;
    rope.attached = true;
    rope.length = len;
    rope.targetLength = len;
    rope.attachLength = len;
    rope.taut = true;
    rope.wasTaut = true;
    rope.losBlocked = 0;
    rope.groundTime = 0;
    rope.fromGround = false;
    rope.onGround = false;
    rope.byButton = false;
  }

  hasFreeDirection(): boolean {
    return !this.isTrapped();
  }

  /** True when the capsule cannot move in any horizontal direction or up. */
  private isTrapped(): boolean {
    const r = tuning.body.radius,
      h = tuning.body.height;
    const p = this.pos;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (this.world.capsuleFree(p.x + Math.cos(a) * 0.6, p.y + 0.05, p.z + Math.sin(a) * 0.6, r, h)) return false;
    }
    return !this.world.capsuleFree(p.x, p.y + 0.6, p.z, r, h);
  }

  /** Find the nearest free standing position around (x, y, z). */
  findSafeSpot(x: number, y: number, z: number, out: Vector3): boolean {
    const r = tuning.body.radius,
      h = tuning.body.height;
    const w = this.world;
    const tryAt = (cx: number, cz: number, maxY: number): boolean => {
      const s = w.supportHeight(cx, cz, maxY, 0);
      if (s.y === -Infinity) return false;
      if (!w.capsuleFree(cx, s.y + 0.02, cz, r + 0.05, h)) return false;
      out.set(cx, s.y + 0.02, cz);
      return true;
    };
    if (tryAt(x, z, y + 1.5)) return true;
    const radii = [0.8, 1.6, 2.5, 4, 6, 9, 13, 18, 25, 35, 50, 70];
    for (const rad of radii) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const cx = x + Math.cos(a) * rad,
          cz = z + Math.sin(a) * rad;
        if (tryAt(cx, cz, y + 1.5)) return true;
        if (tryAt(cx, cz, y + 40)) return true;
      }
    }
    return false;
  }

  private recover(): void {
    const p = this.pos;
    tmpC.copy(p);
    if (!this.findSafeSpot(p.x, p.y, p.z, tmpA)) {
      tmpA.set(this.layout.spawn[0], this.layout.spawn[1] + 0.1, this.layout.spawn[2]);
    }
    this.renderOffset.add(tmpC.sub(tmpA));
    this.pos.copy(tmpA);
    this.vel.set(0, 0, 0);
    this.setMode(MODE_GROUND);
    this.grounded = true;
    this.progressAnchor.copy(this.pos);
    this.progressTimer = 0;
    this.deepTicks = 0;
    this.stats.recoveries++;
    this.events.push({ type: 'recover' });
  }

  private respawnFromWater(): void {
    const L = this.layout;
    const p = this.pos;
    let tx: number, tz: number;
    const terr = this.world.terrain;
    if (terr.inPark(p.x, p.z) && terr.inPond(p.x, p.z)) {
      const pd = L.pond;
      const dx = (p.x - pd.cx) / pd.rx,
        dz = (p.z - pd.cz) / pd.rz;
      const k = Math.hypot(dx, dz) || 1;
      tx = pd.cx + (dx / k) * (pd.rx + 5);
      tz = pd.cz + (dz / k) * (pd.rz + 5);
    } else {
      // Nearest point on the island promenade (or the islet).
      const isl = L.islet;
      const dIslet = Math.hypot(Math.max(isl.minX - p.x, 0, p.x - isl.maxX), Math.max(isl.minZ - p.z, 0, p.z - isl.maxZ));
      const land = L.land;
      const dLand = Math.hypot(Math.max(land.minX - p.x, 0, p.x - land.maxX), Math.max(land.minZ - p.z, 0, p.z - land.maxZ));
      const r = dIslet < dLand ? isl : land;
      tx = clamp(p.x, r.minX + 6, r.maxX - 6);
      tz = clamp(p.z, r.minZ + 6, r.maxZ - 6);
    }
    if (!this.findSafeSpot(tx, 0.5, tz, tmpA)) tmpA.set(L.spawn[0], L.spawn[1] + 0.1, L.spawn[2]);
    this.pos.copy(tmpA);
    this.vel.set(0, 0, 0);
    this.renderOffset.set(0, 0, 0);
    this.setMode(MODE_GROUND);
    this.grounded = true;
    this.progressAnchor.copy(this.pos);
    this.progressTimer = 0;
    this.events.push({ type: 'respawn' });
  }

  /** For tests/debug: is the capsule penetrating anything right now. */
  penetration(): number {
    return this.world.capsulePenetration(this.pos.x, this.pos.y, this.pos.z, tuning.body.radius, tuning.body.height);
  }

  /** Ray helper for the animation system (foot planting). */
  groundBelow(x: number, y: number, z: number): number {
    const s = this.world.supportHeight(x, z, y + 0.6, 0);
    return s.y;
  }

  get rayScratch(): ReturnType<typeof makeRayHit> {
    return this.ray;
  }
}

