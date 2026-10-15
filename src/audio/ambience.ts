/**
 * Continuous layers driven every frame by the listener state: speed wind
 * (dive flutter, slow gusts, a swing-line whistle), a rooftop breeze, the
 * city traffic hum with occasional distant horns, park birds by day, night
 * crickets, waterfront lapping and rain (a hiss and a patter band with
 * droplet ticks, plus thunder on request).
 *
 * The static graph is built once; update() only moves AudioParams (with
 * setTargetAtTime, so every change is click-free). Short one-shots (bird
 * phrases, horns, laps) are spawned at random intervals through the shared,
 * capped voice allocator at the lowest priority.
 */
import { chance, clamp01, glide, perc, pick, pulseCurve, rand, randInt, Smoothed } from './dsp';
import { tone, type Kit } from './kit';
import { makePanner, PRI_AMBIENT, PRI_SFX } from './voices';

/** Smoothed listener values the ambience follows. */
export interface AmbienceInput {
  /** Player speed, m/s. */
  speed: number;
  /** Metres above ground. */
  alt: number;
  park: number;
  night: number;
  water: number;
  /** 0..1, on a web line. */
  swing: number;
  /** 0..1, diving. */
  dive: number;
  /** 0..1, rain (the rooftop moment). */
  rain: number;
}

// Full-scale linear level of each layer before the wind/ambience buses.
const WIND_LEVEL = 0.5;
const RUMBLE_LEVEL = 0.45;
const WHISTLE_LEVEL = 0.05;
const BREEZE_LEVEL = 0.22;
const TRAFFIC_LEVEL = 0.08;
const WATER_LEVEL = 0.14;
const BIRD_LEVEL = 0.07;
const CRICKET_LEVEL = 0.05;
const HORN_LEVEL = 0.025;
const LAP_LEVEL = 0.09;
const RAIN_LEVEL = 0.2;
const PATTER_LEVEL = 0.12;
const DRIP_LEVEL = 0.05;
const THUNDER_LEVEL = 0.5;

/** Cricket voices: carrier Hz, pulse rate Hz, chirp rate Hz, pan, relative level. */
const CRICKETS: readonly (readonly [number, number, number, number, number])[] = [
  [4400, 42, 2.3, -0.55, 1],
  [4750, 37, 1.7, 0.6, 0.7],
  [4150, 47, 2.9, 0.1, 0.5],
];

export class Ambience {
  private readonly windGain: Smoothed;
  private readonly windBand: Smoothed;
  private readonly windLow: Smoothed;
  private readonly rumbleGain: Smoothed;
  private readonly flutterDepth: Smoothed;
  private readonly gustDepth: Smoothed;
  private readonly whistleGain: Smoothed;
  private readonly whistleBand: Smoothed;
  private readonly breezeGain: Smoothed;
  private readonly trafficGain: Smoothed;
  private readonly trafficLow: Smoothed;
  private readonly waterGain: Smoothed;
  private readonly birdGain: Smoothed;
  private readonly cricketGain: Smoothed;
  private readonly rainGain: Smoothed;
  private readonly patterGain: Smoothed;
  private readonly birdBus: GainNode;
  private readonly rainBus: GainNode;
  private readonly hornBus: GainNode;
  private readonly lapBus: GainNode;
  private nextBird: number;
  private nextHorn: number;
  private nextLap: number;
  private nextDrip: number;
  private rain = 0;
  private traffic = 0;
  private birds = 0;
  private water = 0;

  constructor(
    private readonly kit: Kit,
    windOut: AudioNode,
    ambOut: AudioNode,
  ) {
    const ctx = kit.ctx;
    const bank = kit.bank;
    const now = ctx.currentTime;
    const gain = (value: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = value;
      return g;
    };
    const filter = (type: BiquadFilterType, freq: number, q: number): BiquadFilterNode => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
    const lfo = (type: OscillatorType, freq: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.start(now + rand(0, 0.25));
      return o;
    };
    const loop = (buf: AudioBuffer, offset: number): AudioBufferSourceNode => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start(now, buf.duration * offset);
      return s;
    };
    /** Connects a chain of nodes in series; the last element may be an AudioParam (modulation). */
    const wire = (...chain: (AudioNode | AudioParam)[]): void => {
      for (let i = 0; i + 1 < chain.length; i++) {
        const from = chain[i] as AudioNode;
        const to = chain[i + 1];
        if (to instanceof AudioParam) from.connect(to);
        else from.connect(to);
      }
    };

    // --- Wind: pink noise through a speed-tracking band, with rumble, flutter and gusts.
    const pinkA = loop(bank.pink, 0);
    const pinkB = loop(bank.pink, 0.5);
    const windHp = filter('highpass', 90, 0.6);
    const windBand = filter('bandpass', 400, 0.7);
    const windLow = filter('lowpass', 2000, 0.5);
    const wind = gain(0);
    const windMod = gain(1);
    wire(pinkA, windHp, windBand, windLow, wind, windMod, windOut);
    const rumbleLp = filter('lowpass', 140, 0.9);
    const rumble = gain(0);
    wire(pinkA, rumbleLp, rumble, windMod);
    const flutterA = lfo('sine', 7.3);
    const flutterB = lfo('triangle', 11.9);
    const flutterBMix = gain(0.6);
    const flutter = gain(0);
    flutterA.connect(flutter);
    wire(flutterB, flutterBMix, flutter, windMod.gain);
    const gustA = lfo('sine', 0.13);
    const gustB = lfo('sine', 0.29);
    const gust = gain(0);
    gustA.connect(gust);
    gustB.connect(gust);
    gust.connect(windBand.frequency);
    const gustAmp = gain(0.12);
    wire(gustA, gustAmp, windMod.gain);
    const whistleBp = filter('bandpass', 900, 9);
    const whistle = gain(0);
    wire(pinkA, whistleBp, whistle, windMod);
    // Rooftop breeze (part of the ambience: it is there even when standing still up high).
    const breezeLp = filter('lowpass', 800, 0.5);
    const breezeHp = filter('highpass', 150, 0.6);
    const breeze = gain(0);
    const breezeMod = gain(0.75);
    wire(pinkB, breezeLp, breezeHp, breeze, breezeMod, ambOut);
    const breezeDepth = gain(0.2);
    gustA.connect(breezeDepth);
    wire(gustB, breezeDepth, breezeMod.gain);

    // --- Traffic hum: low-passed brown noise plus a little tyre hiss, drifting slowly.
    const brownA = loop(bank.brown, 0);
    const brownB = loop(bank.brown, 0.5);
    const trafficLp = filter('lowpass', 240, 0.5);
    const trafficHp = filter('highpass', 45, 0.7);
    const traffic = gain(0);
    const trafficMod = gain(1);
    wire(brownA, trafficLp, trafficHp, traffic, trafficMod, ambOut);
    const tyreBp = filter('bandpass', 650, 0.6);
    const tyre = gain(0.3);
    wire(pinkB, tyreBp, tyre, traffic);
    const driftA = lfo('sine', 0.071);
    const driftB = lfo('sine', 0.163);
    const drift = gain(0.2);
    driftA.connect(drift);
    wire(driftB, drift, trafficMod.gain);

    // --- Water: low-passed brown noise with slow swells and a faint fizz.
    const waterLp = filter('lowpass', 600, 0.6);
    const waterHp = filter('highpass', 110, 0.6);
    const water = gain(0);
    const waterMod = gain(0.55);
    wire(brownB, waterLp, waterHp, water, waterMod, ambOut);
    const fizzBp = filter('bandpass', 1300, 0.9);
    const fizz = gain(0.12);
    wire(pinkA, fizzBp, fizz, water);
    const swellA = lfo('sine', 0.17);
    const swellB = lfo('sine', 0.31);
    const swellDepth = gain(0.25);
    swellA.connect(swellDepth);
    wire(swellB, swellDepth, waterMod.gain);

    // --- Crickets: high sines gated by fast pulse trains inside slower chirp gates, plus a faint chorus.
    const crickets = gain(0);
    crickets.connect(ambOut);
    const pulseShape = pulseCurve(0.1, 1.6);
    const chirpShape = pulseCurve(0.5, 1);
    const tempo = lfo('sine', 0.05);
    for (const [carrierHz, pulseHz, chirpHz, pan, level] of CRICKETS) {
      const carrier = lfo('sine', carrierHz * rand(0.98, 1.02));
      const pulse = lfo('sine', pulseHz);
      const chirp = lfo('sine', chirpHz);
      const ps = ctx.createWaveShaper();
      ps.curve = pulseShape;
      const cs = ctx.createWaveShaper();
      cs.curve = chirpShape;
      const am1 = gain(0);
      const am2 = gain(0);
      wire(pulse, ps);
      ps.connect(am1.gain);
      wire(chirp, cs);
      cs.connect(am2.gain);
      const tempoDepth = gain(chirpHz * 0.08);
      wire(tempo, tempoDepth, chirp.frequency);
      const out = gain(level);
      const panner = makePanner(ctx, pan);
      if (panner) wire(carrier, am1, am2, panner, out, crickets);
      else wire(carrier, am1, am2, out, crickets);
    }
    const chorusBp = filter('bandpass', 4600, 10);
    const chorusAm = gain(0);
    const chorusPulse = lfo('sine', 31);
    const chorusShape = ctx.createWaveShaper();
    chorusShape.curve = pulseShape;
    wire(chorusPulse, chorusShape);
    chorusShape.connect(chorusAm.gain);
    const chorus = gain(0.6);
    wire(pinkB, chorusBp, chorusAm, chorus, crickets);

    // --- Rain: a high hiss and a softer patter band of pink noise, swelling slowly with the gusts.
    const rainSrc = loop(bank.pink, 0.25);
    const rainHp = filter('highpass', 1900, 0.5);
    const rainLp = filter('lowpass', 7800, 0.5);
    const rainHiss = gain(0);
    const rainMod = gain(0.85);
    wire(rainSrc, rainHp, rainLp, rainHiss, rainMod, ambOut);
    const patterSrc = loop(bank.pink, 0.75);
    const patterBp = filter('bandpass', 950, 0.7);
    const patter = gain(0);
    wire(patterSrc, patterBp, patter, rainMod);
    const rainSwell = gain(0.15);
    wire(gustB, rainSwell, rainMod.gain);

    // --- Ambient one-shots: birds, horns and laps play into their own buses. Each bus feeds the
    // shared reverb after its own gain, so the wet part always follows the dry level.
    this.birdBus = gain(0);
    this.hornBus = gain(1);
    this.lapBus = gain(1);
    this.rainBus = gain(1);
    const sends: [GainNode, number][] = [
      [this.birdBus, 0.12],
      [this.hornBus, 0.35],
      [this.lapBus, 0.05],
      [this.rainBus, 0.5],
    ];
    for (const [bus, amount] of sends) {
      bus.connect(ambOut);
      if (kit.reverb) wire(bus, gain(amount), kit.reverb);
    }

    this.windGain = new Smoothed(wind.gain, 0.06);
    this.windBand = new Smoothed(windBand.frequency, 0.08);
    this.windLow = new Smoothed(windLow.frequency, 0.08);
    this.rumbleGain = new Smoothed(rumble.gain, 0.06);
    this.flutterDepth = new Smoothed(flutter.gain, 0.15);
    this.gustDepth = new Smoothed(gust.gain, 0.2);
    this.whistleGain = new Smoothed(whistle.gain, 0.08);
    this.whistleBand = new Smoothed(whistleBp.frequency, 0.08);
    this.breezeGain = new Smoothed(breeze.gain, 0.3);
    this.trafficGain = new Smoothed(traffic.gain, 0.3);
    this.trafficLow = new Smoothed(trafficLp.frequency, 0.3);
    this.waterGain = new Smoothed(water.gain, 0.3);
    this.birdGain = new Smoothed(this.birdBus.gain, 0.3);
    this.cricketGain = new Smoothed(crickets.gain, 0.3);
    this.rainGain = new Smoothed(rainHiss.gain, 0.4);
    this.patterGain = new Smoothed(patter.gain, 0.4);

    this.nextBird = now + rand(0.8, 2.5);
    this.nextHorn = now + rand(5, 12);
    this.nextLap = now + rand(0.8, 2);
    this.nextDrip = now + 0.2;
  }

  /** Moves every layer towards the listener state; spawns ambient one-shots only when `live`. */
  update(now: number, s: AmbienceInput, live: boolean): void {
    const sN = clamp01((s.speed - 6) / 54);
    const sC = sN * sN * (3 - 2 * sN) * 0.55 + sN * 0.45;
    const over = clamp01((s.speed - 60) / 30);
    const altF = 1 - Math.exp(-Math.max(0, s.alt) / 80);
    const dive = clamp01(s.dive);

    const wind = (Math.pow(sC, 0.6) * (0.85 + 0.3 * altF) + 0.2 * over) * (1 + 0.15 * dive);
    this.windGain.to(WIND_LEVEL * wind, now);
    const center = 380 + 1500 * sC + 300 * dive;
    this.windBand.to(center, now);
    this.gustDepth.to(center * 0.12, now);
    this.windLow.to(1400 + 5200 * sC + 1500 * dive, now);
    this.rumbleGain.to(RUMBLE_LEVEL * sC * sC * (1 + 0.3 * dive), now);
    this.flutterDepth.to((0.05 + 0.06 * altF + 0.3 * dive) / 1.6, now);
    this.whistleGain.to(WHISTLE_LEVEL * clamp01(s.swing) * sC, now);
    this.whistleBand.to(650 + 1500 * sC, now);
    this.breezeGain.to(BREEZE_LEVEL * Math.pow(altF, 1.5) * (1 - 0.6 * sC), now);

    const park = clamp01(s.park);
    const night = clamp01(s.night);
    const waterF = clamp01(s.water);
    this.traffic = (1 - 0.75 * park) * (1 - 0.5 * night) * (1 - 0.7 * altF) * (1 - 0.35 * waterF);
    this.trafficGain.to(TRAFFIC_LEVEL * this.traffic, now);
    this.trafficLow.to(260 - 110 * altF, now);
    this.birds = park * (1 - night) * (1 - 0.5 * altF);
    this.birdGain.to(BIRD_LEVEL * this.birds, now);
    this.cricketGain.to(CRICKET_LEVEL * night * (0.3 + 0.7 * park) * (1 - 0.75 * altF), now);
    this.water = waterF * (1 - 0.6 * altF);
    this.waterGain.to(WATER_LEVEL * this.water, now);
    this.rain = clamp01(s.rain);
    this.rainGain.to(RAIN_LEVEL * this.rain, now);
    this.patterGain.to(PATTER_LEVEL * this.rain * this.rain, now);

    if (!live) {
      // Nothing is spawned while paused; resume with fresh intervals instead of a burst.
      this.nextBird = Math.max(this.nextBird, now + 0.5);
      this.nextHorn = Math.max(this.nextHorn, now + 3);
      this.nextLap = Math.max(this.nextLap, now + 0.5);
      this.nextDrip = Math.max(this.nextDrip, now + 0.2);
      return;
    }
    if (now >= this.nextDrip) {
      if (this.rain > 0.2) drip(this.kit, this.rainBus, DRIP_LEVEL * this.rain);
      this.nextDrip = now + rand(0.05, 0.16) / Math.max(0.3, this.rain);
    }
    if (now >= this.nextBird) {
      if (this.birds > 0.03) birdPhrase(this.kit, this.birdBus);
      this.nextBird = now + rand(1, 4);
    }
    if (now >= this.nextHorn) {
      if (this.traffic > 0.2) horn(this.kit, this.hornBus, HORN_LEVEL * this.traffic);
      this.nextHorn = now + rand(8, 25);
    }
    if (now >= this.nextLap) {
      if (this.water > 0.06) lap(this.kit, this.lapBus, LAP_LEVEL * this.water);
      this.nextLap = now + rand(1.1, 3.2);
    }
  }

  /** Distant thunder (0..1 closeness): a soft crack when close, then a long rolling rumble. */
  thunder(closeness: number): void {
    thunder(this.kit, this.rainBus, THUNDER_LEVEL * (0.5 + 0.5 * clamp01(closeness)), clamp01(closeness));
  }
}

// ---------------------------------------------------------------------------
// Ambient one-shots

interface BirdNote {
  f0: number;
  f1: number;
  dur: number;
  gap: number;
  /** FM depth in Hz (trill), 0 for a pure sweep. */
  fm: number;
  fmRate: number;
  amp: number;
}

/** A 2-6 note phrase in one of four song styles. */
function planPhrase(): BirdNote[] {
  const notes: BirdNote[] = [];
  switch (randInt(0, 3)) {
    case 0: {
      // Warbler: quick up/down sweeps with a light trill.
      const base = rand(2600, 3600);
      const count = randInt(3, 6);
      for (let i = 0; i < count; i++) {
        const f0 = base * rand(0.85, 1.15);
        const f1 = f0 * (chance(0.5) ? rand(1.2, 1.5) : rand(0.65, 0.85));
        notes.push({ f0, f1, dur: rand(0.06, 0.11), gap: rand(0.03, 0.09), fm: f0 * rand(0.03, 0.08), fmRate: rand(30, 55), amp: rand(0.6, 1) });
      }
      break;
    }
    case 1: {
      // Sparrow chips: short, fast downward chirps.
      const base = rand(3800, 5000);
      const count = randInt(3, 6);
      for (let i = 0; i < count; i++) {
        const f0 = base * rand(0.95, 1.05);
        notes.push({ f0, f1: f0 * rand(0.55, 0.7), dur: rand(0.035, 0.055), gap: rand(0.05, 0.11), fm: 0, fmRate: 40, amp: rand(0.7, 1) });
      }
      break;
    }
    case 2: {
      // Whistler: slow two-tone "fee-bee" with a gentle vibrato.
      const base = rand(1900, 2700);
      const count = randInt(2, 3);
      for (let i = 0; i < count; i++) {
        const f0 = base * (i % 2 === 1 ? 0.84 : 1);
        notes.push({ f0, f1: f0 * rand(0.97, 1.03), dur: rand(0.16, 0.3), gap: rand(0.08, 0.16), fm: f0 * 0.01, fmRate: rand(6, 9), amp: rand(0.7, 1) });
      }
      break;
    }
    default: {
      // Trill: two longer notes with fast FM and an upward sweep.
      const base = rand(3000, 4200);
      for (let i = 0; i < 2; i++) {
        const f0 = base * rand(0.95, 1.05);
        notes.push({ f0, f1: f0 * rand(1.1, 1.3), dur: rand(0.25, 0.42), gap: rand(0.1, 0.2), fm: f0 * rand(0.06, 0.1), fmRate: rand(60, 90), amp: rand(0.5, 0.8) });
      }
      break;
    }
  }
  return notes;
}

/** One bird phrase: a single FM sine voice whose pitch and envelope are automated note by note. */
function birdPhrase(kit: Kit, dest: AudioNode): void {
  const notes = planPhrase();
  let total = 0;
  for (const n of notes) total += n.dur + n.gap;
  const v = kit.voice(rand(0.35, 1), rand(-0.85, 0.85), 0, PRI_AMBIENT, dest);
  if (!v) return;
  const t0 = v.t0;
  const end = t0 + total + 0.05;
  const car = v.osc('sine', notes[0].f0, t0, end);
  const mod = v.osc('sine', notes[0].fmRate, t0, end);
  const depth = v.gain(0);
  mod.connect(depth);
  depth.connect(car.frequency);
  const env = v.gain(0);
  car.connect(env);
  env.connect(v.out);
  let t = t0;
  for (const n of notes) {
    const att = Math.min(0.012, n.dur * 0.25);
    const rel = Math.min(0.02, n.dur * 0.3);
    glide(car.frequency, t, n.f0, n.f1, n.dur);
    depth.gain.setValueAtTime(n.fm, t);
    mod.frequency.setValueAtTime(n.fmRate, t);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(n.amp, t + att);
    env.gain.linearRampToValueAtTime(n.amp * 0.75, t + n.dur - rel);
    env.gain.linearRampToValueAtTime(0, t + n.dur);
    t += n.dur + n.gap;
  }
}

/** Distant car horn: two detuned square/saw tones a third or fourth apart, low-passed, sometimes a double honk. */
function horn(kit: Kit, dest: AudioNode, level: number): void {
  const v = kit.voice(level, rand(-0.8, 0.8), 0, PRI_AMBIENT, dest);
  if (!v) return;
  const t = v.t0;
  const f = rand(330, 470);
  const ratio = pick([1.2599, 1.1892, 1.3348]);
  const honks: [number, number][] = chance(0.35)
    ? [
        [0, rand(0.1, 0.17)],
        [rand(0.22, 0.3), rand(0.25, 0.55)],
      ]
    : [[0, rand(0.3, 0.8)]];
  const last = honks[honks.length - 1];
  const end = t + last[0] + last[1] + 0.05;
  const a = v.osc('square', f, t, end);
  a.detune.value = rand(-8, 8);
  const b = v.osc('sawtooth', f * ratio, t, end);
  b.detune.value = rand(-8, 8);
  const ga = v.gain(0.5);
  const gb = v.gain(0.42);
  const lp = v.filter('lowpass', rand(1100, 1700), 0.9);
  const hp = v.filter('highpass', 280, 0.7);
  const env = v.gain(0);
  a.connect(ga);
  b.connect(gb);
  ga.connect(lp);
  gb.connect(lp);
  lp.connect(hp);
  hp.connect(env);
  env.connect(v.out);
  for (const [off, dur] of honks) {
    const s = t + off;
    env.gain.setValueAtTime(0, s);
    env.gain.linearRampToValueAtTime(1, s + 0.02);
    env.gain.setValueAtTime(1, s + dur - 0.05);
    env.gain.linearRampToValueAtTime(0, s + dur);
    // The pitch sags slightly as the horn diaphragm starts.
    a.frequency.setValueAtTime(f * 0.97, s);
    a.frequency.linearRampToValueAtTime(f, s + 0.04);
    b.frequency.setValueAtTime(f * ratio * 0.97, s);
    b.frequency.linearRampToValueAtTime(f * ratio, s + 0.04);
  }
}

/** A single wave lapping against the pier: band-passed noise swell, sometimes with a droplet plip. */
function lap(kit: Kit, dest: AudioNode, level: number): void {
  const v = kit.voice(level * rand(0.5, 1), rand(-0.6, 0.6), 0, PRI_AMBIENT, dest);
  if (!v) return;
  const t = v.t0;
  const rise = rand(0.06, 0.16);
  const fall = rand(0.22, 0.5);
  const n = v.noise(kit.bank.white, t, t + rise + fall + 0.03);
  const f = rand(420, 950);
  const band = v.filter('bandpass', f, rand(1, 1.8));
  glide(band.frequency, t, f, f * rand(0.75, 0.95), rise + fall);
  const lp = v.filter('lowpass', 1800, 0.6);
  const g = v.gain(0);
  perc(g.gain, t, 0.5, rise, fall);
  n.connect(band);
  band.connect(lp);
  lp.connect(g);
  g.connect(v.out);
  if (chance(0.4)) {
    const tp = t + rand(0.05, 0.2);
    const fp = rand(600, 900);
    tone(v, tp, 'sine', fp, fp * 1.6, 0.03, 0.06, 0.002, 0.04);
  }
}

/** A raindrop tick on a nearby surface: a very short band-passed noise click. */
function drip(kit: Kit, dest: AudioNode, level: number): void {
  const v = kit.voice(level * rand(0.3, 1), rand(-0.9, 0.9), 0, PRI_AMBIENT, dest);
  if (!v) return;
  const t = v.t0;
  const n = v.noise(kit.bank.white, t, t + 0.05);
  const f = v.filter('bandpass', rand(2200, 5200), rand(1.5, 3));
  const g = v.gain(0);
  perc(g.gain, t, 1, 0.001, rand(0.008, 0.025));
  n.connect(f);
  f.connect(g);
  g.connect(v.out);
}

/** Thunder: low brown-noise rumble with a few rolling swells; close strikes start with a crack. */
function thunder(kit: Kit, dest: AudioNode, level: number, closeness: number): void {
  const v = kit.voice(level, rand(-0.5, 0.5), 0, PRI_SFX, dest);
  if (!v) return;
  const t = v.t0;
  const dur = rand(3.5, 6);
  const n = v.noise(kit.bank.brown, t, t + dur + 0.1);
  const lp = v.filter('lowpass', 120 + 160 * closeness, 0.7);
  const g = v.gain(0);
  n.connect(lp);
  lp.connect(g);
  g.connect(v.out);
  const p = g.gain;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(0.8, t + 0.12);
  let tt = t + 0.12;
  for (let i = 0; i < 4; i++) {
    tt += rand(0.35, 0.9);
    p.linearRampToValueAtTime(rand(0.35, 1), tt);
  }
  p.exponentialRampToValueAtTime(0.001, t + dur);
  p.linearRampToValueAtTime(0, t + dur + 0.05);
  if (closeness > 0.5) {
    const c = v.noise(kit.bank.white, t, t + 0.6);
    const bp = v.filter('bandpass', rand(700, 1100), 0.8);
    const cg = v.gain(0);
    perc(cg.gain, t, 0.6 * closeness, 0.004, 0.45);
    c.connect(bp);
    bp.connect(cg);
    cg.connect(v.out);
  }
}
