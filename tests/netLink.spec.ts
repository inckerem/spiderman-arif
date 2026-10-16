import { test, expect } from '@playwright/test';
import { buildMapRuntime } from '../server/mapRuntime';
import { CombatView } from '../src/combat/client/combatView';
import { Player } from '../src/player/player';
import { NetLink } from '../src/net/netLink';
import { ByteWriter, encodeEnemySnapshot } from '../src/net/codec';
import { makeHeroCombatSnap } from '../src/sim/types';
import type { RoomInfo, ServerMsg } from '../src/net/protocol';

/** Synchronous transport lets packets arrive before the connect Promise's continuation. */
class Socket {
  static readonly OPEN = 1;
  static last: Socket;
  readyState = 1;
  binaryType = '';
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  constructor(_url: string) { Socket.last = this; }
  send(data: string | Uint8Array): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  receive(message: ServerMsg): void { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const crime = { id: 1, type: 'robbery' as const, boss: -1, x: 20, y: 0, z: 30, radius: 20, enemiesLeft: 5, startedAt: 0, arena: 2, total: 5 };
const room: RoomInfo = { id: 'private-test', map: 'manhattan', seed: 1337, public: false, code: 'K7P2QX', pvp: true, index: 0 };
const welcome = (target: RoomInfo): ServerMsg => ({ t: 'welcome', v: 1, pid: 1, name: 'Gezgin', room: target, token: 'abc', now: 1000, players: [], events: [crime], clock: { hour: 12, dayLen: 12 }, hp: 100 });

function setup() {
  let now = 1000;
  const rt = buildMapRuntime('manhattan');
  const view = new CombatView();
  const player = new Player(rt.world, rt.layout);
  const link = new NetLink({ url: 'ws://test/ws', name: 'Gezgin', costume: 'redNavy', map: 'manhattan', world: { map: 'manhattan', seed: 1337 }, join: { kind: 'code', code: room.code! }, player, view, clock: () => now, socket: Socket as unknown as typeof WebSocket });
  return { view, link, advance: (ms: number) => { now += ms; } };
}

for (const target of [{ ...room, map: 'istanbul' as const }, { ...room, seed: 42 }]) {
  test(`NetLink rejects wrong world before uploads and combat side effects (${target.map}/${target.seed})`, async () => {
    const { view, link } = setup();
    const before = JSON.stringify(view);
    let corrections = 0;
    let clocks = 0;
    link.onCorrect = () => corrections++;
    link.onClock = () => clocks++;
    const connected = link.connect();
    const socket = Socket.last;
    socket.onopen?.();
    // These follow welcome in the same task, before Online.start can close the socket.
    socket.receive(welcome(target));
    socket.receive({ t: 'ce', ev: [{ e: 'evStart', ev: crime }] });
    socket.receive({ t: 'correct', x: 500, y: 10, z: 500, why: 'bounds' });
    socket.receive({ t: 'clock', hour: 3, dayLen: 1 });
    const self = makeHeroCombatSnap();
    self.hp = 10;
    const packet = encodeEnemySnapshot(1000, [], 0, new ByteWriter(), self);
    socket.onmessage?.({ data: packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer });
    try {
      expect(await connected).toEqual({ ok: true, room: target, accepted: false });
      expect(socket.sent.filter((p) => typeof p !== 'string')).toHaveLength(0);
      link.syncClock();
      expect(corrections).toBe(0);
      expect(clocks).toBe(0);
      expect(JSON.stringify(view)).toBe(before);
      expect(link.status).toBe('connecting');
    } finally {
      link.close();
    }
  });
}

test('NetLink accepts matching worlds and repeats welcome sync and upload on reconnect', async () => {
  const { view, link } = setup();
  const resumed: boolean[] = [];
  link.onWelcome = (same) => resumed.push(same);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const connected = link.connect();
      const socket = Socket.last;
      socket.onopen?.();
      socket.receive(welcome(room));
      expect(await connected).toEqual({ ok: true, room, accepted: true });
      expect(link.status).toBe('online');
      expect(view.selfPid).toBe(1);
      expect(view.crimes).toHaveLength(1);
      expect(view.crimes[0].id).toBe(crime.id);
      expect(socket.sent.filter((p) => typeof p !== 'string')).toHaveLength(1);
      if (attempt === 0) link.close();
    }
    expect(resumed).toEqual([false, true]);
  } finally {
    link.close();
  }
});


test('NetLink replays the welcome clock to late listeners before a periodic clock broadcast', async () => {
  const { link, advance } = setup();
  const connected = link.connect();
  const socket = Socket.last;
  socket.onopen?.();
  socket.receive(welcome(room));
  try {
    expect((await connected).ok).toBe(true);
    // Online attaches this only after connect resolves. No periodic clock packet has arrived.
    const samples: Array<[number, number]> = [];
    link.onClock = (hour, dayLen) => samples.push([hour, dayLen]);
    advance(60_000);
    link.syncClock();
    expect(samples).toEqual([[14, 12]]);
    // A later broadcast replaces the retained sample, including its new day length.
    socket.receive({ t: 'clock', hour: 23, dayLen: 6 });
    advance(30_000);
    link.syncClock();
    expect(samples).toEqual([[14, 12], [23, 6], [1, 6]]);
  } finally {
    link.close();
  }
});
