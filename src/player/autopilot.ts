import { Vector3 } from 'three';
import { tuning } from '../config/tuning';
import { Rng } from '../core/rng';
import type { TickInput } from '../input/input';
import type { CollisionWorld } from '../physics/collision';
import type { CityLayout } from '../world/types';
import { MODE_AIR, MODE_GROUND, MODE_SWING, MODE_TRAVERSE, MODE_WALL, MODE_ZIP, type Player } from './player';
import { makeAnchorResult, type AnchorResult } from './targeting';

/**
 * Bot play shared by the test drivers and the menu autopilot: input levels,
 * crosshair aiming through the wide anchor search, and the swing brain that
 * holds the button through a swing and lets go on the rising arc. The
 * autopilot wanders the city on top of it (waypoints, pull lines, wall runs,
 * rooftop perches, stall recovery). Simulation only: no rendering imports.
 */

/** Input levels a bot holds for one tick; edges are derived from the previous levels. */
export interface BotInput {
  moveX: number;
  moveY: number;
  jump: boolean;
  sprint: boolean;
  dive: boolean;
  swing: boolean;
  zip: boolean;
  reel: number;
}

export function emptyBotInput(): BotInput {
  return { moveX: 0, moveY: 0, jump: false, sprint: false, dive: false, swing: false, zip: false, reel: 0 };
}

/** Bot levels to a tick snapshot (edges from the previous levels); the aim fields are left alone. */
export function fillTickInput(out: TickInput, inp: BotInput, prev: BotInput): void {
  out.moveX = inp.moveX;
  out.moveY = inp.moveY;
  out.jump = inp.jump;
  out.jumpPressed = inp.jump && !prev.jump;
  out.sprint = inp.sprint;
  out.groundSprint = false;
  out.dive = inp.dive;
  out.swing = inp.swing;
  out.swingPressed = inp.swing && !prev.swing;
  out.swingReleased = !inp.swing && prev.swing;
  out.zip = inp.zip;
  out.zipPressed = inp.zip && !prev.zip;
  out.reel = inp.reel;
}

/** The view a bot aims with: the gameplay camera rig, or the autopilot's own unrendered one. */
export interface AimRig {
  yaw: number;
  pitch: number;
  readonly position: Vector3;
  readonly fwd: Vector3;
  setLook(yaw: number, pitch: number): void;
  refreshPose(feet: Vector3): void;
}

/** A player and the view it aims with (the Game satisfies this too). */
export interface Pilot {
  readonly player: Player;
  readonly rig: AimRig;
}

/** Points the crosshair at (x, y, z) without advancing the camera follow; a few passes converge. */
export function aimAt(pilot: Pilot, x: number, y: number, z: number): void {
  const rig = pilot.rig;
  const feet = pilot.player.pos;
  for (let i = 0; i < 4; i++) {
    rig.refreshPose(feet);
    const c = rig.position;
    const dx = x - c.x,
      dy = y - c.y,
      dz = z - c.z;
    rig.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  }
  rig.refreshPose(feet);
}

/** The anchor a player would aim at next from the current view (wide search). */
export function planTarget(pilot: Pilot, mode: 0 | 1, out: AnchorResult): boolean {
  const pl = pilot.player;
  const r = pilot.rig;
  return pl.targeting.plan(mode, pl.pos.x, pl.pos.y, pl.pos.z, r.position.x, r.position.y, r.position.z, r.fwd.x, r.fwd.y, r.fwd.z, out);
}

/**
 * Aims at the planned anchor and presses the button for the next step (the
 * caller clears the press afterwards). Returns the view to restore after that
 * step so steering continues smoothly, or null when nothing is in view.
 */
export function aimForClick(pilot: Pilot, mode: 0 | 1, inp: BotInput, target: AnchorResult): [number, number] | null {
  if (!planTarget(pilot, mode, target)) return null;
  const view: [number, number] = [pilot.rig.yaw, pilot.rig.pitch];
  aimAt(pilot, target.x, target.y, target.z);
  if (mode === 0) inp.swing = true;
  else inp.zip = true;
  return view;
}

const DT = 1 / 120;

/** Where a route follower is: the current segment and the look-ahead point. */
export interface RouteTarget {
  seg: number;
  x: number;
  z: number;
}

/**
 * Route following shared by the bots: moves past segments the position has
 * (almost) finished, then returns the point `ahead` metres further along the
 * route, spilling into the next segment near a corner.
 */
export function routeTarget(route: ReadonlyArray<readonly [number, number]>, count: number, px: number, pz: number, ahead: number, out: RouteTarget): void {
  let seg = out.seg;
  while (seg < count - 1) {
    const a = route[seg]!,
      b = route[seg + 1]!;
    const abx = b[0] - a[0],
      abz = b[1] - a[1];
    const l2 = abx * abx + abz * abz;
    const t = ((px - a[0]) * abx + (pz - a[1]) * abz) / l2;
    if (t > 0.98) seg++;
    else break;
  }
  out.seg = seg;
  const a = route[seg]!,
    b = route[Math.min(count - 1, seg + 1)]!;
  const abx = b[0] - a[0],
    abz = b[1] - a[1];
  const ab = Math.hypot(abx, abz) || 1;
  const t = Math.max(0, ((px - a[0]) * abx + (pz - a[1]) * abz) / ab);
  let tx = a[0] + (abx / ab) * Math.min(ab, t + ahead);
  let tz = a[1] + (abz / ab) * Math.min(ab, t + ahead);
  if (t + ahead > ab && seg + 2 < count) {
    const c = route[seg + 2]!;
    const over = t + ahead - ab;
    const bcx = c[0] - b[0],
      bcz = c[1] - b[1];
    const bc = Math.hypot(bcx, bcz) || 1;
    tx = b[0] + (bcx / bc) * Math.min(bc, over);
    tz = b[1] + (bcz / bc) * Math.min(bc, over);
  }
  out.x = tx;
  out.z = tz;
}

/**
 * Swinging toward a point, one tick at a time: steer the view, hold the
 * button while on a line, let go on the rising arc (or past the anchor, or
 * after a while), and aim and press again once falling. On the ground it
 * runs, hops and keeps trying for a line. Per tick: `steer`, `choose`,
 * optional changes to `inp` / `fire`, `press`, run the tick, `after`.
 */
export class SwingBrain {
  readonly inp: BotInput = emptyBotInput();
  /** Levels of the previous tick (the caller's step copies `inp` here). */
  readonly prev: BotInput = emptyBotInput();
  readonly target: AnchorResult = makeAnchorResult();
  state: 'run' | 'swing' | 'fly' = 'run';
  stateT = 0;
  /** Press the swing button this tick (when the previous tick had it up). */
  fire = false;
  ticks = 0;
  swings = 0;
  goodReleases = 0;
  private lastTry = -99;
  private restore = false;
  private viewYaw = 0;
  private viewPitch = 0;

  constructor(private readonly pilot: Pilot) {}

  /** Turn the view a step toward (tx, tz) and toward a slightly raised pitch. */
  steer(tx: number, tz: number, pitchT = 0.34): void {
    const p = this.pilot.player.pos;
    const rig = this.pilot.rig;
    const yawTarget = Math.atan2(-(tx - p.x), -(tz - p.z));
    let dy = yawTarget - rig.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    rig.setLook(rig.yaw + dy * 0.08, rig.pitch + (pitchT - rig.pitch) * 0.1);
  }

  /** Movement levels and the swing state machine; sets `fire` when a new line is wanted. */
  choose(): void {
    const pl = this.pilot.player;
    const p = pl.pos;
    const inp = this.inp;
    inp.moveY = 1;
    inp.moveX = 0;
    inp.sprint = true;
    inp.jump = false;
    inp.dive = false;
    this.stateT += DT;
    const rope = pl.rope;
    this.fire = false;
    if (pl.mode === MODE_SWING) {
      if (this.state !== 'swing') {
        this.state = 'swing';
        this.stateT = 0;
        this.swings++;
      }
      inp.swing = true;
      const v = pl.vel;
      // Let go on the rising arc (visible cue), or when past the anchor, or after a while.
      const past = rope.attached && v.x * (rope.anchor.x - p.x) + v.z * (rope.anchor.z - p.z) < 0;
      // Swing angle from straight down: cut later on the arc when low (to gain height).
      const ax = p.x - rope.anchor.x,
        ay = p.y + tuning.body.ropeOffset - rope.anchor.y,
        az = p.z - rope.anchor.z;
      const ang = (Math.acos(Math.max(-1, Math.min(1, -ay / (Math.hypot(ax, ay, az) || 1)))) * 180) / Math.PI;
      const wantAngle = p.y < 30 ? 38 : 18;
      const goodNow = rope.goodWindow && ang >= wantAngle;
      if (rope.attached && (goodNow || (past && v.y > 0 && this.stateT > 0.8) || this.stateT > 3.2)) {
        if (rope.goodWindow) this.goodReleases++;
        inp.swing = false;
        this.state = 'fly';
        this.stateT = 0;
      }
    } else {
      inp.swing = false;
      if (this.state === 'swing') {
        this.state = 'fly';
        this.stateT = 0;
      }
      if (pl.mode === MODE_ZIP) {
        // A pull line in progress: a swing press would replace it.
        this.fire = false;
      } else if (this.state === 'fly') {
        // Re-attach once falling, or right away when close to the ground.
        this.fire = (pl.vel.y < -0.5 && this.stateT > 0.12) || (p.y < 4 && pl.vel.y < 2) || this.stateT > 1.4;
        if (pl.mode === MODE_GROUND) this.state = 'run';
      } else {
        // On the ground: run and try to swing.
        this.fire = true;
        inp.jump = this.ticks % 50 === 0;
      }
    }
  }

  /** Aim at the next anchor and press; retry every few ticks while nothing is in view. */
  press(): void {
    if (!this.fire || this.prev.swing || this.ticks - this.lastTry < 3) return;
    this.lastTry = this.ticks;
    this.pressAt(0);
  }

  /** Aim the planned anchor of `mode` (0 swing, 1 pull line) and press its button; false when nothing is in view. */
  pressAt(mode: 0 | 1): boolean {
    if (!planTarget(this.pilot, mode, this.target)) return false;
    this.keepView();
    aimAt(this.pilot, this.target.x, this.target.y, this.target.z);
    if (mode === 0) this.inp.swing = true;
    else this.inp.zip = true;
    return true;
  }

  /** Aim at an exact point and press the pull-line button. */
  pullAt(x: number, y: number, z: number): void {
    this.keepView();
    aimAt(this.pilot, x, y, z);
    this.inp.zip = true;
  }

  /** After the tick ran: restore the steering view an aimed press replaced. */
  after(): void {
    if (this.restore) {
      this.pilot.rig.setLook(this.viewYaw, this.viewPitch);
      this.restore = false;
    }
    this.ticks++;
  }

  private keepView(): void {
    if (this.restore) return;
    this.restore = true;
    this.viewYaw = this.pilot.rig.yaw;
    this.viewPitch = this.pilot.rig.pitch;
  }
}

// -----------------------------------------------------------------------------
// Autopilot: the hero behind the menus
// -----------------------------------------------------------------------------

export const WP_ROOF = 0;
export const WP_PARK = 1;
export const WP_WATERFRONT = 2;

export interface Waypoint {
  x: number;
  z: number;
  kind: number;
  /** Building id for roofs, -1 otherwise. */
  building: number;
  /** Roof height (roofs only). */
  roofY: number;
}

export interface AutopilotStats {
  legs: number;
  zips: number;
  wallRuns: number;
  dives: number;
  perches: number;
  perchTries: number;
  reroutes: number;
  rescues: number;
}

/** Waypoint kinds are picked with these weights (roof, park, waterfront). */
const KIND_WEIGHTS = [0.45, 0.25, 0.3];
const KINDS = [WP_ROOF, WP_PARK, WP_WATERFRONT];
/** Distance band (m) for the next waypoint. */
const LEG_MIN = 230;
const LEG_MAX = 720;
/** A waypoint counts as reached within this horizontal distance. */
const ARRIVE = 40;
const LOOK_AHEAD = 70;

/**
 * Plays the hero on its own: picks waypoints on roofs, in the park and along
 * the waterfront (never over water), swings there with the swing brain, and
 * mixes in pull lines, wall runs, dives and rooftop perches. Stalls are
 * caught by a progress check (new waypoint, then a hop and a pull line, then
 * a move to a nearby roof as a last resort).
 */
export class Autopilot {
  readonly brain: SwingBrain;
  readonly waypoints: Waypoint[] = [];
  /** Waypoints by kind (roof, park, waterfront). */
  private readonly byKind: Waypoint[][] = [[], [], []];
  readonly goal: Waypoint = { x: 0, z: 0, kind: WP_PARK, building: -1, roofY: 0 };
  /** Standing on a roof on purpose (the camera orbits). */
  perching = false;
  /** Rescue teleports so far (the attract mode treats each as a camera cut). */
  teleports = 0;
  readonly stats: AutopilotStats = { legs: 0, zips: 0, wallRuns: 0, dives: 0, perches: 0, perchTries: 0, reroutes: 0, rescues: 0 };
  private readonly rng: Rng;
  /** The leg to the goal along avenues and streets (up to 7 points with pond detours) and where the hero is on it. */
  private readonly route: Array<[number, number]> = [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  private routeN = 0;
  private readonly follow: RouteTarget = { seg: 0, x: 0, z: 0 };
  /** Hold Shift on the next wall touched (a wall run); otherwise walls are only brushed. */
  private wallRunNext = false;
  private perchPlan = false;
  private perchT = 0;
  private perchLen = 0;
  private perchTryAt = -99;
  private perchMisses = 0;
  /** Seconds on the current leg. */
  private legT = 0;
  private wallT = 0;
  private wallLen = 0;
  private diveT = 0;
  /** Seconds hanging almost still on a line (pressed into a wall or a corner). */
  private slowSwingT = 0;
  private zipNext = false;
  private unstick = false;
  private lastState: SwingBrain['state'] = 'run';
  private readonly progress = new Vector3();
  private progressT = 0;
  private groundT = 0;
  private readonly spot = new Vector3();

  constructor(
    private readonly pilot: Pilot,
    private readonly layout: CityLayout,
    private readonly world: CollisionWorld,
    seed: number,
  ) {
    this.brain = new SwingBrain(pilot);
    this.rng = new Rng(seed ^ 0x5eed);
    this.buildWaypoints();
  }

  /** Start on a random roof with a fresh goal, looking toward it. */
  reset(): void {
    const pl = this.pilot.player;
    const roofs = this.waypoints.filter((w) => w.kind === WP_ROOF);
    const start = roofs.length > 0 ? this.rng.pick(roofs) : this.waypoints[0]!;
    if (!pl.findSafeSpot(start.x, start.kind === WP_ROOF ? start.roofY + 1 : 0.5, start.z, this.spot)) {
      const s = this.layout.spawn;
      this.spot.set(s[0], s[1], s[2]);
    }
    pl.teleport(this.spot.x, this.spot.y, this.spot.z);
    this.perching = false;
    this.perchPlan = false;
    this.wallLen = 0;
    this.diveT = 0;
    this.zipNext = false;
    this.unstick = false;
    const b = this.brain;
    Object.assign(b.inp, emptyBotInput());
    Object.assign(b.prev, emptyBotInput());
    b.state = 'run';
    b.stateT = 0;
    this.lastState = 'run';
    this.pickGoal();
    const p = pl.pos;
    this.pilot.rig.setLook(Math.atan2(-(this.goal.x - p.x), -(this.goal.z - p.z)), 0.2);
    this.progress.copy(p);
    this.progressT = 0;
    this.groundT = 0;
  }

  /** Choose this tick's input (the caller runs the tick, copies the levels to `brain.prev` and calls `after`). */
  decide(): void {
    const pl = this.pilot.player;
    const p = pl.pos;
    const b = this.brain;
    const inp = b.inp;
    if (this.perching) {
      this.perchStep();
      return;
    }
    // Landed on a roof while heading for a perch (the goal roof, or one the pull line reached first): stay a while.
    if (this.perchPlan && pl.mode === MODE_GROUND && this.onRoof(-1)) {
      this.perching = true;
      this.perchPlan = false;
      this.perchT = 0;
      this.perchLen = this.rng.range(5, 8);
      this.stats.perches++;
      this.perchStep();
      return;
    }
    this.legT += DT;
    // A perch goal stays until the hero lands on it or the tries run out.
    if (this.perchPlan && this.legT > 45) this.perchPlan = false;
    if (!this.perchPlan && Math.hypot(p.x - this.goal.x, p.z - this.goal.z) < ARRIVE) {
      this.stats.legs++;
      this.pickGoal();
    }
    // Steer toward a point 70 m ahead on the route (avenues and streets, like a player would).
    routeTarget(this.route, this.routeN, p.x, p.z, LOOK_AHEAD, this.follow);
    b.steer(this.follow.x, this.follow.z);
    b.choose();
    // The release just happened: decide whether the next line is a pull line, and the next wall a wall run.
    if (this.lastState === 'swing' && b.state === 'fly') {
      this.zipNext = this.rng.chance(0.18);
      this.wallRunNext = this.rng.chance(0.2);
    }
    this.lastState = b.state;
    inp.zip = false;
    // Hanging still on a line (snagged on a wall or in a corner): let go and look for another.
    this.slowSwingT = pl.mode === MODE_SWING && pl.speed < 3 && b.stateT > 0.5 ? this.slowSwingT + DT : 0;
    if (this.slowSwingT > 0.6) {
      inp.swing = false;
      b.state = 'fly';
      b.stateT = 0;
      this.slowSwingT = 0;
    }
    // Shift on the ground is a sprint; in the air it would cling to every wall brushed.
    inp.sprint = pl.mode === MODE_GROUND || pl.mode === MODE_WALL || this.wallRunNext;

    if (pl.mode === MODE_WALL) {
      // Wall run: climb a little before jumping off.
      if (this.wallLen === 0) {
        this.wallLen = this.rng.range(0.5, 1.6);
        this.wallT = 0;
        this.stats.wallRuns++;
      }
      this.wallT += DT;
      this.wallRunNext = false;
      b.fire = false;
      if (this.wallT > this.wallLen) inp.jump = true;
    } else this.wallLen = 0;

    // Dive from high up now and then before the next line.
    if (this.diveT > 0) {
      this.diveT -= DT;
      inp.dive = true;
      b.fire = b.fire && this.diveT <= 0;
    } else if (b.fire && b.state === 'fly' && p.y > 50 && pl.vel.y < -2 && this.rng.chance(0.004)) {
      this.diveT = 0.7;
      this.stats.dives++;
      b.fire = false;
    }

    if (this.unstick && pl.mode === MODE_GROUND) {
      // Stalled on the ground: hop and pull out.
      inp.jump = true;
      if (b.pressAt(1)) this.stats.zips++;
      this.unstick = false;
      b.fire = false;
    } else if (this.perchPlan && pl.mode !== MODE_SWING && this.aboveGoalRoof()) {
      // Over the goal roof: drop onto it.
      b.fire = false;
    } else if (this.perchPlan && pl.mode !== MODE_ZIP && pl.mode !== MODE_TRAVERSE && b.ticks - this.perchTryAt > 60 && this.tryPerch()) {
      b.fire = false;
      inp.swing = false;
    } else if (b.fire && this.zipNext && !b.prev.swing && pl.zipCooldown <= 0 && pl.mode !== MODE_GROUND) {
      this.zipNext = false;
      if (planTarget(this.pilot, 1, b.target) && this.ahead(b.target.x, b.target.z, 18)) {
        b.pressAt(1);
        this.stats.zips++;
        b.fire = false;
      }
    }
    // Falling toward water (the pond, the river): grab the next line now, or pull out to the shore.
    if (pl.mode === MODE_AIR && pl.vel.y < 0 && p.y < 14 && !b.prev.swing && !b.prev.zip && this.overWaterAhead()) {
      if (!b.pressAt(0) && pl.zipCooldown <= 0 && b.pressAt(1)) this.stats.zips++;
      b.fire = false;
    }
    b.press();
  }

  /** Water under the hero or where it lands within about a second. */
  private overWaterAhead(): boolean {
    const pl = this.pilot.player;
    const t = this.world.terrain;
    const p = pl.pos;
    return t.isWater(p.x, p.z) || t.isWater(p.x + pl.vel.x, p.z + pl.vel.z);
  }

  /** After the tick: restore the view and track progress (stalls, rescues). */
  after(): void {
    this.brain.after();
    const pl = this.pilot.player;
    const p = pl.pos;
    if (this.perching) {
      this.progress.copy(p);
      this.progressT = 0;
      this.groundT = 0;
      return;
    }
    this.groundT = pl.mode === MODE_GROUND ? this.groundT + DT : 0;
    if (this.groundT > 2.2) {
      this.unstick = true;
      this.groundT = 0;
    }
    if (p.distanceToSquared(this.progress) > 16) {
      this.progress.copy(p);
      this.progressT = 0;
      return;
    }
    this.progressT += DT;
    if (this.progressT > 2 && this.progressT - DT <= 2) {
      // Little progress for 2 s: a new direction, and a hop with a pull line if on the ground.
      this.stats.reroutes++;
      this.pickGoal();
      this.unstick = true;
    } else if (this.progressT > 4.5) {
      // Last resort: move to a nearby roof (the menu camera cuts away).
      this.stats.rescues++;
      this.rescue();
    }
  }

  /** Standing still on a roof; after a while run on toward a new goal. */
  private perchStep(): void {
    const b = this.brain;
    const inp = b.inp;
    inp.moveX = 0;
    inp.moveY = 0;
    inp.jump = false;
    inp.sprint = false;
    inp.dive = false;
    inp.swing = false;
    inp.zip = false;
    inp.reel = 0;
    b.fire = false;
    this.perchT += DT;
    if (this.perchT > this.perchLen || this.pilot.player.mode !== MODE_GROUND) {
      this.perching = false;
      this.stats.legs++;
      this.pickGoal();
      b.state = 'run';
      b.stateT = 0;
    }
  }

  /** Pull line to just below the goal roof's edge (a mantle onto the roof) when in reach. */
  private tryPerch(): boolean {
    const pl = this.pilot.player;
    const p = pl.pos;
    const bld = this.layout.buildings[this.goal.building];
    if (!bld) {
      this.perchPlan = false;
      return false;
    }
    const v = bld.volumes[bld.volumes.length - 1]!;
    const cx = Math.max(v.minX, Math.min(v.maxX, p.x)),
      cz = Math.max(v.minZ, Math.min(v.maxZ, p.z));
    const d = Math.hypot(cx - p.x, cz - p.z);
    if (d < 6 || d > 62 || p.y < v.maxY - 40 || p.y > v.maxY + 20) return false;
    this.perchTryAt = this.brain.ticks;
    if (++this.perchMisses > 6) {
      // Too many misses on this roof: give up the perch.
      this.perchPlan = false;
      return false;
    }
    this.stats.perchTries++;
    // Aim a little inside the face so the ray meets the wall, 1 m under the top.
    const nx = (cx - p.x) / (d || 1),
      nz = (cz - p.z) / (d || 1);
    this.brain.pullAt(cx + nx * 0.2, v.maxY - 1, cz + nz * 0.2);
    this.stats.zips++;
    return true;
  }

  /** Inside the goal roof's footprint and above it. */
  private aboveGoalRoof(): boolean {
    const bld = this.layout.buildings[this.goal.building];
    if (!bld) return false;
    const v = bld.volumes[bld.volumes.length - 1]!;
    const p = this.pilot.player.pos;
    return p.x > v.minX + 1 && p.x < v.maxX - 1 && p.z > v.minZ + 1 && p.z < v.maxZ - 1 && p.y > v.maxY;
  }

  /** Standing on a roof of building `id` (any building when -1), well above the street. */
  private onRoof(id: number): boolean {
    const p = this.pilot.player.pos;
    const s = this.world.supportHeight(p.x, p.z, p.y + 0.3, 0.2);
    if (s.id < 0 || Math.abs(s.y - p.y) > 0.25) return false;
    const owner = this.world.owner[s.id]!;
    if (owner < 0 || owner >= this.layout.buildings.length) return false;
    return (id < 0 || owner === id) && p.y - this.world.terrain.height(p.x, p.z) > 8;
  }

  /** True when (x, z) lies ahead of the travel direction and at least `min` metres away. */
  private ahead(x: number, z: number, min: number): boolean {
    const p = this.pilot.player.pos;
    const v = this.pilot.player.vel;
    const dx = x - p.x,
      dz = z - p.z;
    const d = Math.hypot(dx, dz);
    const hs = Math.hypot(v.x, v.z);
    if (d < min) return false;
    if (hs < 3) return true;
    return (dx * v.x + dz * v.z) / (d * hs) > 0.55;
  }

  private rescue(): void {
    const pl = this.pilot.player;
    const p = pl.pos;
    let best: Waypoint | null = null;
    let bestD = Infinity;
    for (const w of this.waypoints) {
      if (w.kind !== WP_ROOF) continue;
      const d = Math.hypot(w.x - p.x, w.z - p.z);
      if (d > 30 && d < bestD) {
        bestD = d;
        best = w;
      }
    }
    if (best && pl.findSafeSpot(best.x, best.roofY + 1, best.z, this.spot)) {
      pl.teleport(this.spot.x, this.spot.y, this.spot.z);
      this.teleports++;
    }
    this.progress.copy(pl.pos);
    this.progressT = 0;
    this.pickGoal();
  }

  /** Next waypoint: 230-720 m away, preferring ones that do not turn back. */
  private pickGoal(): void {
    const pl = this.pilot.player;
    const p = pl.pos;
    const hs = Math.hypot(pl.vel.x, pl.vel.z);
    const rng = this.rng;
    let pick: Waypoint | null = null;
    for (let tries = 0; tries < 60 && !pick; tries++) {
      const list = this.byKind[rng.weighted(KINDS, KIND_WEIGHTS)]!;
      if (list.length === 0) continue;
      const w = list[rng.int(0, list.length - 1)]!;
      const dx = w.x - p.x,
        dz = w.z - p.z;
      const d = Math.hypot(dx, dz);
      if ((d < LEG_MIN || d > LEG_MAX) && tries < 50) continue;
      if (hs > 6 && (dx * pl.vel.x + dz * pl.vel.z) / (d * hs) < -0.3 && tries < 30) continue;
      pick = w;
    }
    if (!pick) pick = this.waypoints[rng.int(0, this.waypoints.length - 1)]!;
    Object.assign(this.goal, pick);
    this.planRoute(rng.chance(0.5));
    this.perchPlan = pick.kind === WP_ROOF && rng.chance(0.4);
    this.perchMisses = 0;
    this.perchTryAt = -99;
    this.legT = 0;
  }

  /**
   * Route to the goal along the grid: over to the nearest avenue, along it to
   * the street nearest the goal and along that street (or streets first),
   * then in to the goal. Street canyons have anchors on both sides; the
   * waterfront drive is left out (water on one side).
   */
  private planRoute(avenueFirst: boolean): void {
    const p = this.pilot.player.pos;
    const g = this.goal;
    const L = this.layout;
    const near = (roads: CityLayout['avenues'], v: number): number => {
      let best = v,
        bd = Infinity;
      for (const r of roads) {
        if (r.perimeter) continue;
        const d = Math.abs(r.center - v);
        if (d < bd) {
          bd = d;
          best = r.center;
        }
      }
      return best;
    };
    let n = 0;
    const put = (x: number, z: number): void => {
      const prev = n > 0 ? this.route[n - 1]! : null;
      if (prev && Math.hypot(prev[0] - x, prev[1] - z) < 12) return;
      this.route[n]![0] = x;
      this.route[n]![1] = z;
      n++;
    };
    put(p.x, p.z);
    if (avenueFirst) {
      const ax = near(L.avenues, p.x),
        sz = near(L.streets, g.z);
      put(ax, p.z);
      put(ax, sz);
      put(g.x, sz);
    } else {
      const sz = near(L.streets, p.z),
        ax = near(L.avenues, g.x);
      put(p.x, sz);
      put(ax, sz);
      put(ax, g.z);
    }
    put(g.x, g.z);
    if (n < 2) {
      this.route[1]![0] = g.x + 1;
      this.route[1]![1] = g.z;
      n = 2;
    }
    this.routeN = n;
    this.avoidPond();
    this.follow.seg = 0;
  }

  /**
   * The park pond has nothing to swing from above it: a leg that would cross
   * it (with a margin) goes around its nearer side instead.
   */
  private avoidPond(): void {
    const pd = this.layout.pond;
    const rx = pd.rx + 30,
      rz = pd.rz + 30;
    const inside = (x: number, z: number): boolean => ((x - pd.cx) / rx) ** 2 + ((z - pd.cz) / rz) ** 2 < 1;
    for (let i = 0; i + 1 < this.routeN && this.routeN < this.route.length; i++) {
      const a = this.route[i]!,
        b = this.route[i + 1]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let hit = false;
      for (let k = 1, steps = Math.max(2, Math.ceil(len / 10)); k < steps && !hit; k++) {
        const t = k / steps;
        hit = inside(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      }
      if (!hit) continue;
      // Around the side that keeps the leg shortest: east or west for a north-south leg, else north or south.
      const ns = Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]);
      let bx = 0,
        bz = 0,
        best = Infinity;
      for (const sgn of [-1, 1]) {
        const x = ns ? pd.cx + sgn * (rx + 15) : (a[0] + b[0]) / 2;
        const z = ns ? (a[1] + b[1]) / 2 : pd.cz + sgn * (rz + 15);
        const d = Math.hypot(x - a[0], z - a[1]) + Math.hypot(b[0] - x, b[1] - z);
        if (d < best) {
          best = d;
          bx = x;
          bz = z;
        }
      }
      for (let j = this.routeN; j > i + 1; j--) {
        this.route[j]![0] = this.route[j - 1]![0];
        this.route[j]![1] = this.route[j - 1]![1];
      }
      this.route[i + 1]![0] = bx;
      this.route[i + 1]![1] = bz;
      this.routeN++;
      i++;
    }
  }

  private buildWaypoints(): void {
    const L = this.layout;
    const t = this.world.terrain;
    for (const b of L.buildings) {
      const v = b.volumes[b.volumes.length - 1]!;
      if (v.maxY < 22 || v.maxY > 170 || v.maxX - v.minX < 12 || v.maxZ - v.minZ < 12) continue;
      this.waypoints.push({ x: (v.minX + v.maxX) / 2, z: (v.minZ + v.maxZ) / 2, kind: WP_ROOF, building: b.id, roofY: v.maxY });
    }
    const P = L.park;
    for (let x = P.minX + 30; x < P.maxX - 20; x += 60) {
      for (let z = P.minZ + 30; z < P.maxZ - 20; z += 60) {
        // Not on or near the pond (nothing to swing from above the water).
        const pd = L.pond;
        const nearPond = ((x - pd.cx) / (pd.rx + 40)) ** 2 + ((z - pd.cz) / (pd.rz + 40)) ** 2 < 1;
        if (!t.isWater(x, z) && !nearPond) this.waypoints.push({ x, z, kind: WP_PARK, building: -1, roofY: 0 });
      }
    }
    // The waterfront: a ring 45 m inside the island's edge.
    const R = L.land;
    const inset = 45;
    const add = (x: number, z: number): void => {
      if (!t.isWater(x, z)) this.waypoints.push({ x, z, kind: WP_WATERFRONT, building: -1, roofY: 0 });
    };
    for (let x = R.minX + inset; x <= R.maxX - inset; x += 90) {
      add(x, R.minZ + inset);
      add(x, R.maxZ - inset);
    }
    for (let z = R.minZ + inset + 90; z <= R.maxZ - inset - 90; z += 90) {
      add(R.minX + inset, z);
      add(R.maxX - inset, z);
    }
    for (const w of this.waypoints) this.byKind[w.kind]!.push(w);
  }
}
