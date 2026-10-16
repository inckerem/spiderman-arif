/**
 * Room clock helpers (design M12 §2 "Clock sync", §4 "Clock"). PURE: the
 * caller passes its local millisecond clock in, so this runs the same in the
 * browser, in Node and in tests.
 */

export interface ClockSample {
  /** Round trip (ms). */
  rtt: number;
  /** server time − local time at the middle of the round trip (ms). */
  offset: number;
}

/**
 * Estimates room time from ping/pong pairs: keeps the last 8 samples and
 * targets the offset of the one with the smallest round trip (least queueing).
 * The applied offset follows the first few samples and large corrections
 * directly, and slews small ones at ≤ 5 ms per second, so room time never
 * visibly jumps or runs backwards much once settled.
 */
export class ClockSync {
  static readonly SAMPLES = 8;
  static readonly SLEW_MS_PER_S = 5;
  /**
   * A target this far off (ms) is taken at once instead of slewed: the first
   * estimates can carry a long round trip (a busy page), and a 5 ms/s slew
   * would take minutes to undo that. Small refinements are slewed.
   */
  static readonly SNAP_MS = 100;
  /** The first samples always set the offset directly. */
  static readonly WARMUP = 4;

  readonly samples: ClockSample[] = [];
  /** Applied offset: roomNow = local + offset. */
  offset = 0;
  /** Offset of the best sample (what `offset` slews toward). */
  target = 0;
  /** Round trip of the best sample (ms), Infinity before the first. */
  rtt = Infinity;
  private synced = false;
  private lastLocal = 0;

  get ready(): boolean {
    return this.synced;
  }

  /** A pong arrived: `c` = local ms the ping was sent, `s` = server ms in the pong, `local` = local ms now. */
  onPong(c: number, s: number, local: number): void {
    const rtt = Math.max(0, local - c);
    const offset = s - (c + rtt / 2);
    this.samples.push({ rtt, offset });
    if (this.samples.length > ClockSync.SAMPLES) this.samples.shift();
    let best = this.samples[0];
    for (const x of this.samples) if (x.rtt < best.rtt) best = x;
    this.target = best.offset;
    this.rtt = best.rtt;
    if (!this.synced || this.samples.length < ClockSync.WARMUP || Math.abs(this.target - this.offset) > ClockSync.SNAP_MS) {
      this.offset = this.target;
      this.synced = true;
      this.lastLocal = local;
    }
  }

  /** Room time (ms) for a local time; advances the slew. */
  now(local: number): number {
    if (this.synced) {
      const dt = Math.max(0, local - this.lastLocal) / 1000;
      const step = ClockSync.SLEW_MS_PER_S * dt;
      const d = this.target - this.offset;
      this.offset += d > step ? step : d < -step ? -step : d;
    }
    this.lastLocal = local;
    return local + this.offset;
  }

  reset(): void {
    this.samples.length = 0;
    this.offset = 0;
    this.target = 0;
    this.rtt = Infinity;
    this.synced = false;
  }
}

// ---------------------------------------------------------------------------
// Shared day-night clock

/** Hours per real second for a day of `dayLenMin` real minutes. */
export const hoursPerSecond = (dayLenMin: number): number => 24 / (Math.max(0.5, dayLenMin) * 60);

export const wrapHour = (h: number): number => ((h % 24) + 24) % 24;

/** Shortest signed difference to − from in hours, in (-12, 12]. */
export function hourDelta(from: number, to: number): number {
  let d = wrapHour(to) - wrapHour(from);
  if (d > 12) d -= 24;
  else if (d <= -12) d += 24;
  return d;
}

/** The authoritative per-room hour (server and LocalLink). */
export class DayClock {
  constructor(
    public hour: number,
    /** Real minutes per in-game day. */
    public dayLen: number,
  ) {
    this.hour = wrapHour(hour);
  }

  advance(dtSeconds: number): void {
    this.hour = wrapHour(this.hour + dtSeconds * hoursPerSecond(this.dayLen));
  }
}

/** Off by more than this (hours), a client snaps to the room hour instead of blending. */
export const HOUR_SNAP = 0.05;
/** Blend time (s) toward the room hour. */
export const HOUR_BLEND_S = 2;

/**
 * Client side: pulls a locally advancing hour toward the room hour, wrap
 * aware. Snaps when off by more than HOUR_SNAP, otherwise closes the gap
 * exponentially with a time constant of HOUR_BLEND_S / 3 (≈ 95 % in 2 s).
 */
export function pullHour(local: number, room: number, dt: number): number {
  const d = hourDelta(local, room);
  if (Math.abs(d) > HOUR_SNAP) return wrapHour(room);
  const k = 1 - Math.exp((-3 * dt) / HOUR_BLEND_S);
  return wrapHour(local + d * k);
}
