/**
 * Snapshot interpolation buffer (design M12 §4–5): remote heroes keep 32
 * samples keyed by room ms and render at roomNow − 100 ms. PURE and
 * allocation free after construction: samples are preallocated objects that
 * the caller fills through `push`.
 */

export const INTERP_CAPACITY = 32;
/** Render delay behind room time (s). */
export const RENDER_DELAY_S = 0.1;
/** Longest extrapolation past the newest sample on an underrun (ms). */
export const MAX_EXTRAPOLATE_MS = 150;

/** sample() results */
export const INTERP_EMPTY = 0;
export const INTERP_BETWEEN = 1;
/** Past the newest sample, extrapolated (≤ MAX_EXTRAPOLATE_MS). */
export const INTERP_AHEAD = 2;
/** Before the oldest sample, or extrapolation exhausted: held at the nearest sample. */
export const INTERP_HELD = 3;

export interface InterpOps<T> {
  create(): T;
  copy(src: T, dst: T): void;
  /** dst = a + (b − a)·f; f may exceed 1 when extrapolating. */
  lerp(a: T, b: T, f: number, dst: T): void;
  /** True when a → b must not be blended (teleport counter changed, ...). */
  snap?(a: T, b: T): boolean;
}

export class InterpBuffer<T> {
  private readonly items: T[] = [];
  private readonly times: number[] = [];
  /** Index of the oldest sample. */
  private head = 0;
  private count = 0;

  constructor(
    private readonly ops: InterpOps<T>,
    readonly capacity = INTERP_CAPACITY,
    readonly maxExtrapolateMs = MAX_EXTRAPOLATE_MS,
  ) {
    for (let i = 0; i < capacity; i++) {
      this.items.push(ops.create());
      this.times.push(0);
    }
  }

  get size(): number {
    return this.count;
  }

  /** Time of the newest sample (ms), or -Infinity. */
  get newest(): number {
    return this.count ? this.times[(this.head + this.count - 1) % this.capacity] : -Infinity;
  }

  get oldest(): number {
    return this.count ? this.times[this.head] : -Infinity;
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
  }

  /**
   * Appends a copy of `s` at time `t` (ms). Out-of-order or duplicate times
   * are dropped (returns false). A full buffer drops the oldest sample.
   */
  push(t: number, s: T): boolean {
    if (!Number.isFinite(t) || (this.count && t <= this.newest)) return false;
    let idx: number;
    if (this.count < this.capacity) {
      idx = (this.head + this.count) % this.capacity;
      this.count++;
    } else {
      idx = this.head;
      this.head = (this.head + 1) % this.capacity;
    }
    this.ops.copy(s, this.items[idx]);
    this.times[idx] = t;
    return true;
  }

  private at(i: number): number {
    return (this.head + i) % this.capacity;
  }

  /** Writes the state at time `t` (ms) into `out`; returns an INTERP_* code. */
  sample(t: number, out: T): number {
    const n = this.count;
    if (!n) return INTERP_EMPTY;
    const first = this.at(0);
    if (n === 1 || t <= this.times[first]) {
      this.ops.copy(this.items[first], out);
      return INTERP_HELD;
    }
    const last = this.at(n - 1);
    if (t >= this.times[last]) {
      const prev = this.at(n - 2);
      const a = this.items[prev];
      const b = this.items[last];
      const ta = this.times[prev];
      const tb = this.times[last];
      const ahead = Math.min(t - tb, this.maxExtrapolateMs);
      if (ahead <= 0 || (this.ops.snap && this.ops.snap(a, b))) {
        this.ops.copy(b, out);
        return ahead <= 0 ? INTERP_BETWEEN : INTERP_HELD;
      }
      this.ops.lerp(a, b, 1 + ahead / (tb - ta), out);
      return t - tb > this.maxExtrapolateMs ? INTERP_HELD : INTERP_AHEAD;
    }
    // Binary search for the pair around t.
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.times[this.at(mid)] <= t) lo = mid;
      else hi = mid;
    }
    const ia = this.at(lo);
    const ib = this.at(hi);
    const a = this.items[ia];
    const b = this.items[ib];
    if (this.ops.snap && this.ops.snap(a, b)) {
      this.ops.copy(a, out);
      return INTERP_BETWEEN;
    }
    this.ops.lerp(a, b, (t - this.times[ia]) / (this.times[ib] - this.times[ia]), out);
    return INTERP_BETWEEN;
  }
}

/** Shortest-arc angle blend (radians); f may exceed 1. */
export function lerpAngle(a: number, b: number, f: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}
