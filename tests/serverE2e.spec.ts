/**
 * End-to-end check of the built game server (dist-server/server.mjs serving
 * dist/): /healthz, static files, raw WebSocket bots in the public room
 * (presence and state relay), overflow into public #2, private rooms by code,
 * PvP gating, names, the cheat kick, reconnect, size and connection limits,
 * graceful shutdown. No browser. Builds what is missing first.
 * Run: `npm run test:server` (or `npx playwright test tests/serverE2e.spec.ts`).
 */
import { test, expect } from '@playwright/test';
import { NetBot } from './netBot';
import { buildAll, startServerProc, type ServerProc } from './serverProc';

const MAX_CONN_PER_IP = 24;

test.describe.configure({ mode: 'serial' });

let srv: ServerProc;
let base = '';
let wsUrl = '';
const bots: NetBot[] = [];

async function join(name: string, join?: Parameters<typeof NetBot.join>[1]['join'], token?: string): Promise<NetBot> {
  const b = await NetBot.join(wsUrl, { name, join, token });
  bots.push(b);
  return b;
}

async function health(): Promise<{ ok: boolean; rooms: number; players: number; connections: number; version: string; protocol: number }> {
  const r = await fetch(`${base}/healthz`);
  expect(r.ok).toBe(true);
  return r.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test.beforeAll(async () => {
  test.setTimeout(300_000);
  buildAll();
  srv = await startServerProc(['--static=dist', '--test-hooks', `--max-conn-per-ip=${MAX_CONN_PER_IP}`, '--reconnect-grace-s=3', '--private-room-idle-s=1']);
  base = srv.base;
  wsUrl = srv.wsUrl;
});

test.afterAll(async () => {
  await Promise.all(bots.map((b) => b.close()));
  if (srv) await srv.stop();
});

test('healthz and static files', async () => {
  const h = await health();
  expect(h).toMatchObject({ ok: true, rooms: 0, players: 0, protocol: 1 });
  expect(typeof h.version).toBe('string');
  const index = await fetch(`${base}/`);
  expect(index.status).toBe(200);
  expect(index.headers.get('content-type')).toContain('text/html');
  expect(index.headers.get('cache-control')).toBe('no-cache');
  const html = await index.text();
  const asset = /(?:src|href)="\.\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
  expect(asset).toBeTruthy();
  const js = await fetch(`${base}/${asset}`, { method: 'HEAD' });
  expect(js.status).toBe(200);
  expect(js.headers.get('content-type')).toContain('javascript');
  expect(js.headers.get('cache-control')).toContain('immutable');
  for (const p of ['/nope.js', '/%2e%2e/package.json', '/..%2fpackage.json', '/.git/HEAD']) {
    expect((await fetch(`${base}${p}`)).status, p).toBe(404);
  }
  expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
});

test('two bots in the public room see each other and the relayed movement', async () => {
  const a = await join('Ayşe');
  const b = await join('Bora');
  expect(a.welcome?.room).toMatchObject({ public: true, index: 1, map: 'manhattan', seed: 1337, pvp: false });
  expect(b.welcome?.room.id).toBe(a.welcome?.room.id);
  expect(b.welcome?.players.map((p) => p.name)).toEqual(['Ayşe']);
  await a.until(() => a.of('join').some((j) => j.name === 'Bora'));
  expect(a.welcome?.clock.dayLen).toBeGreaterThan(0);
  expect(a.welcome?.hp).toBe(100);
  // A swings east at 40 m/s for 1 s, 20 Hz; B gets the relayed states.
  let x = 100;
  for (let i = 0; i < 20; i++) {
    x += 2;
    a.state(x, 60, -50, a.roomNow(), { vx: 40, mode: 2 });
    await sleep(50);
  }
  await b.until(() => (b.remotes.get(a.pid)?.s.x ?? 0) >= x - 0.01, 2000);
  const seen = b.remotes.get(a.pid)!;
  expect(Math.hypot(seen.s.x - x, seen.s.y - 60, seen.s.z + 50)).toBeLessThan(0.5);
  expect(seen.count).toBeGreaterThanOrEqual(15);
  expect(seen.s.vx).toBeCloseTo(40, 1);
  expect(a.remotes.has(a.pid)).toBe(false); // own state is not echoed
  // Ping/pong carries the room clock.
  a.send({ t: 'ping', c: 7 });
  await a.until(() => a.of('pong').length > 0);
  expect(a.of('pong')[0].c).toBe(7);
  expect(a.of('pong')[0].s).toBeGreaterThan(0);
});

test('16 fill public #1, the 17th lands in public #2, which closes when empty', async () => {
  const already = bots.length; // Ayşe, Bora
  const filled: NetBot[] = [];
  for (let i = already; i < 16; i++) filled.push(await join(`Bot${i}`));
  expect(filled.every((b) => b.welcome?.room.index === 1)).toBe(true);
  const extra = await join('Fazladan');
  expect(extra.welcome?.room).toMatchObject({ public: true, index: 2 });
  let h = await health();
  expect(h).toMatchObject({ rooms: 2, players: 17 });
  extra.send({ t: 'leave' });
  await extra.until(() => extra.closed);
  await sleep(150);
  h = await health();
  expect(h).toMatchObject({ rooms: 1, players: 16 });
  // Duplicate and profane names.
  const first = bots[0];
  for (const b of filled.slice(0, 2)) {
    b.send({ t: 'leave' }); // a plain close would keep the slot for the reconnect grace
    await b.until(() => b.closed);
  }
  const dup = await join('ayşe');
  expect(dup.welcome?.name).toBe('ayşe#2');
  const rude = await join('0r0spu');
  expect(rude.rejected).toBe('profanity');
  await rude.until(() => rude.closed);
  expect(first.of('join').some((j) => j.name === 'ayşe#2')).toBe(true);
});

test('private room: create with PvP, join by code, notFound', async () => {
  const host = await join('Kurucu', { kind: 'create', pvp: true });
  const code = host.welcome!.room.code!;
  expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  expect(host.welcome!.room).toMatchObject({ public: false, pvp: true, index: 0 });
  const guest = await join('Misafir', { kind: 'code', code: code.toLowerCase() });
  expect(guest.welcome!.room.id).toBe(host.welcome!.room.id);
  expect(guest.welcome!.players.map((p) => p.name)).toEqual(['Kurucu']);
  const lost = await join('Kayıp', { kind: 'code', code: 'ZZZZZZ' });
  expect(lost.rejected).toBe('notFound');
  // (Combat intents, PvP included, are covered by serverCombat.spec.ts.)
  // Test hooks are on for this server: accepted silently.
  host.send({ t: 'dbg', op: 'killAll', a: [] });
  await sleep(100);
  expect(host.closed).toBe(false);
});

test('a teleporting cheat is corrected, then kicked', async () => {
  const cheat = await join('Işınlanan');
  cheat.state(0, 50, 0, cheat.roomNow());
  await sleep(60);
  for (let i = 0; i < 12 && !cheat.closed; i++) {
    cheat.state(600, 50, 0, cheat.roomNow(), { tp: i + 1 });
    await sleep(60);
    if (!cheat.closed && cheat.of('correct').length) cheat.state(0, 50, 0, cheat.roomNow(), { tp: i + 1 }); // obeys, then cheats again
    await sleep(60);
  }
  await cheat.until(() => cheat.closed, 3000);
  expect(cheat.of('correct').length).toBe(5);
  expect(cheat.of('correct')[0]).toMatchObject({ x: 0, y: 50, z: 0, why: 'teleport' });
  expect(cheat.of('kick')).toEqual([{ t: 'kick', why: 'cheat' }]);
  expect(cheat.closeCode).toBe(1008);
});

test('reconnect with the token keeps pid and name; garbage and oversize frames close the socket', async () => {
  const r = await join('Dönen');
  const { pid, token } = r.welcome!;
  r.cut();
  await sleep(300);
  const back = await join('Başka İsim', { kind: 'public' }, token);
  expect(back.welcome).toMatchObject({ pid, name: 'Dönen' });
  // Oversize (> 4096 B) → 1009 from ws; garbage → 1008.
  const big = await join('Büyük');
  big.sendRaw('x'.repeat(5000));
  await big.until(() => big.closed);
  expect(big.closeCode).toBe(1009);
  const junk = await join('Çöp');
  junk.sendRaw('{"t":"what"}');
  await junk.until(() => junk.closed);
  expect(junk.closeCode).toBe(1008);
  expect(junk.of('kick')).toEqual([{ t: 'kick', why: 'garbage' }]);
});

test('connections per IP are capped; graceful shutdown', async () => {
  const h = await health();
  const extra: NetBot[] = [];
  let refused = '';
  for (let i = 0; i < MAX_CONN_PER_IP + 2 && !refused; i++) {
    try {
      extra.push(await NetBot.open(wsUrl));
    } catch (e) {
      refused = String(e);
    }
  }
  expect(refused).toContain('HTTP 429');
  expect(h.connections + extra.length).toBe(MAX_CONN_PER_IP);
  await Promise.all(extra.map((b) => b.close()));
  // A wrong path is not upgraded.
  await expect(NetBot.open(wsUrl.replace('/ws', '/other'))).rejects.toThrow(/HTTP 404/);
  // SIGTERM: every bot gets kick 'shutdown' (1001) and the process exits 0.
  const live = bots.filter((b) => !b.closed);
  expect(live.length).toBeGreaterThan(10);
  expect(await srv.stop()).toBe(0);
  await Promise.all(live.map((b) => b.until(() => b.closed, 3000)));
  expect(live.every((b) => b.closeCode === 1001)).toBe(true);
  expect(live[0].of('kick').at(-1)).toEqual({ t: 'kick', why: 'shutdown' });
  expect(srv.log()).toContain('shutting down');
});
