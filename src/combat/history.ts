/**
 * Ring buffers of entity positions for lag compensation: intents are checked
 * against where the target was at the time the client saw it (`viewT`).
 * Single player uses the same path (its view runs one combat tick behind).
 * Fixed capacity per slot, no allocation after construction.
 */
export class PosHistory {
  private readonly t: Float64Array;
  private readonly p: Float32Array;
  private readonly head: Int32Array;
  private readonly count: Int32Array;

  constructor(
    readonly slots: number,
    readonly cap = 24,
  ) {
    this.t = new Float64Array(slots * cap);
    this.p = new Float32Array(slots * cap * 3);
    this.head = new Int32Array(slots);
    this.count = new Int32Array(slots);
  }

  clear(slot: number): void {
    this.head[slot] = 0;
    this.count[slot] = 0;
  }

  /** Append a sample; times must not decrease. */
  record(slot: number, t: number, x: number, y: number, z: number): void {
    const cap = this.cap;
    const h = this.head[slot]!;
    const i = slot * cap + h;
    this.t[i] = t;
    this.p[i * 3] = x;
    this.p[i * 3 + 1] = y;
    this.p[i * 3 + 2] = z;
    this.head[slot] = (h + 1) % cap;
    if (this.count[slot]! < cap) this.count[slot]!++;
  }

  /** Number of samples held for a slot. */
  size(slot: number): number {
    return this.count[slot]!;
  }

  /**
   * Position at time `t`, linearly interpolated between the two samples around
   * it and clamped to the oldest and newest samples (no extrapolation).
   * Returns false when the slot holds no sample.
   */
  sample(slot: number, t: number, out: { x: number; y: number; z: number }): boolean {
    const n = this.count[slot]!;
    if (n === 0) return false;
    const cap = this.cap;
    const base = slot * cap;
    const newest = (this.head[slot]! - 1 + cap) % cap;
    // Walk back from the newest sample to the first one at or before t.
    let k = newest;
    for (let s = 0; s < n; s++) {
      const ti = this.t[base + k]!;
      if (ti <= t) {
        if (k === newest) return this.copy(base + k, out);
        const k1 = (k + 1) % cap;
        const t1 = this.t[base + k1]!;
        const f = t1 > ti ? (t - ti) / (t1 - ti) : 1;
        const a = (base + k) * 3,
          b = (base + k1) * 3;
        const p = this.p;
        out.x = p[a]! + (p[b]! - p[a]!) * f;
        out.y = p[a + 1]! + (p[b + 1]! - p[a + 1]!) * f;
        out.z = p[a + 2]! + (p[b + 2]! - p[a + 2]!) * f;
        return true;
      }
      if (s === n - 1) return this.copy(base + k, out);
      k = (k - 1 + cap) % cap;
    }
    return this.copy(base + newest, out);
  }

  private copy(i: number, out: { x: number; y: number; z: number }): boolean {
    out.x = this.p[i * 3]!;
    out.y = this.p[i * 3 + 1]!;
    out.z = this.p[i * 3 + 2]!;
    return true;
  }
}
