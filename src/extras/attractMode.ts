import { Vector3, type PerspectiveCamera } from 'three';
import { tuning } from '../config/tuning';
import { CameraRig } from '../camera/cameraRig';
import { CinematicDirector, type ShotSubject } from '../camera/director';
import { CharacterAnimator } from '../character/animator';
import type { CharacterRig } from '../character/rig';
import { emptyTickInput, type TickInput } from '../input/input';
import type { CollisionWorld } from '../physics/collision';
import { Autopilot, fillTickInput } from '../player/autopilot';
import { Player, type PlayerEvent } from '../player/player';
import type { CityLayout } from '../world/types';

/**
 * Attract mode: the living background behind the main menu. An autopilot
 * plays its own Player (the real simulation, separate from the game's, so
 * nothing it does reaches play) and aims with its own unrendered camera rig;
 * a cinematic director films it with the game camera. It shares the hero
 * mesh, web line and particles with the game, so only one is shown at a time.
 */
export class AttractMode {
  player: Player;
  /** The autopilot's own view (aim origin and direction); never rendered. */
  rig: CameraRig;
  autopilot: Autopilot;
  animator: CharacterAnimator;
  director: CinematicDirector;
  readonly prevPos = new Vector3();
  readonly renderPos = new Vector3();
  /** Simulation events (web line and particle effects). */
  onEvent: ((e: PlayerEvent) => void) | null = null;
  private readonly tickInput: TickInput = emptyTickInput();
  private readonly subject: ShotSubject;
  private readonly lastFrame = new Vector3();
  private started = false;

  constructor(
    private readonly world: CollisionWorld,
    private readonly layout: CityLayout,
    private readonly hero: CharacterRig,
    seed: number,
  ) {
    this.player = new Player(world, layout);
    this.rig = new CameraRig(world, 16 / 9);
    this.rig.autoFollow = false;
    this.autopilot = new Autopilot(this, layout, world, seed);
    this.animator = new CharacterAnimator(hero, this.player);
    this.director = new CinematicDirector(world, seed);
    this.subject = { pos: this.renderPos, vel: this.player.vel, perching: false };
  }

  /** First start: a random roof, a fresh goal and a fresh shot. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.autopilot.reset();
    this.prevPos.copy(this.player.pos);
    this.renderPos.copy(this.player.pos);
    this.rig.snap();
    this.rig.update(1 / 120, { pos: this.player.pos, vel: this.player.vel, mode: this.player.mode });
    this.resume();
  }

  /**
   * Test hook: start over from a clean state, the same for a given seed (a
   * fresh player and animator, reseeded autopilot and director, a new roof).
   */
  restart(seed: number): void {
    this.player = new Player(this.world, this.layout);
    this.rig = new CameraRig(this.world, 16 / 9);
    this.rig.autoFollow = false;
    this.autopilot = new Autopilot(this, this.layout, this.world, seed);
    this.animator = new CharacterAnimator(this.hero, this.player);
    this.director = new CinematicDirector(this.world, seed);
    this.subject.vel = this.player.vel;
    this.started = false;
    this.start();
  }

  /** Back to the menu: the hero carries on where it was; the director starts with a new shot. */
  resume(): void {
    this.director.reset();
    this.animator.reset();
    this.lastFrame.copy(this.player.pos);
  }

  /** One fixed simulation tick of the autopilot. */
  tick(dt: number): void {
    if (!this.started) this.start();
    const pl = this.player;
    const ap = this.autopilot;
    const rig = this.rig;
    this.prevPos.copy(pl.pos);
    ap.decide();
    const t = this.tickInput;
    fillTickInput(t, ap.brain.inp, ap.brain.prev);
    t.yaw = rig.yaw;
    t.pitch = rig.pitch;
    t.aimOrigin.copy(rig.position);
    t.aimDir.copy(rig.fwd);
    pl.step(dt, t);
    Object.assign(ap.brain.prev, ap.brain.inp);
    for (const e of pl.events) {
      if (e.type === 'respawn' || e.type === 'recover') this.prevPos.copy(pl.pos);
      this.animator.onEvent(e);
      this.onEvent?.(e);
    }
    rig.update(dt, { pos: pl.pos, vel: pl.vel, mode: pl.mode });
    ap.after();
  }

  /** Per rendered frame: interpolated hero position and the cinematic camera. */
  frame(alpha: number, dt: number, cam: PerspectiveCamera): void {
    if (!this.started) this.start();
    const pl = this.player;
    this.renderPos.lerpVectors(this.prevPos, pl.pos, alpha);
    const off = pl.renderOffset;
    if (off.lengthSq() > 1e-8) {
      this.renderPos.add(off);
      off.multiplyScalar(Math.exp(-dt / Math.max(0.01, tuning.recovery.blendTime / 3)));
    }
    // A teleport (rescue, water respawn) is a cut, never a whip pan.
    if (this.renderPos.distanceToSquared(this.lastFrame) > 30 * 30) this.director.reset();
    this.lastFrame.copy(this.renderPos);
    this.subject.perching = this.autopilot.perching;
    this.animator.perch = this.autopilot.perching ? 1 : 0;
    this.director.update(dt, this.subject, cam);
  }
}
