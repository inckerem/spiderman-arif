/**
 * Server-side combat over real WebSockets (no browser): the built server runs
 * M11's CombatSim in every room. Raw bots spawn enemies through the test
 * hooks, receive enemy snapshots (~15 Hz) and combat events, strike (hit,
 * and rejections for range, rate and time), take damage, go down and respawn
 * on a roof the Room accepts as a teleport; PvP only in private PvP rooms.
 * (Determinism parity Room + wire vs bare CombatSim: tests/server.spec.ts.)
 */
import { test, expect } from '@playwright/test';
import { buildMapRuntime } from '../server/mapRuntime';
import { AR } from '../src/combat/spawnPoints';
import { tuning } from '../src/config/tuning';
import { HERO_ID_BASE, type CombatEvent } from '../src/sim/types';
import { NetBot } from './netBot';
import { buildAll, startServerProc, type ServerProc } from './serverProc';

test.describe.configure({ mode: 'serial' });

let srv: ServerProc;
const bots: NetBot[] = [];
let spot = { x: 0, y: 0, z: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function join(name: string, join?: Parameters<typeof NetBot.join>[1]['join']): Promise<NetBot> {
  const b = await NetBot.join(srv.wsUrl, { name, join });
  expect(b.welcome, b.rejected ?? 'no welcome').not.toBeNull();
  bots.push(b);
  return b;
}

/** Bot standing at the ground spot (offset dx), uploading at 20 Hz. */
async function stand(name: string, dx: number, join_?: Parameters<typeof NetBot.join>[1]['join']): Promise<NetBot> {
  const b = await join(name, join_);
  b.pos.x = spot.x + dx;
  b.pos.y = spot.y;
  b.pos.z = spot.z;
  b.startUpload();
  await sleep(150);
  return b;
}

const events = (b: NetBot, pred: (e: CombatEvent) => boolean) => b.combat.filter(pred);
const rejOf = (b: NetBot, seq: number) => (b.combat.find((e) => e.e === 'rej' && e.seq === seq) as { why: string } | undefined)?.why;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  buildAll();
  const map = buildMapRuntime('manhattan');
  const a = map.spawns.arenas.find((r) => !r.roof && r.type === AR.INTERSECTION) ?? map.spawns.arenas.find((r) => !r.roof)!;
  spot = { x: a.x, y: a.y, z: a.z };
  srv = await startServerProc(['--static=', '--test-hooks', '--private-room-idle-s=1']);
  expect(srv.log()).toMatch(/map ready .*"map":"manhattan"/);
  expect(srv.log()).toContain('"sim":"combat"');
});

test.afterAll(async () => {
  await Promise.all(bots.map((b) => b.close()));
  if (srv) await srv.stop();
});

test('enemies from the test hooks, ~15 Hz snapshots, strikes hit or are rejected with the right reason', async () => {
  const a = await stand('Yumrukçu', 0, { kind: 'create', pvp: false });
  a.send({ t: 'dbg', op: 'spawn', a: [0, spot.x + 1.2, spot.y, spot.z] });
  a.send({ t: 'dbg', op: 'spawn', a: [0, spot.x + 30, spot.y, spot.z] });
  await a.until(() => events(a, (e) => e.e === 'spawn').length === 2, 3000);
  await a.until(() => a.enemyCount === 2, 3000);
  const ids = events(a, (e) => e.e === 'spawn') as Array<{ id: number; x: number }>;
  const near = ids.find((e) => e.x < spot.x + 5)!.id;
  const far = ids.find((e) => e.x > spot.x + 5)!.id;
  expect(a.enemies[0].id).toBe(near); // nearest first
  // Snapshot rate over 2 s.
  const n0 = a.snapshotTimes.length;
  await sleep(2000);
  const rate = (a.snapshotTimes.length - n0) / 2;
  expect(rate).toBeGreaterThan(12);
  expect(rate).toBeLessThan(18);

  const strike = (seq: number, target: number, viewT: number) =>
    a.send({ t: 'act', i: { k: 'strike', seq, target, move: 0, viewT, hx: a.pos.x, hy: a.pos.y, hz: a.pos.z } });
  const v = a.viewT();
  strike(1, near, v);
  strike(2, near, v + 0.02); // faster than minStrikeInterval
  strike(3, near, v - 5); // far outside the view window
  await a.until(() => events(a, (e) => e.e === 'hit' && e.src === HERO_ID_BASE + a.pid).length > 0 && !!rejOf(a, 2) && !!rejOf(a, 3), 3000);
  const hit = events(a, (e) => e.e === 'hit' && e.src === HERO_ID_BASE + a.pid)[0] as { tgt: number; dmg: number; hp: number };
  expect(hit.tgt).toBe(near);
  expect(hit.dmg).toBeGreaterThan(0);
  expect(rejOf(a, 2)).toBe('rate');
  expect(rejOf(a, 3)).toBe('time');
  await sleep(300);
  strike(4, far, a.viewT());
  await a.until(() => !!rejOf(a, 4), 3000);
  expect(rejOf(a, 4)).toBe('range');
  // Enemy health shows in the snapshot.
  await a.until(() => a.enemies.slice(0, a.enemyCount).some((e) => e.id === near && e.hp < 1), 2000);
});

test('the hero takes damage, goes down and respawns on a roof the server accepts', async () => {
  const a = bots[0];
  // The thug next to the hero fights back.
  await a.until(() => events(a, (e) => e.e === 'hit' && e.tgt === HERO_ID_BASE + a.pid).length > 0, 10_000);
  const hurt = events(a, (e) => e.e === 'hit' && e.tgt === HERO_ID_BASE + a.pid)[0] as { dmg: number; hp: number };
  expect(hurt.dmg).toBeGreaterThan(0);
  expect(hurt.hp).toBeLessThan(tuning.combat.maxHp);
  a.send({ t: 'dbg', op: 'setHp', a: [0] });
  await a.until(() => events(a, (e) => e.e === 'down' && e.pid === a.pid).length > 0, 2000);
  await a.until(() => events(a, (e) => e.e === 'respawn' && e.pid === a.pid).length > 0, (tuning.combat.downTime + 2) * 1000);
  const r = events(a, (e) => e.e === 'respawn' && e.pid === a.pid)[0] as { x: number; y: number; z: number };
  expect(r.y).toBeGreaterThanOrEqual(tuning.combat.respawnRoofMinY - 1);
  // The bot teleported there (counter bumped) and keeps uploading: no correction, not kicked.
  expect(a.pos).toEqual({ x: r.x, y: r.y, z: r.z });
  await sleep(1000);
  expect(a.of('correct')).toEqual([]);
  expect(a.closed).toBe(false);
  // Clear the room's enemies.
  a.send({ t: 'dbg', op: 'clear', a: [] });
  await a.until(() => a.enemyCount === 0, 2000);
});

test('PvP: a hero target is rejected in the public room and lands in a private PvP room', async () => {
  const p1 = await stand('Kavgacı', 0);
  const p2 = await stand('Seyirci', 1);
  expect(p1.welcome!.room.public).toBe(true);
  p1.send({ t: 'act', i: { k: 'strike', seq: 11, target: HERO_ID_BASE + p2.pid, move: 0, viewT: p1.viewT(), hx: p1.pos.x, hy: p1.pos.y, hz: p1.pos.z } });
  await p1.until(() => !!rejOf(p1, 11), 3000);
  expect(rejOf(p1, 11)).toBe('pvp');
  expect(p2.combat.some((e) => e.e === 'rej')).toBe(false);

  const c = await stand('Düellocu', 0, { kind: 'create', pvp: true });
  const d = await stand('Rakip', 1, { kind: 'code', code: c.welcome!.room.code! });
  expect(d.welcome!.room.pvp).toBe(true);
  c.send({ t: 'act', i: { k: 'strike', seq: 12, target: HERO_ID_BASE + d.pid, move: 0, viewT: c.viewT(), hx: c.pos.x, hy: c.pos.y, hz: c.pos.z } });
  await d.until(() => d.combat.some((e) => e.e === 'hit' && e.tgt === HERO_ID_BASE + d.pid), 3000);
  expect(rejOf(c, 12)).toBeUndefined();
});
