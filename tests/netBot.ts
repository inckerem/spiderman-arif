/**
 * Raw WebSocket bot for server tests (Node `ws`, the real protocol and codec).
 * Used by tests/serverE2e.spec.ts; the browser net tests (M12 part 2) can
 * fill rooms with it.
 */
import WebSocket from 'ws';
import { decodeHeroStates, encodeHeroState, encodeMsg, parseServerMsg } from '../src/net/codec';
import { HF, OP_STATES, PROTOCOL_VERSION, makeHeroSample, type ClientMsg, type HeroSample, type JoinRequest, type ServerMsg } from '../src/net/protocol';

export type Welcome = Extract<ServerMsg, { t: 'welcome' }>;

export interface BotOptions {
  name: string;
  join?: JoinRequest;
  costume?: string;
  token?: string;
  origin?: string;
}

export class NetBot {
  readonly msgs: ServerMsg[] = [];
  /** Latest relayed state per remote pid, with the local receive time. */
  readonly remotes = new Map<number, { s: HeroSample; at: number; count: number }>();
  welcome: Welcome | null = null;
  closeCode = 0;
  closed = false;
  seq = 0;
  tp = 0;
  private welcomeAt = 0;
  readonly self: HeroSample = makeHeroSample();
  private readonly scratch = makeHeroSample();
  private waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = 'nodebuffer';
    ws.on('message', (data, isBinary) => {
      const buf = data as Buffer;
      if (isBinary) {
        const b = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        if (b[0] === OP_STATES) {
          decodeHeroStates(b, this.scratch, (pid, s) => {
            const prev = this.remotes.get(pid);
            const copy = makeHeroSample();
            Object.assign(copy, s, { events: s.events.slice() });
            this.remotes.set(pid, { s: copy, at: Date.now(), count: (prev?.count ?? 0) + 1 });
          });
        }
      } else {
        const m = parseServerMsg(buf.toString('utf8'));
        if (m) {
          this.msgs.push(m);
          if (m.t === 'welcome') {
            this.welcome = m;
            this.welcomeAt = performance.now();
          }
        }
      }
      this.wake();
    });
    ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
      this.wake();
    });
    ws.on('error', () => {});
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** Opens a socket (rejects on HTTP refusal, e.g. 429). */
  static open(url: string, origin?: string): Promise<NetBot> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, origin ? { origin } : undefined);
      const bot = new NetBot(ws);
      ws.once('open', () => resolve(bot));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', (e) => reject(e));
    });
  }

  /** Opens, says hello and waits for welcome or reject. */
  static async join(url: string, o: BotOptions): Promise<NetBot> {
    const bot = await NetBot.open(url, o.origin);
    bot.send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      name: o.name,
      costume: o.costume ?? 'redNavy',
      map: 'manhattan',
      join: o.join ?? { kind: 'public' },
      ...(o.token ? { token: o.token } : {}),
    });
    await bot.until(() => bot.msgs.some((m) => m.t === 'welcome' || m.t === 'reject') || bot.closed, 5000);
    return bot;
  }

  /** Estimated room time (ms): the welcome's `now` plus the local time since. */
  roomNow(): number {
    return this.welcome ? this.welcome.now + (performance.now() - this.welcomeAt) : 0;
  }

  get pid(): number {
    return this.welcome?.pid ?? 0;
  }

  get rejected(): string | null {
    const r = this.msgs.find((m) => m.t === 'reject');
    return r && r.t === 'reject' ? r.why : null;
  }

  send(m: ClientMsg): void {
    this.ws.send(encodeMsg(m));
  }

  sendRaw(data: string | Uint8Array): void {
    this.ws.send(data);
  }

  /** Sends the own hero state at (x, y, z) with room time `t` (ms). */
  state(x: number, y: number, z: number, t: number, extra: Partial<HeroSample> = {}): void {
    const s = this.self;
    Object.assign(s, { seq: this.seq++ & 0xffff, t, x, y, z, flags: HF.GROUNDED, tp: this.tp, events: [] }, extra);
    this.ws.send(encodeHeroState(s));
  }

  of<T extends ServerMsg['t']>(t: T): Array<Extract<ServerMsg, { t: T }>> {
    return this.msgs.filter((m) => m.t === t) as Array<Extract<ServerMsg, { t: T }>>;
  }

  /** Resolves when `pred` holds (checked after every message), rejects after `ms`. */
  until(pred: () => boolean, ms = 5000): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for condition')), ms);
      const check = (): void => {
        if (pred()) {
          clearTimeout(timer);
          resolve();
        } else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.ws.close(1000);
    return this.until(() => this.closed, 3000).catch(() => this.ws.terminate());
  }

  /** Drops the connection without a close handshake (network loss). */
  cut(): void {
    this.ws.terminate();
  }
}
