/**
 * Another player's hero (design M12 §5): its own rig, animator and web line,
 * driven by relayed state. Samples go into an interpolation buffer keyed by
 * room time and are read 100 ms late; the events carried in a sample fire
 * when the render time passes that sample, so attach/release/land line up
 * with the motion. Implements `AnimSource`, so the hero's own animator poses
 * it. A changed teleport counter snaps instead of blending.
 */
import { Vector3, type PerspectiveCamera } from 'three';
import { tuning } from '../config/tuning';
import { clamp } from '../core/math';
import { SURF_CONCRETE, type CollisionWorld } from '../physics/collision';
import { CA, MODE_SWING, MODE_ZIP, type CombatAnim, type PlayerEvent } from '../player/player';
import { HB, HF, type HeroSample, type NetEvent } from '../net/protocol';
import { InterpBuffer, lerpAngle, INTERP_EMPTY } from '../net/interp';
import { buildCharacter, setCostume, type CharacterRig } from './rig';
import { CharacterAnimator } from './animator';
import { WebLine, type WebLineState } from './webLine';
import { isCostumeId, DEFAULT_COSTUME, type CostumeId } from './costumes';
import type { AnimSource } from './animSource';

/** One interpolated state (a subset of the wire sample). */
interface RemoteSample {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  facing: number;
  mode: number;
  flags: number;
  blocks: number;
  tp: number;
  ax: number;
  ay: number;
  az: number;
  zx: number;
  zy: number;
  zz: number;
  wnx: number;
  wnz: number;
  wrun: number;
  travKind: number;
  travT: number;
  travDur: number;
  action: number;
  actionSide: number;
  /** Room time (s) the combat overlay started. */
  actionT0: number;
  actionDur: number;
}

function makeRemoteSample(): RemoteSample {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, facing: 0, mode: 0, flags: 0, blocks: 0, tp: 0, ax: 0, ay: 0, az: 0,
    zx: 0, zy: 0, zz: 0, wnx: 0, wnz: 0, wrun: 0, travKind: 0, travT: 0, travDur: 0, action: 0, actionSide: 0, actionT0: -1e9, actionDur: 0,
  };
}

const OPS = {
  create: makeRemoteSample,
  copy: (a: RemoteSample, d: RemoteSample) => {
    Object.assign(d, a);
  },
  lerp: (a: RemoteSample, b: RemoteSample, f: number, d: RemoteSample) => {
    // Discrete state from the nearer sample, motion blended.
    Object.assign(d, f < 0.5 ? a : b);
    d.x = a.x + (b.x - a.x) * f;
    d.y = a.y + (b.y - a.y) * f;
    d.z = a.z + (b.z - a.z) * f;
    d.vx = a.vx + (b.vx - a.vx) * f;
    d.vy = a.vy + (b.vy - a.vy) * f;
    d.vz = a.vz + (b.vz - a.vz) * f;
    d.facing = lerpAngle(a.facing, b.facing, f);
    if (a.mode === b.mode && a.mode === 5) d.travT = a.travT + (b.travT - a.travT) * clamp(f, 0, 1);
  },
  snap: (a: RemoteSample, b: RemoteSample) => a.tp !== b.tp,
};

/** Distances (m) for the level of detail tiers. */
export const LOD_FULL = 60;
export const LOD_LITE = 150;
export const LOD_SILHOUETTE = 500;

const _v = new Vector3();

export class RemotePlayer implements AnimSource {
  // AnimSource
  mode = 1;
  readonly vel = new Vector3();
  facing = 0;
  diving = false;
  grounded = false;
  rollTimer = 0;
  readonly groundSurface = SURF_CONCRETE;
  /** Render time (s): the clock of `combatAnim.t0`. */
  time = 0;
  readonly rope = { attached: false, hand: 0, anchor: { x: 0, y: 0, z: 0 } };
  readonly zip = { tx: 0, ty: 0, tz: 0, ex: 0, ey: 0, ez: 0, hand: 0 };
  readonly wall = { nx: 0, nz: 0, run: 0 };
  readonly trav = { kind: 0, t: 0, dur: 0 };
  readonly combatAnim: CombatAnim = { action: CA.NONE, t0: -1e9, dur: 0, side: 0 };

  /** Interpolated feet position at the last frame. */
  readonly pos = new Vector3();
  readonly rig: CharacterRig;
  readonly animator: CharacterAnimator;
  readonly web = new WebLine();
  readonly buf = new InterpBuffer<RemoteSample>(OPS, 32);
  costume: CostumeId;
  /** Level of detail at the last frame: 0 full, 1 lite, 2 silhouette, 3 dot only; -1 no state yet. */
  lod = -1;
  /** In the camera frustum at the last frame. */
  inView = false;
  /** Room ms of the newest sample. */
  lastSampleMs = 0;
  /** Called for each event when it fires (audio, particles). */
  onEvent: ((r: RemotePlayer, e: PlayerEvent) => void) | null = null;

  private readonly cur = makeRemoteSample();
  private readonly incoming = makeRemoteSample();
  private readonly events: Array<{ at: number; e: PlayerEvent }> = [];
  private liteAcc = 0;
  private liteFrame = 0;
  private wasVisible = false;
  private readonly webState: WebLineState = { visible: false, progress: 1, from: new Vector3(), to: new Vector3(), slack: 0, tension: 1 };

  constructor(
    readonly pid: number,
    public name: string,
    costume: string,
    readonly world: CollisionWorld,
  ) {
    this.costume = isCostumeId(costume) ? costume : DEFAULT_COSTUME;
    this.rig = buildCharacter(this.costume);
    this.rig.mesh.visible = false;
    this.animator = new CharacterAnimator(this.rig, this);
  }

  setCostume(id: string): void {
    const c = isCostumeId(id) ? id : DEFAULT_COSTUME;
    if (c !== this.costume) {
      this.costume = c;
      setCostume(this.rig, c);
    }
  }

  groundBelow(x: number, y: number, z: number): number {
    return this.world.supportHeight(x, z, y + 0.6, 0).y;
  }

  /** A relayed state (the wire sample is reused by the caller: copied here). */
  push(s: HeroSample): void {
    const r = this.incoming;
    r.x = s.x;
    r.y = s.y;
    r.z = s.z;
    r.vx = s.vx;
    r.vy = s.vy;
    r.vz = s.vz;
    r.facing = s.facing;
    r.mode = s.mode;
    r.flags = s.flags;
    r.blocks = s.blocks;
    r.tp = s.tp;
    r.ax = s.ax;
    r.ay = s.ay;
    r.az = s.az;
    r.zx = s.zx;
    r.zy = s.zy;
    r.zz = s.zz;
    r.wnx = s.wnx;
    r.wnz = s.wnz;
    r.wrun = s.wrun;
    r.travKind = s.travKind;
    r.travT = s.travT;
    r.travDur = s.travDur;
    r.action = s.action;
    r.actionSide = s.actionSide;
    r.actionT0 = s.t / 1000 - s.actionT;
    r.actionDur = s.actionDur;
    if (!this.buf.push(s.t, r)) return;
    this.lastSampleMs = s.t;
    for (const e of s.events) if (this.events.length < 64) this.events.push({ at: s.t, e: toPlayerEvent(e) });
  }

  /**
   * Sample at `renderMs`, fire due events, pose (by level of detail) and
   * update the web line. Returns false while there is nothing to show.
   */
  frame(renderMs: number, dt: number, camera: PerspectiveCamera, night: number, inView: boolean): boolean {
    if (this.buf.sample(renderMs, this.cur) === INTERP_EMPTY) {
      this.rig.mesh.visible = false;
      this.web.group.visible = false;
      this.lod = -1;
      return false;
    }
    const c = this.cur;
    this.time = renderMs / 1000;
    this.pos.set(c.x, c.y, c.z);
    this.vel.set(c.vx, c.vy, c.vz);
    this.facing = c.facing;
    this.mode = c.mode;
    this.diving = (c.flags & HF.DIVING) !== 0;
    this.grounded = (c.flags & HF.GROUNDED) !== 0;
    const ropeOn = (c.flags & (HF.ROPE_ATTACHED | HF.ROPE_FIRING)) !== 0 && (c.blocks & HB.ANCHOR) !== 0;
    this.rope.attached = (c.flags & HF.ROPE_ATTACHED) !== 0;
    this.rope.hand = (c.flags & HF.HAND_RIGHT) !== 0 ? 1 : 0;
    this.rope.anchor.x = c.ax;
    this.rope.anchor.y = c.ay;
    this.rope.anchor.z = c.az;
    this.zip.tx = c.ax;
    this.zip.ty = c.ay;
    this.zip.tz = c.az;
    this.zip.ex = c.zx;
    this.zip.ey = c.zy;
    this.zip.ez = c.zz;
    this.zip.hand = this.rope.hand;
    this.wall.nx = c.wnx;
    this.wall.nz = c.wnz;
    this.wall.run = c.wrun;
    this.trav.kind = c.travKind;
    this.trav.t = c.travT;
    this.trav.dur = c.travDur;
    const ca = this.combatAnim;
    ca.action = c.action;
    ca.side = c.actionSide;
    ca.t0 = c.actionT0;
    ca.dur = c.actionDur;
    this.rollTimer = Math.max(0, this.rollTimer - dt);
    // Events due by now.
    let n = 0;
    for (const q of this.events) {
      if (q.at > renderMs) break;
      n++;
      if (q.e.type === 'land' && q.e.roll) this.rollTimer = tuning.ground.rollDuration;
      if (q.e.type === 'attach' || q.e.type === 'zipStart') this.web.attach(_v.set(q.e.x, q.e.y, q.e.z), q.e.type === 'attach' ? new Vector3(q.e.nx, q.e.ny, q.e.nz) : new Vector3(0, 1, 0));
      if (q.e.type === 'release') this.web.release();
      this.animator.onEvent(q.e);
      this.onEvent?.(this, q.e);
    }
    if (n) this.events.splice(0, n);

    // Level of detail.
    const d = camera.position.distanceTo(_v.set(c.x, c.y + 1, c.z));
    this.inView = inView;
    this.lod = d < LOD_FULL ? 0 : d < LOD_LITE ? 1 : d < LOD_SILHOUETTE ? 2 : 3;
    const showRig = this.lod <= 1 && inView;
    if (showRig && !this.wasVisible) this.animator.reset();
    this.wasVisible = showRig;
    this.rig.mesh.visible = showRig;
    if (showRig) {
      if (this.lod === 0) this.animator.update(dt, this.pos, this.facing);
      else {
        // Lite: pose every 3rd frame with the accumulated time.
        this.liteAcc += dt;
        if (++this.liteFrame % 3 === 0) {
          this.animator.update(this.liteAcc, this.pos, this.facing);
          this.liteAcc = 0;
        }
      }
    }
    // Web line (rope or zip), only where the rig is shown.
    const st = this.webState;
    st.visible = showRig && (ropeOn || this.mode === MODE_ZIP);
    if (st.visible) {
      const hand = this.animator.handPos[this.rope.hand]!;
      st.from.copy(hand);
      st.to.set(c.ax, c.ay, c.az);
      st.progress = 1;
      st.slack = 0;
      st.tension = this.mode === MODE_SWING || this.mode === MODE_ZIP ? 1 : 0.5;
    }
    this.web.group.visible = showRig;
    this.web.update(dt, camera.position, st, night);
    return true;
  }

  /** Web line drawn this frame (tests). */
  get webVisible(): boolean {
    return this.webState.visible;
  }

  dispose(): void {
    this.rig.mesh.removeFromParent();
    this.web.group.removeFromParent();
    this.rig.mesh.geometry.dispose();
    const m = this.rig.mesh.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose());
    else m.dispose();
  }
}

/** Wire events have exactly the PlayerEvent shapes. */
function toPlayerEvent(e: NetEvent): PlayerEvent {
  return e as PlayerEvent;
}
