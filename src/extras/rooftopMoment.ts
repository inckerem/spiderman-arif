import { tuning } from '../config/tuning';
import { clamp, smoothstep } from '../core/math';
import { Rng } from '../core/rng';
import type { Game } from '../game';
import { MODE_GROUND, MODE_SWING, MODE_ZIP } from '../player/player';

export type MomentPhase = 'idle' | 'arming' | 'in' | 'active' | 'out';

/**
 * The rooftop moment. Standing still on a roof for a few seconds (no movement
 * or action input, no ring race running) starts it: the music fades in, the
 * sky runs through dusk to night, then rain sets in with a darker, wetter
 * grade, overcast and lightning; the HUD gives way to letterbox bars and the
 * camera orbits the perched hero. Any key, mouse button, wheel, touch or a
 * deliberate mouse movement ends it (the music toggle and photo mode keys do
 * not), and everything eases back: rain off, the hour back to where it was,
 * the HUD and the gameplay camera.
 *
 * It only changes this client's look and sound: the hour override, weather,
 * camera and HUD state live here and in the renderer, never in the
 * simulation, so a shared clock (multiplayer) only has to resume after it.
 * The app calls `update` once per frame; while paused or in photo mode
 * (`live` false) everything holds still.
 *
 * It arms only after the player has played a while since the last spawn,
 * respawn or new game (`minPlaySeconds`) and has moved (walked
 * `minTravel` metres or used a line): the game starts on a roof, and a new
 * player reading the controls should not get it right away. An explicit
 * hour change during the moment or its way out (hour keys, the photo time
 * slider, fast-forward) wins: the saved hour is not restored.
 */
export class RooftopMoment {
  phase: MomentPhase = 'idle';
  /** Seconds standing still on a roof so far. */
  idleT = 0;
  /** The hour before the moment; restored at the end. */
  savedHour = 0;
  /** Music wanted (0 or 1); the app fades the music bus. */
  music = 0;
  /** HUD hidden and letterbox bars in. */
  cine = false;
  readonly stats = { starts: 0, ends: 0, bolts: 0 };
  /** Thunder after a lightning flash (closeness 0..1). */
  onThunder: ((closeness: number) => void) | null = null;
  /** Online (M12): the hour to return to is the room's current hour, not the saved one. */
  restoreHour: (() => number) | null = null;
  /** The moment begins (the app restarts the music from the top). */
  onStart: (() => void) | null = null;
  /** Live play since the last spawn, respawn or new game (s), distance walked or flown (m), a line used. */
  sinceSpawn = 0;
  travelled = 0;
  usedLine = false;
  /** The player set the hour during the moment: it is not restored. */
  hourTaken = false;
  /** Combat (M11): while this returns true (enemies engaged or an event close by) the moment does not arm. */
  blocked: (() => boolean) | null = null;
  private t = 0;
  /** Signed hours from the saved hour to night, and the share of it reached. */
  private span = 0;
  private hourK = 0;
  private outFrom = 0;
  private rainFrom = 0;
  private moodFrom = 0;
  private orbitFrom = 0;
  private seen = 0;
  private boltT = 0;
  private flashT = -1;
  private thunderT = -1;
  private thunderClose = 0;
  private readonly rng = new Rng(0x12a1);

  constructor(private readonly game: Game) {
    this.seen = game.input.activity;
  }

  /** Running (fading in, held or fading out). */
  get running(): boolean {
    return this.phase === 'in' || this.phase === 'active' || this.phase === 'out';
  }

  update(dt: number, live: boolean): void {
    const act = this.game.input.activity;
    const touched = act !== this.seen;
    this.seen = act;
    if (!live) {
      // Paused, photo mode, waiting for the pointer lock: hold everything; arming starts over.
      if (this.phase === 'arming') this.phase = 'idle';
      if (this.phase === 'idle') this.idleT = 0;
      // A flash in progress never freezes into the pause background or a photo.
      this.flashT = -1;
      this.game.weather.flash = 0;
      return;
    }
    const pl = this.game.player;
    this.sinceSpawn += dt;
    this.travelled += pl.speed * dt;
    if (pl.mode === MODE_SWING || pl.mode === MODE_ZIP) this.usedLine = true;
    // Fast-forward during the moment or its way out takes the hour over.
    if (this.running && this.game.timeFast) this.takeHour();
    switch (this.phase) {
      case 'idle':
      case 'arming':
        if (touched || !this.ready || !this.stillOnRoof() || this.blocked?.()) {
          this.phase = 'idle';
          this.idleT = 0;
          break;
        }
        this.phase = 'arming';
        this.idleT += dt;
        if (this.idleT >= tuning.moment.idleSeconds) this.begin();
        break;
      case 'in':
      case 'active':
        if (touched) this.end();
        else {
          this.t += dt;
          this.drive(dt);
        }
        break;
      case 'out':
        this.t += dt;
        this.driveOut(dt);
        break;
    }
  }

  private restoreBase(): number {
    return this.restoreHour ? this.restoreHour() : this.savedHour;
  }

  /** Ends at once, restoring everything (leaving to the main menu, a new game). */
  cancel(): void {
    if (this.running) {
      if (!this.hourTaken) this.game.dayNight.setHour(this.restoreBase());
      this.finish();
    }
    this.phase = 'idle';
    this.idleT = 0;
  }

  /** A spawn, respawn or new game: the player has to play and move again before it can arm. */
  resetSpawn(): void {
    this.sinceSpawn = 0;
    this.travelled = 0;
    this.usedLine = false;
    if (this.phase === 'arming') this.phase = 'idle';
    this.idleT = 0;
  }

  /** Combat ends a running moment (a hit, an enemy engaging, an event starting close by): it eases out as after an input. */
  interrupt(): void {
    if (this.phase === 'in' || this.phase === 'active') this.end();
  }

  /** Played long enough since the last spawn and moved. */
  get ready(): boolean {
    const M = tuning.moment;
    return this.sinceSpawn >= M.minPlaySeconds && (this.travelled >= M.minTravel || this.usedLine);
  }

  /**
   * The player set the hour (hour keys, photo time slider, fast-forward)
   * during the moment or its way out: that hour wins. The moment stops
   * driving the hour, the clock runs again and the end restores nothing.
   */
  takeHour(): void {
    if (!this.running) return;
    this.hourTaken = true;
    this.game.dayNight.hold = false;
  }

  /** Standing still on a building roof well above the street, with no input held and no race running. */
  stillOnRoof(): boolean {
    const g = this.game;
    const pl = g.player;
    const ti = g.tickInput;
    if (g.rings.activeRoute >= 0 || g.timeFast) return false;
    if (pl.mode !== MODE_GROUND || pl.speed > 0.3) return false;
    if (ti.moveX !== 0 || ti.moveY !== 0 || ti.jump || ti.swing || ti.zip || ti.sprint || ti.dive) return false;
    const p = pl.pos;
    const w = g.world;
    const s = w.supportHeight(p.x, p.z, p.y + 0.3, 0.2);
    if (s.id < 0 || Math.abs(s.y - p.y) > 0.25) return false;
    const owner = w.owner[s.id]!;
    if (owner < 0 || owner >= g.layout.buildings.length) return false;
    return p.y - w.terrain.height(p.x, p.z) >= tuning.moment.minRoofHeight;
  }

  private begin(): void {
    const M = tuning.moment;
    const dn = this.game.dayNight;
    this.phase = 'in';
    this.t = 0;
    this.hourK = 0;
    this.savedHour = dn.hour;
    this.hourTaken = false;
    dn.hold = true;
    const h = dn.hour;
    // Already night: stay. Morning: back through dawn to the small hours. Otherwise forward through dusk.
    if (h >= 20.6 || h < 4.5) this.span = 0;
    else if (h < 9.5) this.span = M.dawnNightHour - h;
    else this.span = (M.nightHour - h + 24) % 24;
    this.music = 1;
    this.cine = true;
    this.boltT = this.rng.range(M.boltMin * 0.5, M.boltMax * 0.5);
    this.flashT = -1;
    this.thunderT = -1;
    this.stats.starts++;
    this.onStart?.();
  }

  private drive(dt: number): void {
    const M = tuning.moment;
    const g = this.game;
    const t = this.t;
    this.hourK = this.span === 0 ? 1 : smoothstep(0, 1, clamp(t / M.toNightSeconds, 0, 1));
    if (!this.hourTaken) g.dayNight.setHour(this.savedHour + this.span * this.hourK);
    const rainStart = M.toNightSeconds * 0.85;
    g.weather.rain = clamp((t - rainStart) / M.rainInSeconds, 0, 1);
    g.weather.mood = smoothstep(0, 1, clamp((t - M.toNightSeconds * 0.5) / (M.rainInSeconds + M.toNightSeconds * 0.5), 0, 1));
    g.cineOrbit = smoothstep(0, 1, clamp(t / M.orbitInSeconds, 0, 1));
    g.animator.perch = 1;
    if (this.phase === 'in' && t >= M.toNightSeconds + M.rainInSeconds) this.phase = 'active';
    // Lightning once the rain is in: a double flicker, thunder a moment later.
    if (g.weather.rain > 0.8) {
      this.boltT -= dt;
      if (this.boltT <= 0) {
        this.boltT = this.rng.range(M.boltMin, M.boltMax);
        this.flashT = 0;
        this.thunderClose = this.rng.float();
        this.thunderT = 0.4 + (1 - this.thunderClose) * 2.2;
        this.stats.bolts++;
      }
    }
    this.lightning(dt);
  }

  private end(): void {
    const g = this.game;
    this.phase = 'out';
    this.t = 0;
    this.outFrom = this.span * this.hourK;
    this.rainFrom = g.weather.rain;
    this.moodFrom = g.weather.mood;
    this.orbitFrom = g.cineOrbit;
    this.music = 0;
    this.cine = false;
    g.animator.perch = 0;
    this.stats.ends++;
  }

  private driveOut(dt: number): void {
    const M = tuning.moment;
    const g = this.game;
    const t = this.t;
    const back = smoothstep(0, 1, clamp(t / M.hourBackSeconds, 0, 1));
    if (!this.hourTaken) g.dayNight.setHour(this.restoreBase() + this.outFrom * (1 - back));
    g.weather.rain = this.rainFrom * (1 - clamp(t / M.rainOutSeconds, 0, 1));
    g.weather.mood = this.moodFrom * (1 - back);
    g.cineOrbit = this.orbitFrom * (1 - smoothstep(0, 1, clamp(t / M.orbitOutSeconds, 0, 1)));
    this.thunderT = -1;
    this.lightning(dt);
    if (t >= Math.max(M.hourBackSeconds, M.rainOutSeconds, M.orbitOutSeconds)) {
      if (!this.hourTaken) g.dayNight.setHour(this.restoreBase());
      this.finish();
      this.phase = 'idle';
      this.idleT = 0;
    }
  }

  /** Flash envelope (two flickers and a fade) and the delayed thunder. */
  private lightning(dt: number): void {
    const g = this.game;
    if (this.flashT >= 0) {
      this.flashT += dt;
      const f = this.flashT;
      g.weather.flash = f < 0.06 ? 1 : f < 0.12 ? 0.15 : f < 0.19 ? 0.75 : Math.max(0, 0.75 * (1 - (f - 0.19) / 0.4));
      if (f > 0.6) {
        this.flashT = -1;
        g.weather.flash = 0;
      }
    }
    if (this.thunderT >= 0) {
      this.thunderT -= dt;
      if (this.thunderT < 0) this.onThunder?.(this.thunderClose);
    }
  }

  private finish(): void {
    const g = this.game;
    g.dayNight.hold = false;
    g.weather.rain = 0;
    g.weather.mood = 0;
    g.weather.flash = 0;
    g.cineOrbit = 0;
    g.animator.perch = 0;
    this.music = 0;
    this.cine = false;
    this.flashT = -1;
    this.thunderT = -1;
  }
}
