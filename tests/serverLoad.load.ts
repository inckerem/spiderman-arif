/**
 * Server load test (not part of the regular suites): `npm run test:server:load`.
 * A: one room with 16 bot players and ~30 enemies for 60 s.
 * B: ten rooms at once (160 bots, ~300 enemies) for 30 s.
 * Bots upload at 20 Hz while walking, strike nearby enemies once a second,
 * follow their respawns; enemies are topped up to ~30 per room through the
 * test hooks. Reports room step time (p50/p95), whole-tick time, server CPU
 * and memory, and bytes per client; numbers go to test-results/server-load.json.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildMapRuntime } from '../server/mapRuntime';
import { AR } from '../src/combat/spawnPoints';
import { NetBot } from './netBot';
import { ROOT, buildAll, startServerProc, type ServerProc } from './serverProc';

test.describe.configure({ mode: 'serial' });

let srv: ServerProc;
let spots: Array<{ x: number; y: number; z: number }> = [];
const results: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Detail {
  tick: { p50: number; p95: number; max: number; mean: number; n: number };
  rooms: Array<{ name: string; players: number; enemies: number; step: { p50: number; p95: number; max: number; mean: number; n: number } }>;
  cpu: { user: number; system: number };
  memory: { rss: number; heapUsed: number };
}

async function detail(reset = false): Promise<Detail> {
  const r = await fetch(`${srv.base}/healthz?detail=1${reset ? '&reset=1' : ''}`);
  return ((await r.json()) as { detail: Detail }).detail;
}

interface Group {
  bots: NetBot[];
  timers: Array<ReturnType<typeof setInterval>>;
}

/** 16 bots in a new private room around `c`, walking, striking, with enemies topped up to `enemies`. */
async function fillRoom(tag: string, c: { x: number; y: number; z: number }, enemies: number): Promise<Group> {
  const bots: NetBot[] = [];
  const lead = await NetBot.join(srv.wsUrl, { name: `${tag} Lider`, join: { kind: 'create', pvp: false } });
  expect(lead.welcome).not.toBeNull();
  bots.push(lead);
  for (let i = 1; i < 16; i++) {
    const b = await NetBot.join(srv.wsUrl, { name: `${tag} Bot${i}`, join: { kind: 'code', code: lead.welcome!.room.code! } });
    expect(b.welcome, b.rejected ?? '').not.toBeNull();
    bots.push(b);
  }
  const timers: Group['timers'] = [];
  bots.forEach((b, i) => {
    const a = (i / bots.length) * Math.PI * 2;
    b.pos.x = c.x + Math.cos(a) * 8;
    b.pos.y = c.y;
    b.pos.z = c.z + Math.sin(a) * 8;
    let heading = a + Math.PI / 2;
    b.startUpload(20, () => ({ vx: Math.cos(heading) * 2, vz: Math.sin(heading) * 2 }));
    timers.push(
      setInterval(() => {
        heading += 0.04;
        b.pos.x += Math.cos(heading) * 0.1; // 2 m/s
        b.pos.z += Math.sin(heading) * 0.1;
      }, 50),
    );
    let seq = 0;
    timers.push(
      setInterval(() => {
        const e = b.enemies[0];
        if (b.enemyCount && e && Math.hypot(e.x - b.pos.x, e.z - b.pos.z) < 3) {
          b.send({ t: 'act', i: { k: 'strike', seq: ++seq, target: e.id, move: 0, viewT: b.viewT(), hx: b.pos.x, hy: b.pos.y, hz: b.pos.z } });
        }
      }, 1000 + i * 13),
    );
  });
  // Keep about `enemies` alive: the debug spawns are spread over the bots (5 per second each).
  let k = 0;
  const topUp = () => {
    const missing = Math.min(10, enemies - lead.enemyCount);
    for (let j = 0; j < missing; j++, k++) {
      const b = bots[k % bots.length];
      const ang = k * 2.4;
      b.send({ t: 'dbg', op: 'spawn', a: [k % 2, c.x + Math.cos(ang) * (6 + (k % 12)), c.y, c.z + Math.sin(ang) * (6 + (k % 12))] });
    }
  };
  topUp();
  timers.push(setInterval(topUp, 1000));
  return { bots, timers };
}

async function stopGroup(g: Group): Promise<void> {
  for (const t of g.timers) clearInterval(t);
  await Promise.all(g.bots.map((b) => b.close()));
}

async function measure(label: string, groups: Group[], seconds: number) {
  await sleep(4000); // warm-up: enemies spawned and engaged
  const bytes0 = groups.flatMap((g) => g.bots.map((b) => b.bytesIn));
  const up0 = groups.flatMap((g) => g.bots.map((b) => b.bytesOut));
  const d0 = await detail(true);
  const t0 = performance.now();
  const enemySamples: number[] = [];
  for (let s = 0; s < seconds; s += 5) {
    await sleep(5000);
    const d = await detail(false);
    enemySamples.push(d.rooms.reduce((a, r) => a + r.enemies, 0) / Math.max(1, d.rooms.length));
  }
  const d1 = await detail(false);
  const wall = (performance.now() - t0) / 1000;
  const bots = groups.flatMap((g) => g.bots);
  const down = bots.map((b, i) => (b.bytesIn - bytes0[i]) / wall);
  const up = bots.map((b, i) => (b.bytesOut - up0[i]) / wall);
  const cpu = (d1.cpu.user + d1.cpu.system - d0.cpu.user - d0.cpu.system) / 1e6 / wall;
  const steps = d1.rooms.filter((r) => r.players > 0);
  const r = {
    seconds: Math.round(wall),
    rooms: steps.length,
    players: steps.reduce((a, x) => a + x.players, 0),
    enemiesPerRoomAvg: +(enemySamples.reduce((a, x) => a + x, 0) / enemySamples.length).toFixed(1),
    roomStepMs: {
      p50: +Math.max(...steps.map((x) => x.step.p50)).toFixed(3),
      p95: +Math.max(...steps.map((x) => x.step.p95)).toFixed(3),
      max: +Math.max(...steps.map((x) => x.step.max)).toFixed(2),
      mean: +(steps.reduce((a, x) => a + x.step.mean, 0) / steps.length).toFixed(3),
    },
    tickMs: { p50: +d1.tick.p50.toFixed(3), p95: +d1.tick.p95.toFixed(3), max: +d1.tick.max.toFixed(2) },
    serverCpuCores: +cpu.toFixed(3),
    rssMB: Math.round(d1.memory.rss / 1048576),
    heapMB: Math.round(d1.memory.heapUsed / 1048576),
    downKBps: { avg: +(down.reduce((a, x) => a + x, 0) / down.length / 1024).toFixed(1), max: +(Math.max(...down) / 1024).toFixed(1) },
    upKBps: { avg: +(up.reduce((a, x) => a + x, 0) / up.length / 1024).toFixed(2) },
    botsClosed: bots.filter((b) => b.closed).length,
    corrections: bots.reduce((a, b) => a + b.of('correct').length, 0),
  };
  results[label] = r;
  console.log(label, JSON.stringify(r));
  return r;
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  buildAll();
  const map = buildMapRuntime('manhattan');
  spots = map.spawns.arenas.filter((a) => !a.roof && a.type === AR.INTERSECTION).map((a) => ({ x: a.x, y: a.y, z: a.z }));
  expect(spots.length).toBeGreaterThanOrEqual(10);
  srv = await startServerProc(['--static=', '--test-hooks', '--max-conn-per-ip=400']);
});

test.afterAll(async () => {
  if (srv) await srv.stop();
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'test-results/server-load.json'), JSON.stringify(results, null, 2));
});

test('@load one room: 16 players and ~30 enemies for 60 s', async () => {
  test.setTimeout(240_000);
  const g = await fillRoom('A', spots[0], 30);
  const r = await measure('oneRoom', [g], 60);
  await stopGroup(g);
  expect(r.botsClosed).toBe(0);
  expect(r.enemiesPerRoomAvg).toBeGreaterThan(20);
  expect(r.roomStepMs.p95).toBeLessThan(15);
});

test('@load ten rooms at once: 160 players and ~300 enemies for 30 s', async () => {
  test.setTimeout(300_000);
  const groups: Group[] = [];
  for (let i = 0; i < 10; i++) groups.push(await fillRoom(`R${i}`, spots[(i * 7) % spots.length], 30));
  const r = await measure('tenRooms', groups, 30);
  await Promise.all(groups.map(stopGroup));
  expect(r.botsClosed).toBe(0);
  expect(r.rooms).toBe(10);
  expect(r.tickMs.p95).toBeLessThan(1000 / 30);
});
