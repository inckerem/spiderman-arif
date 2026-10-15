import { Vector3 } from 'three';
import { Game } from './game';
import { UI, type HudState, type MinimapRing, type Settings } from './ui/ui';
import { AudioEngine, type AudioListenerState } from './audio/audio';
import { tr } from './i18n/tr';
import { clamp, smoothstep } from './core/math';
import { MODE_SWING, MODE_ZIP, type PlayerEvent } from './player/player';
import type { Action } from './input/bindings';
import { RooftopMoment } from './extras/rooftopMoment';
import { tuning } from './config/tuning';

export type AppState = 'loading' | 'menu' | 'playing' | 'paused' | 'photo';

const WATER_SAMPLES = 10;

/**
 * Application shell: owns the UI, the audio engine and the game, and runs
 * the screen flow loading -> main menu -> playing <-> paused / photo mode.
 * Pointer lock gates play; losing it (Esc, alt-tab) pauses.
 */
export class App {
  state: AppState = 'loading';
  readonly ui: UI;
  readonly audio: AudioEngine;
  game!: Game;
  /** Rings shown on the minimap (filled by the ring races). */
  minimapRings: MinimapRing[] = [];
  /** Per-frame HUD hook for ring races and other extras. */
  extraHud: ((hud: HudState) => void) | null = null;
  /** Standing still on a roof: night, rain and music (this client only). */
  moment!: RooftopMoment;
  private readonly hud: HudState = {
    speed: 0,
    altitude: 0,
    anchorValid: false,
    zipValid: false,
    anchorScreen: null,
    goodWindow: false,
    goodFlash: Infinity,
    ring: null,
    fps: null,
  };
  private readonly listener: AudioListenerState = {
    speed: 0,
    altitude: 0,
    parkFactor: 0,
    nightFactor: 0,
    waterFactor: 0,
    swinging: false,
    diving: false,
    paused: true,
    rain: 0,
  };
  private readonly ringHud: NonNullable<HudState['ring']> = { routeName: '', index: 0, total: 0, time: 0, best: null, finished: null };
  private readonly screenPt = { x: 0, y: 0 };
  private readonly proj = new Vector3();
  private fpsAvg = 60;
  private waterTimer = 0;
  private waterFactor = 0;
  private musicWarned = false;
  private warnTimer = 0;
  private photoReturn: 'playing' | 'paused' = 'playing';
  private photoTimePaused = false;

  constructor(private readonly canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.ui = new UI(uiRoot);
    this.audio = new AudioEngine(`${import.meta.env.BASE_URL}audio/theme.mp3`);
  }

  async boot(seed: number): Promise<void> {
    const ui = this.ui;
    this.game = new Game({ seed, canvas: this.canvas, onProgress: (f, label) => ui.setLoading(f, label) });
    const game = this.game;
    await game.init();
    ui.setLayout(game.layout);
    this.moment = new RooftopMoment(game);
    this.applySettings(ui.settings);
    this.wire();
    game.showMenu();
    game.playing = false;
    ui.hideLoading();
    ui.showMainMenu();
    this.state = 'menu';
    this.audio.setMenuMode(true);
    game.onFrame = (dt) => this.frame(dt);
    game.start();
  }

  private wire(): void {
    const ui = this.ui;
    const game = this.game;
    const audio = this.audio;
    ui.onPlay = () => this.play();
    ui.onResume = () => this.resume();
    ui.onMainMenu = () => this.toMainMenu();
    ui.onUiSound = (kind) => (kind === 'click' ? audio.uiClick() : audio.uiHover());
    ui.onSettingsChange = (s) => this.applySettings(s);
    game.onPlayerEvent = (e) => this.onEvent(e);
    game.rings.onEvent = (e) => {
      if (e.type === 'pass') audio.ringPass(e.index);
      else if (e.type === 'finish') audio.ringComplete();
    };
    game.animator.onFootstep = (f) => audio.footstep(f.surface, f.intensity);
    this.moment.onThunder = (closeness) => audio.thunder(closeness);
    // The moment's music starts from the top of the track.
    this.moment.onStart = () => audio.restartMusic();
    // Hour keys during the moment: the new hour wins over the restore.
    game.onHourKey = () => this.moment.takeHour();
    game.input.onLock((locked) => this.onLock(locked));
    // Audio may only start after a user gesture.
    const unlock = (): void => {
      audio.unlock();
      ui.notifyAudioUnlocked();
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    game.input.onAction((action, e) => this.onAction(action, e));
    window.addEventListener('keydown', (e) => this.onKey(e));
    this.canvas.addEventListener('click', () => {
      if (this.state === 'playing' || this.state === 'photo') game.input.requestLock();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });
  }

  // ------------------------------------------------------------------ flow

  /** A new game from the main menu: the hero starts at the spawn point (the attract hero stays behind the menu). */
  play(): void {
    const game = this.game;
    this.moment.cancel();
    this.moment.resetSpawn();
    this.ui.hideMenus();
    this.ui.setHudVisible(true);
    game.input.clearAll();
    game.startPlay();
    this.state = 'playing';
    this.audio.setMenuMode(false);
    this.audio.unlock();
    this.lockForPlay();
  }

  resume(): void {
    this.ui.hideMenus();
    this.ui.setHudVisible(true);
    this.state = 'playing';
    this.game.view = 'play';
    this.lockForPlay();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    const game = this.game;
    this.state = 'paused';
    game.playing = false;
    game.input.enabled = false;
    game.input.clearAll();
    this.ui.showClickToResume(false);
    this.ui.setHudVisible(false);
    this.ui.showPause();
  }

  toMainMenu(): void {
    const game = this.game;
    game.input.exitLock();
    game.playing = false;
    game.input.enabled = false;
    this.moment.cancel();
    this.ui.setCinematic(false);
    game.showMenu();
    this.state = 'menu';
    this.ui.setHudVisible(false);
    this.ui.showClickToResume(false);
    this.ui.showMainMenu();
    this.audio.setMenuMode(true);
  }

  /** Request pointer lock; play starts once it is granted (the click-to-resume hint covers refusals). */
  private lockForPlay(): void {
    const game = this.game;
    if (document.pointerLockElement === this.canvas) {
      this.onLock(true);
      return;
    }
    game.playing = false;
    game.input.enabled = false;
    this.ui.showClickToResume(true);
    game.input.requestLock();
  }

  private onLock(locked: boolean): void {
    const game = this.game;
    if (this.state === 'playing') {
      if (locked) {
        game.input.clearAll();
        game.input.enabled = true;
        game.playing = true;
        this.ui.showClickToResume(false);
      } else if (game.playing) {
        this.pause();
      }
    }
  }

  enterPhoto(): void {
    if (this.state !== 'playing' && this.state !== 'paused') return;
    const game = this.game;
    this.photoReturn = this.state;
    this.state = 'photo';
    game.playing = false;
    game.input.enabled = false;
    game.input.clearAll();
    this.photoTimePaused = game.dayNight.paused;
    game.dayNight.paused = true;
    game.beginPhoto();
    this.ui.hideMenus();
    this.ui.showClickToResume(false);
    // Where the time slider starts (5-minute steps).
    let sliderHour = (Math.round((game.dayNight.hour * 60) / 5) * 5) / 60;
    this.ui.showPhoto({
      fov: game.photoCam.fov,
      hour: game.dayNight.hour,
      onChange: (fov, hour) => {
        game.photoCam.fov = fov;
        // Only a moved time slider sets the hour (a FOV change leaves it alone);
        // during the rooftop moment the new hour wins over the restore.
        if (Math.abs(hour - sliderHour) > 1e-6) {
          sliderHour = hour;
          this.moment.takeHour();
          game.dayNight.setHour(hour);
        }
      },
      onSave: () => {
        game.savePhoto();
        this.audio.photoShutter();
      },
      onExit: () => this.exitPhoto(),
    });
  }

  exitPhoto(): void {
    if (this.state !== 'photo') return;
    const game = this.game;
    this.ui.hidePhoto();
    game.dayNight.paused = this.photoTimePaused;
    game.view = 'play';
    if (this.photoReturn === 'paused') {
      this.state = 'playing';
      this.pause();
    } else {
      this.state = 'playing';
      this.ui.setHudVisible(true);
      this.lockForPlay();
    }
  }

  /** Hotkeys bound in the settings: music, photo mode and the day-night pause. */
  private onAction(action: Action, e: KeyboardEvent | MouseEvent): void {
    if (this.state === 'loading') return;
    // A focused slider keeps its keys; only the music and photo toggles pass through.
    if (e.target instanceof HTMLInputElement && action !== 'photo' && action !== 'music') return;
    const game = this.game;
    switch (action) {
      case 'music': {
        const muted = this.audio.toggleMusic();
        this.ui.toast(muted ? tr.hud.musicOff : tr.hud.musicOn);
        break;
      }
      case 'photo':
        if (this.state === 'photo') this.exitPhoto();
        else this.enterPhoto();
        break;
      case 'timePause':
        if (this.state === 'playing') {
          game.dayNight.paused = !game.dayNight.paused;
          this.ui.toast(game.dayNight.paused ? tr.hud.timePaused : tr.hud.timeRunning);
        }
        break;
      default:
        break;
    }
  }

  /** Esc is fixed: the browser also uses it to release the pointer lock. */
  private onKey(e: KeyboardEvent): void {
    if (e.repeat || this.state === 'loading' || e.code !== 'Escape' || e.target instanceof HTMLInputElement) return;
    // Esc while locked is consumed by the browser (lock loss pauses); this
    // covers play without a lock and closing the pause menu.
    if (this.state === 'playing' && document.pointerLockElement !== this.canvas) this.pause();
    else if (this.state === 'paused' && this.ui.menuOpen) this.resume();
  }

  // ------------------------------------------------------------- settings

  applySettings(s: Settings): void {
    const game = this.game;
    if (!game || !game.post) return;
    if (game.qualityIndex !== s.quality) game.applyQuality(s.quality);
    game.renderScale = s.renderScale;
    game.post.settings.dynamicResolution = s.dynamicResolution;
    game.resize();
    game.rig.fovOffset = s.fovOffset;
    game.rig.sensitivity = s.sensitivity;
    game.rig.invertY = s.invertY;
    game.rig.autoFollow = s.cameraFollow;
    game.dayNight.dayLengthMinutes = s.dayLengthMinutes;
    game.input.setBindings(s.bindings);
    game.setCostume(s.costume);
    this.audio.setVolumes(s.masterVolume, s.musicVolume, s.sfxVolume);
  }

  // ---------------------------------------------------------------- events

  private onEvent(e: PlayerEvent): void {
    const a = this.audio;
    const pl = this.game.player;
    switch (e.type) {
      case 'webFire':
        a.webShot(e.hand === 0 ? -0.6 : 0.6);
        break;
      case 'attach':
        a.attach(clamp(pl.speed / 40, 0.2, 1));
        break;
      case 'release':
        a.release(e.good);
        break;
      case 'zipStart':
        a.zipStart();
        break;
      case 'zipEnd':
        a.zipEnd();
        break;
      case 'jump':
      case 'wallJump':
        a.jump();
        break;
      case 'boost':
        a.boost();
        break;
      case 'dive':
        a.dive();
        break;
      case 'vault':
      case 'mantle':
        a.vault();
        break;
      case 'land':
        a.land(e.impact, e.surface);
        if (e.roll) a.roll();
        break;
      case 'wallGrab':
        a.wallGrab(e.surface);
        break;
      case 'splash':
        a.splash();
        break;
      case 'respawn':
        this.moment.resetSpawn();
        break;
      default:
        break;
    }
  }

  // ----------------------------------------------------------------- frame

  private frame(dt: number): void {
    const game = this.game;
    const pl = game.player;
    const ui = this.ui;
    // Rooftop moment (holds still while paused, in photo mode or waiting for the pointer lock).
    const moment = this.moment;
    moment.update(dt, this.state === 'playing' && game.playing);
    ui.setCinematic(moment.cine);
    // Music plays in the menus and in the rooftop moment only.
    const M = tuning.moment;
    const music = this.state === 'menu' ? 1 : moment.music;
    this.audio.setMusicPresence(music, music > this.audio.musicPresence ? (this.state === 'menu' ? 1 : M.musicInSeconds) : this.state === 'playing' && moment.running ? M.musicOutSeconds : 1);
    if (dt > 0) this.fpsAvg += (1 / Math.max(1e-3, dt) - this.fpsAvg) * Math.min(1, dt * 2);
    const hud = this.hud;
    hud.fps = ui.settings.showFps ? this.fpsAvg : null;
    if (this.state === 'playing' || this.state === 'paused') {
      hud.speed = pl.speed;
      hud.altitude = Math.max(0, pl.pos.y);
      const rope = pl.rope;
      const t = rope.attached || rope.firing ? rope.anchor : pl.swingTarget;
      hud.anchorValid = pl.swingTarget.valid || rope.attached;
      hud.zipValid = pl.zipTarget.valid;
      hud.anchorScreen = t.valid ? this.toScreen(t.x, t.y, t.z) : null;
      hud.goodWindow = rope.attached && rope.goodWindow;
      hud.goodFlash = pl.goodReleaseFlash;
      const rh = game.rings.hud();
      if (rh) {
        const r = this.ringHud;
        r.routeName = tr.routes[game.rings.routeId(rh.route)];
        r.index = rh.index;
        r.total = rh.total;
        r.time = rh.time;
        r.best = rh.best;
        r.finished = rh.finished;
        hud.ring = r;
      } else hud.ring = null;
      game.rings.markers(this.minimapRings);
      this.extraHud?.(hud);
      ui.updateMinimap(pl.pos.x, pl.pos.z, game.rig.yaw, this.minimapRings);
    }
    ui.updateHud(hud);
    // Audio listener: the hero on screen (in the menu, the attract hero).
    const L = this.listener;
    const ap = this.state === 'menu' ? game.attract.player : pl;
    const P = game.layout.park;
    const dx = Math.max(P.minX - ap.pos.x, 0, ap.pos.x - P.maxX);
    const dz = Math.max(P.minZ - ap.pos.z, 0, ap.pos.z - P.maxZ);
    this.waterTimer -= dt;
    if (this.waterTimer <= 0) {
      this.waterTimer = 0.3;
      let n = 0;
      const t = game.world.terrain;
      for (let i = 0; i < WATER_SAMPLES; i++) {
        const a = (i / WATER_SAMPLES) * Math.PI * 2;
        if (t.isWater(ap.pos.x + Math.cos(a) * 70, ap.pos.z + Math.sin(a) * 70)) n++;
      }
      this.waterFactor = clamp((n / WATER_SAMPLES) * 2, 0, 1);
    }
    const ground = ap.groundBelow(ap.pos.x, ap.pos.y, ap.pos.z);
    L.speed = this.state === 'menu' ? 0 : ap.speed;
    L.altitude = Math.max(0, ap.pos.y - (ground > -1e6 ? ground : 0));
    L.parkFactor = 1 - smoothstep(0, 90, Math.hypot(dx, dz));
    L.nightFactor = game.dayNight.night;
    L.waterFactor = this.waterFactor;
    L.swinging = ap.mode === MODE_SWING || ap.mode === MODE_ZIP;
    L.diving = ap.diving;
    L.paused = this.state !== 'playing' || !game.playing;
    L.rain = game.weather.rain;
    this.audio.update(dt, L);
    // A missing music file is reported once, the game continues silently.
    this.warnTimer -= dt;
    if (!this.musicWarned && this.warnTimer <= 0) {
      this.warnTimer = 1;
      const info = this.audio.getDebugInfo();
      if (info.musicError) {
        this.musicWarned = true;
        ui.toast(tr.warnings.musicMissing);
      }
    }
  }

  private toScreen(x: number, y: number, z: number): { x: number; y: number } | null {
    const v = this.proj.set(x, y, z).project(this.game.rig.camera);
    if (v.z > 1 || v.z < -1) return null;
    this.screenPt.x = (v.x * 0.5 + 0.5) * window.innerWidth;
    this.screenPt.y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    return this.screenPt;
  }
}
