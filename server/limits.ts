/** Abuse limits: token buckets, sustained-abuse detection, connections per IP. */
import type { IncomingMessage } from 'node:http';

/** Classic token bucket: `rate` tokens per second, at most `burst` stored. */
export class TokenBucket {
  private tokens: number;
  private last = -1;

  constructor(
    readonly rate: number,
    readonly burst: number,
  ) {
    this.tokens = burst;
  }

  take(nowMs: number, n = 1): boolean {
    if (this.last >= 0) this.tokens = Math.min(this.burst, this.tokens + ((nowMs - this.last) / 1000) * this.rate);
    this.last = nowMs;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/**
 * Counts dropped (over-limit) messages. Drops that keep coming with gaps of
 * at most `gapMs` for `sustainMs` in a row are sustained abuse.
 */
export class AbuseMeter {
  private since = -1;
  private last = -1;

  constructor(
    readonly sustainMs = 10_000,
    readonly gapMs = 1_000,
  ) {}

  /** Record a drop; true once the abuse has been sustained. */
  hit(nowMs: number): boolean {
    if (this.since < 0 || nowMs - this.last > this.gapMs) this.since = nowMs;
    this.last = nowMs;
    return nowMs - this.since >= this.sustainMs;
  }
}

/** Open WebSocket connections per client address. */
export class ConnLimiter {
  private readonly counts = new Map<string, number>();

  constructor(readonly max: number) {}

  acquire(ip: string): boolean {
    const n = this.counts.get(ip) ?? 0;
    if (n >= this.max) return false;
    this.counts.set(ip, n + 1);
    return true;
  }

  release(ip: string): void {
    const n = (this.counts.get(ip) ?? 0) - 1;
    if (n > 0) this.counts.set(ip, n);
    else this.counts.delete(ip);
  }

  count(ip: string): number {
    return this.counts.get(ip) ?? 0;
  }
}

/**
 * The client address: the socket peer, or with `trustProxy` the last
 * X-Forwarded-For hop (the one our own proxy appended; earlier hops are client supplied).
 */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff.join(',') : xff;
    if (raw) {
      const hops = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Per-session message budgets (design M12 §6). */
export const RATE = {
  state: { rate: 30, burst: 40 },
  act: { rate: 15, burst: 15 },
  other: { rate: 5, burst: 10 },
  helloTimeoutMs: 5_000,
  pingIntervalMs: 20_000,
  missedPingsBeforeTerminate: 2,
  /** Hero state sends are skipped for a client whose socket has this much queued (slow link). */
  maxBufferedBytes: 256 * 1024,
} as const;
