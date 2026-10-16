/**
 * Combat sound effects (M11), synthesised like the rest (sfx.ts): punches
 * and kicks that climb in pitch with the combo, the shield clang, gunshots
 * and the gunman's laser hum, drone bolts, smashed bottles, the hero's hurt
 * thud and knockout, enemy KOs, the spider-sense tick, the event start and
 * cleared stings, and a looping drone whir (`DroneHum`). Every one-shot is
 * one voice; `gain` is the distance attenuation (0..1) and `pan` the side.
 */
import { clamp, clamp01, glide, num, perc, rand, semis, vary } from './dsp';
import { burst, tone, type Kit } from './kit';
import { PRI_UI } from './voices';

export type CombatSound =
  | 'punch'
  | 'kick'
  | 'block'
  | 'gunshot'
  | 'laser'
  | 'bolt'
  | 'bottle'
  | 'hurt'
  | 'heroDown'
  | 'ko'
  | 'sense'
  | 'dodge'
  | 'eventStart'
  | 'eventClear'
  | 'eventFail';

/** Plays a combat one-shot; `param` is the combo count for punches and kicks. */
export function playCombat(k: Kit, name: CombatSound, gain: number, pan: number, param: number): void {
  const g = clamp01(num(gain, 1));
  if (g < 0.02) return;
  const p = clamp(num(pan, 0), -1, 1);
  switch (name) {
    case 'punch':
      return punch(k, g, p, num(param, 0), false);
    case 'kick':
      return punch(k, g, p, num(param, 0), true);
    case 'block':
      return block(k, g, p);
    case 'gunshot':
      return gunshot(k, g, p);
    case 'laser':
      return laser(k, g, p);
    case 'bolt':
      return bolt(k, g, p);
    case 'bottle':
      return bottle(k, g, p);
    case 'hurt':
      return hurt(k, g);
    case 'heroDown':
      return heroDown(k, g);
    case 'ko':
      return ko(k, g, p);
    case 'sense':
      return sense(k, g);
    case 'dodge':
      return dodge(k, g);
    case 'eventStart':
      return eventStart(k, g);
    case 'eventClear':
      return eventClear(k, g);
    case 'eventFail':
      return eventFail(k, g);
  }
}

/** Meaty thump: a falling sine body, a short noise smack and a cloth whoosh; kicks are deeper and longer. Pitch climbs with the combo. */
function punch(k: Kit, g: number, pan: number, combo: number, heavy: boolean): void {
  const v = k.voice((heavy ? 0.72 : 0.62) * g * vary(0.08), pan * 0.5, 0.06);
  if (!v) return;
  const t = v.t0;
  const up = semis(Math.min(12, Math.max(0, combo - 1)) * 0.7) * vary(0.04);
  const f0 = (heavy ? 150 : 190) * up;
  tone(v, t, 'sine', f0, f0 * 0.32, heavy ? 0.12 : 0.08, 0.9, 0.002, heavy ? 0.2 : 0.13);
  tone(v, t, 'triangle', f0 * 2.1, f0 * 0.9, 0.05, 0.22, 0.001, 0.06);
  burst(v, k.bank.white, t, 'bandpass', (heavy ? 1300 : 1800) * up, 1.1, 0.75, 0.0006, heavy ? 0.05 : 0.035);
  burst(v, k.bank.white, t, 'lowpass', 700, 0.7, 0.5, 0.001, 0.06);
  // The swing's whoosh just before the contact.
  const w = burst(v, k.bank.pink, t, 'bandpass', 900, 1.2, heavy ? 0.35 : 0.22, 0.03, 0.09);
  glide(w.frequency, t, 600, 2200, 0.1);
}

/** Shield clang: an inharmonic metal ring with a hard click. */
function block(k: Kit, g: number, pan: number): void {
  const v = k.voice(0.5 * g * vary(0.08), pan * 0.5, 0.2);
  if (!v) return;
  const t = v.t0;
  burst(v, k.bank.white, t, 'highpass', 3000, 0.8, 0.6, 0.0005, 0.02);
  const base = rand(420, 520);
  const ratios = [1, 1.47, 2.09, 2.76, 3.51];
  const amps = [0.28, 0.2, 0.15, 0.1, 0.07];
  for (let i = 0; i < ratios.length; i++) {
    const f = base * ratios[i]! * vary(0.01);
    tone(v, t, i % 2 ? 'triangle' : 'sine', f, f * 0.995, 0.3, amps[i]!, 0.001, 0.5 - i * 0.06);
  }
  tone(v, t, 'sine', 120, 70, 0.06, 0.4, 0.002, 0.08);
}

/** Gunshot: a sharp crack, a low boom and a short room tail (one round of a burst). */
function gunshot(k: Kit, g: number, pan: number): void {
  const v = k.voice(0.55 * g * vary(0.1), pan * 0.6, 0.25);
  if (!v) return;
  const t = v.t0;
  burst(v, k.bank.white, t, 'highpass', 2200, 0.7, 1.1, 0.0004, 0.03);
  burst(v, k.bank.white, t, 'bandpass', 900 * vary(0.08), 0.9, 0.8, 0.001, 0.09);
  tone(v, t, 'sine', 160, 48, 0.08, 0.8, 0.001, 0.16);
  burst(v, k.bank.pink, t + 0.02, 'lowpass', 1200, 0.6, 0.25, 0.02, 0.28);
}

/** The gunman's laser sight locking on: a thin rising hum. */
function laser(k: Kit, g: number, pan: number): void {
  const v = k.voice(0.16 * g, pan * 0.5, 0.05);
  if (!v) return;
  const t = v.t0;
  const d = 0.68;
  const o = v.osc('sawtooth', 620, t, t + d + 0.05);
  glide(o.frequency, t, 620, 1250, d);
  const bp = v.filter('bandpass', 1800, 6);
  glide(bp.frequency, t, 1400, 3200, d);
  const env = v.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.5, t + 0.08);
  env.gain.setValueAtTime(0.5, t + d - 0.08);
  env.gain.linearRampToValueAtTime(0, t + d);
  o.connect(bp);
  bp.connect(env);
  env.connect(v.out);
  tone(v, t, 'sine', 2400, 4800, d, 0.05, 0.05, d);
}

/** Drone plasma bolt: a descending electric zap. */
function bolt(k: Kit, g: number, pan: number): void {
  const v = k.voice(0.42 * g * vary(0.08), pan * 0.6, 0.12);
  if (!v) return;
  const t = v.t0;
  const o = v.osc('square', 1800 * vary(0.05), t, t + 0.3);
  glide(o.frequency, t, 1800, 180, 0.24);
  const lp = v.filter('lowpass', 3000, 4);
  glide(lp.frequency, t, 5000, 600, 0.24);
  const env = v.gain(0);
  perc(env.gain, t, 0.45, 0.002, 0.24);
  o.connect(lp);
  lp.connect(env);
  env.connect(v.out);
  const fm = v.osc('sine', 55, t, t + 0.3);
  const depth = v.gain(400);
  fm.connect(depth);
  depth.connect(o.frequency);
  burst(v, k.bank.white, t, 'highpass', 4000, 0.7, 0.3, 0.001, 0.05);
}

/** A bottle smashing: a glass crack and scattered tinkles. */
function bottle(k: Kit, g: number, pan: number): void {
  const v = k.voice(0.5 * g * vary(0.08), pan * 0.6, 0.15);
  if (!v) return;
  const t = v.t0;
  burst(v, k.bank.white, t, 'highpass', 4800, 0.8, 0.9, 0.0005, 0.05);
  burst(v, k.bank.white, t, 'bandpass', 2600, 1.4, 0.5, 0.001, 0.12);
  tone(v, t, 'sine', 140, 80, 0.04, 0.3, 0.002, 0.05);
  for (let i = 0; i < 7; i++) {
    const ti = t + rand(0.01, 0.32);
    const f = rand(2800, 6400);
    tone(v, ti, 'sine', f, f * rand(0.98, 1.02), 0, rand(0.06, 0.14), 0.0006, rand(0.04, 0.12));
  }
}

/** Hero hurt: a heavy body thud (no voice acting), a muffled smack and a short low "oof" of filtered noise. */
function hurt(k: Kit, g: number): void {
  const v = k.voice(0.7 * g * vary(0.06), null, 0.05);
  if (!v) return;
  const t = v.t0;
  tone(v, t, 'sine', 110 * vary(0.05), 42, 0.14, 1, 0.003, 0.24);
  burst(v, k.bank.white, t, 'lowpass', 600, 0.8, 0.8, 0.002, 0.08);
  const f = burst(v, k.bank.pink, t + 0.01, 'bandpass', 420, 2.5, 0.35, 0.02, 0.16);
  glide(f.frequency, t + 0.01, 520, 260, 0.16);
}

/** Hero knocked out: a big thud and a falling, dimming tone. */
function heroDown(k: Kit, g: number): void {
  const v = k.voice(0.7 * g, null, 0.3);
  if (!v) return;
  const t = v.t0;
  tone(v, t, 'sine', 90, 30, 0.3, 1, 0.003, 0.45);
  burst(v, k.bank.white, t, 'lowpass', 500, 0.7, 0.7, 0.003, 0.15);
  tone(v, t + 0.05, 'triangle', 330, 110, 1.1, 0.18, 0.02, 1.2);
  tone(v, t + 0.05, 'triangle', 392, 130, 1.1, 0.12, 0.02, 1.2);
}

/** An enemy goes down for good: a heavy body drop. */
function ko(k: Kit, g: number, pan: number): void {
  const v = k.voice(0.5 * g * vary(0.08), pan * 0.5, 0.1);
  if (!v) return;
  const t = v.t0;
  tone(v, t, 'sine', 95 * vary(0.06), 40, 0.18, 0.9, 0.003, 0.26);
  burst(v, k.bank.white, t, 'lowpass', 900, 0.7, 0.5, 0.002, 0.1);
  burst(v, k.bank.white, t + 0.12, 'lowpass', 700, 0.7, 0.25, 0.002, 0.08);
  tone(v, t, 'triangle', 600, 300, 0.2, 0.08, 0.002, 0.2);
}

/** Spider-sense: two bright ticks. */
function sense(k: Kit, g: number): void {
  const v = k.voice(0.22 * g, null, 0.05, PRI_UI);
  if (!v) return;
  const t = v.t0;
  tone(v, t, 'sine', 2637, 2637, 0, 0.5, 0.001, 0.06);
  tone(v, t + 0.07, 'sine', 3520, 3520, 0, 0.4, 0.001, 0.07);
}

/** Dodge: a quick cloth whoosh. */
function dodge(k: Kit, g: number): void {
  const v = k.voice(0.35 * g * vary(0.08), rand(-0.2, 0.2), 0.05);
  if (!v) return;
  const t = v.t0;
  const f = burst(v, k.bank.pink, t, 'bandpass', 700, 1.4, 0.9, 0.03, 0.18);
  glide(f.frequency, t, 500, 2600, 0.2);
}

/** Event announced: a brassy minor stab over a low hit. */
function eventStart(k: Kit, g: number): void {
  const v = k.voice(0.45 * g, null, 0.25, PRI_UI);
  if (!v) return;
  const t = v.t0;
  tone(v, t, 'sine', 70, 40, 0.3, 0.8, 0.004, 0.5);
  burst(v, k.bank.white, t, 'lowpass', 1200, 0.7, 0.4, 0.002, 0.12);
  const notes = [220, 261.6, 329.6];
  for (let r = 0; r < 2; r++) {
    const tr = t + r * 0.17;
    for (const f0 of notes) {
      const o = v.osc('sawtooth', f0 * vary(0.003), tr, tr + 0.5);
      const lp = v.filter('lowpass', 2400, 1.2);
      glide(lp.frequency, tr, 2600, 700, 0.35);
      const e = v.gain(0);
      perc(e.gain, tr, r === 0 ? 0.13 : 0.17, 0.008, r === 0 ? 0.14 : 0.45);
      o.connect(lp);
      lp.connect(e);
      e.connect(v.out);
    }
  }
}

/** Event cleared: a rising major arpeggio with a shimmer. */
function eventClear(k: Kit, g: number): void {
  const v = k.voice(0.42 * g, null, 0.3, PRI_UI);
  if (!v) return;
  const t = v.t0;
  const notes = [523.3, 659.3, 784, 1046.5];
  for (let i = 0; i < notes.length; i++) {
    const tn = t + i * 0.085;
    const f = notes[i]!;
    tone(v, tn, 'triangle', f, f, 0, 0.3, 0.004, 0.5);
    tone(v, tn, 'sine', f * 2, f * 2, 0, 0.08, 0.002, 0.3);
  }
  const n = burst(v, k.bank.white, t + 0.25, 'bandpass', 4000, 1.2, 0.12, 0.2, 0.5);
  glide(n.frequency, t + 0.25, 3000, 8000, 0.6);
}

/** Event expired or failed: two falling notes. */
function eventFail(k: Kit, g: number): void {
  const v = k.voice(0.3 * g, null, 0.2, PRI_UI);
  if (!v) return;
  const t = v.t0;
  tone(v, t, 'triangle', 392, 380, 0.2, 0.3, 0.005, 0.3);
  tone(v, t + 0.22, 'triangle', 293.7, 280, 0.3, 0.3, 0.005, 0.5);
}

/** Below this level for this long the drone whir's nodes are torn down (s). */
const HUM_IDLE_STOP = 2;

/**
 * Looping drone whir for the nearest drone: two detuned saws through a band
 * (the motor) plus pink noise chopped by a rotor-rate tremolo, panned and
 * faded by `set(level, pan)`. Built on first use and torn down after two
 * seconds of silence, so it costs nothing without drones.
 */
export class DroneHum {
  private nodes: AudioNode[] = [];
  private sources: AudioScheduledSourceNode[] = [];
  private out: GainNode | null = null;
  private panner: StereoPannerNode | null = null;
  private quietFor = 0;
  private lastT = 0;

  constructor(private readonly k: Kit, private readonly dest: AudioNode) {}

  /** level 0..1 (0 = silent), pan -1..1; call every frame. */
  set(level: number, pan: number): void {
    const ctx = this.k.ctx;
    const now = ctx.currentTime;
    const dt = Math.max(0, Math.min(0.25, now - this.lastT));
    this.lastT = now;
    const l = clamp01(num(level, 0));
    if (l < 0.01) {
      if (!this.out) return;
      this.out.gain.setTargetAtTime(0, now, 0.15);
      this.quietFor += dt;
      if (this.quietFor > HUM_IDLE_STOP) this.stop();
      return;
    }
    this.quietFor = 0;
    if (!this.out) this.build();
    if (!this.out) return;
    this.out.gain.setTargetAtTime(l * 0.16, now, 0.12);
    if (this.panner) this.panner.pan.setTargetAtTime(clamp(num(pan, 0), -1, 1) * 0.7, now, 0.1);
  }

  stop(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // Already stopped.
      }
    }
    for (const n of this.nodes) n.disconnect();
    this.nodes = [];
    this.sources = [];
    this.out = null;
    this.panner = null;
    this.quietFor = 0;
  }

  private build(): void {
    const ctx = this.k.ctx;
    const t = ctx.currentTime;
    const keep = <T extends AudioNode>(n: T): T => {
      this.nodes.push(n);
      return n;
    };
    const out = keep(ctx.createGain());
    out.gain.value = 0;
    let tail: AudioNode = out;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = keep(ctx.createStereoPanner());
      out.connect(p);
      tail = p;
      this.panner = p;
    }
    tail.connect(this.dest);
    const motor = keep(ctx.createBiquadFilter());
    motor.type = 'bandpass';
    motor.frequency.value = 900;
    motor.Q.value = 1.4;
    const mg = keep(ctx.createGain());
    mg.gain.value = 0.5;
    motor.connect(mg);
    mg.connect(out);
    for (const f of [182, 186.5]) {
      const o = keep(ctx.createOscillator());
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(motor);
      o.start(t);
      this.sources.push(o);
    }
    // Rotor chop: pink noise through a band, amplitude-modulated at ~38 Hz.
    const src = keep(ctx.createBufferSource());
    src.buffer = this.k.bank.pink;
    src.loop = true;
    const band = keep(ctx.createBiquadFilter());
    band.type = 'bandpass';
    band.frequency.value = 2200;
    band.Q.value = 0.9;
    const chop = keep(ctx.createGain());
    chop.gain.value = 0.55;
    const lfo = keep(ctx.createOscillator());
    lfo.frequency.value = 38;
    const depth = keep(ctx.createGain());
    depth.gain.value = 0.45;
    lfo.connect(depth);
    depth.connect(chop.gain);
    src.connect(band);
    band.connect(chop);
    chop.connect(out);
    src.start(t);
    lfo.start(t);
    this.sources.push(src, lfo);
    this.out = out;
  }
}
