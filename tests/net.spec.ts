/**
 * M12 online play in real browsers against a real game server (started here
 * on SKYTHREAD_SERVER_PORT, default 8787, which the Vite dev server's /ws
 * proxy targets). Two or three browser contexts join rooms through the
 * Turkish lobby and see each other; private rooms by code and invite link;
 * PvP only in PvP rooms; a shared enemy agrees on both clients; reconnect
 * after a socket drop; the single-player fallback; honest movement is never
 * corrected while a teleport cheat is.
 * Run: SKYTHREAD_DEV_PORT=5302 SKYTHREAD_SERVER_PORT=8797 npx playwright test tests/net.spec.ts --workers=1
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import { buildAll, startServerProc, type ServerProc } from './serverProc';

const SERVER_PORT = Number(process.env.SKYTHREAD_SERVER_PORT) || 8787;
const SHOTS = process.env.SKYTHREAD_SHOTS || 'test-results/m12';
const HERO = 0x8000;

test.describe.configure({ mode: 'serial' });

let srv: ServerProc;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type NetState = {
  active: boolean;
  status: string;
  pid: number;
  name: string;
  room: { id: string; code?: string; pvp: boolean; public: boolean; index: number } | null;
  tp: number;
  players: Array<{ pid: number; name: string }>;
  remotes: Array<{ pid: number; name: string; x: number; y: number; z: number; lod: number; inView: boolean; webVisible: boolean }>;
  tags: string[];
  hour: number;
  roomHour: number | null;
  now: number;
  self: { hp: number; down: boolean };
  enemies: Array<{ id: number; hp: number; x: number; y: number; z: number; state: number }>;
  invite: string;
};

interface Client {
  page: Page;
  problems: string[];
  close(): Promise<void>;
}

async function client(browser: Browser, path = '/'): Promise<Client> {
  // Several software-rendered pages share the CPU: small viewport, Low quality.
  const ctx = await browser.newContext({ viewport: { width: 800, height: 450 }, baseURL: test.info().project.use.baseURL });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('skythread.settings.v1')) localStorage.setItem('skythread.settings.v1', JSON.stringify({ quality: 0, dynamicResolution: false }));
  });
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await page.goto(path);
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 180_000 });
  // Software GL on a shared machine: draw only for screenshots.
  await page.evaluate(() => (window as any).__game.drawPaused(true));
  return { page, problems, close: () => ctx.close() };
}

const net = (p: Page): Promise<NetState> => p.evaluate(() => (window as any).__net.state());

/** Lobby: name, then a public room, a new private room (pvp) or a code. */
async function joinVia(p: Page, name: string, how: { kind: 'public' } | { kind: 'create'; pvp: boolean } | { kind: 'code'; code?: string }, shot?: string): Promise<NetState> {
  if (!(await p.locator('.sk-screen-lobby.is-active').count())) await p.locator('.sk-btn-mp').click();
  await expect(p.locator('.sk-screen-lobby')).toHaveClass(/is-active/);
  await p.locator('.sk-lobby input.sk-name').fill(name);
  if (how.kind === 'create' && how.pvp) await p.locator('.sk-pvp').click();
  if (how.kind === 'code' && how.code) await p.locator('.sk-lobby input.sk-code').fill(how.code);
  if (shot) {
    await p.setViewportSize({ width: 1280, height: 800 });
    await screenshot(p, shot);
    await p.setViewportSize({ width: 800, height: 450 });
  }
  await p.locator(how.kind === 'public' ? '.sk-join-public' : how.kind === 'create' ? '.sk-create' : '.sk-join-code').click();
  try {
    await p.waitForFunction(() => (window as any).__net.state().active, null, { timeout: 120_000 });
  } catch (e) {
    const status = await p.locator('.sk-lobby-status').textContent();
    const st = await p.evaluate(() => JSON.stringify((window as any).__net.state()).slice(0, 400));
    throw new Error(`join failed: status "${status}" state ${st} (${(e as Error).message})`);
  }
  await p.evaluate(() => {
    const g = (window as any).__game;
    g.forcePlay();
    g.realtimeInput(true);
  });
  return net(p);
}

/** Draw a few frames, save a screenshot, stop drawing again. */
async function screenshot(p: Page, file: string): Promise<void> {
  await p.evaluate(() => (window as any).__game.drawPaused(false));
  await sleep(1500);
  await p.screenshot({ path: `${SHOTS}/${file}` });
  await p.evaluate(() => (window as any).__game.drawPaused(true));
}

/** A strike intent at another player (the router targets enemies; PvP checks use the link directly). */
async function strikeHero(p: Page, targetPid: number, seq = 1): Promise<void> {
  await p.evaluate(
    ([pid, sq, base]) => {
      const n = (window as any).__net;
      const q = (window as any).__game.game.player.pos;
      n.intent({ k: 'strike', seq: sq, target: base + pid, move: 0, viewT: n.state().now - 0.1, hx: q.x, hy: q.y, hz: q.z });
    },
    [targetPid, seq, HERO],
  );
}

async function strikeEnemy(p: Page, id: number, seq: number): Promise<void> {
  await p.evaluate(
    ([eid, sq]) => {
      const n = (window as any).__net;
      const q = (window as any).__game.game.player.pos;
      n.intent({ k: 'strike', seq: sq, target: eid, move: 0, viewT: n.state().now - 0.1, hx: q.x, hy: q.y, hz: q.z });
    },
    [id, seq],
  );
}

async function hold(p: Page, input: Record<string, unknown>): Promise<void> {
  await p.evaluate((i) => (window as any).__game.setInput(i), input);
}

async function heroPos(p: Page): Promise<[number, number, number]> {
  return p.evaluate(() => {
    const q = (window as any).__game.game.player.pos;
    return [q.x, q.y, q.z] as [number, number, number];
  });
}

/** Place `who` `dist` m in front of `viewer`'s camera on the viewer's level, and turn it to face the viewer. */
async function standInFront(viewer: Page, who: Page, dist: number): Promise<void> {
  const v = await viewer.evaluate(() => {
    const g = (window as any).__game.game;
    return { x: g.player.pos.x, y: g.player.pos.y, z: g.player.pos.z, yaw: g.rig.yaw };
  });
  const tx = v.x - Math.sin(v.yaw) * dist;
  const tz = v.z - Math.cos(v.yaw) * dist;
  // Walk there in short hops (the server's sanity check sees ordinary movement).
  for (let k = 0; k < 40; k++) {
    const [x, , z] = await heroPos(who);
    const d = Math.hypot(tx - x, tz - z);
    if (d < 0.5) break;
    const s = Math.min(1, d);
    await who.evaluate(([nx, ny, nz]) => (window as any).__game.teleport(nx, ny, nz), [x + ((tx - x) / d) * s, v.y + 0.05, z + ((tz - z) / d) * s]);
    await sleep(60);
  }
}

function expectQuiet(c: Client, allow: RegExp[] = []): void {
  const bad = c.problems.filter((p) => !allow.some((a) => a.test(p)));
  expect(bad, bad.join('\n')).toEqual([]);
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  buildAll();
  srv = await startServerProc(['--static=', '--test-hooks', `--port=${SERVER_PORT}`, '--reconnect-grace-s=20']);
});

test.afterAll(async () => {
  if (srv) await srv.stop();
});

test('presence: two players in the public room see each other move and swing, with name tags', async ({ browser }) => {
  test.setTimeout(900_000);
  const [a, b] = await Promise.all([client(browser), client(browser)]);
  const sa = await joinVia(a.page, 'Ayşe', { kind: 'public' }, 'lobby.png');
  const sb = await joinVia(b.page, 'Bora', { kind: 'public' });
  expect(sa.room?.id).toBe(sb.room?.id);
  expect(sb.players.map((p) => p.name)).toContain('Ayşe');
  // B stands still; A walks into B's view and stops.
  await standInFront(b.page, a.page, 7);
  // B's view of A (100 ms behind) settles within 0.5 m of A's own position.
  let err = Infinity;
  for (let k = 0; k < 60 && err >= 0.5; k++) {
    await sleep(500);
    const [ax, ay, az] = await heroPos(a.page);
    const r = (await net(b.page)).remotes.find((q) => q.pid === sa.pid);
    err = r ? Math.hypot(r.x - ax, r.y - ay, r.z - az) : Infinity;
  }
  expect(err).toBeLessThan(0.5);
  await b.page.waitForFunction((n) => (window as any).__net.state().tags.includes(n), 'Ayşe', { timeout: 30_000 });
  const rb = (await net(b.page)).remotes.find((r) => r.pid === sa.pid)!;
  expect(rb.lod).toBe(0);
  expect(rb.inView).toBe(true);
  await b.page.evaluate(() => (window as any).__game.showUi(true));
  await screenshot(b.page, 'together.png');
  // A swings: B sees the web line.
  // A fires a pull line (the spawn roof has nothing higher to swing from): B sees the web line.
  let aimed = false;
  for (let k = 0; k < 24 && !aimed; k++) {
    await a.page.evaluate(([yaw, pitch]) => (window as any).__game.setLook(yaw, pitch), [(k / 24) * Math.PI * 2, k % 2 ? -0.15 : 0.1]);
    await sleep(150);
    aimed = await a.page.evaluate(() => (window as any).__game.state().zipTarget === true);
  }
  expect(aimed).toBe(true);
  const seen = b.page.waitForFunction((pid) => (window as any).__net.state().remotes.some((q: any) => q.pid === pid && q.webVisible), sa.pid, { timeout: 30_000, polling: 50 });
  await hold(a.page, { zip: true });
  await seen;
  await hold(a.page, { zip: false });
  // Shared clock: both clients within 0.02 h of each other.
  const hd = (x: number, y: number) => Math.min(Math.abs(x - y), 24 - Math.abs(x - y));
  const [na, nb] = await Promise.all([net(a.page), net(b.page)]);
  // Each shows the room hour (plus an easing offset that only absorbs clock-message jitter) ...
  expect(Math.abs((na as any).hourOffset)).toBeLessThan(0.02);
  expect(Math.abs((nb as any).hourOffset)).toBeLessThan(0.02);
  // ... and both room clocks agree (pages read concurrently; at 2 game hours per real minute 0.02 h is 0.6 s).
  expect(hd(na.roomHour!, nb.roomHour!)).toBeLessThan(0.02);

  // Public room: a hero target is not hit (PvP is off).
  await standInFront(a.page, b.page, 1.2);
  await strikeHero(a.page, sb.pid);
  await sleep(2500);
  expect((await net(b.page)).self.hp).toBe(100);

  // Reconnect after a dropped socket: same player id and name.
  await a.page.evaluate(() => (window as any).__net.dropSocket());
  await a.page.waitForFunction(() => {
    const st = (window as any).__net.state();
    return st.drops === 1 && st.status === 'online';
  }, null, { timeout: 30_000 });
  const back = await net(a.page);
  expect([back.pid, back.name]).toEqual([sa.pid, 'Ayşe']);
  expect((await net(b.page)).players.map((q) => q.pid)).toContain(sa.pid);

  // Honest movement (walking, a pull line) is never corrected; a teleport cheat is.
  const tp0 = (await net(a.page)).tp;
  await hold(a.page, { moveY: 1 });
  await sleep(2000);
  await hold(a.page, { moveY: 0 });
  await sleep(500);
  expect((await net(a.page)).tp).toBe(tp0);
  const before = await heroPos(a.page);
  await a.page.evaluate(([x, y, z]) => (window as any).__game.teleport(x + 600, y + 20, z), before);
  try {
    await a.page.waitForFunction((tp) => (window as any).__net.state().tp > tp, tp0, { timeout: 10_000 });
  } catch (e) {
    const st = await net(a.page);
    console.log('NO CORRECTION', tp0, JSON.stringify({ tp: st.tp, status: st.status, app: (st as any).appState, pl: (st as any).playing, out: (st as any).bytesOut }), await heroPos(a.page), before);
    console.log(srv.log().split('\n').slice(-12).join('\n'));
    throw e;
  }
  await sleep(500);
  const after = await heroPos(a.page);
  expect(Math.hypot(after[0] - before[0], after[2] - before[2])).toBeLessThan(10); // put back by the server
  const seenByB = (await net(b.page)).remotes.find((q) => q.pid === sa.pid)!;
  expect(Math.hypot(seenByB.x - before[0], seenByB.z - before[2])).toBeLessThan(15);
  expectQuiet(a);
  expectQuiet(b);
  await a.close();
  await b.close();
});

test('private rooms: create with PvP, join by invite link and by typed code; PvP hits; a shared enemy agrees', async ({ browser }) => {
  test.setTimeout(900_000);
  const [a, c] = await Promise.all([client(browser), client(browser)]);
  const sa = await joinVia(a.page, 'Kurucu', { kind: 'create', pvp: true });
  expect(sa.room).toMatchObject({ public: false, pvp: true });
  const code = sa.room!.code!;
  expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  expect(sa.invite).toContain(`?oda=${code}`);
  // The pause menu shows the room panel with the code and the invite button.
  await a.page.evaluate(() => (window as any).__game.app.pause());
  await expect(a.page.locator('.sk-room-code')).toHaveText(code);
  await expect(a.page.locator('.sk-copy-invite')).toBeVisible();
  await a.page.setViewportSize({ width: 1280, height: 800 });
  await screenshot(a.page, 'pause-room.png');
  await a.page.setViewportSize({ width: 800, height: 450 });
  await a.page.evaluate(() => {
    (window as any).__game.app.resume();
    (window as any).__game.forcePlay();
  });
  // Invite link: the lobby opens with the code filled in.
  const b = await client(browser, `/?oda=${code.toLowerCase()}`);
  await expect(b.page.locator('.sk-screen-lobby')).toHaveClass(/is-active/);
  await expect(b.page.locator('.sk-lobby input.sk-code')).toHaveValue(code);
  const sb = await joinVia(b.page, 'Davetli', { kind: 'code' });
  // Typed code.
  const sc = await joinVia(c.page, 'Kodcu', { kind: 'code', code: code.toLowerCase() });
  expect([sb.room?.id, sc.room?.id]).toEqual([sa.room!.id, sa.room!.id]);
  await a.page.waitForFunction(() => (window as any).__net.state().players.length === 2, null, { timeout: 30_000 });
  await c.close();

  // PvP: A hits B.
  await standInFront(a.page, b.page, 1.2);
  await sleep(500);
  await strikeHero(a.page, sb.pid, 7);
  await b.page.waitForFunction(() => (window as any).__net.state().self.hp < 100, null, { timeout: 15_000 });

  // A shared enemy: spawned by A next to both, struck by A; both clients agree on its health.
  const [x, y, z] = await heroPos(a.page);
  await a.page.evaluate(([ex, ey, ez]) => (window as any).__net.dbg('spawn', [0, ex + 1.3, ey, ez]), [x, y, z]);
  const id = await a.page.waitForFunction(() => (window as any).__net.state().enemies[0]?.id ?? 0, null, { timeout: 15_000 }).then((h) => h.jsonValue() as Promise<number>);
  await b.page.waitForFunction((eid) => (window as any).__net.state().enemies.some((e: any) => e.id === eid), id, { timeout: 15_000 });
  await strikeEnemy(a.page, id, 8);
  const hpA = await a.page.waitForFunction((eid) => {
    const e = (window as any).__net.state().enemies.find((q: any) => q.id === eid);
    return e && e.hp < 59.5 ? e.hp : 0;
  }, id, { timeout: 15_000 }).then((h) => h.jsonValue() as Promise<number>);
  await b.page.waitForFunction(
    ([eid, hp]) => {
      const e = (window as any).__net.state().enemies.find((q: any) => q.id === eid);
      return e && Math.abs(e.hp - hp) < 0.6;
    },
    [id, hpA],
    { timeout: 15_000 },
  );
  await a.page.evaluate(() => (window as any).__net.dbg('clear', []));
  expectQuiet(a);
  expectQuiet(b);
  await a.close();
  await b.close();
});

test('no server: the lobby falls back to single player with a toast', async ({ browser }) => {
  test.setTimeout(600_000);
  const a = await client(browser, '/?ws=ws://127.0.0.1:9/ws');
  await a.page.locator('.sk-btn-mp').click();
  await a.page.locator('.sk-lobby input.sk-name').fill('Yalnız');
  const t0 = Date.now();
  await a.page.locator('.sk-join-public').click();
  await expect(a.page.locator('.sk-toast')).toContainText('Sunucuya ulaşılamadı', { timeout: 15_000 });
  await a.page.waitForFunction(() => (window as any).__game.app.state === 'playing', null, { timeout: 15_000 });
  expect(Date.now() - t0).toBeLessThan(8000);
  expect((await net(a.page)).active).toBe(false);
  expect(await a.page.evaluate(() => (window as any).__game.game.link.online)).toBe(false);
  expectQuiet(a, [/WebSocket connection to 'ws:\/\/127\.0\.0\.1:9\/ws' failed/]);
  await a.close();
});
