/**
 * Rooms on the server (design M12 §6): one public room per map that
 * overflows into "#2", "#3", ... when full, private rooms by 6-character
 * code, reconnect tokens. Owns the routing from room pids to connections.
 */
import { randomInt } from 'node:crypto';
import { MAPS, type MapId } from '../src/net/maps';
import { isRoomCode, makeRoomCode, normalizeRoomCode, PROTOCOL_VERSION, type ClientMsg, type KickWhy, type LeftWhy, type RejectWhy, type ServerMsg } from '../src/net/protocol';
import { buildMapRuntime } from '../src/sim/mapRuntime';
import { nullSimFactory } from '../src/sim/nullSim';
import { Room } from '../src/sim/room';
import type { MapRuntime, RoomSimFactory } from '../src/sim/types';
import { silentLog, type Log } from './log';

/** A connection as the rooms see it. */
export interface Peer {
  /** Send a message to this connection. */
  deliver(m: ServerMsg | Uint8Array): void;
  /** Send `kick` and close; the slot is already gone or handed over. */
  detach(why: KickWhy): void;
}

export interface ManagedRoom {
  readonly room: Room;
  readonly map: MapId;
  readonly publicRoom: boolean;
  readonly index: number;
  readonly code: string;
  readonly peers: Map<number, Peer>;
}

export interface RoomManagerOptions {
  maxPlayersPerRoom: number;
  maxRooms: number;
  privateRoomIdleS: number;
  reconnectGraceS: number;
  testHooks: boolean;
  /** Combat hook per room (default NullSim: presence only, until M11). */
  simFactory?: RoomSimFactory;
  /** Integer in [0, n); default crypto.randomInt. */
  randInt?: (n: number) => number;
  /** Max enemies per room handed to the sim factory. */
  maxEnemies?: number;
  log?: Log;
}

export type HelloResult = { ok: true; mr: ManagedRoom; pid: number; resumed: boolean } | { ok: false; why: RejectWhy };

type Hello = Extract<ClientMsg, { t: 'hello' }>;

export class RoomManager {
  readonly rooms = new Map<string, ManagedRoom>();
  private readonly byCode = new Map<string, ManagedRoom>();
  private readonly byToken = new Map<string, ManagedRoom>();
  private readonly maps = new Map<MapId, MapRuntime>();
  private readonly simFactory: RoomSimFactory;
  private readonly randInt: (n: number) => number;
  private readonly log: Log;

  constructor(readonly opts: RoomManagerOptions) {
    this.simFactory = opts.simFactory ?? nullSimFactory;
    this.randInt = opts.randInt ?? ((n) => randomInt(n));
    this.log = opts.log ?? silentLog;
  }

  /** Builds every map's runtime (city + collision world); call once at start. */
  prepareMaps(): void {
    for (const id of Object.keys(MAPS) as MapId[]) this.mapRuntime(id);
  }

  private mapRuntime(id: MapId): MapRuntime {
    let rt = this.maps.get(id);
    if (!rt) {
      rt = buildMapRuntime(id);
      this.maps.set(id, rt);
    }
    return rt;
  }

  get playerCount(): number {
    let n = 0;
    for (const mr of this.rooms.values()) n += mr.room.players.size;
    return n;
  }

  /** Public rooms of a map, by index. */
  publicRooms(map: MapId): ManagedRoom[] {
    return [...this.rooms.values()].filter((r) => r.publicRoom && r.map === map).sort((a, b) => a.index - b.index);
  }

  private create(map: MapId, publicRoom: boolean, index: number, code: string, pvp: boolean, nowMs: number): ManagedRoom {
    const id = publicRoom ? `${map}#${index}` : `${map}:${code}`;
    const peers = new Map<number, Peer>();
    const rt = this.mapRuntime(map);
    const sim = this.simFactory(rt, { seed: this.randInt(0x7fffffff), pvp: pvp && !publicRoom, maxEnemies: this.opts.maxEnemies ?? 60 });
    const room = new Room(
      {
        id,
        map: rt,
        pvp,
        maxPlayers: this.opts.maxPlayersPerRoom,
        publicRoom,
        code: code || undefined,
        index,
        testHooks: this.opts.testHooks,
        reconnectGraceS: this.opts.reconnectGraceS,
      },
      {
        send: (pid, m) => peers.get(pid)?.deliver(m),
        disconnect: (pid, why) => {
          const p = peers.get(pid);
          peers.delete(pid);
          p?.detach(why);
        },
      },
      sim,
      nowMs,
    );
    const mr: ManagedRoom = { room, map, publicRoom, index, code, peers };
    this.rooms.set(id, mr);
    if (code) this.byCode.set(code, mr);
    this.log.info('room open', { id, pvp: room.pvp });
    return mr;
  }

  /** Lowest-index public room of the map with a free slot, opening the next index when all are full. */
  joinPublic(map: MapId, nowMs: number): ManagedRoom | null {
    const list = this.publicRooms(map);
    for (const mr of list) if (!mr.room.full) return mr;
    if (this.rooms.size >= this.opts.maxRooms) return null;
    let index = 1;
    for (const mr of list) if (mr.index === index) index++;
    return this.create(map, true, index, '', false, nowMs);
  }

  createPrivate(map: MapId, pvp: boolean, nowMs: number): ManagedRoom | null {
    if (this.rooms.size >= this.opts.maxRooms) return null;
    let code = makeRoomCode(this.randInt);
    while (this.byCode.has(code)) code = makeRoomCode(this.randInt);
    return this.create(map, false, 0, code, pvp, nowMs);
  }

  findByCode(raw: string): ManagedRoom | null {
    const code = normalizeRoomCode(raw);
    return isRoomCode(code) ? (this.byCode.get(code) ?? null) : null;
  }

  /** Handles `hello`: reconnect by token, else join or create as asked. Binds `peer` to the pid. */
  hello(peer: Peer, h: Hello, nowMs: number): HelloResult {
    if (h.v !== PROTOCOL_VERSION) return { ok: false, why: 'version' };
    let mr: ManagedRoom | null = null;
    let created = false;
    if (h.token) {
      const byToken = this.byToken.get(h.token);
      if (byToken && this.rooms.get(byToken.room.id) === byToken && byToken.room.hasToken(h.token)) mr = byToken;
      else this.byToken.delete(h.token);
    }
    if (!mr) {
      switch (h.join.kind) {
        case 'public':
          mr = this.joinPublic(h.map, nowMs);
          if (!mr) return { ok: false, why: 'full' };
          break;
        case 'code':
          mr = this.findByCode(h.join.code);
          if (!mr) return { ok: false, why: 'notFound' };
          break;
        case 'create':
          mr = this.createPrivate(h.map, h.join.pvp, nowMs);
          if (!mr) return { ok: false, why: 'full' };
          created = true;
          break;
      }
    }
    const r = mr.room.admit(h.name, h.costume, nowMs, mr.room.hasToken(h.token ?? '') ? h.token : undefined);
    if ('reject' in r) {
      if (created && mr.room.empty) this.close(mr);
      return { ok: false, why: r.reject };
    }
    mr.peers.set(r.pid, peer);
    this.byToken.set(r.token, mr);
    peer.deliver(r.welcome);
    this.log.info(r.resumed ? 'player resumed' : 'player joined', { room: mr.room.id, pid: r.pid, name: r.name });
    return { ok: true, mr, pid: r.pid, resumed: r.resumed };
  }

  /**
   * A bound connection ended. `keep`: unexpected close, keep the slot for the
   * reconnect grace; otherwise the player left (or was kicked) for good.
   */
  release(mr: ManagedRoom, pid: number, peer: Peer, keep: boolean, why: LeftWhy, nowMs: number): void {
    if (mr.peers.get(pid) !== peer) return; // replaced by a newer connection
    mr.peers.delete(pid);
    mr.room.drop(pid, keep, nowMs, why);
  }

  /** Steps every room and closes rooms nobody needs any more. */
  tick(nowMs: number): void {
    for (const mr of this.rooms.values()) {
      mr.room.step(nowMs);
      const r = mr.room;
      if (!r.empty) continue;
      if (mr.publicRoom ? mr.index > 1 : nowMs - r.emptySince >= this.opts.privateRoomIdleS * 1000) this.close(mr);
    }
  }

  private close(mr: ManagedRoom): void {
    this.rooms.delete(mr.room.id);
    if (mr.code) this.byCode.delete(mr.code);
    for (const [token, r] of this.byToken) if (r === mr) this.byToken.delete(token);
    this.log.info('room closed', { id: mr.room.id });
  }

  /** Detaches every connection (server shutdown). */
  shutdown(): void {
    for (const mr of this.rooms.values()) {
      for (const [pid, p] of mr.peers) {
        mr.peers.delete(pid);
        p.detach('shutdown');
      }
    }
  }
}
