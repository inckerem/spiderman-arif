/**
 * M12 Node-side checks (no browser, no page): protocol codec, names and the
 * profanity filter, room codes, clock sync, interpolation, the shared Room
 * (relay, sanity checks, kicks, reconnect, clock, PvP, combat hook),
 * RoomManager (public overflow, private codes), limits, sessions and the
 * purity of the shared modules. Run: `npm run test:server` (or
 * `npx playwright test tests/server.spec.ts`).
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import {
  ByteWriter,
  NE,
  cloneHeroSample,
  decodeEnemySnapshot,
  decodeHeroState,
  decodeHeroStates,
  encodeEnemySnapshot,
  encodeHeroState,
  encodeHeroStates,
  parseClientMsg,
  setHeroStateTime,
} from '../src/net/codec';
import { HB, HF, KICK_REASONS, NET, REJECT_REASONS, isRoomCode, makeHeroSample, makeRoomCode, normalizeRoomCode, type HeroSample, type NetEvent, type ServerMsg } from '../src/net/protocol';
import { checkName, isProfane, uniqueName, nameKey } from '../src/net/names';
import { tr } from '../src/i18n/tr';
import { ClockSync, DayClock, hourDelta, pullHour, wrapHour } from '../src/net/clock';
import { InterpBuffer, INTERP_AHEAD, INTERP_BETWEEN, INTERP_EMPTY, INTERP_HELD, lerpAngle } from '../src/net/interp';
import { buildMapRuntime } from '../server/mapRuntime';
import { NullSim } from '../src/sim/nullSim';
import { CombatRoomSim, combatSimFactory } from '../src/sim/combatRoomSim';
import { CombatSim } from '../src/combat/combatSim';
import { AR } from '../src/combat/spawnPoints';
import { tuning } from '../src/config/tuning';
import { Room, STATE_CORRECTED, STATE_DROPPED, STATE_KICKED, STATE_OK, type RoomOut } from '../src/sim/room';
import { HERO_ID_BASE, makeEnemySnap, makeHeroCombatSnap, type CombatEvent, type EnemySnap, type MapRuntime } from '../src/sim/types';
import { RoomManager, type Peer } from '../server/roomManager';
import { AbuseMeter, ConnLimiter, TokenBucket, clientIp } from '../server/limits';
import { argsToEnv, loadConfig } from '../server/config';
import { Session, type Conn } from '../server/session';
import { resolveStaticPath } from '../server/static';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let map: MapRuntime;

test.beforeAll(() => {
  map = buildMapRuntime('manhattan');
});

// ---------------------------------------------------------------------------
// Helpers

const ALL_EVENTS: NetEvent[] = [
  { type: 'jump' },
  { type: 'land', impact: 23.45, surface: 3, roll: true },
  { type: 'webFire', hand: 1, x: 10.5, y: 80.25, z: -33.125 },
  { type: 'attach', hand: 0, x: 1.5, y: 2.5, z: 3.5, nx: 0, ny: 0.6, nz: -0.8 },
  { type: 'release', good: true, broken: false, power: 0.8 },
  { type: 'boost' },
  { type: 'dive' },
  { type: 'zipStart', x: -5, y: 40, z: 7.75, hand: 1 },
  { type: 'zipEnd' },
  { type: 'wallGrab', surface: 5 },
  { type: 'wallJump' },
  { type: 'vault' },
  { type: 'mantle' },
  { type: 'splash', x: 400, y: -1.2, z: 900 },
  { type: 'respawn' },
  { type: 'recover' },
  { type: 'lunge' },
  { type: 'lungeEnd', ok: true },
  { type: 'strike', move: 3 },
  { type: 'dodge' },
  { type: 'hurt', dmg: 22 },
  { type: 'down' },
  { type: 'revive' },
];

function fullSample(): HeroSample {
  const s = makeHeroSample();
  Object.assign(s, {
    seq: 65000, t: 123456789, x: 123.456, y: 78.9, z: -654.321, vx: 45.67, vy: -12.34, vz: 99.99,
    facing: -2.5, mode: 2, flags: HF.ROPE_ATTACHED | HF.HAND_RIGHT | HF.DIVING, blocks: HB.ANCHOR | HB.ZIP | HB.WALL | HB.TRAV,
    tp: 7, action: 4, actionSide: 1, actionT: 0.37, actionDur: 0.42, ax: 100.5, ay: 140.25, az: -620, zx: 1, zy: 2, zz: 3, wnx: 0.7071, wnz: -0.7071,
    wrun: 8.3, travKind: 1, travT: 0.21, travDur: 0.6,
  });
  s.events = ALL_EVENTS.map((e) => ({ ...e }));
  return s;
}

function sampleAt(x: number, y: number, z: number, t: number, tp = 0): HeroSample {
  const s = makeHeroSample();
  s.x = x;
  s.y = y;
  s.z = z;
  s.t = t;
  s.tp = tp;
  s.flags = HF.GROUNDED;
  return s;
}

class Rec implements RoomOut {
  readonly msgs: Array<{ pid: number; m: ServerMsg | Uint8Array }> = [];
  readonly disc: Array<{ pid: number; why: string }> = [];
  send(pid: number, m: ServerMsg | Uint8Array): void {
    this.msgs.push({ pid, m });
  }
  disconnect(pid: number, why: string): void {
    this.disc.push({ pid, why });
  }
  json(pid: number, t?: string): ServerMsg[] {
    return this.msgs.filter((x) => x.pid === pid && !(x.m instanceof Uint8Array) && (!t || (x.m as ServerMsg).t === t)).map((x) => x.m as ServerMsg);
  }
  bin(pid: number, op?: number): Uint8Array[] {
    return this.msgs.filter((x) => x.pid === pid && x.m instanceof Uint8Array && (op === undefined || (x.m as Uint8Array)[0] === op)).map((x) => x.m as Uint8Array);
  }
  clear(): void {
    this.msgs.length = 0;
    this.disc.length = 0;
  }
}

function makeRoom(opts: Partial<{ pvp: boolean; publicRoom: boolean; maxPlayers: number; testHooks: boolean; sim: NullSim }> = {}) {
  const out = new Rec();
  const sim = opts.sim ?? new NullSim();
  let n = 0;
  const room = new Room(
    {
      id: 'test',
      map,
      pvp: opts.pvp ?? false,
      maxPlayers: opts.maxPlayers ?? 16,
      publicRoom: opts.publicRoom ?? true,
      index: 1,
      testHooks: opts.testHooks ?? false,
      newToken: () => `tok${++n}`,
    },
    out,
    sim,
    0,
  );
  return { room, out, sim };
}

function admit(room: Room, name: string, now = 0): number {
  const r = room.admit(name, 'redNavy', now);
  if ('reject' in r) throw new Error(`rejected ${r.reject}`);
  return r.pid;
}

// ---------------------------------------------------------------------------
// Codec

test.describe('codec', () => {
  test('hero state round trip with every block and event type', () => {
    const s = fullSample();
    const bytes = encodeHeroState(s);
    expect(bytes[0]).toBe(0x01);
    const d = makeHeroSample();
    expect(decodeHeroState(bytes, d)).toBe(true);
    expect(d.seq).toBe(65000);
    expect(d.t).toBe(123456789);
    for (const k of ['x', 'y', 'z', 'ax', 'ay', 'az', 'zx', 'zy', 'zz'] as const) expect(d[k]).toBe(Math.fround(s[k]));
    for (const k of ['vx', 'vy', 'vz'] as const) expect(Math.abs(d[k] - s[k])).toBeLessThanOrEqual(0.005 + 1e-9);
    expect(Math.abs(d.facing - s.facing)).toBeLessThan(1e-4);
    expect([d.mode, d.flags, d.blocks, d.tp, d.action, d.actionSide]).toEqual([s.mode, s.flags, s.blocks, s.tp, s.action, s.actionSide]);
    expect(Math.abs(d.actionT - s.actionT)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(d.actionDur - s.actionDur)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(d.wnx - s.wnx)).toBeLessThan(0.01);
    expect(Math.abs(d.wnz - s.wnz)).toBeLessThan(0.01);
    expect(Math.abs(d.wrun - s.wrun)).toBeLessThanOrEqual(0.05);
    expect([d.travKind, d.travT, d.travDur]).toEqual([1, 0.21, 0.6]);
    expect(d.events.map((e) => e.type)).toEqual(ALL_EVENTS.map((e) => e.type));
    expect(Object.keys(NE).length).toBe(ALL_EVENTS.length);
    for (let i = 0; i < ALL_EVENTS.length; i++) {
      const a = ALL_EVENTS[i] as Record<string, unknown>;
      const b = d.events[i] as Record<string, unknown>;
      for (const k of Object.keys(a)) {
        if (typeof a[k] === 'number') expect(Math.abs((b[k] as number) - (a[k] as number)), `${a.type}.${k}`).toBeLessThan(0.01);
        else expect(b[k], `${a.type}.${k}`).toBe(a[k]);
      }
    }
    // Sizes: 36 B at rest, 48 B on a line (design: 34–58 B plus events).
    const rest = makeHeroSample();
    expect(encodeHeroState(rest).length).toBe(36);
    rest.blocks = HB.ANCHOR;
    expect(encodeHeroState(rest).length).toBe(48);
  });

  test('malformed hero states are rejected', () => {
    const good = encodeHeroState(fullSample());
    const d = makeHeroSample();
    expect(decodeHeroState(good.slice(0, good.length - 1), d)).toBe(false); // truncated
    expect(decodeHeroState(new Uint8Array([...good, 0]), d)).toBe(false); // trailing byte
    const badOp = good.slice();
    badOp[0] = 0x02;
    expect(decodeHeroState(badOp, d)).toBe(false);
    const badBlocks = encodeHeroState(makeHeroSample());
    badBlocks[1 + 28] = 0x10;
    expect(decodeHeroState(badBlocks, d)).toBe(false);
    const manyEvents = encodeHeroState(makeHeroSample());
    manyEvents[manyEvents.length - 1] = NET.maxStateEvents + 1;
    expect(decodeHeroState(manyEvents, d)).toBe(false);
    const unknownEvent = new Uint8Array([...encodeHeroState(makeHeroSample()).slice(0, -1), 1, 99]);
    expect(decodeHeroState(unknownEvent, d)).toBe(false);
    for (let i = 0; i < 200; i++) {
      const junk = new Uint8Array(randomInt(0, 80)).map(() => randomInt(256));
      if (junk.length) junk[0] = 0x01;
      decodeHeroState(junk, d); // must never throw
    }
  });

  test('hero states batch (0x02) and time rewrite', () => {
    const w = new ByteWriter(64);
    const a = sampleAt(1, 2, 3, 1000);
    a.events.push({ type: 'jump' });
    const b = sampleAt(4, 5, 6, 2000);
    b.blocks = HB.ANCHOR;
    b.ax = 9;
    const pa = encodeHeroState(a);
    const pb = encodeHeroState(b);
    setHeroStateTime(pb, 1500);
    const batch = encodeHeroStates([3, 7], [pa, pb], 2, w);
    expect(batch[0]).toBe(0x02);
    const got: Array<{ pid: number; s: HeroSample }> = [];
    expect(decodeHeroStates(batch, makeHeroSample(), (pid, s) => got.push({ pid, s: cloneHeroSample(s) }))).toBe(true);
    expect(got.map((g) => g.pid)).toEqual([3, 7]);
    expect(got[0].s.events).toEqual([{ type: 'jump' }]);
    expect(got[1].s.t).toBe(1500);
    expect(got[1].s.ax).toBe(9);
    expect(decodeHeroStates(batch.slice(0, -1), makeHeroSample(), () => {})).toBe(false);
  });

  test('enemy snapshot quantization ≤ 5 cm and 0.01 rad', () => {
    const snaps: EnemySnap[] = [];
    for (let i = 0; i < NET.snapshotMax; i++) {
      const e = makeEnemySnap();
      Object.assign(e, {
        id: 1 + i * 997, kind: i % 8, state: i % 14, x: -1000 + Math.random() * 2200, y: Math.random() * 300,
        z: -1000 + Math.random() * 2000, yaw: (Math.random() * 2 - 1) * Math.PI, hp: Math.random(), guard: Math.random(),
        anim: i, animT: Math.random() * 5, flags: i & 0xff, target: i % 17,
      });
      snaps.push(e);
    }
    const mine = { hp: 63.4, maxHp: 100, down: true, downUntil: 101.5, combo: 7, comboUntil: 99.3, focus: 45.5, iframesUntil: -1e9 };
    const bytes = encodeEnemySnapshot(98765, snaps, snaps.length, new ByteWriter(), mine);
    expect(bytes.length).toBe(7 + 18 * snaps.length + 21);
    const out: EnemySnap[] = [];
    const got = makeHeroCombatSnap();
    const r = decodeEnemySnapshot(bytes, out, makeEnemySnap, got);
    expect(r).toEqual({ roomMs: 98765, count: snaps.length, hasSelf: true });
    expect(got).toMatchObject({ hp: 63.4, maxHp: 100, down: true, combo: 7, focus: 45.5 });
    expect(got.downUntil).toBeCloseTo(101.5, 6);
    expect(got.comboUntil).toBeCloseTo(99.3, 6);
    expect(got.iframesUntil).toBeLessThan(-1e6); // "never" stays far in the past
    expect(decodeEnemySnapshot(encodeEnemySnapshot(5, [], 0, new ByteWriter()), out, makeEnemySnap)).toEqual({ roomMs: 5, count: 0, hasSelf: false });
    let maxPos = 0;
    let maxYaw = 0;
    for (let i = 0; i < snaps.length; i++) {
      const a = snaps[i];
      const b = out[i];
      expect([b.id, b.kind, b.state, b.anim, b.flags, b.target]).toEqual([a.id, a.kind, a.state, a.anim, a.flags, a.target]);
      maxPos = Math.max(maxPos, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
      maxYaw = Math.max(maxYaw, Math.abs(lerpAngle(a.yaw, b.yaw, 1) - a.yaw));
      expect(Math.abs(a.hp - b.hp)).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
      expect(Math.abs(a.animT - b.animT)).toBeLessThanOrEqual(0.01 + 1e-9);
    }
    expect(maxPos).toBeLessThanOrEqual(0.05);
    expect(maxYaw).toBeLessThanOrEqual(0.01);
    expect(decodeEnemySnapshot(bytes.slice(0, -1), out, makeEnemySnap)).toBeNull();
  });

  test('client text messages are validated and rebuilt', () => {
    const hello = { t: 'hello', v: 1, name: 'Arif', costume: 'redGold', map: 'manhattan', join: { kind: 'create', pvp: true }, token: 'abc', extra: 1 };
    expect(parseClientMsg(JSON.stringify(hello))).toEqual({ t: 'hello', v: 1, name: 'Arif', costume: 'redGold', map: 'manhattan', join: { kind: 'create', pvp: true }, token: 'abc' });
    const strike = { t: 'act', i: { k: 'strike', seq: 4, target: 12, move: 2, viewT: 10.5, hx: 1, hy: 2, hz: 3 } };
    expect(parseClientMsg(JSON.stringify(strike))).toEqual(strike);
    expect(parseClientMsg('{"t":"act","i":{"k":"pin","seq":1,"target":3,"viewT":1,"hx":0,"hy":0,"hz":0}}')).not.toBeNull();
    expect(parseClientMsg('{"t":"act","i":{"k":"dodge","seq":1,"t":2.5}}')).toEqual({ t: 'act', i: { k: 'dodge', seq: 1, t: 2.5 } });
    expect(parseClientMsg('{"t":"ping","c":12.5}')).toEqual({ t: 'ping', c: 12.5 });
    expect(parseClientMsg('{"t":"leave"}')).toEqual({ t: 'leave' });
    expect(parseClientMsg('{"t":"dbg","op":"spawn","a":[0,1,2,3]}')).toEqual({ t: 'dbg', op: 'spawn', a: [0, 1, 2, 3] });
    for (const bad of [
      'nope', '[]', 'null', '{"t":"x"}', '{"t":"ping","c":"1"}', '{"t":"ping"}',
      '{"t":"hello","v":1,"name":"a","costume":"x","map":"atlantis","join":{"kind":"public"}}',
      '{"t":"hello","v":1,"name":"a","costume":"x","map":"manhattan","join":{"kind":"vip"}}',
      '{"t":"hello","v":1,"name":"a","costume":"x","map":"toString","join":{"kind":"public"}}',
      '{"t":"act","i":{"k":"strike","seq":1,"target":1,"move":1,"viewT":1,"hx":1,"hy":1}}',
      '{"t":"act","i":{"k":"nuke","seq":1,"target":1,"viewT":1,"hx":1,"hy":1,"hz":1}}',
      '{"t":"dbg","op":"spawn","a":["1"]}', '{"t":"dbg","op":"eval","a":[]}',
      JSON.stringify({ t: 'hello', v: 1, name: 'x'.repeat(65), costume: 'a', map: 'manhattan', join: { kind: 'public' } }),
    ]) {
      expect(parseClientMsg(bad), bad).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Names

test.describe('names', () => {
  test('length, charset, normalization', () => {
    expect(checkName('  Arif  ')).toEqual({ ok: true, name: 'Arif' });
    expect(checkName('Ayşe Nur  Çağ')).toEqual({ ok: true, name: 'Ayşe Nur Çağ' });
    expect(checkName('Şule')).toEqual({ ok: true, name: 'Şule' }); // NFC
    expect(checkName('ab')).toEqual({ ok: false, why: 'short' });
    expect(checkName('')).toEqual({ ok: false, why: 'empty' });
    expect(checkName('x'.repeat(17))).toEqual({ ok: false, why: 'long' });
    expect(checkName('x'.repeat(16)).ok).toBe(true);
    expect(checkName('a​bc')).toEqual({ ok: false, why: 'chars' });
    expect(checkName('abc\u0007')).toEqual({ ok: false, why: 'chars' });
    expect(checkName('a<b>c')).toEqual({ ok: false, why: 'chars' });
    expect(checkName('Ali#2')).toEqual({ ok: false, why: 'chars' });
    expect(checkName('___')).toEqual({ ok: false, why: 'chars' });
    expect(checkName('Kerem_07.x-y').ok).toBe(true);
  });

  test('profanity: Turkish and English, leetspeak, separators, repeats', () => {
    for (const bad of [
      'fuck', 'FUCKER', 'f.u.c.k', 'fuuuuck', 'phuck you fck', 'sh1t', '$hit', 'b1tch', 'BITCH', 'a$$hole', 'c0ck', 'n1gg3r',
      'siktir', 'S1KT1R', 's i k t i r', 'SİKTİR', 'orospu', '0r0spu', 'oruspu cocugu orospu', 'amcık', 'amk', 'a.m.k',
      'yarrak', 'yaraaak', 'piç', 'Ali Oç', 'şerefsiz', 'serefsiz', 'pezevenk', 'kahpe', 'göt veren', 'g0tveren', '@mcik',
    ]) {
      expect(isProfane(bad), bad).toBe(true);
    }
    for (const fine of [
      'Ahmet', 'Ayşe', 'Mehmet', 'Arif', 'Sikke', 'Ambulans', 'Şikayetçi', 'Eksik Parça', 'Sıkıntı', 'Kasık', 'Peacock',
      'Scunthorpe', 'Dickens', 'Therapist', 'Nigar', 'Amina', 'Kemal', 'Malik', 'Pedro', 'Koç', 'Kaya', 'Cockpit',
      'Hancock', 'Assassin', 'Classic', 'Basketbol', 'Picasso', 'Gotham', 'Oktay', 'Tolga', 'Spider Fan',
    ]) {
      expect(isProfane(fine), fine).toBe(false);
    }
    expect(checkName('FuCk3r')).toEqual({ ok: false, why: 'profanity' });
  });

  test('every reject, kick and name problem has a Turkish string', () => {
    for (const r of REJECT_REASONS) expect(tr.net.reject[r], r).toBeTruthy();
    for (const k of KICK_REASONS) expect(tr.net.kick[k], k).toBeTruthy();
    for (const n of ['empty', 'short', 'long', 'chars', 'profanity'] as const) expect(tr.net.name[n], n).toBeTruthy();
  });

  test('duplicate names get #2, #3 (case-insensitive, Turkish rules)', () => {
    const taken = new Set(['arif', 'arif#2', nameKey('IŞIK')].map(nameKey));
    expect(uniqueName('Arif', taken)).toBe('Arif#3');
    expect(uniqueName('ARİF', taken)).toBe('ARİF#3');
    expect(uniqueName('ışık', taken)).toBe('ışık#2');
    expect(uniqueName('Kerem', taken)).toBe('Kerem');
  });
});

// ---------------------------------------------------------------------------
// Room codes

test('room codes: alphabet without ambiguous characters, 10k unique codes', () => {
  for (const ch of '0O1IL') expect(NET.roomCodeAlphabet.includes(ch)).toBe(false);
  expect(new Set(NET.roomCodeAlphabet).size).toBe(NET.roomCodeAlphabet.length);
  let bad = 0;
  for (let i = 0; i < 1000; i++) if (!isRoomCode(makeRoomCode((n) => randomInt(n)))) bad++;
  expect(bad).toBe(0);
  expect(normalizeRoomCode(' k7p2-qx ')).toBe('K7P2QX');
  expect(isRoomCode('K7P2QX')).toBe(true);
  expect(isRoomCode('K7P2Q0')).toBe(false);
  expect(isRoomCode('K7P2Q')).toBe(false);
  // 10k private rooms through the manager (retries on a clash).
  const mgr = new RoomManager({ maxPlayersPerRoom: 16, maxRooms: 10_000, privateRoomIdleS: 60, reconnectGraceS: 30, testHooks: false });
  const codes = new Set<string>();
  for (let i = 0; i < 10_000; i++) codes.add(mgr.createPrivate('manhattan', false, 0)?.code ?? 'none');
  expect(codes.size).toBe(10_000);
  expect([...codes].filter((c) => !isRoomCode(c))).toEqual([]);
  expect(mgr.createPrivate('manhattan', false, 0)).toBeNull(); // MAX_ROOMS
});

// ---------------------------------------------------------------------------
// Clock and interpolation

test('clock sync picks the minimum-RTT sample and slews ≤ 5 ms/s', () => {
  const OFFSET = 12_345;
  const c = new ClockSync();
  let local = 1000;
  // First pong: rtt 80 ms with asymmetric delay (server stamp 60 ms after send).
  c.onPong(local, local + 60 + OFFSET, local + 80);
  local += 80;
  expect(c.ready).toBe(true);
  expect(c.offset).toBe(OFFSET + 20); // jumps at once
  for (let i = 0; i < 12; i++) {
    local += 2000;
    const rtt = i === 5 ? 10 : 40 + (i % 3) * 30;
    const up = i === 5 ? 5 : rtt * 0.7;
    c.onPong(local - rtt, local - rtt + up + OFFSET, local);
  }
  expect(c.rtt).toBe(10);
  expect(Math.abs(c.target - OFFSET)).toBeLessThanOrEqual(0.5);
  // Slew: 20 ms off takes ~4 s at 5 ms/s, never faster.
  let prev = c.now(local);
  for (let i = 1; i <= 50; i++) {
    const r = c.now(local + i * 100);
    expect(r - prev - 100).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(r - prev - 100).toBeGreaterThanOrEqual(-0.5 - 1e-9);
    prev = r;
  }
  expect(Math.abs(c.offset - OFFSET)).toBeLessThan(1);
});

test('day clock and client hour pull (wrap aware)', () => {
  const d = new DayClock(23.9, 12); // 12 real minutes per day → 2 h per real minute
  d.advance(6); // 0.2 h
  expect(d.hour).toBeCloseTo(0.1, 6);
  expect(hourDelta(23.9, 0.1)).toBeCloseTo(0.2, 9);
  expect(hourDelta(0.1, 23.9)).toBeCloseTo(-0.2, 9);
  expect(wrapHour(-1)).toBe(23);
  expect(pullHour(10, 10.2, 1 / 60)).toBeCloseTo(10.2, 9); // > 0.05 h → snap
  let h = 23.99;
  for (let i = 0; i < 120; i++) h = pullHour(h, 0.02, 1 / 60); // 2 s blend across midnight
  expect(Math.abs(hourDelta(h, 0.02))).toBeLessThan(0.03 * 0.06);
});

test('interpolation buffer: between, extrapolate ≤ 150 ms, hold, wrap, snap', () => {
  type P = { x: number; tp: number };
  const buf = new InterpBuffer<P>(
    {
      create: () => ({ x: 0, tp: 0 }),
      copy: (s, d) => {
        d.x = s.x;
        d.tp = s.tp;
      },
      lerp: (a, b, f, d) => {
        d.x = a.x + (b.x - a.x) * f;
        d.tp = b.tp;
      },
      snap: (a, b) => a.tp !== b.tp,
    },
    8,
  );
  const out = { x: 0, tp: 0 };
  expect(buf.sample(0, out)).toBe(INTERP_EMPTY);
  for (let i = 0; i < 20; i++) buf.push(i * 50, { x: i * 10, tp: 0 }); // wraps (capacity 8)
  expect(buf.size).toBe(8);
  expect(buf.oldest).toBe(12 * 50);
  expect(buf.push(900, { x: 0, tp: 0 })).toBe(false); // out of order
  expect(buf.push(950, { x: 0, tp: 0 })).toBe(false); // duplicate time
  expect(buf.sample(900, out)).toBe(INTERP_BETWEEN);
  expect(out.x).toBeCloseTo(180, 9);
  expect(buf.sample(1000, out)).toBe(INTERP_AHEAD);
  expect(out.x).toBeCloseTo(200, 9);
  expect(buf.sample(950 + 400, out)).toBe(INTERP_HELD);
  expect(out.x).toBeCloseTo(190 + 30, 9); // capped at 150 ms of extrapolation
  expect(buf.sample(0, out)).toBe(INTERP_HELD);
  expect(out.x).toBe(120);
  buf.push(1000, { x: 5000, tp: 1 }); // teleport
  buf.sample(975, out);
  expect(out.x).toBe(190); // no blend across a teleport
});

// ---------------------------------------------------------------------------
// Room

test.describe('room', () => {
  test('admit: names, #2 suffix, profanity, full, join/left broadcasts', () => {
    const { room, out } = makeRoom({ maxPlayers: 3 });
    const a = room.admit('Arif', 'redNavy', 0);
    expect('pid' in a && a.name).toBe('Arif');
    const b = room.admit('arif', 'blackGold', 0);
    expect('pid' in b && b.name).toBe('arif#2');
    expect(room.admit('siktir', 'x', 0)).toEqual({ reject: 'profanity' });
    expect(room.admit('a', 'x', 0)).toEqual({ reject: 'name' });
    room.admit('Kerem', '<script>', 0);
    expect(room.admit('Deniz', 'x', 0)).toEqual({ reject: 'full' });
    expect(out.json(1, 'join').map((m) => (m as { name: string }).name)).toEqual(['arif#2', 'Kerem']);
    const welcome = 'pid' in b ? b.welcome : null;
    expect(welcome && welcome.t === 'welcome' && welcome.players.map((p) => p.name)).toEqual(['Arif']);
    expect(welcome && welcome.t === 'welcome' && welcome.room).toMatchObject({ id: 'test', map: 'manhattan', seed: 1337, public: true, pvp: false, index: 1 });
    expect(room.players.get(3)?.costume).toBe('');
    room.drop(2, false, 10, 'leave');
    expect(out.json(1, 'left')).toEqual([{ t: 'left', pid: 2, why: 'leave' }]);
  });

  test('relay: 20 Hz states reach the others in one batch per step, time clamped', () => {
    const { room, out } = makeRoom();
    const [a, b, c] = ['Ada', 'Bora', 'Cem'].map((n) => admit(room, n));
    out.clear();
    const sa = sampleAt(10, 20, 30, 999_999); // claims the future
    expect(room.onState(a, sa, encodeHeroState(sa), 500)).toBe(STATE_OK);
    const sb = sampleAt(-10, 20, 30, 100); // more than 1 s old
    expect(room.onState(b, sb, encodeHeroState(sb), 1500)).toBe(STATE_OK);
    room.step(1510);
    const toC: Array<{ pid: number; t: number; x: number }> = [];
    for (const pkt of out.bin(c, 0x02)) decodeHeroStates(pkt, makeHeroSample(), (pid, s) => toC.push({ pid, t: s.t, x: s.x }));
    expect(toC).toEqual([
      { pid: a, t: 500, x: 10 },
      { pid: b, t: 500, x: -10 },
    ]);
    const toA: number[] = [];
    for (const pkt of out.bin(a, 0x02)) decodeHeroStates(pkt, makeHeroSample(), (pid) => toA.push(pid));
    expect(toA).toEqual([b]);
    out.clear();
    room.step(1543);
    expect(out.bin(c, 0x02)).toEqual([]); // nothing new, nothing sent
  });

  test('movement sanity: 110 m/s ok, speed and teleport cheats corrected, valid respawns accepted', () => {
    const { room, out } = makeRoom();
    const p = admit(room, 'Hızlı');
    let t = 1000;
    let x = 0;
    expect(room.onState(p, sampleAt(x, 50, 0, t), null, t)).toBe(STATE_OK);
    for (let i = 0; i < 40; i++) {
      t += 50;
      x += 108 * 0.05; // 108 m/s
      expect(room.onState(p, sampleAt(x, 50, 0, t), null, t)).toBe(STATE_OK);
    }
    // 30 m in 50 ms without a teleport → speed correction to the last valid spot.
    t += 50;
    expect(room.onState(p, sampleAt(x + 30, 50, 0, t), null, t)).toBe(STATE_CORRECTED);
    expect(out.json(p, 'correct').at(-1)).toEqual({ t: 'correct', x, y: 50, z: 0, why: 'speed' });
    // In-flight states before the client applied it are dropped, not counted.
    t += 50;
    expect(room.onState(p, sampleAt(x + 35, 50, 0, t), null, t)).toBe(STATE_DROPPED);
    t += 50;
    expect(room.onState(p, sampleAt(x, 50, 0, t, 1), null, t)).toBe(STATE_OK); // applied (tp bumped)
    expect(room.players.get(p)!.corrections.length).toBe(1);
    // Teleport with the counter bumped: within 80 m (water/recovery) ok, 300 m away not.
    t += 50;
    expect(room.onState(p, sampleAt(x + 70, 45, 0, t, 2), null, t)).toBe(STATE_OK);
    x += 70;
    t += 50;
    expect(room.onState(p, sampleAt(x + 300, 45, 0, t, 3), null, t)).toBe(STATE_CORRECTED);
    expect(out.json(p, 'correct').at(-1)).toMatchObject({ why: 'teleport' });
    t += 50;
    expect(room.onState(p, sampleAt(x, 45, 0, t, 4), null, t)).toBe(STATE_OK);
    // Teleport to the map spawn is always fine.
    const [sx, sy, sz] = map.layout.spawn;
    t += 50;
    expect(room.onState(p, sampleAt(sx, sy, sz, t, 5), null, t)).toBe(STATE_OK);
    // NaN and out of bounds.
    t += 50;
    expect(room.onState(p, sampleAt(NaN, 0, 0, t), null, t)).toBe(STATE_CORRECTED);
    expect(out.json(p, 'correct').at(-1)).toMatchObject({ why: 'nan', x: sx, y: sy, z: sz });
  });

  test('more than 5 corrections in 10 s is a kick; a client ignoring corrections is resent and kicked', () => {
    const { room, out } = makeRoom();
    const p = admit(room, 'Hileci');
    const other = admit(room, 'Dürüst');
    let t = 0;
    room.onState(p, sampleAt(0, 50, 0, t), null, t);
    let kicked = false;
    for (let i = 0; i < 6; i++) {
      t += 1000;
      const r = room.onState(p, sampleAt(500, 50, 0, t, i + 1), null, t); // 500 m teleport
      if (i < 5) {
        expect(r).toBe(STATE_CORRECTED);
        t += 100;
        expect(room.onState(p, sampleAt(0, 50, 0, t, i + 1), null, t)).toBe(STATE_OK); // obeys
      } else {
        expect(r).toBe(STATE_KICKED);
        kicked = true;
      }
    }
    expect(kicked).toBe(true);
    expect(out.disc).toEqual([{ pid: p, why: 'cheat' }]);
    expect(room.players.has(p)).toBe(false);
    expect(out.json(other, 'left').at(-1)).toEqual({ t: 'left', pid: p, why: 'cheat' });

    // Ignoring the correction: it is resent (and counted) every 1.5 s → kicked within 10 s.
    const r2 = makeRoom();
    const q = admit(r2.room, 'İnatçı');
    t = 0;
    r2.room.onState(q, sampleAt(0, 50, 0, t), null, t);
    let code = 0;
    while (t < 10_000 && code !== STATE_KICKED) {
      t += 50;
      code = r2.room.onState(q, sampleAt(600, 50, 0, t), null, t);
    }
    expect(code).toBe(STATE_KICKED);
    expect(t).toBeLessThan(10_000);
    expect(r2.out.json(q, 'correct').length).toBe(5);
  });

  test('reconnect: slot kept 30 s (afk, invisible), token resumes pid and name, then expires', () => {
    const { room, out, sim } = makeRoom();
    const a = room.admit('Yolcu', 'redGold', 0);
    if (!('pid' in a)) throw new Error('rejected');
    const b = admit(room, 'Bekçi');
    room.onState(a.pid, sampleAt(5, 40, 5, 0), null, 0);
    room.drop(a.pid, true, 1000);
    expect(room.players.get(a.pid)!.connected).toBe(false);
    expect(sim.heroes.get(a.pid)!.afk).toBe(true);
    expect(room.full).toBe(false);
    expect(out.json(b, 'left')).toEqual([]);
    room.step(20_000);
    const back = room.admit('Başka', 'x', 25_000, a.token);
    expect(back).toMatchObject({ pid: a.pid, name: 'Yolcu', resumed: true });
    expect(room.players.get(a.pid)!.connected).toBe(true);
    // A second connection with the same token replaces the first.
    room.admit('Yolcu', 'x', 26_000, a.token);
    expect(out.disc).toEqual([{ pid: a.pid, why: 'replaced' }]);
    room.drop(a.pid, true, 30_000);
    room.step(59_000);
    expect(room.players.has(a.pid)).toBe(true);
    room.step(60_001);
    expect(room.players.has(a.pid)).toBe(false);
    expect(out.json(b, 'left').at(-1)).toEqual({ t: 'left', pid: a.pid, why: 'timeout' });
    expect(sim.heroes.has(a.pid)).toBe(false);
  });

  test('shared clock: in welcome, broadcast every 5 s, advances by dayLen', () => {
    const { room, out } = makeRoom();
    const p = admit(room, 'Saat');
    const h0 = room.hour;
    for (let i = 0; i <= 30 * 12; i++) room.step(i * (1000 / 30));
    expect(out.json(p, 'clock').length).toBe(3); // t = 0, 5, 10 s
    const hoursPerS = 24 / (room.clock.dayLen * 60);
    expect(hourDelta(h0, room.hour)).toBeCloseTo(12 * hoursPerS, 4);
    const last = out.json(p, 'clock').at(-1) as { hour: number; dayLen: number };
    expect(last.dayLen).toBe(room.clock.dayLen);
  });

  test('intents reach the sim with times in sim seconds; debug hooks only with testHooks', () => {
    const priv = makeRoom({ pvp: true, publicRoom: false });
    expect(priv.room.pvp).toBe(true);
    expect(makeRoom({ pvp: true, publicRoom: true }).room.pvp).toBe(false);
    const b = admit(priv.room, 'Düellocu');
    for (let i = 0; i < 31; i++) priv.room.step(5000 + (i * 1000) / 30); // sim awake: sim time 1.0 s at room 6 s
    priv.room.onIntent(b, { k: 'yank', seq: 1, target: HERO_ID_BASE + 3, viewT: 6, hx: 0, hy: 0, hz: 0 });
    const got = priv.sim.intents[0];
    expect(got.i.k).toBe('yank');
    expect((got.i as { viewT: number }).viewT).toBeCloseTo(priv.sim.time, 6); // converted to sim seconds
    expect(priv.room.onDebug(b, 'spawn', [0, 1, 2, 3])).toBe(false);
    const dbg = makeRoom({ testHooks: true });
    const d = admit(dbg.room, 'Testçi');
    expect(dbg.room.onDebug(d, 'killAll', [])).toBe(true);
    expect(dbg.room.onDebug(99, 'killAll', [])).toBe(false);
    expect(dbg.sim.debugCalls).toEqual([{ pid: d, op: 'killAll', a: [] }]);
  });

  test('combat hook: events batched as ce (rej only to its player), snapshots at 15 Hz, sim sleeps when nobody is connected', () => {
    class FakeSim extends NullSim {
      pending: CombatEvent[] = [];
      enemies = 3;
      override drainEvents(out: CombatEvent[]): void {
        out.push(...this.pending);
        this.pending = [];
      }
      override snapshot(_x: number, _y: number, _z: number, _r: number, out: EnemySnap[], max: number): number {
        const n = Math.min(this.enemies, max);
        for (let i = 0; i < n; i++) Object.assign(out[i], { id: i + 1, kind: 0, x: i, y: 0, z: 0, hp: 1 });
        return n;
      }
    }
    const sim = new FakeSim();
    const { room, out } = makeRoom({ sim });
    const a = admit(room, 'Birinci');
    const b = admit(room, 'İkinci');
    room.onState(a, sampleAt(0, 0, 0, 0), null, 0);
    room.onState(b, sampleAt(5, 0, 0, 0), null, 0);
    out.clear();
    sim.pending = [
      { e: 'tele', src: 1, tgt: HERO_ID_BASE + a, atk: 0, at: sim.time + 0.5 },
      { e: 'rej', pid: b, seq: 3, why: 'range' },
      { e: 'hit', src: HERO_ID_BASE + a, tgt: 1, move: 0, dmg: 10, hp: 50, fl: 1, kx: 0, ky: 0, kz: 0 },
    ];
    for (let i = 0; i < 4; i++) room.step(10_000 + (i * 1000) / 30);
    const ceA = out.json(a, 'ce') as Array<{ ev: CombatEvent[] }>;
    expect(ceA.length).toBe(1);
    expect(ceA[0].ev.map((e) => e.e)).toEqual(['tele', 'hit']);
    const tele = ceA[0].ev[0] as { at: number };
    expect(tele.at).toBeCloseTo(10 - 1 / 30 + 0.5, 6); // sim time → room seconds (sim t = 1/30 after the step at room 10 s)
    expect((out.json(b, 'ce') as Array<{ ev: CombatEvent[] }>).map((m) => m.ev.map((e) => e.e))).toEqual([['rej'], ['tele', 'hit']]);
    expect(out.json(a, 'ce').some((m) => (m as { ev: CombatEvent[] }).ev.some((e) => e.e === 'rej'))).toBe(false);
    const snaps = out.bin(a, 0x03);
    expect(snaps.length).toBe(2); // every 2nd of 4 steps
    const decoded: EnemySnap[] = [];
    expect(decodeEnemySnapshot(snaps[0], decoded, makeEnemySnap)?.count).toBe(3);
    // Enemies gone: snapshots keep coming (they also carry the hero's own combat state).
    sim.enemies = 0;
    out.clear();
    for (let i = 4; i < 10; i++) room.step(10_000 + (i * 1000) / 30);
    expect(out.bin(a, 0x03).map((s) => s.length)).toEqual([7 + 21, 7 + 21, 7 + 21]);
    // Nobody connected: the sim does not step.
    room.drop(a, true, 11_000);
    room.drop(b, true, 11_000);
    const simT = sim.time;
    for (let i = 0; i < 30; i++) room.step(11_000 + (i * 1000) / 30);
    expect(sim.time).toBe(simT);
  });
});

// ---------------------------------------------------------------------------
// Combat rooms: Room + CombatRoomSim (M11's CombatSim behind the RoomSim hook)

const STEP_MS = 1000 / 30;

/** A ground arena centre (street level) to stand heroes and spawn enemies on. */
function groundSpot(): { x: number; y: number; z: number } {
  const a = map.spawns.arenas.find((r) => !r.roof && r.type === AR.INTERSECTION) ?? map.spawns.arenas.find((r) => !r.roof)!;
  return { x: a.x, y: a.y, z: a.z };
}

function makeCombatRoom(opts: { pvp?: boolean; publicRoom?: boolean; seed?: number } = {}) {
  const out = new Rec();
  const csim = combatSimFactory(map, { seed: opts.seed ?? 7, pvp: !!opts.pvp && !opts.publicRoom, maxEnemies: 60 }) as CombatRoomSim;
  let n = 0;
  const room = new Room(
    { id: 'combat', map, pvp: !!opts.pvp, maxPlayers: 16, publicRoom: opts.publicRoom ?? true, index: 1, testHooks: true, newToken: () => `c${++n}` },
    out,
    csim,
    0,
  );
  let k = 0; // steps run
  const nowMs = () => k * STEP_MS;
  const step = (count = 1) => {
    for (let i = 0; i < count; i++) {
      k++;
      room.step(nowMs());
    }
  };
  const state = (pid: number, x: number, y: number, z: number, tp = 0) => room.onState(pid, sampleAt(x, y, z, nowMs(), tp), null, nowMs());
  const events = (pid: number): CombatEvent[] => out.json(pid, 'ce').flatMap((m) => (m as { ev: CombatEvent[] }).ev);
  return { room, out, csim, step, state, events, nowS: () => nowMs() / 1000 };
}

test.describe('combat room (CombatSim)', () => {
  test('strikes: in range hits, too fast → rate, out of range → range, stale → time; enemies hurt heroes', () => {
    const c = makeCombatRoom();
    const g = groundSpot();
    const a = admit(c.room, 'Yumruk');
    c.state(a, g.x, g.y, g.z);
    c.step();
    c.room.onDebug(a, 'spawn', [0, g.x + 1.2, g.y, g.z]);
    c.room.onDebug(a, 'spawn', [0, g.x + 25, g.y, g.z]);
    c.step();
    const spawns = c.events(a).filter((e) => e.e === 'spawn') as Array<{ id: number; x: number }>;
    expect(spawns.length).toBe(2);
    const near = spawns.find((e) => e.x < g.x + 5)!.id;
    const far = spawns.find((e) => e.x > g.x + 5)!.id;
    const strike = (seq: number, target: number, viewT: number) =>
      c.room.onIntent(a, { k: 'strike', seq, target, move: 0, viewT, hx: g.x, hy: g.y, hz: g.z });
    c.state(a, g.x, g.y, g.z);
    strike(1, near, c.nowS() - 0.1);
    strike(2, near, c.nowS() - 0.08); // 20 ms later: faster than minStrikeInterval
    strike(4, near, c.nowS() - 3); // far in the past
    c.step();
    c.state(a, g.x, g.y, g.z);
    c.step(8); // past minStrikeInterval
    c.state(a, g.x, g.y, g.z);
    strike(3, far, c.nowS() - 0.05); // 25 m away
    c.step();
    const ev = c.events(a);
    const hit = ev.find((e) => e.e === 'hit' && e.src === HERO_ID_BASE + a);
    expect(hit, JSON.stringify(ev)).toMatchObject({ tgt: near, move: 0 });
    const rej = Object.fromEntries(ev.filter((e) => e.e === 'rej').map((e) => [(e as { seq: number }).seq, (e as { why: string }).why]));
    expect(rej).toEqual({ 2: 'rate', 3: 'range', 4: 'time' });
    // The nearby thug fights back.
    let hurt = false;
    for (let i = 0; i < 30 * 6 && !hurt; i++) {
      if (i % 3 === 0) c.state(a, g.x, g.y, g.z);
      c.step();
      hurt = c.events(a).some((e) => e.e === 'hit' && e.tgt === HERO_ID_BASE + a);
    }
    expect(hurt).toBe(true);
    expect(c.csim.heroHp(a)).toBeLessThan(tuning.combat.maxHp);
  });

  test('down and respawn: the server respawn point is an accepted teleport, rejoin hp in welcome', () => {
    const c = makeCombatRoom();
    const g = groundSpot();
    const a = admit(c.room, 'Düşen');
    c.state(a, g.x, g.y, g.z);
    c.step();
    c.room.onDebug(a, 'setHp', [0]);
    let resp: { x: number; y: number; z: number } | null = null;
    for (let i = 0; i < 30 * (tuning.combat.downTime + 2) && !resp; i++) {
      if (i % 3 === 0) c.state(a, g.x, g.y, g.z);
      c.step();
      resp = (c.events(a).find((e) => e.e === 'respawn') as { x: number; y: number; z: number } | undefined) ?? null;
    }
    expect(c.events(a).some((e) => e.e === 'down' && e.pid === a)).toBe(true);
    expect(resp).not.toBeNull();
    expect(Math.hypot(resp!.x - g.x, resp!.z - g.z)).toBeGreaterThan(tuning.combat.respawnRoofMin - 15); // a roof, not the street
    const out = { x: 0, y: 0, z: 0 };
    expect(c.csim.respawnPoint(a, out)).toBe(true);
    expect(c.state(a, resp!.x, resp!.y, resp!.z, 1)).toBe(STATE_OK);
    expect(c.out.json(a, 'correct')).toEqual([]);
    expect(c.csim.heroHp(a)).toBe(tuning.combat.maxHp);
    // Elsewhere far away with the counter bumped is still a cheat.
    c.step();
    expect(c.state(a, resp!.x + 300, resp!.y, resp!.z, 2)).toBe(STATE_CORRECTED);
  });

  test('PvP is CombatSim\'s rule: rejected in public rooms, allowed in private PvP rooms', () => {
    for (const pvpRoom of [false, true]) {
      const c = makeCombatRoom({ pvp: pvpRoom, publicRoom: !pvpRoom });
      const g = groundSpot();
      const a = admit(c.room, 'Saldıran');
      const b = admit(c.room, 'Hedef');
      c.state(a, g.x, g.y, g.z);
      c.state(b, g.x + 1, g.y, g.z);
      c.step(3);
      c.state(a, g.x, g.y, g.z);
      c.state(b, g.x + 1, g.y, g.z);
      c.room.onIntent(a, { k: 'strike', seq: 5, target: HERO_ID_BASE + b, move: 0, viewT: c.nowS() - 0.05, hx: g.x, hy: g.y, hz: g.z });
      c.step();
      const ev = c.events(a);
      if (pvpRoom) {
        expect(ev.some((e) => e.e === 'rej'), JSON.stringify(ev)).toBe(false);
        expect(ev.some((e) => e.e === 'hit' && e.tgt === HERO_ID_BASE + b)).toBe(true);
        expect(c.csim.heroHp(b)).toBeLessThan(tuning.combat.maxHp);
      } else {
        expect(ev.filter((e) => e.e === 'rej')).toEqual([{ e: 'rej', pid: a, seq: 5, why: 'pvp' }]);
        expect(c.events(b).some((e) => e.e === 'rej')).toBe(false); // only to the sender
      }
    }
  });

  test('snapshots: nearest first within the radius, into the preallocated array', () => {
    const c = makeCombatRoom();
    const g = groundSpot();
    for (let i = 0; i < 45; i++) {
      const ang = i * 2.399;
      const r = 3 + i * 8;
      c.csim.sim.debugSpawn(0, g.x + Math.cos(ang) * r, g.y + 5, g.z + Math.sin(ang) * r);
    }
    const out = Array.from({ length: 30 }, makeEnemySnap);
    const before = out.slice();
    const n = c.csim.snapshot(g.x, g.y, g.z, 300, out, 30);
    expect(out.every((o, i) => o === before[i])).toBe(true);
    const all = c.csim.sim.enemies.map((e) => Math.hypot(e.pos.x - g.x, e.pos.y - g.y, e.pos.z - g.z)).filter((d) => d <= 300).sort((p, q) => p - q);
    expect(n).toBe(Math.min(30, all.length));
    const got = out.slice(0, n).map((e) => Math.hypot(e.x - g.x, e.y - g.y, e.z - g.z));
    for (let i = 0; i < n; i++) expect(got[i]).toBeCloseTo(all[i], 6);
    expect(out[0]).toMatchObject({ kind: 0, hp: 1, target: 0 });
    expect(c.csim.snapshot(g.x, g.y, g.z, 1, out, 30)).toBe(0);
  });

  test('parity: Room + CombatRoomSim over the wire format and a bare CombatSim give the same hash', () => {
    const g = groundSpot();
    const seed = 4242;
    const q = (v: number) => Math.round(v * 16) / 16; // exactly representable after f32 / JSON
    const script = (k: number, pid: number) => {
      const t = k * 0.03 + pid;
      return { x: q(g.x + Math.cos(t) * 3), y: g.y, z: q(g.z + Math.sin(t) * 3), vx: q(Math.cos(t) * 2), vz: q(Math.sin(t) * 2) };
    };
    const STEPS = 450;
    // (a) through the Room: encoded states, JSON intents, debug hooks.
    const c = makeCombatRoom({ seed });
    const pids = [admit(c.room, 'Bir'), admit(c.room, 'İki')];
    // (b) a bare CombatSim with the same inputs.
    const bare = new CombatSim(map.world, map.layout, map.spawns, seed, { pvp: false, maxEnemies: 60 });
    const decoded = makeHeroSample();
    const ceRoom: string[] = [];
    const ceBare: string[] = [];
    for (let k = 0; k < STEPS; k++) {
      const nowMs = (k * 1000) / 30;
      if (k % 3 === 0) {
        for (const pid of pids) {
          const p = script(k, pid);
          const s = sampleAt(p.x, p.y, p.z, nowMs);
          s.vx = p.vx;
          s.vz = p.vz;
          expect(decodeHeroState(encodeHeroState(s), decoded)).toBe(true);
          // The bare sim gets exactly what came off the wire, with the Room's clock conversion.
          const d = decoded;
          bare.upsertHero({ pid, x: d.x, y: d.y, z: d.z, vx: d.vx, vy: d.vy, vz: d.vz, mode: d.mode, grounded: true, facing: d.facing, afk: false, t: c.room.toSim(Math.round(nowMs) / 1000) });
          c.room.onState(pid, decoded, null, nowMs);
        }
      }
      if (k === 3) {
        for (let i = 0; i < 6; i++) {
          const args = [i % 2, g.x + 4 + i, g.y, g.z - 3 + i];
          const msg = parseClientMsg(JSON.stringify({ t: 'dbg', op: 'spawn', a: args }));
          if (!msg || msg.t !== 'dbg') throw new Error('dbg');
          c.room.onDebug(pids[0], msg.op, msg.a);
          bare.debugSpawn(args[0] as 0, args[1], args[2], args[3]);
        }
      }
      if (k > 6 && k % 10 === 0) {
        for (const pid of pids) {
          const p = script(k - k % 3, pid);
          const i = { k: 'strike', seq: k, target: 1 + ((k / 10) % 6), move: 0, viewT: nowMs / 1000 - 0.1, hx: p.x, hy: p.y, hz: p.z } as const;
          const msg = parseClientMsg(JSON.stringify({ t: 'act', i }));
          if (!msg || msg.t !== 'act') throw new Error('act');
          c.room.onIntent(pid, msg.i);
          bare.intent(pid, { ...i, viewT: c.room.toSim(i.viewT) }); // the Room's clock conversion (offset ≈ 0 here)
        }
      }
      c.room.step(((k + 1) * 1000) / 30);
      bare.step();
      const evs: CombatEvent[] = [];
      bare.drainEvents(evs);
      for (const e of evs) ceBare.push(e.e);
    }
    for (const m of c.out.msgs) if (m.pid === pids[0] && !(m.m instanceof Uint8Array) && m.m.t === 'ce') for (const e of m.m.ev) ceRoom.push(e.e);
    expect(c.csim.sim.steps).toBe(STEPS);
    expect(c.csim.hash()).toBe(bare.hash());
    expect(ceBare.filter((e) => e === 'hit').length).toBeGreaterThan(3);
    // Same event stream (the Room sends 'rej' only to its owner, so compare without them).
    expect(ceRoom.filter((e) => e !== 'rej')).toEqual(ceBare.filter((e) => e !== 'rej'));
  });
});

// ---------------------------------------------------------------------------
// RoomManager

class FakePeer implements Peer {
  readonly got: Array<ServerMsg | Uint8Array> = [];
  detached: string | null = null;
  deliver(m: ServerMsg | Uint8Array): void {
    this.got.push(m);
  }
  detach(why: string): void {
    this.detached = why;
  }
  json(t: string): ServerMsg[] {
    return this.got.filter((m) => !(m instanceof Uint8Array) && m.t === t) as ServerMsg[];
  }
}

function hello(name: string, join: { kind: 'public' } | { kind: 'code'; code: string } | { kind: 'create'; pvp: boolean }, token?: string) {
  return { t: 'hello' as const, v: 1, name, costume: 'redNavy', map: 'manhattan' as const, join, ...(token ? { token } : {}) };
}

test.describe('room manager', () => {
  const opts = { maxPlayersPerRoom: 16, maxRooms: 10, privateRoomIdleS: 60, reconnectGraceS: 30, testHooks: false };

  test('16 fill public #1, the 17th opens #2, an empty #2 closes', () => {
    const mgr = new RoomManager(opts);
    const peers: FakePeer[] = [];
    for (let i = 0; i < 17; i++) {
      const p = new FakePeer();
      const r = mgr.hello(p, hello(`Oyuncu${i}`, { kind: 'public' }), 0);
      expect(r.ok).toBe(true);
      peers.push(p);
    }
    const pubs = mgr.publicRooms('manhattan');
    expect(pubs.map((r) => [r.index, r.room.players.size])).toEqual([
      [1, 16],
      [2, 1],
    ]);
    const w17 = peers[16].json('welcome')[0] as Extract<ServerMsg, { t: 'welcome' }>;
    expect(w17.room).toMatchObject({ public: true, index: 2, pvp: false });
    // One leaves #1: the next public join fills #1 again (lowest index first).
    const mr1 = pubs[0];
    mgr.release(mr1, 3, mr1.peers.get(3)!, false, 'leave', 100);
    const p18 = new FakePeer();
    const r18 = mgr.hello(p18, hello('Geç Gelen', { kind: 'public' }), 100);
    expect(r18.ok && r18.mr.index).toBe(1);
    // #2 empties → closed on the next tick; #1 stays.
    const mr2 = pubs[1];
    mgr.release(mr2, 1, mr2.peers.get(1)!, false, 'leave', 200);
    mgr.tick(233);
    expect(mgr.publicRooms('manhattan').map((r) => r.index)).toEqual([1]);
  });

  test('private rooms: create with PvP, join by code (case-insensitive), notFound, idle close', () => {
    const mgr = new RoomManager(opts);
    const host = new FakePeer();
    const r = mgr.hello(host, hello('Kurucu', { kind: 'create', pvp: true }), 0);
    expect(r.ok).toBe(true);
    const w = host.json('welcome')[0] as Extract<ServerMsg, { t: 'welcome' }>;
    expect(w.room.public).toBe(false);
    expect(w.room.pvp).toBe(true);
    expect(isRoomCode(w.room.code!)).toBe(true);
    const guest = new FakePeer();
    const g = mgr.hello(guest, hello('Misafir', { kind: 'code', code: w.room.code!.toLowerCase() }), 10);
    expect(g.ok && g.mr.room.id).toBe(w.room.id);
    expect(mgr.hello(new FakePeer(), hello('Kayıp', { kind: 'code', code: 'ZZZZZZ' }), 10)).toEqual({ ok: false, why: 'notFound' });
    expect(mgr.hello(new FakePeer(), hello('Kayıp', { kind: 'code', code: 'nope' }), 10)).toEqual({ ok: false, why: 'notFound' });
    expect(mgr.hello(new FakePeer(), { ...hello('Eski', { kind: 'public' }), v: 0 }, 10)).toEqual({ ok: false, why: 'version' });
    expect(mgr.hello(new FakePeer(), hello('orospu', { kind: 'create', pvp: false }), 10)).toEqual({ ok: false, why: 'profanity' });
    expect(mgr.rooms.size).toBe(1); // the rejected creator's room is gone
    // Everyone leaves; the room closes after PRIVATE_ROOM_IDLE_S.
    const mr = g.ok ? g.mr : null;
    mgr.release(mr!, 1, host, false, 'leave', 1000);
    mgr.release(mr!, 2, guest, false, 'leave', 1000);
    mgr.tick(30_000);
    expect(mgr.findByCode(w.room.code!)).not.toBeNull();
    mgr.tick(61_001);
    expect(mgr.findByCode(w.room.code!)).toBeNull();
  });

  test('reconnect through hello with the token, rooms cap', () => {
    const mgr = new RoomManager({ ...opts, maxRooms: 2 });
    const p1 = new FakePeer();
    const r = mgr.hello(p1, hello('Gezgin', { kind: 'create', pvp: false }), 0);
    if (!r.ok) throw new Error('rejected');
    const token = (p1.json('welcome')[0] as Extract<ServerMsg, { t: 'welcome' }>).token;
    mgr.release(r.mr, r.pid, p1, true, 'disconnect', 1000);
    const p2 = new FakePeer();
    const back = mgr.hello(p2, hello('Gezgin', { kind: 'public' }, token), 5000);
    expect(back).toMatchObject({ ok: true, pid: r.pid, resumed: true });
    expect(back.ok && back.mr).toBe(r.mr);
    // Unknown token: normal join.
    const p3 = new FakePeer();
    expect(mgr.hello(p3, hello('Yeni', { kind: 'public' }, 'f'.repeat(32)), 5000)).toMatchObject({ ok: true, resumed: false });
    expect(mgr.hello(new FakePeer(), hello('Fazla', { kind: 'create', pvp: false }), 5000)).toEqual({ ok: false, why: 'full' });
  });
});

// ---------------------------------------------------------------------------
// Limits, config, sessions, static files

test('token bucket, sustained abuse, connections per IP, client address', () => {
  const b = new TokenBucket(30, 40);
  let ok = 0;
  for (let i = 0; i < 100; i++) if (b.take(0)) ok++;
  expect(ok).toBe(40); // burst
  ok = 0;
  for (let t = 0; t < 10_000; t += 10) if (b.take(t)) ok++; // 100/s offered for 10 s
  expect(ok).toBeGreaterThanOrEqual(299);
  expect(ok).toBeLessThanOrEqual(301);
  const m = new AbuseMeter();
  expect(m.hit(0)).toBe(false);
  expect(m.hit(5000)).toBe(false); // gap > 1 s restarts
  let k = false;
  for (let t = 5000; t <= 15_000 && !k; t += 500) k = m.hit(t);
  expect(k).toBe(true);
  const c = new ConnLimiter(2);
  expect([c.acquire('a'), c.acquire('a'), c.acquire('a'), c.acquire('b')]).toEqual([true, true, false, true]);
  c.release('a');
  expect(c.acquire('a')).toBe(true);
  const req = { headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' } } as never;
  expect(clientIp(req, false)).toBe('127.0.0.1');
  expect(clientIp(req, true)).toBe('1.2.3.4');
});

test('config from env and CLI flags', () => {
  expect(argsToEnv(['--port=8787', '--static=', '--test-hooks', '--max-players-per-room=4'])).toEqual({ PORT: '8787', STATIC_DIR: '', TEST_HOOKS: '1', MAX_PLAYERS_PER_ROOM: '4' });
  const c = loadConfig({ PORT: '9000', ALLOWED_ORIGINS: 'https://oyun.example.com/, https://b.example' }, ['--static=', '--test-hooks']);
  expect(c).toMatchObject({ port: 9000, host: '0.0.0.0', staticDir: '', maxPlayersPerRoom: 16, maxRooms: 200, maxConnPerIp: 8, testHooks: true, trustProxy: false });
  expect(c.allowedOrigins).toEqual(['https://oyun.example.com', 'https://b.example']);
  expect(loadConfig({}, []).staticDir).toBe(path.resolve('dist'));
  expect(() => loadConfig({ PORT: 'abc' }, [])).toThrow(/PORT/);
  expect(() => loadConfig({ MAX_PLAYERS_PER_ROOM: '0' }, [])).toThrow(/MAX_PLAYERS_PER_ROOM/);
  expect(() => loadConfig({}, ['oops'])).toThrow(/Unknown argument/);
});

class FakeConn implements Conn {
  sent: Array<string | Uint8Array> = [];
  closed: { code: number; reason: string } | null = null;
  terminated = false;
  pings = 0;
  bufferedAmount = 0;
  send(d: string | Uint8Array): void {
    this.sent.push(d);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  terminate(): void {
    this.terminated = true;
  }
  ping(): void {
    this.pings++;
  }
  json(): ServerMsg[] {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s) as ServerMsg);
  }
}

test('sessions: hello first, garbage closes 1008, flooding kicks after 10 s, leave and drop', async () => {
  const mgr = new RoomManager({ maxPlayersPerRoom: 16, maxRooms: 10, privateRoomIdleS: 60, reconnectGraceS: 30, testHooks: false });
  let now = 0;
  const clock = () => now;
  const open = () => {
    const conn = new FakeConn();
    const s = new Session(conn, '1.1.1.1', mgr, clock, { helloTimeoutMs: 40 });
    return { conn, s };
  };
  const helloText = (name: string) => JSON.stringify(hello(name, { kind: 'public' }));

  // Binary or anything but hello first → garbage.
  const g1 = open();
  g1.s.onMessage(encodeHeroState(sampleAt(0, 0, 0, 0)), true);
  expect(g1.conn.closed?.code).toBe(1008);
  expect(g1.conn.json().at(-1)).toEqual({ t: 'kick', why: 'garbage' });
  const g2 = open();
  g2.s.onMessage('{"t":"ping","c":1}', false);
  expect(g2.conn.closed?.code).toBe(1008);

  // Hello timeout.
  const slow = open();
  await new Promise((r) => setTimeout(r, 80));
  expect(slow.conn.closed).toEqual({ code: 1008, reason: 'hello timeout' });

  // A good session.
  const a = open();
  a.s.onMessage(helloText('Akıncı'), false);
  expect(a.conn.json()[0].t).toBe('welcome');
  const pid = a.s.pid;
  const room = a.s.mr!.room;
  a.s.onMessage('{"t":"ping","c":42}', false);
  expect(a.conn.json().at(-1)).toEqual({ t: 'pong', c: 42, s: 0 });
  // Garbage binary after hello → kick, slot removed.
  const b = open();
  b.s.onMessage(helloText('Bozuk'), false);
  const bpid = b.s.pid;
  b.s.onMessage(new Uint8Array([0x01, 2, 3]), true);
  expect(b.conn.closed?.code).toBe(1008);
  expect(room.players.has(bpid)).toBe(false);

  // State flood: 100/s → over the 30/s budget; dropped, then kicked after 10 s.
  const f = open();
  f.s.onMessage(helloText('Seli'), false);
  let seq = 0;
  for (now = 0; now < 12_000 && !f.conn.closed; now += 10) {
    const st = sampleAt(0, 50, 0, now);
    st.seq = seq++;
    f.s.onMessage(encodeHeroState(st), true);
  }
  expect(f.conn.json().at(-1)).toEqual({ t: 'kick', why: 'rate' });
  expect(now).toBeGreaterThanOrEqual(10_000);
  expect(f.s.dropped).toBeGreaterThan(500);
  // Normal 20 Hz upload is never limited.
  const n = open();
  n.s.onMessage(helloText('Normal'), false);
  for (let i = 0; i < 400; i++, now += 50) n.s.onMessage(encodeHeroState(sampleAt(0, 50, 0, now)), true);
  expect(n.s.dropped).toBe(0);
  expect(n.conn.closed).toBeNull();

  // Unexpected close keeps the slot; leave removes it.
  a.s.onClose();
  expect(room.players.get(pid)?.connected).toBe(false);
  n.s.onMessage('{"t":"leave"}', false);
  expect(n.conn.closed?.code).toBe(1000);
  expect([...room.players.values()].some((s) => s.name === 'Normal')).toBe(false);
  // Heartbeat: two missed pongs terminate.
  const h = open();
  h.s.onMessage(helloText('Kalp'), false);
  h.s.heartbeat();
  h.s.onPong();
  h.s.heartbeat();
  h.s.heartbeat();
  expect(h.conn.terminated).toBe(false);
  h.s.heartbeat();
  expect(h.conn.terminated).toBe(true);
  expect(h.conn.pings).toBe(3);
});

test('static paths cannot escape the root', () => {
  const root = path.resolve('/srv/www');
  expect(resolveStaticPath(root, '/')).toBe(path.join(root, 'index.html'));
  expect(resolveStaticPath(root, '/assets/app.js')).toBe(path.join(root, 'assets', 'app.js'));
  for (const bad of ['/../etc/passwd', '/%2e%2e/etc/passwd', '/assets/../../x', '/.git/config', '/a%00b', '/%E0%A4%A', '/..%5c..%5cx', '/.env']) {
    expect(resolveStaticPath(root, bad), bad).toBeNull();
  }
});

// ---------------------------------------------------------------------------
// Purity of the shared modules (they run in the browser, in Node and in LocalLink)

test('shared net/sim modules import only pure code and no DOM or Node APIs', () => {
  const allowed = [/^three$/, /^src\/combat\/(?!render\/|client\/)[a-zA-Z/]+\.ts$/, /^src\/config\/tuning\.ts$/, /^src\/core\/(math|rng)\.ts$/, /^src\/physics\/[a-zA-Z]+\.ts$/, /^src\/world\/(types|cityGen|cityCollision)\.ts$/, /^src\/net\/(protocol|codec|names|maps|clock|interp)\.ts$/, /^src\/sim\/[a-zA-Z]+\.ts$/];
  const roots = ['protocol', 'codec', 'names', 'maps', 'clock', 'interp'].map((n) => `src/net/${n}.ts`).concat(fs.readdirSync(path.join(ROOT, 'src/sim')).map((f) => `src/sim/${f}`));
  const seen = new Set<string>();
  const queue = [...roots];
  const problems: string[] = [];
  while (queue.length) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const isShared = /^src\/(net|sim)\//.test(rel);
    if (isShared) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const bad of [/\bwindow\b/, /\bdocument\b/, /\blocalStorage\b/, /\bprocess\./, /\brequire\(/, /\bBuffer\b/, /['"]node:/, /\bperformance\./, /\bDate\.now\b/]) {
        if (bad.test(code)) problems.push(`${rel}: ${bad}`);
      }
    }
    for (const m of src.matchAll(/^\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      if (!spec.startsWith('.')) {
        if (!allowed.some((a) => a.test(spec))) problems.push(`${rel} imports ${spec}`);
        continue;
      }
      const target = path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, rel)), spec)).split(path.sep).join('/') + '.ts';
      if (!allowed.some((a) => a.test(target))) problems.push(`${rel} imports ${target}`);
      else queue.push(target);
    }
  }
  expect(problems).toEqual([]);
  expect(seen.size).toBeGreaterThan(10);
});
