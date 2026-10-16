/**
 * Online combat link (design M12 §4): the same `CombatLink` the game uses in
 * single player, over a WebSocket to the game server. Up: the hero's full
 * state at 20 Hz (binary 0x01, with its events, rope/zip anchors and combat
 * overlay), intents and pings. Down: enemy snapshots with the hero's own
 * combat state (into the CombatView), `ce` events, relayed remote hero states
 * (to the roster through `onRemoteState`), presence, the shared clock and
 * corrections. Reconnects with the room token after a drop (0.5, 1, 2, 4, 8 s).
 * Browser only through `WebSocket` and `performance` (both injectable).
 */
import { kindStats } from '../combat/roster';
import { ENEMY_KIND_COUNT, HERO_ID_BASE, type CombatEvent, type CombatIntent, type CrimeEventInfo, type EnemyKind, type HeroState } from '../combat/types';
import type { CombatView } from '../combat/client/combatView';
import { makeEnemySnap as makeViewSnap, makeSelfSnap, type CombatLink, type CombatSnapshot, type EnemySnap as ViewSnap } from '../combat/client/link';
import { MODE_TRAVERSE, MODE_WALL, MODE_ZIP, type Player, type PlayerEvent } from '../player/player';
import { ClockSync } from './clock';
import { ByteWriter, decodeEnemySnapshot, decodeHeroStates, encodeHeroState, encodeMsg, parseServerMsg } from './codec';
import type { MapId } from './maps';
import {
  HB,
  HF,
  NET,
  OP_ENEMIES,
  OP_STATES,
  PROTOCOL_VERSION,
  makeHeroSample,
  type ClientMsg,
  type HeroSample,
  type JoinRequest,
  type KickWhy,
  type LeftWhy,
  type NetEvent,
  type PlayerInfo,
  type RejectWhy,
  type RoomInfo,
  type ServerMsg,
} from './protocol';
import { makeEnemySnap as makeWireSnap, makeHeroCombatSnap, type DebugOp, type EnemySnap as WireSnap } from '../sim/types';

export type NetStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'closed';
export type ConnectResult = { ok: true; room: RoomInfo } | { ok: false; why: RejectWhy | 'unreachable' };

export interface NetLinkOptions {
  url: string;
  name: string;
  costume: string;
  map: MapId;
  join: JoinRequest;
  /** Reconnect token of an earlier session (sessionStorage), tried first. */
  token?: string;
  /** The local hero (its full state is uploaded). */
  player: Player;
  view: CombatView;
  connectTimeoutMs?: number;
  /** Local millisecond clock (default performance.now). */
  clock?: () => number;
  /** WebSocket constructor (tests). */
  socket?: typeof WebSocket;
}

/** Render delay behind room time (s). */
export const ONLINE_RENDER_DELAY = 0.1;
const UPLOAD_INTERVAL = 1 / NET.stateHz;
const PING_MS = 2000;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const MAX_EVENTS = NET.maxStateEvents;

export class NetLink implements CombatLink {
  readonly mode = 'online' as const;
  selfPid = 0;
  status: NetStatus = 'idle';
  room: RoomInfo | null = null;
  name = '';
  token = '';
  /** Health at welcome (the server keeps it across reconnects). */
  welcomeHp = 100;
  /** Other players in the room. */
  readonly players = new Map<number, PlayerInfo>();
  readonly clock = new ClockSync();
  /** Bumped on every deliberate teleport (respawn, recovery, correction): the server accepts the jump. */
  tp = 0;
  /** Bytes received and sent (diagnostics). */
  bytesIn = 0;
  bytesOut = 0;
  /** Connections lost and retried (diagnostics, tests). */
  drops = 0;

  // Hooks (the online controller wires them).
  onRemoteState: ((pid: number, s: HeroSample) => void) | null = null;
  onJoin: ((p: PlayerInfo) => void) | null = null;
  onLeft: ((pid: number, why: LeftWhy) => void) | null = null;
  onClock: ((hour: number, dayLen: number) => void) | null = null;
  onCorrect: ((x: number, y: number, z: number) => void) | null = null;
  onKick: ((why: KickWhy) => void) | null = null;
  onStatus: ((s: NetStatus) => void) | null = null;
  /** After a (re)connect: `resumed` when the server kept this player's slot. */
  onWelcome: ((resumed: boolean) => void) | null = null;

  private ws: WebSocket | null = null;
  private readonly opts: NetLinkOptions;
  private readonly now_: () => number;
  private readonly Socket: typeof WebSocket;
  private paused = false;
  private uploadAcc = 0;
  private seq = 0;
  private readonly sample = makeHeroSample();
  private readonly scratch = makeHeroSample();
  private readonly writer = new ByteWriter(256);
  private readonly pendingEvents: NetEvent[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closedByUs = false;
  private helloAt = 0;
  /** The room's active crime events at the last welcome (`syncCrimes`). */
  private welcomeEvents: CrimeEventInfo[] = [];
  // Snapshot conversion buffers.
  private readonly wire: WireSnap[] = [];
  private readonly viewSnaps: ViewSnap[] = [];
  private readonly self = makeSelfSnap();
  private readonly wireSelf = makeHeroCombatSnap();
  private readonly snap: CombatSnapshot = { t: 'snap', time: 0, count: 0, enemies: this.viewSnaps, self: null };

  constructor(opts: NetLinkOptions) {
    this.opts = opts;
    this.now_ = opts.clock ?? (() => performance.now());
    this.Socket = opts.socket ?? WebSocket;
    this.token = opts.token ?? '';
    for (let i = 0; i < NET.snapshotMax; i++) {
      this.wire.push(makeWireSnap());
      this.viewSnaps.push(makeViewSnap());
    }
  }

  get view(): CombatView {
    return this.opts.view;
  }

  // -------------------------------------------------------------------------
  // CombatLink

  /** Room time (s). */
  now(): number {
    return this.clock.now(this.now_()) / 1000;
  }

  renderTime(): number {
    return this.now() - ONLINE_RENDER_DELAY;
  }

  /** Every 120 Hz tick while playing: collect the hero's events, upload at 20 Hz. */
  tick(dt: number, _self: HeroState): void {
    this.collectEvents(this.opts.player.events);
    this.uploadAcc += dt;
    if (this.uploadAcc >= UPLOAD_INTERVAL) {
      this.uploadAcc %= UPLOAD_INTERVAL;
      this.upload();
    }
  }

  intent(i: CombatIntent): void {
    this.send({ t: 'act', i });
  }

  /** Paused online: the game keeps running for everyone else; the hero is away (ignored by enemies, cannot be hurt). */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.upload();
  }

  close(): void {
    this.closedByUs = true;
    this.clearTimers();
    if (this.ws && this.ws.readyState === this.Socket.OPEN) this.send({ t: 'leave' });
    this.ws?.close(1000);
    this.ws = null;
    this.setStatus('closed');
  }

  // -------------------------------------------------------------------------
  // Connection

  /** Opens the socket and says hello; resolves on welcome, reject, or after the connect timeout. */
  connect(): Promise<ConnectResult> {
    this.closedByUs = false;
    this.setStatus('connecting');
    return this.open(this.opts.connectTimeoutMs ?? 4000);
  }

  private open(timeoutMs: number): Promise<ConnectResult> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: ConnectResult): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      let ws: WebSocket;
      try {
        ws = new this.Socket(this.opts.url);
      } catch {
        resolve({ ok: false, why: 'unreachable' });
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.onclose = null;
        ws.close();
        if (this.ws === ws) this.ws = null;
        finish({ ok: false, why: 'unreachable' });
      }, timeoutMs);
      ws.onopen = () => {
        this.helloAt = this.now_();
        const hello: ClientMsg = { t: 'hello', v: PROTOCOL_VERSION, name: this.opts.name, costume: this.opts.costume, map: this.opts.map, join: this.opts.join };
        if (this.token) hello.token = this.token;
        this.send(hello);
      };
      ws.onerror = () => undefined;
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        if (!done) finish({ ok: false, why: 'unreachable' });
        else this.lost();
      };
      ws.onmessage = (ev) => {
        const data = ev.data as ArrayBuffer | string;
        if (typeof data === 'string') {
          this.bytesIn += data.length;
          const m = parseServerMsg(data);
          if (!m) return;
          if (m.t === 'welcome') {
            this.onWelcomeMsg(m);
            finish({ ok: true, room: m.room });
          } else if (m.t === 'reject') {
            finish({ ok: false, why: m.why });
          } else this.onText(m);
        } else {
          this.bytesIn += data.byteLength;
          this.onBinary(new Uint8Array(data));
        }
      };
    });
  }

  private onWelcomeMsg(m: Extract<ServerMsg, { t: 'welcome' }>): void {
    const resumed = this.selfPid === m.pid && this.token === m.token;
    this.selfPid = m.pid;
    this.name = m.name;
    this.token = m.token;
    this.room = m.room;
    this.welcomeHp = m.hp;
    this.opts.view.selfPid = m.pid;
    // First clock estimate from the hello → welcome round trip; pings refine it.
    this.clock.onPong(this.helloAt, m.now, this.now_());
    this.players.clear();
    for (const p of m.players) this.players.set(p.pid, p);
    this.welcomeEvents = m.events;
    this.syncCrimes();
    this.onClock?.(m.clock.hour, m.clock.dayLen);
    this.attempt = 0;
    this.clearTimers();
    this.pingTimer = setInterval(() => this.send({ t: 'ping', c: this.now_() }), PING_MS);
    this.setStatus('online');
    this.onWelcome?.(resumed);
    this.upload();
  }

  /**
   * Brings the view's crime events in line with the last welcome: events that
   * ended while this client was away are dropped (no result is known), the
   * ones still running update their count, and new ones arrive as `evStart`
   * (the HUD announces them). The online controller calls it again after the
   * new game has reset the view.
   */
  syncCrimes(): void {
    const view = this.opts.view;
    const list = this.welcomeEvents;
    for (let i = view.crimes.length - 1; i >= 0; i--) if (!list.some((e) => e.id === view.crimes[i]!.id)) view.crimes.splice(i, 1);
    const fresh: CombatEvent[] = [];
    for (const ev of list) {
      const known = view.crimes.find((c) => c.id === ev.id);
      if (known) known.enemiesLeft = ev.enemiesLeft;
      else fresh.push({ e: 'evStart', ev: { ...ev } });
    }
    if (fresh.length) view.apply({ t: 'ce', time: this.now(), ev: fresh });
  }

  /** The socket dropped while playing: reconnect with the token (backoff), then give up. */
  private lost(): void {
    this.clearTimers();
    if (this.closedByUs || this.status === 'closed') return;
    if (this.attempt >= BACKOFF_MS.length) {
      this.setStatus('closed');
      this.onKick?.('timeout');
      return;
    }
    if (this.attempt === 0) this.drops++;
    this.setStatus('reconnecting');
    const wait = BACKOFF_MS[this.attempt++];
    this.retryTimer = setTimeout(() => {
      void this.open(4000).then((r) => {
        if (this.closedByUs) return;
        if (!r.ok) {
          if (r.why === 'unreachable') this.lost();
          else {
            this.setStatus('closed');
            this.onKick?.('timeout');
          }
        }
      });
    }, wait);
  }

  /** Server test hooks (only a TEST_HOOKS server acts on them). */
  debug(op: DebugOp, a: number[]): void {
    this.send({ t: 'dbg', op, a });
  }

  /** Test hook: drop the socket as a network failure would. */
  dropSocket(): void {
    this.ws?.close(4000);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = null;
    this.retryTimer = null;
  }

  private setStatus(s: NetStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.onStatus?.(s);
  }

  private send(m: ClientMsg): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== this.Socket.OPEN) return;
    const text = encodeMsg(m);
    this.bytesOut += text.length;
    ws.send(text);
  }

  // -------------------------------------------------------------------------
  // Down

  private onText(m: ServerMsg): void {
    switch (m.t) {
      case 'ce': {
        for (const e of m.ev) this.noteEvent(e);
        this.opts.view.apply({ t: 'ce', time: this.now(), ev: m.ev });
        break;
      }
      case 'join':
        this.players.set(m.pid, { pid: m.pid, name: m.name, costume: m.costume });
        this.onJoin?.({ pid: m.pid, name: m.name, costume: m.costume });
        break;
      case 'left':
        this.players.delete(m.pid);
        this.onLeft?.(m.pid, m.why);
        break;
      case 'clock':
        this.onClock?.(m.hour, m.dayLen);
        break;
      case 'pong':
        this.clock.onPong(m.c, m.s, this.now_());
        break;
      case 'correct':
        this.tp = (this.tp + 1) & 0xff;
        this.onCorrect?.(m.x, m.y, m.z);
        this.upload();
        break;
      case 'kick':
        this.closedByUs = true;
        this.setStatus('closed');
        this.onKick?.(m.why);
        break;
      default:
        break;
    }
  }

  private noteEvent(e: CombatEvent): void {
    // The room moved this hero (knockout → roof): that jump is a teleport.
    if (e.e === 'respawn' && e.pid === this.selfPid) this.tp = (this.tp + 1) & 0xff;
  }

  private onBinary(b: Uint8Array): void {
    if (b[0] === OP_STATES) {
      decodeHeroStates(b, this.scratch, (pid, s) => this.onRemoteState?.(pid, s));
    } else if (b[0] === OP_ENEMIES) {
      const r = decodeEnemySnapshot(b, this.wire, makeWireSnap, this.wireSelf);
      if (!r) return;
      const time = r.roomMs / 1000;
      for (let i = 0; i < r.count; i++) {
        const w = this.wire[i];
        const v = this.viewSnaps[i];
        const maxHp = w.kind < ENEMY_KIND_COUNT ? kindStats(w.kind as EnemyKind).hp : 100;
        v.id = w.id;
        v.kind = w.kind;
        v.state = w.state;
        v.x = w.x;
        v.y = w.y;
        v.z = w.z;
        v.yaw = w.yaw;
        v.maxHp = maxHp;
        v.hp = w.hp * maxHp;
        v.guard = w.guard;
        v.anim = w.anim;
        v.animT0 = time - w.animT;
        v.flags = w.flags;
        v.target = w.target ? HERO_ID_BASE + w.target : -1;
      }
      const s = this.snap;
      s.time = time;
      s.count = r.count;
      if (r.hasSelf) Object.assign(this.self, this.wireSelf);
      s.self = r.hasSelf ? this.self : null;
      this.opts.view.apply(s);
    }
  }

  // -------------------------------------------------------------------------
  // Up

  private collectEvents(events: readonly PlayerEvent[]): void {
    for (const e of events) {
      if (e.type === 'respawn' || e.type === 'recover' || e.type === 'revive') this.tp = (this.tp + 1) & 0xff;
      if (this.pendingEvents.length < MAX_EVENTS) this.pendingEvents.push({ ...e } as NetEvent);
    }
  }

  /** Builds the hero's state from the Player and sends it (0x01). */
  private upload(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== this.Socket.OPEN || this.status !== 'online') return;
    const p = this.opts.player;
    const s = this.sample;
    s.seq = this.seq++ & 0xffff;
    s.t = this.clock.now(this.now_());
    s.x = p.pos.x;
    s.y = p.pos.y;
    s.z = p.pos.z;
    s.vx = p.vel.x;
    s.vy = p.vel.y;
    s.vz = p.vel.z;
    s.facing = p.facing;
    s.mode = p.mode;
    const rope = p.rope;
    let flags = 0;
    if (p.grounded) flags |= HF.GROUNDED;
    if (p.diving) flags |= HF.DIVING;
    if (rope.attached) flags |= HF.ROPE_ATTACHED;
    if (rope.firing) flags |= HF.ROPE_FIRING;
    if ((p.mode === MODE_ZIP ? p.zip.hand : rope.hand) === 1) flags |= HF.HAND_RIGHT;
    if (this.opts.view.self.down) flags |= HF.DOWN;
    if (this.paused) flags |= HF.AFK | HF.PAUSED;
    s.flags = flags;
    let blocks = 0;
    if (rope.attached || rope.firing) {
      blocks |= HB.ANCHOR;
      s.ax = rope.anchor.x;
      s.ay = rope.anchor.y;
      s.az = rope.anchor.z;
    }
    if (p.mode === MODE_ZIP) {
      blocks |= HB.ANCHOR | HB.ZIP;
      s.ax = p.zip.tx;
      s.ay = p.zip.ty;
      s.az = p.zip.tz;
      s.zx = p.zip.ex;
      s.zy = p.zip.ey;
      s.zz = p.zip.ez;
    }
    if (p.mode === MODE_WALL) {
      blocks |= HB.WALL;
      s.wnx = p.wall.nx;
      s.wnz = p.wall.nz;
      s.wrun = p.wall.run;
    }
    if (p.mode === MODE_TRAVERSE) {
      blocks |= HB.TRAV;
      s.travKind = p.trav.kind;
      s.travT = p.trav.t;
      s.travDur = p.trav.dur;
    }
    s.blocks = blocks;
    s.tp = this.tp;
    const ca = p.combatAnim;
    const age = p.time - ca.t0;
    if (ca.action !== 0 && age >= 0 && age < ca.dur + 0.5) {
      s.action = ca.action;
      s.actionSide = ca.side;
      s.actionT = age;
      s.actionDur = ca.dur;
    } else {
      s.action = 0;
      s.actionT = 0;
      s.actionDur = 0;
    }
    s.events = this.pendingEvents;
    const bytes = encodeHeroState(s, this.writer);
    this.pendingEvents.length = 0;
    this.bytesOut += bytes.length;
    ws.send(bytes as Uint8Array<ArrayBuffer>);
  }
}
