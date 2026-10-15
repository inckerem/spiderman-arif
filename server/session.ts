/**
 * One WebSocket connection (design M12 §6): `hello` within 5 s, then hero
 * states (binary), intents, pings and debug hooks, each under a token
 * bucket. Garbage closes the connection (1008); sustained flooding (10 s)
 * is a kick. Oversize frames never get here: ws closes them with 1009.
 * The socket is behind the small `Conn` interface so tests can drive a
 * session without a network.
 */
import { decodeHeroState, encodeMsg, parseClientMsg } from '../src/net/codec';
import { OP_STATE, makeHeroSample, type KickWhy, type ServerMsg } from '../src/net/protocol';
import { AbuseMeter, RATE, TokenBucket } from './limits';
import { silentLog, type Log } from './log';
import type { ManagedRoom, Peer, RoomManager } from './roomManager';

export interface Conn {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  terminate(): void;
  ping(): void;
  readonly bufferedAmount: number;
}

export interface SessionOptions {
  helloTimeoutMs?: number;
  log?: Log;
}

/** WebSocket close codes used by the server. */
export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  POLICY: 1008,
  TOO_BIG: 1009,
  REPLACED: 4001,
} as const;

const KICK_CODE: Record<KickWhy, number> = {
  cheat: CLOSE.POLICY,
  rate: CLOSE.POLICY,
  garbage: CLOSE.POLICY,
  timeout: CLOSE.NORMAL,
  idle: CLOSE.NORMAL,
  shutdown: CLOSE.GOING_AWAY,
  replaced: CLOSE.REPLACED,
};

export class Session implements Peer {
  mr: ManagedRoom | null = null;
  pid = 0;
  closed = false;
  /** Set by pong frames, cleared by each heartbeat. */
  alive = true;
  missedPings = 0;
  private pingSentAt = 0;
  private helloTimer: ReturnType<typeof setTimeout> | null;
  private readonly stateBucket = new TokenBucket(RATE.state.rate, RATE.state.burst);
  private readonly actBucket = new TokenBucket(RATE.act.rate, RATE.act.burst);
  private readonly otherBucket = new TokenBucket(RATE.other.rate, RATE.other.burst);
  private readonly abuse = new AbuseMeter();
  private readonly sample = makeHeroSample();
  private readonly log: Log;
  /** Messages dropped by the rate limits (tests read it). */
  dropped = 0;

  constructor(
    private readonly conn: Conn,
    readonly ip: string,
    private readonly manager: RoomManager,
    private readonly now: () => number,
    opts: SessionOptions = {},
  ) {
    this.log = opts.log ?? silentLog;
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      if (!this.mr && !this.closed) this.close(CLOSE.POLICY, 'hello timeout');
    }, opts.helloTimeoutMs ?? RATE.helloTimeoutMs);
  }

  // -------------------------------------------------------------------------
  // Peer

  deliver(m: ServerMsg | Uint8Array): void {
    if (this.closed) return;
    if (m instanceof Uint8Array) {
      if (this.conn.bufferedAmount > RATE.maxBufferedBytes) return; // slow link: skip high-rate state
      this.conn.send(m);
    } else {
      this.conn.send(encodeMsg(m));
    }
  }

  detach(why: KickWhy): void {
    this.mr = null;
    if (this.closed) return;
    this.deliver({ t: 'kick', why });
    this.close(KICK_CODE[why], why);
  }

  // -------------------------------------------------------------------------
  // Socket events

  onMessage(data: Uint8Array | string, isBinary: boolean): void {
    if (this.closed) return;
    const now = this.now();
    if (isBinary) {
      const bytes = typeof data === 'string' ? null : data;
      if (!bytes || !this.mr || bytes[0] !== OP_STATE) return this.kick('garbage');
      if (!this.stateBucket.take(now)) return this.overLimit(now);
      if (!decodeHeroState(bytes, this.sample)) return this.kick('garbage');
      this.mr.room.onState(this.pid, this.sample, bytes, now);
      return;
    }
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const m = parseClientMsg(text);
    if (!m) return this.kick('garbage');
    if (!this.mr) {
      if (m.t !== 'hello') return this.kick('garbage');
      this.clearHelloTimer();
      let r;
      try {
        r = this.manager.hello(this, m, now);
      } catch (e) {
        this.log.error('hello failed', { err: String(e) });
        r = { ok: false as const, why: 'server' as const };
      }
      if (!r.ok) {
        this.deliver({ t: 'reject', why: r.why });
        this.close(CLOSE.NORMAL, r.why);
        return;
      }
      this.mr = r.mr;
      this.pid = r.pid;
      return;
    }
    switch (m.t) {
      case 'act':
        if (!this.actBucket.take(now)) return this.overLimit(now);
        this.mr.room.onIntent(this.pid, m.i);
        return;
      case 'ping':
        if (!this.otherBucket.take(now)) return this.overLimit(now);
        this.deliver({ t: 'pong', c: m.c, s: now });
        return;
      case 'dbg':
        if (!this.otherBucket.take(now)) return this.overLimit(now);
        this.mr.room.onDebug(this.pid, m.op, m.a);
        return;
      case 'leave': {
        const mr = this.mr;
        this.mr = null;
        this.manager.release(mr, this.pid, this, false, 'leave', now);
        this.close(CLOSE.NORMAL, 'leave');
        return;
      }
      case 'hello':
        return this.kick('garbage');
    }
  }

  /** The socket closed (any reason; idempotent). An unexpected close keeps the slot for reconnects. */
  onClose(): void {
    this.clearHelloTimer();
    this.closed = true;
    const mr = this.mr;
    this.mr = null;
    if (mr) this.manager.release(mr, this.pid, this, true, 'disconnect', this.now());
  }

  onPong(): void {
    this.alive = true;
    this.missedPings = 0;
    if (this.mr && this.pingSentAt) this.mr.room.setRtt(this.pid, this.now() - this.pingSentAt);
  }

  /** Called every RATE.pingIntervalMs: pings, and terminates after two missed pongs. */
  heartbeat(): void {
    if (this.closed) return;
    if (!this.alive && ++this.missedPings >= RATE.missedPingsBeforeTerminate) {
      this.log.info('ping timeout', { ip: this.ip, pid: this.pid });
      this.conn.terminate();
      this.onClose();
      return;
    }
    this.alive = false;
    this.pingSentAt = this.now();
    this.conn.ping();
  }

  // -------------------------------------------------------------------------

  private overLimit(now: number): void {
    this.dropped++;
    if (this.abuse.hit(now)) this.kick('rate');
  }

  /** Kick from the session's own checks (garbage, flooding). */
  kick(why: KickWhy): void {
    if (this.closed) return;
    this.log.info('kick', { ip: this.ip, pid: this.pid, why });
    if (this.mr) this.mr.room.kick(this.pid, why); // → RoomOut.disconnect → detach
    if (!this.closed) this.detach(why);
  }

  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.clearHelloTimer();
    this.closed = true;
    this.conn.close(code, reason);
  }

  private clearHelloTimer(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }
}
