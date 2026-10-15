/**
 * SKYTHREAD audio engine.
 *
 * Bus graph (created on the first user gesture, inside unlock()):
 *
 *   music loop instances -> musicTrim (normalisation) -> music bus --+
 *   one-shot voices --------------------------------------> sfx bus -+-> master -> limiter -> output
 *   wind layers -> wind duck ------------------------------> sfx bus |
 *   ambience layers + ambient one-shots -> ambience duck --> sfx bus |
 *   reverb sends -> convolver (procedural IR) -> return ---> sfx bus
 *
 * Before unlock() every method is a no-op, and no public method ever throws.
 * Every sound is synthesised (see sfx.ts and ambience.ts); the only file is
 * the music track fetched from the URL given to the constructor.
 */
import { Ambience, type AmbienceInput } from './ambience';
import { clamp, clamp01, follow, impulseJob, num } from './dsp';
import { Bank, Kit } from './kit';
import { MusicLoop } from './music';
import * as fx from './sfx';

export interface AudioListenerState {
  /** Player speed m/s (0..90). */
  speed: number;
  /** Metres above ground (0..300). */
  altitude: number;
  /** 0..1, player in/near the central park. */
  parkFactor: number;
  /** 0..1, 1 = full night. */
  nightFactor: number;
  /** 0..1, near the waterfront. */
  waterFactor: number;
  /** On a web line. */
  swinging: boolean;
  diving: boolean;
  /** Menus open: ambience/wind ducked, music keeps playing. */
  paused: boolean;
  /** 0..1, rain around the player (the rooftop moment). */
  rain: number;
}

export interface AudioDebugInfo {
  state: string;
  unlocked: boolean;
  musicLoaded: boolean;
  musicDuration: number;
  musicError: string | null;
  activeVoices: number;
  loopsScheduled: number;
  /** Target gain of the music bus (0 while no music is wanted, muted or at a zero slider). */
  musicLevel: number;
}

/** Concurrent one-shot voices before the least important ones are stolen. */
const MAX_VOICES = 28;
/** Music bus level at a full slider (the track itself is normalised to about -20 dBFS RMS). */
const MUSIC_LEVEL = 0.8;
/** SFX bus level at a full slider. */
const SFX_LEVEL = 1;
/** Pre-limiter trim that compensates the DynamicsCompressor's automatic make-up gain. */
const MASTER_TRIM = 0.88;
/** Ambience level while the game is paused under a menu. */
const PAUSE_DUCK = 0.3;
/** Reverb return level. */
const REVERB_RETURN = 0.9;
/** One-shots requested this soon after unlock() still play while the context finishes resuming (ms). */
const RESUME_GRACE_MS = 800;
/** Minimum spacing of hover ticks (ms). */
const HOVER_SPACING_MS = 35;

type AudioContextCtor = new () => AudioContext;

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  music: GainNode;
  sfx: GainNode;
  wind: GainNode;
  amb: GainNode;
  kit: Kit;
  bank: Bank;
  /** Receives its impulse response in a deferred build step (silent until then). */
  convolver: ConvolverNode | null;
  /** Created by the last deferred build step (null for the first few frames after unlock). */
  ambience: Ambience | null;
  loop: MusicLoop;
}

function findAudioContext(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext || w.webkitAudioContext || null;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/** Slider position (0..1) to gain: a square law, so the slider feels even across its travel. */
function perceptual(v: number): number {
  const x = clamp01(v);
  return x * x;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private graph: Graph | null = null;
  private unsupported = false;
  private muted = false;
  private menu = false;
  private paused = false;
  private hidden = false;
  private masterVol = 1;
  private musicVol = 1;
  private sfxVol = 1;
  /** Where music is wanted (0..1): the menus and the rooftop moment; silent in play otherwise. */
  private presence = 1;
  private presenceFade = 0.1;
  private unlockAt = Number.NEGATIVE_INFINITY;
  private hoverAt = Number.NEGATIVE_INFINITY;
  private warned = false;
  private readonly smooth: AmbienceInput = { speed: 0, alt: 0, park: 0, night: 0, water: 0, swing: 0, dive: 0, rain: 0 };

  constructor(private readonly musicUrl: string) {}

  /** True once the AudioContext exists and is running. */
  get unlocked(): boolean {
    try {
      return this.ctx !== null && this.ctx.state === 'running';
    } catch {
      return false;
    }
  }

  /** M key state; setting it fades the music bus over about 0.3 s. */
  get musicMuted(): boolean {
    return this.muted;
  }

  set musicMuted(value: boolean) {
    try {
      this.muted = !!value;
      this.applyMusic();
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * Called from a user-gesture handler (click/keydown). Creates the
   * AudioContext on the first call and starts loading the music; every call
   * resumes a suspended context. Idempotent.
   */
  unlock(): void {
    try {
      if (this.unsupported) return;
      if (!this.ctx) {
        const Ctor = findAudioContext();
        if (!Ctor) {
          this.unsupported = true;
          console.warn('[skythread] audio: Web Audio is not available in this browser; the game continues without sound.');
          return;
        }
        const ctx = new Ctor();
        try {
          this.graph = this.build(ctx);
        } catch (e) {
          this.unsupported = true;
          this.fail(e);
          try {
            void ctx.close().catch(() => undefined);
          } catch {
            // Nothing else to release.
          }
          return;
        }
        this.ctx = ctx;
        this.watch();
        this.graph.loop.load();
        this.finishBuild(this.graph);
      }
      this.unlockAt = nowMs();
      const ctx = this.ctx;
      const state = ctx.state as string;
      if (state !== 'running' && state !== 'closed' && typeof ctx.resume === 'function') {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => undefined);
      }
    } catch (e) {
      this.fail(e);
    }
  }

  /** Each value 0..1; changes ramp smoothly. */
  setVolumes(master: number, music: number, sfx: number): void {
    try {
      this.masterVol = clamp01(num(master, this.masterVol));
      this.musicVol = clamp01(num(music, this.musicVol));
      this.sfxVol = clamp01(num(sfx, this.sfxVol));
      const g = this.graph;
      if (!g) return;
      this.ramp(g.master.gain, this.masterGain(), 0.05);
      this.ramp(g.sfx.gain, this.sfxGain(), 0.05);
      this.applyMusic();
    } catch (e) {
      this.fail(e);
    }
  }

  /** Music wanted at this share of the music volume (0..1), faded in about `fadeSeconds`. */
  setMusicPresence(level: number, fadeSeconds: number): void {
    try {
      const v = clamp01(num(level, this.presence));
      if (v === this.presence) return;
      this.presence = v;
      this.presenceFade = Math.max(0.03, num(fadeSeconds, 1) / 3);
      this.applyMusic();
      this.presenceFade = 0.1;
    } catch (e) {
      this.fail(e);
    }
  }

  get musicPresence(): number {
    return this.presence;
  }

  /** Distant thunder (rooftop moment); closeness 0..1. */
  thunder(closeness: number): void {
    try {
      const g = this.graph;
      if (!g || !g.ambience || g.ctx.state !== 'running') return;
      g.ambience.thunder(clamp01(num(closeness, 0.5)));
    } catch (e) {
      this.fail(e);
    }
  }

  /** Toggles the music mute (smooth fade); returns the new muted state. */
  toggleMusic(): boolean {
    this.musicMuted = !this.muted;
    return this.muted;
  }

  /** Menu mode: ambience and wind muted, music at full level. */
  setMenuMode(menu: boolean): void {
    try {
      this.menu = !!menu;
      this.applyDucks();
    } catch (e) {
      this.fail(e);
    }
  }

  /** Per-frame update: drives the continuous layers and tops up the music schedule. */
  update(dt: number, s: AudioListenerState): void {
    try {
      const g = this.graph;
      if (!g || !s) return;
      const paused = !!s.paused;
      if (paused !== this.paused) {
        this.paused = paused;
        this.applyDucks();
      }
      const d = clamp(num(dt, 0), 0, 0.25);
      const sm = this.smooth;
      sm.speed = follow(sm.speed, clamp(num(s.speed, 0), 0, 120), d, 0.08);
      sm.alt = follow(sm.alt, clamp(num(s.altitude, 0), 0, 400), d, 0.35);
      sm.park = follow(sm.park, clamp01(num(s.parkFactor, 0)), d, 0.6);
      sm.night = follow(sm.night, clamp01(num(s.nightFactor, 0)), d, 0.6);
      sm.water = follow(sm.water, clamp01(num(s.waterFactor, 0)), d, 0.6);
      sm.swing = follow(sm.swing, s.swinging ? 1 : 0, d, 0.12);
      sm.dive = follow(sm.dive, s.diving ? 1 : 0, d, 0.15);
      sm.rain = follow(sm.rain, clamp01(num(s.rain, 0)), d, 0.5);
      this.housekeep();
      // Automation is only scheduled on a running clock (a suspended clock would pile events up).
      if (g.ctx.state !== 'running' || !g.ambience) return;
      g.ambience.update(g.ctx.currentTime, sm, !this.menu && !this.paused && !this.hidden);
    } catch (e) {
      this.fail(e);
    }
  }

  // --- One-shot SFX -------------------------------------------------------

  /** pan -1 left hand .. +1 right hand. */
  webShot(pan: number): void {
    this.play((k) => fx.webShot(k, pan));
  }

  /** strength 0..1. */
  attach(strength: number): void {
    this.play((k) => fx.attach(k, strength));
  }

  release(good: boolean): void {
    this.play((k) => fx.release(k, !!good));
  }

  zipStart(): void {
    this.play((k) => fx.zipStart(k));
  }

  zipEnd(): void {
    this.play((k) => fx.zipEnd(k));
  }

  /** Surface ids as in src/physics/collision.ts; intensity 0 walk .. 1 sprint. */
  footstep(surface: number, intensity: number): void {
    this.play((k) => fx.footstep(k, surface, intensity));
  }

  /** impact m/s 0..80. */
  land(impact: number, surface: number): void {
    this.play((k) => fx.land(k, impact, surface));
  }

  roll(): void {
    this.play((k) => fx.roll(k));
  }

  wallGrab(surface: number): void {
    this.play((k) => fx.wallGrab(k, surface));
  }

  jump(): void {
    this.play((k) => fx.jump(k));
  }

  boost(): void {
    this.play((k) => fx.boost(k));
  }

  dive(): void {
    this.play((k) => fx.dive(k));
  }

  vault(): void {
    this.play((k) => fx.vault(k));
  }

  splash(): void {
    this.play((k) => fx.splash(k));
  }

  ringPass(index: number): void {
    this.play((k) => fx.ringPass(k, index));
  }

  ringComplete(): void {
    this.play((k) => fx.ringComplete(k));
  }

  uiClick(): void {
    this.play((k) => fx.uiClick(k));
  }

  uiHover(): void {
    const t = nowMs();
    if (t - this.hoverAt < HOVER_SPACING_MS) return;
    this.hoverAt = t;
    this.play((k) => fx.uiHover(k));
  }

  photoShutter(): void {
    this.play((k) => fx.photoShutter(k));
  }

  getDebugInfo(): AudioDebugInfo {
    try {
      const g = this.graph;
      return {
        state: this.ctx ? String(this.ctx.state) : this.unsupported ? 'unsupported' : 'locked',
        unlocked: this.unlocked,
        musicLoaded: g ? g.loop.loaded : false,
        musicDuration: g ? g.loop.duration : 0,
        musicError: g ? g.loop.error : this.unsupported ? 'Web Audio is not available' : null,
        activeVoices: g ? g.kit.voices.active : 0,
        loopsScheduled: g ? g.loop.scheduled : 0,
        musicLevel: this.musicGain(),
      };
    } catch {
      return {
        state: 'error',
        unlocked: false,
        musicLoaded: false,
        musicDuration: 0,
        musicError: null,
        activeVoices: 0,
        loopsScheduled: 0,
        musicLevel: 0,
      };
    }
  }

  // --- Internals ----------------------------------------------------------

  /** Synchronous part of the graph: everything needed for sound right after the gesture. */
  private build(ctx: AudioContext): Graph {
    const gain = (value: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = value;
      return g;
    };
    const master = gain(this.masterGain());
    let tail: AudioNode = master;
    try {
      // Gentle peak limiter: only the rare stacked peaks above about -4 dBFS are touched.
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -3;
      lim.knee.value = 3;
      lim.ratio.value = 12;
      lim.attack.value = 0.003;
      lim.release.value = 0.25;
      master.connect(lim);
      tail = lim;
    } catch {
      tail = master;
    }
    tail.connect(ctx.destination);

    const music = gain(this.musicGain());
    music.connect(master);
    const musicTrim = gain(1);
    musicTrim.connect(music);
    const sfxBus = gain(this.sfxGain());
    sfxBus.connect(master);
    const wind = gain(this.windDuck());
    wind.connect(sfxBus);
    const amb = gain(this.ambDuck());
    amb.connect(sfxBus);

    // The convolver gets its impulse response in a deferred step (it outputs silence until then).
    let reverb: AudioNode | null = null;
    let convolver: ConvolverNode | null = null;
    try {
      convolver = ctx.createConvolver();
      convolver.normalize = false;
      const send = gain(1);
      const ret = gain(REVERB_RETURN);
      send.connect(convolver);
      convolver.connect(ret);
      ret.connect(sfxBus);
      reverb = send;
    } catch {
      reverb = null;
      convolver = null;
    }

    const bank = new Bank(ctx);
    const kit = new Kit(ctx, bank, sfxBus, reverb, MAX_VOICES);
    const loop = new MusicLoop(ctx, musicTrim, this.musicUrl, (k) => {
      musicTrim.gain.value = k;
    });
    return { ctx, master, music, sfx: sfxBus, wind, amb, kit, bank, convolver, ambience: null, loop };
  }

  /**
   * Deferred part of the build, one step per task (each a few milliseconds):
   * the long noise loops, more grain variants, the reverb impulse and finally
   * the ambience graph (which needs the long loops).
   */
  private finishBuild(g: Graph): void {
    const steps = g.bank.steps();
    const conv = g.convolver;
    if (conv) {
      const ir = impulseJob(g.ctx, 1.6, 1.25);
      steps.push(...ir.steps, () => {
        conv.buffer = ir.buffer;
      });
    }
    steps.push(() => {
      g.ambience = new Ambience(g.kit, g.wind, g.amb);
    });
    const next = (): void => {
      const step = steps.shift();
      if (!step) return;
      try {
        step();
      } catch (e) {
        this.fail(e);
      }
      if (steps.length > 0) setTimeout(next, 0);
    };
    setTimeout(next, 0);
  }

  /** Visibility ducking plus a slow backup pump for the music look-ahead when update() is not running. */
  private watch(): void {
    try {
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        this.hidden = document.visibilityState === 'hidden';
        document.addEventListener('visibilitychange', () => {
          try {
            this.hidden = document.visibilityState === 'hidden';
            this.applyDucks();
            this.housekeep();
          } catch (e) {
            this.fail(e);
          }
        });
      }
      if (typeof window !== 'undefined' && typeof window.setInterval === 'function') {
        // Only tops up the queue; all timing stays on the AudioContext clock.
        window.setInterval(() => {
          try {
            this.housekeep();
          } catch (e) {
            this.fail(e);
          }
        }, 1000);
      }
    } catch (e) {
      this.fail(e);
    }
  }

  private housekeep(): void {
    const g = this.graph;
    if (!g) return;
    g.kit.voices.prune(g.ctx.currentTime);
    g.loop.pump();
  }

  private play(fn: (k: Kit) => void): void {
    try {
      const g = this.graph;
      if (!g) return;
      const state = g.ctx.state as string;
      const resuming = state === 'suspended' && nowMs() - this.unlockAt < RESUME_GRACE_MS;
      if (state !== 'running' && !resuming) return;
      fn(g.kit);
    } catch (e) {
      this.fail(e);
    }
  }

  private masterGain(): number {
    return perceptual(this.masterVol) * MASTER_TRIM;
  }

  private musicGain(): number {
    return this.muted ? 0 : perceptual(this.musicVol) * MUSIC_LEVEL * this.presence;
  }

  private sfxGain(): number {
    return perceptual(this.sfxVol) * SFX_LEVEL;
  }

  private windDuck(): number {
    return this.menu || this.paused || this.hidden ? 0 : 1;
  }

  private ambDuck(): number {
    if (this.menu || this.hidden) return 0;
    return this.paused ? PAUSE_DUCK : 1;
  }

  private applyMusic(): void {
    const g = this.graph;
    if (g) this.ramp(g.music.gain, this.musicGain(), this.presenceFade);
  }

  private applyDucks(): void {
    const g = this.graph;
    if (!g) return;
    this.ramp(g.wind.gain, this.windDuck(), 0.12);
    this.ramp(g.amb.gain, this.ambDuck(), 0.15);
  }

  /** Smooth move of a bus gain (time constant `tc`), replacing any pending move. */
  private ramp(p: AudioParam, value: number, tc: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const t = ctx.currentTime;
      p.cancelScheduledValues(t);
      p.setTargetAtTime(value, t, tc);
    } catch {
      try {
        p.value = value;
      } catch {
        // Leave the bus where it is.
      }
    }
  }

  private fail(e: unknown): void {
    if (this.warned) return;
    this.warned = true;
    try {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[skythread] audio: unexpected error (${msg}); sound continues where possible.`);
    } catch {
      // Console unavailable.
    }
  }
}
