/**
 * Music loader and seamless looper.
 *
 * The track is fetched and decoded once. Leading/trailing near-silence is
 * trimmed so the loop seam sits on audible material, and the level is
 * normalised to a fixed RMS. The loop plays as overlapping
 * AudioBufferSourceNodes, each with its own GainNode, crossfaded with
 * equal-power curves: instance n+1 starts at start(n) + span - crossfade.
 * Instances are scheduled ahead on the AudioContext clock (at least two loops
 * and 45 s), so a paused or throttled main thread never causes a gap; pump()
 * only tops the queue up. `restart` fades the running chain out in a few
 * milliseconds and starts a new one from the top of the track (the rooftop
 * moment); each chain has its own gain node, so the fade never fights the
 * instances' crossfade automation.
 */
import { applyCurve, clamp, fadeCurve } from './dsp';

/** Crossfade at the loop point (clamped to a quarter of the loop for short files). */
const CROSSFADE = 2.5;
/** Fade-in of the very first start (keeps the intro's punch without a click). */
const FIRST_FADE = 0.04;
/** Minimum time scheduled ahead of the audio clock. */
const LOOKAHEAD = 45;
/** Upper bound on simultaneously scheduled loop instances (very short files). */
const MAX_LIVE = 8;
/** Target RMS after normalisation (about -20 dBFS). */
const TARGET_RMS = 0.1;
/** Fade-out of the old chain on a restart. */
const RESTART_FADE = 0.04;

interface Instance {
  src: AudioBufferSourceNode;
  gain: GainNode;
  /** The chain gain node it plays through. */
  chain: GainNode;
  /** Start time on the audio clock. */
  at: number;
}

/** A failure whose message is already user-facing. */
class MusicError extends Error {}

function describe(e: unknown): string {
  if (e instanceof Error) {
    if (e.name && e.message) return `${e.name}: ${e.message}`;
    return e.message || e.name || 'unknown error';
  }
  if (typeof e === 'string' && e) return e;
  return 'unknown error';
}

/** decodeAudioData wrapper accepting both the promise and the legacy callback forms (older Safari). */
function decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    let settled = false;
    const ok = (b: AudioBuffer): void => {
      if (settled) return;
      settled = true;
      if (b && b.length > 0) resolve(b);
      else reject(new Error('the decoded buffer is empty'));
    };
    const bad = (e: unknown): void => {
      if (settled) return;
      settled = true;
      reject(e ?? new Error('decodeAudioData failed'));
    };
    try {
      const p = ctx.decodeAudioData(data, ok, bad);
      if (p && typeof p.then === 'function') p.then(ok, bad);
    } catch (e) {
      bad(e);
    }
  });
}

interface Analysis {
  /** Start of the audible span, seconds. */
  start: number;
  /** End of the audible span, seconds. */
  end: number;
  rms: number;
}

/** Finds the audible span (trimming near-silence at both ends, at most 15 % each) and the RMS of a track. */
function analyse(b: AudioBuffer): Analysis {
  const n = b.length;
  const sr = b.sampleRate;
  const chans: Float32Array[] = [];
  for (let c = 0; c < b.numberOfChannels; c++) chans.push(b.getChannelData(c));
  // Level statistics on a sparse subsample (about 30k frames, accurate to a fraction of a dB) keep this cheap.
  const step = Math.max(1, Math.floor(n / 30000));
  let sum = 0;
  let count = 0;
  let peak = 0;
  for (let i = 0; i < n; i += step) {
    for (const d of chans) {
      const v = d[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    count += chans.length;
  }
  const rms = Math.sqrt(sum / Math.max(1, count));
  const threshold = Math.max(peak * 0.003, 1e-4);
  const audible = (i: number): boolean => {
    for (const d of chans) if (Math.abs(d[i]) > threshold) return true;
    return false;
  };
  // Coarse-to-fine scans: hop 32 frames until sound is found, then refine to the exact frame.
  const hop = 32;
  const maxTrim = Math.floor(n * 0.15);
  let first = 0;
  while (first < maxTrim && !audible(first)) first += hop;
  first = Math.max(0, first - hop);
  while (first < maxTrim && !audible(first)) first++;
  const lastMin = n - 1 - maxTrim;
  let last = n - 1;
  while (last > lastMin && last > first && !audible(last)) last -= hop;
  last = Math.min(n - 1, last + hop);
  while (last > lastMin && last > first && !audible(last)) last--;
  const margin = Math.floor(0.01 * sr);
  first = Math.max(0, first - margin);
  last = Math.min(n - 1, last + margin);
  return { start: first / sr, end: (last + 1) / sr, rms };
}

export class MusicLoop {
  loaded = false;
  /** Decoded duration of the file, seconds. */
  duration = 0;
  error: string | null = null;
  /** Loop instances scheduled so far. */
  scheduled = 0;
  /** Restarts from the top so far. */
  restarts = 0;
  private buffer: AudioBuffer | null = null;
  private offset = 0;
  private span = 0;
  private xf = 0;
  private nextStart = 0;
  private chainEnd = -1;
  private started = false;
  private requested = false;
  private readonly live: Instance[] = [];
  private chain: GainNode | null = null;
  private readonly fadeIn = fadeCurve(64, true);
  private readonly fadeOut = fadeCurve(64, false);

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
    private readonly url: string,
    private readonly onLevel: (gain: number) => void,
  ) {}

  /** Starts fetching and decoding the track (once); playback begins as soon as it is decoded. */
  load(): void {
    if (this.requested) return;
    this.requested = true;
    const url = this.url;
    if (typeof fetch !== 'function') {
      this.fail(`"${url}" could not be fetched (fetch is not available)`);
      return;
    }
    let stage: 'fetch' | 'decode' | 'play' = 'fetch';
    fetch(url)
      .then((res) => {
        if (!res.ok) {
          throw new MusicError(`"${url}" is missing (HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''})`);
        }
        const type = (res.headers.get('content-type') ?? '').toLowerCase();
        if (type.includes('text/html')) {
          throw new MusicError(`"${url}" is missing (the server returned an HTML page instead of audio)`);
        }
        return res.arrayBuffer();
      })
      .then((data) => {
        stage = 'decode';
        return decode(this.ctx, data);
      })
      // Analyse in a task of its own rather than on top of the decode hand-off, to keep frames short.
      .then((buffer) => new Promise<AudioBuffer>((resolve) => setTimeout(() => resolve(buffer), 0)))
      .then((buffer) => {
        stage = 'play';
        this.ready(buffer);
      })
      .catch((e: unknown) => {
        let reason: string;
        if (e instanceof MusicError) reason = e.message;
        else if (stage === 'decode') reason = `"${url}" could not be decoded (${describe(e)}), so the file is unplayable`;
        else if (stage === 'play') reason = `"${url}" could not be played (${describe(e)})`;
        else reason = `"${url}" could not be fetched (${describe(e)})`;
        this.fail(reason);
      });
  }

  /** Keeps at least two loops (and LOOKAHEAD seconds) scheduled ahead of the audio clock. */
  pump(): void {
    if (!this.buffer) return;
    const now = this.ctx.currentTime;
    const period = this.span - this.xf;
    if (!this.started || this.chainEnd < now + 0.05) {
      // First start, or the clock ran past everything scheduled: start fresh with a short fade-in.
      this.started = true;
      this.schedule(now + 0.06, FIRST_FADE);
    } else if (this.nextStart < now + 0.02) {
      // The next loop's start slipped into the past: join now, fading in over what is left of the crossfade.
      const t = now + 0.02;
      this.schedule(t, Math.max(0.05, this.chainEnd - t));
    }
    const horizon = now + Math.max(2 * period + 1, LOOKAHEAD);
    for (let guard = 0; guard < MAX_LIVE && this.nextStart < horizon && this.live.length < MAX_LIVE; guard++) {
      this.schedule(this.nextStart, this.xf);
    }
  }

  /** Live loop instances (playing or scheduled). */
  get liveCount(): number {
    return this.live.length;
  }

  /**
   * Starts the track again from the top in `delay` seconds: the running chain
   * fades out over RESTART_FADE and stops, instances not yet started are
   * dropped. Before the track is decoded this does nothing (the first start
   * plays from the top anyway).
   */
  restart(delay = 0.1): void {
    if (!this.buffer) return;
    const now = this.ctx.currentTime;
    const old = this.chain;
    if (old) {
      old.gain.cancelScheduledValues(now);
      old.gain.setValueAtTime(1, now);
      old.gain.linearRampToValueAtTime(0, now + RESTART_FADE);
    }
    this.chain = null;
    const stopAt = now + RESTART_FADE + 0.01;
    for (const inst of [...this.live]) {
      if (inst.at >= stopAt) {
        // Not playing yet: drop it now.
        try {
          inst.src.stop();
        } catch {
          // Never started.
        }
        this.ended(inst);
      } else {
        try {
          inst.src.stop(stopAt);
        } catch {
          // Already stopped.
        }
      }
    }
    this.started = true;
    this.restarts++;
    this.schedule(now + Math.max(delay, RESTART_FADE), FIRST_FADE);
    this.pump();
  }

  private fail(reason: string): void {
    if (this.error) return;
    this.error = reason;
    console.warn(`[skythread] music: ${reason}. The game continues without music.`);
  }

  private ready(buffer: AudioBuffer): void {
    const a = analyse(buffer);
    this.buffer = buffer;
    this.offset = a.start;
    this.span = Math.max(0.05, a.end - a.start);
    this.xf = Math.min(CROSSFADE, this.span / 4);
    this.duration = buffer.duration;
    this.loaded = true;
    this.onLevel(a.rms > 1e-5 ? clamp(TARGET_RMS / a.rms, 0.4, 1.6) : 1);
    this.pump();
  }

  private schedule(t: number, fade: number): void {
    const b = this.buffer;
    if (!b) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = b;
    const g = ctx.createGain();
    const outAt = t + this.span - this.xf;
    applyCurve(g.gain, this.fadeIn, t, clamp(fade, 0.005, Math.max(0.005, this.span - this.xf - 0.01)));
    applyCurve(g.gain, this.fadeOut, outAt, this.xf);
    let chain = this.chain;
    if (!chain) {
      chain = this.chain = ctx.createGain();
      chain.connect(this.out);
    }
    src.connect(g);
    g.connect(chain);
    src.start(t, this.offset, this.span);
    const inst: Instance = { src, gain: g, chain, at: t };
    src.onended = () => this.ended(inst);
    this.live.push(inst);
    this.scheduled++;
    this.nextStart = outAt;
    this.chainEnd = t + this.span;
  }

  private ended(inst: Instance): void {
    inst.src.onended = null;
    try {
      inst.src.disconnect();
      inst.gain.disconnect();
    } catch {
      // Already disconnected.
    }
    const i = this.live.indexOf(inst);
    if (i >= 0) this.live.splice(i, 1);
    // The last instance of an old chain: release its gain node.
    if (inst.chain !== this.chain && !this.live.some((o) => o.chain === inst.chain)) {
      try {
        inst.chain.disconnect();
      } catch {
        // Already disconnected.
      }
    }
  }
}
