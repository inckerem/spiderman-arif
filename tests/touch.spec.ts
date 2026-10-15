import { test, expect, type CDPSession, type Page } from '@playwright/test';
import { expectClean, saveResult } from './helpers';

// (k) Touch controls in mobile emulation (844x390 landscape, touch, DPR 2):
// play starts without pointer lock, the floating stick is analog (half push
// walks, full push runs, the rim sprints), a right-side drag turns the camera
// (invert Y applies), Ağ holds a swing line while held and lets go on release
// (with the stick and a look drag at the same time), Zıpla, Dalış and Tırman
// work, the pause button pauses and resumes, portrait shows the rotate prompt
// and pauses, the first run picks Low quality, and the menus fit 844x390 and
// 740x360 without horizontal overflow. A desktop context gets none of it.
// Multi-touch goes through CDP Input.dispatchTouchEvent, which Chromium turns
// into touch Pointer Events, one pointer id per finger.

const MOBILE = { width: 844, height: 390 };
const SMALL = { width: 740, height: 360 };


/**
 * Fingers on the screen. touchStart and touchMove list every finger down
 * (Chromium dispatches the ones that changed); touchEnd lists the fingers
 * that lift.
 */
class Fingers {
  private readonly pts = new Map<number, { x: number; y: number }>();
  private next = 1;
  constructor(private readonly cdp: CDPSession) {}

  private send(type: 'touchStart' | 'touchMove' | 'touchEnd', only?: number): Promise<unknown> {
    const touchPoints = [...this.pts.entries()]
      .filter(([id]) => only === undefined || id === only)
      .map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 6, radiusY: 6, force: 1 }));
    return this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  }

  async down(x: number, y: number): Promise<number> {
    const id = this.next++;
    this.pts.set(id, { x, y });
    await this.send('touchStart');
    return id;
  }

  async move(id: number, x: number, y: number): Promise<void> {
    this.pts.set(id, { x, y });
    await this.send('touchMove');
  }

  /** Moves in small steps (a real drag). */
  async drag(id: number, dx: number, dy: number, steps = 10): Promise<void> {
    const p = this.pts.get(id)!;
    const x0 = p.x,
      y0 = p.y;
    for (let i = 1; i <= steps; i++) await this.move(id, x0 + (dx * i) / steps, y0 + (dy * i) / steps);
  }

  async up(id: number): Promise<void> {
    await this.send('touchEnd', id);
    this.pts.delete(id);
  }

  async tap(x: number, y: number, holdMs = 60): Promise<void> {
    const id = await this.down(x, y);
    await new Promise((r) => setTimeout(r, holdMs));
    await this.up(id);
  }
}

async function open(page: Page, url = '/'): Promise<string[]> {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 120_000 });
  return problems;
}

async function center(page: Page, selector: string): Promise<{ x: number; y: number; w: number; h: number }> {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} not visible`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
}

const player = (page: Page) =>
  page.evaluate(() => {
    const g = (window as any).__game;
    const p = g.game.player;
    return {
      mode: g.state().mode as string,
      hs: Math.hypot(p.vel.x, p.vel.z),
      vy: p.vel.y,
      y: p.pos.y,
      attached: p.rope.attached as boolean,
      diving: p.diving as boolean,
      yaw: g.game.rig.yaw as number,
      pitch: g.game.rig.pitch as number,
      events: g.game.eventLog.length as number,
    };
  });

/** Median horizontal speed and the share of ground ticks over `ms` of real-time play. */
const sampleSpeed = (page: Page, ms: number) =>
  page.evaluate(async (ms) => {
    const g = (window as any).__game;
    const p = g.game.player;
    const speeds: number[] = [];
    let ground = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      speeds.push(Math.hypot(p.vel.x, p.vel.z));
      if (p.mode === 0) ground++;
    }
    speeds.sort((a, b) => a - b);
    return { median: speeds[Math.floor(speeds.length / 2)] ?? 0, ground: ground / Math.max(1, speeds.length), frames: speeds.length };
  }, ms);

const eventsSince = (page: Page, n: number) =>
  page.evaluate((n) => {
    const log = (window as any).__game.game.eventLog as Array<{ type: string }>;
    return log.slice(Math.max(0, n - (log.length > 200 ? log.length - 200 : 0))).map((e) => e.type);
  }, n);

/** No horizontal overflow; every visible button inside the viewport (scrolled into view where the panel scrolls). */
async function layoutCheck(page: Page, name: string): Promise<Record<string, unknown>> {
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => {
    const vw = window.innerWidth,
      vh = window.innerHeight;
    const outside: string[] = [];
    const small: string[] = [];
    let buttons = 0;
    for (const b of document.querySelectorAll<HTMLElement>('.sk-menu-layer button, .sk-touch button')) {
      if (b.getClientRects().length === 0) continue;
      buttons++;
      b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = b.getBoundingClientRect();
      const label = (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 24);
      if (r.left < -0.5 || r.right > vw + 0.5 || r.top < -0.5 || r.bottom > vh + 0.5) outside.push(`${label} ${r.left.toFixed(0)},${r.top.toFixed(0)}-${r.right.toFixed(0)},${r.bottom.toFixed(0)}`);
      if (r.height < 43.5) small.push(`${label} ${r.width.toFixed(0)}x${r.height.toFixed(0)}`);
    }
    const active = document.querySelector('.sk-screen.is-active');
    active?.scrollTo(0, 0);
    // A screen that can scroll sideways (overflow-x auto/scroll) must not have anything to scroll to.
    const ox = active ? getComputedStyle(active).overflowX : 'hidden';
    const panelScrollWidth = active && (ox === 'auto' || ox === 'scroll') ? active.scrollWidth - active.clientWidth : 0;
    return { scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, panelScrollWidth, overflowX: ox, vw, buttons, outside, small };
  });
  expect(r.scrollWidth, `${name}: page overflow`).toBeLessThanOrEqual(r.vw);
  expect(r.bodyScrollWidth, `${name}: body overflow`).toBeLessThanOrEqual(r.vw);
  expect(r.panelScrollWidth, `${name}: panel overflow`).toBeLessThanOrEqual(0);
  expect(r.outside, `${name}: buttons outside the viewport`).toEqual([]);
  expect(r.small, `${name}: tap targets under 44 px`).toEqual([]);
  expect(r.buttons, `${name}: buttons found`).toBeGreaterThan(0);
  return { buttons: r.buttons };
}

async function tapButton(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).locator('visible=true').first().tap();
}

test.describe('mobile', () => {
  test.use({ viewport: MOBILE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test('k. touch controls: play without lock, analog stick, look, swing hold, buttons, pause, portrait, phone menus', async ({ page }) => {
    test.setTimeout(15 * 60 * 1000);
    const report: Record<string, unknown> = {};
    const problems = await open(page);
    const fingers = new Fingers(await page.context().newCDPSession(page));
    const T = await page.evaluate(() => {
      const g = (window as any).__game;
      return { ...g.tuning.touch, run: g.tuning.ground.runSpeed, sprint: g.tuning.ground.sprintSpeed };
    });

    // --- Touch mode detected; first run picks Low; mobile meta tags -----------------------
    const boot = await page.evaluate(() => {
      const g = (window as any).__game;
      return {
        touchMode: g.app.touchMode,
        coarse: matchMedia('(pointer: coarse)').matches,
        quality: g.app.ui.settings.quality,
        gameQuality: g.game.qualityIndex,
        stored: localStorage.getItem('skythread.settings.v1'),
        viewport: document.querySelector('meta[name=viewport]')?.getAttribute('content') ?? '',
        view: (document.querySelector('.sk-touch') as HTMLElement | null)?.dataset.view ?? null,
        magnet: g.game.player.targeting.touchAim,
      };
    });
    report.boot = boot;
    expect(boot.touchMode).toBe(true);
    expect(boot.quality).toBe(0);
    expect(boot.gameQuality).toBe(0);
    expect(boot.stored).toBeNull();
    expect(boot.viewport).toContain('viewport-fit=cover');
    expect(boot.viewport).toContain('user-scalable=no');
    expect(boot.view).toBe('off');
    expect(boot.magnet).toBe(true);
    await expect(page.locator('.sk-tb-web')).toBeHidden();

    // --- Phone-size menus: 844x390 and 740x360 ----------------------------------------------
    const layouts: Record<string, unknown> = {};
    for (const size of [MOBILE, SMALL]) {
      await page.setViewportSize(size);
      const tag = `${size.width}x${size.height}`;
      layouts[`main ${tag}`] = await layoutCheck(page, `main ${tag}`);
      for (const screen of ['Ayarlar', 'Kontroller', 'Kostüm']) {
        await tapButton(page, screen);
        await expect(page.getByRole('button', { name: 'Geri' }).locator('visible=true').first()).toBeVisible();
        layouts[`${screen} ${tag}`] = await layoutCheck(page, `${screen} ${tag}`);
        await tapButton(page, 'Geri');
      }
    }
    // Touch screens: no key-binding screen or keys, a touch controls card and the touch look sensitivity.
    await tapButton(page, 'Kontroller');
    await expect(page.getByText('Sağda sürükle', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tuşları değiştir' })).toHaveCount(0);
    await tapButton(page, 'Geri');
    await tapButton(page, 'Ayarlar');
    await expect(page.locator('#sk-st-touchSensitivity')).toBeVisible();
    await expect(page.locator('#sk-st-sensitivity')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Değiştir' })).toHaveCount(0);
    await tapButton(page, 'Geri');
    await page.setViewportSize(MOBILE);
    report.layouts = layouts;

    // --- Oyna starts play at once, without pointer lock -------------------------------------
    await tapButton(page, 'Oyna');
    await page.waitForFunction(() => (window as any).__game.game.playing === true, null, { timeout: 30_000 });
    const started = await page.evaluate(() => {
      const g = (window as any).__game;
      return { state: g.app.state, lock: document.pointerLockElement !== null, enabled: g.game.input.enabled, view: g.app.touch.currentView };
    });
    report.started = started;
    expect(started).toEqual({ state: 'playing', lock: false, enabled: true, view: 'play' });
    for (const sel of ['.sk-tb-web', '.sk-tb-pull', '.sk-tb-jump', '.sk-tb-dive', '.sk-tb-climb', '.sk-tb-pause']) await expect(page.locator(sel)).toBeVisible();
    // Saldırı shows while combat runs (M11); reel buttons show only while swinging.
    await expect(page.locator('.sk-tb-attack')).toBeVisible();
    await expect(page.locator('.sk-tb-reel-in')).toBeHidden();
    layouts.play = await layoutCheck(page, 'play 844x390');
    // A tap on Saldırı is F: always a strike (a whiff with nobody around), never a line.
    await page.evaluate(() => (window as any).__game.touchSpot('avenue'));
    const a0 = (await player(page)).events;
    const attack = await center(page, '.sk-tb-attack');
    await fingers.tap(attack.x, attack.y, 60);
    await page.waitForFunction((n) => {
      const log = (window as any).__game.game.eventLog as Array<{ type: string }>;
      return log.slice(n).some((e) => e.type === 'strike');
    }, a0, { timeout: 10_000 });
    const attackEvents = await eventsSince(page, a0);
    report.attack = attackEvents;
    expect(attackEvents).not.toContain('webFire');

    // --- Joystick: analog speed, full run, rim sprint ----------------------------------------
    const R = T.stickRadius as number;
    const sx = 150,
      sy = 250;
    const stickRun = async (frac: number): Promise<{ median: number; ground: number; frames: number; sprint: boolean; axis: number }> => {
      await page.evaluate(() => (window as any).__game.touchSpot('avenue'));
      const id = await fingers.down(sx, sy);
      await fingers.drag(id, 0, -frac * R, 6);
      await page.waitForTimeout(700);
      const s = await sampleSpeed(page, 900);
      const inp = await page.evaluate(() => {
        const i = (window as any).__game.game.input;
        return { sprint: i.stickSprint as boolean, axis: i.stickY as number };
      });
      await fingers.up(id);
      return { ...s, ...inp };
    };
    // Pushing a resting thumb out of the dead zone counts as input (it ends the rooftop moment).
    await page.evaluate(() => (window as any).__game.touchSpot('avenue'));
    const restId = await fingers.down(sx, sy);
    const act0 = await page.evaluate(() => (window as any).__game.game.input.activity as number);
    await fingers.drag(restId, 0, -0.5 * R, 4);
    const act1 = await page.evaluate(() => (window as any).__game.game.input.activity as number);
    await fingers.up(restId);
    expect(act1).toBeGreaterThan(act0);
    const half = await stickRun(0.5);
    const full = await stickRun(0.93);
    const rim = await stickRun(1.4);
    report.stick = { half, full, rim, runSpeed: T.run, sprintSpeed: T.sprint };
    expect(half.ground).toBeGreaterThan(0.9);
    expect(full.ground).toBeGreaterThan(0.9);
    expect(rim.ground).toBeGreaterThan(0.9);
    expect(half.axis).toBeGreaterThan(0.4);
    expect(half.axis).toBeLessThan(0.6);
    expect(half.median).toBeGreaterThan(T.run * 0.4);
    expect(half.median).toBeLessThan(T.run * 0.6);
    expect(full.sprint).toBe(false);
    expect(full.median).toBeGreaterThan(T.run * 0.9);
    expect(full.median).toBeLessThan(T.run * 1.1);
    expect(rim.sprint).toBe(true);
    expect(rim.median).toBeGreaterThan(T.sprint * 0.9);
    expect(half.median).toBeLessThan(full.median);
    expect(full.median).toBeLessThan(rim.median);
    // Released: the stick is centred and the hero stops.
    await page.waitForFunction(() => {
      const i = (window as any).__game.game.input;
      return i.stickX === 0 && i.stickY === 0 && !i.stickSprint;
    });

    // --- Look drag on the right half (invert Y applies) --------------------------------------
    await page.evaluate(() => (window as any).__game.touchSpot('avenue'));
    const look0 = await player(page);
    let id = await fingers.down(620, 200);
    await fingers.drag(id, -100, 0);
    await fingers.drag(id, 0, 50);
    await fingers.up(id);
    await page.waitForTimeout(300);
    const look1 = await player(page);
    await page.evaluate(() => {
      const app = (window as any).__game.app;
      app.ui.settings.invertY = true;
      app.applySettings(app.ui.settings);
    });
    id = await fingers.down(620, 200);
    await fingers.drag(id, 0, 50);
    await fingers.up(id);
    await page.waitForTimeout(300);
    const look2 = await player(page);
    await page.evaluate(() => {
      const app = (window as any).__game.app;
      app.ui.settings.invertY = false;
      app.applySettings(app.ui.settings);
    });
    const wantYaw = 100 * T.lookRadPerPx;
    const look = { yaw: look1.yaw - look0.yaw, pitch: look1.pitch - look0.pitch, pitchInverted: look2.pitch - look1.pitch, wantYaw, wantPitch: 50 * T.lookRadPerPx };
    report.look = look;
    expect(look.yaw).toBeGreaterThan(wantYaw * 0.85);
    expect(look.yaw).toBeLessThan(wantYaw * 1.15);
    expect(look.pitch).toBeLessThan(-look.wantPitch * 0.85);
    expect(look.pitchInverted).toBeGreaterThan(look.wantPitch * 0.85);

    // --- Ağ: hold fires and keeps the line (with stick and look at once), release lets go ------
    const web = await center(page, '.sk-tb-web');
    let aimed = false;
    for (let k = 0; k < 6 && !aimed; k++) {
      aimed = await page.evaluate((k) => {
        const g = (window as any).__game;
        // High above the avenue: the swing has room before any landing.
        g.touchSpot('air');
        g.game.rig.setLook(k * 1.05, 0.35);
        g.game.snapCamera();
        return g.aimAtAnchor();
      }, k);
    }
    expect(aimed).toBe(true);
    const e0 = (await player(page)).events;
    const webId = await fingers.down(web.x, web.y);
    await page.waitForFunction(() => (window as any).__game.game.player.rope.attached === true, null, { timeout: 30_000 });
    const stickId = await fingers.down(sx, sy);
    await fingers.drag(stickId, 0, -0.6 * R, 4);
    const yawHold0 = (await player(page)).yaw;
    const lookId = await fingers.down(640, 160);
    await fingers.drag(lookId, -40, 0, 4);
    // A tap on Dalış meanwhile: four fingers down at its peak.
    const dive = await center(page, '.sk-tb-dive');
    await fingers.tap(dive.x, dive.y, 80);
    await page.waitForTimeout(400);
    const held = await page.evaluate(() => {
      const g = (window as any).__game;
      const i = g.game.input;
      return {
        attached: g.game.player.rope.attached as boolean,
        mode: g.state().mode as string,
        swingHeld: i.isHeld('swing') as boolean,
        diveHeld: i.isHeld('dive') as boolean,
        stickY: i.stickY as number,
        reelShown: getComputedStyle(document.querySelector('.sk-tb-reel-in')!).display !== 'none',
        webDown: document.querySelector('.sk-tb-web')!.classList.contains('is-down'),
      };
    });
    const yawHold = (await player(page)).yaw - yawHold0;
    await fingers.up(lookId);
    await fingers.up(stickId);
    const stillHeld = await player(page);
    // A finger holding + when the line goes: the hidden button lets go (no reeling while hidden).
    const reelIn = await center(page, '.sk-tb-reel-in');
    const reelId = await fingers.down(reelIn.x, reelIn.y);
    await expect(page.locator('.sk-tb-reel-in')).toHaveClass(/is-down/);
    await fingers.up(webId);
    await page.waitForFunction(() => (window as any).__game.game.player.rope.attached === false, null, { timeout: 10_000 });
    await expect(page.locator('.sk-tb-reel-in')).toBeHidden();
    const reelAfter = await page.evaluate(() => document.querySelector('.sk-tb-reel-in')!.classList.contains('is-down'));
    await fingers.up(reelId);
    expect(reelAfter).toBe(false);
    const webEvents = await eventsSince(page, e0);
    report.web = { held, yawWhileSwinging: yawHold, attachedAfterOtherFingersLift: stillHeld.attached, events: webEvents };
    expect(held.attached).toBe(true);
    expect(held.mode).toBe('swing');
    expect(held.swingHeld).toBe(true);
    expect(held.diveHeld).toBe(false);
    expect(held.stickY).toBeGreaterThan(0.4);
    expect(held.reelShown).toBe(true);
    expect(held.webDown).toBe(true);
    expect(yawHold).toBeGreaterThan(40 * T.lookRadPerPx * 0.7);
    expect(stillHeld.attached).toBe(true);
    expect(webEvents).toContain('webFire');
    expect(webEvents).toContain('attach');
    expect(webEvents).toContain('release');
    expect(await page.evaluate(() => (window as any).__game.game.input.isHeld('swing'))).toBe(false);

    // --- Zıpla ---------------------------------------------------------------------------------
    await page.evaluate(() => (window as any).__game.touchSpot('avenue'));
    await page.waitForFunction(() => (window as any).__game.game.player.mode === 0, null, { timeout: 10_000 });
    const j0 = (await player(page)).events;
    const jump = await center(page, '.sk-tb-jump');
    await fingers.tap(jump.x, jump.y, 60);
    await page.waitForFunction((n) => {
      const log = (window as any).__game.game.eventLog as Array<{ type: string }>;
      return log.slice(n).some((e) => e.type === 'jump');
    }, j0, { timeout: 10_000 });
    const jumped = await player(page);
    report.jump = { mode: jumped.mode, vy: jumped.vy };
    expect(jumped.mode).not.toBe('ground');

    // --- Dalış (hold in the air) -----------------------------------------------------------------
    await page.evaluate(() => (window as any).__game.touchSpot('air'));
    const diveId = await fingers.down(dive.x, dive.y);
    await page.waitForFunction(() => (window as any).__game.game.player.diving === true, null, { timeout: 10_000 });
    await fingers.up(diveId);
    await page.waitForFunction(() => (window as any).__game.game.player.diving === false, null, { timeout: 10_000 });
    report.dive = true;
    // Lost focus lets go of on-screen buttons and the stick too.
    const blurDive = await fingers.down(dive.x, dive.y);
    const blurStick = await fingers.down(sx, sy);
    await fingers.drag(blurStick, 0, -0.6 * R, 3);
    await page.waitForFunction(() => {
      const i = (window as any).__game.game.input;
      return i.isHeld('dive') && i.stickY > 0.4;
    }, null, { timeout: 10_000 });
    const blurred = await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      const i = (window as any).__game.game.input;
      return { dive: i.isHeld('dive') as boolean, x: i.stickX as number, y: i.stickY as number };
    });
    await fingers.up(blurStick);
    await fingers.up(blurDive);
    report.blur = blurred;
    expect(blurred).toEqual({ dive: false, x: 0, y: 0 });

    // --- Tırman: stick forward + hold Tırman clings to the facade and climbs; letting go drops ---
    const wall = await page.evaluate(() => (window as any).__game.touchSpot('wall'));
    expect(wall).not.toBeNull();
    const climb = await center(page, '.sk-tb-climb');
    const climbId = await fingers.down(climb.x, climb.y);
    const moveId = await fingers.down(sx, sy);
    await fingers.drag(moveId, 0, -0.93 * R, 4);
    await page.waitForFunction(() => (window as any).__game.game.player.mode === 4, null, { timeout: 15_000 });
    const w0 = await player(page);
    await page.waitForTimeout(800);
    const w1 = await player(page);
    await fingers.up(climbId);
    await page.waitForFunction(() => (window as any).__game.game.player.mode !== 4, null, { timeout: 10_000 });
    await fingers.up(moveId);
    report.climb = { climbed: w1.y - w0.y, modeAfter: (await player(page)).mode };
    expect(w1.mode).toBe('wall');
    expect(w1.y - w0.y).toBeGreaterThan(1);

    // --- Pause button pauses, Devam Et resumes (no lock) ----------------------------------------
    await page.locator('.sk-tb-pause').tap();
    await page.waitForFunction(() => (window as any).__game.app.state === 'paused', null, { timeout: 10_000 });
    expect(await page.evaluate(() => (window as any).__game.game.playing)).toBe(false);
    await expect(page.locator('.sk-tb-web')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Fotoğraf Modu' })).toBeVisible();
    for (const size of [MOBILE, SMALL]) {
      await page.setViewportSize(size);
      layouts[`pause ${size.width}x${size.height}`] = await layoutCheck(page, `pause ${size.width}x${size.height}`);
    }
    await page.setViewportSize(MOBILE);
    await tapButton(page, 'Devam Et');
    await page.waitForFunction(() => (window as any).__game.game.playing === true, null, { timeout: 10_000 });
    expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();

    // --- Portrait: rotate prompt and pause; landscape again: resume ----------------------------
    await page.setViewportSize({ width: MOBILE.height, height: MOBILE.width });
    await page.waitForFunction(() => (window as any).__game.app.state === 'paused', null, { timeout: 10_000 });
    await expect(page.locator('.sk-rotate')).toBeVisible();
    await expect(page.getByText('Cihazını yatay çevir')).toBeVisible();
    const portrait = await page.evaluate(() => ({ playing: (window as any).__game.game.playing, scrollWidth: document.documentElement.scrollWidth, vw: innerWidth }));
    expect(portrait.playing).toBe(false);
    expect(portrait.scrollWidth).toBeLessThanOrEqual(portrait.vw);
    // Never a lock-out: the prompt can be dismissed.
    await page.getByRole('button', { name: 'Yine de oyna' }).tap();
    await expect(page.locator('.sk-rotate')).toBeHidden();
    await page.setViewportSize(MOBILE);
    await expect(page.locator('.sk-rotate')).toBeHidden();
    // A landscape device with a tall window (Split View, multi-window) gets no prompt.
    await page.evaluate(() => Object.defineProperty(screen.orientation, 'type', { configurable: true, get: () => 'landscape-primary' }));
    await page.setViewportSize({ width: 420, height: 800 });
    await page.waitForTimeout(300);
    const splitView = await page.evaluate(() => (window as any).__game.app.ui.portraitPrompt as boolean);
    await page.evaluate(() => delete (screen.orientation as any).type);
    await page.setViewportSize(MOBILE);
    expect(splitView).toBe(false);
    await expect(page.locator('.sk-rotate')).toBeHidden();
    await tapButton(page, 'Devam Et');
    await page.waitForFunction(() => (window as any).__game.game.playing === true, null, { timeout: 10_000 });
    report.portrait = { paused: true, prompt: true, resumed: true };

    // --- First-run Low is only a default: a choice is stored and kept ----------------------------
    await page.locator('.sk-tb-pause').tap();
    await tapButton(page, 'Ayarlar');
    await page.getByRole('radio', { name: 'Orta' }).tap();
    await page.reload();
    await open(page);
    const kept = await page.evaluate(() => ({ quality: (window as any).__game.app.ui.settings.quality, game: (window as any).__game.game.qualityIndex }));
    expect(kept).toEqual({ quality: 1, game: 1 });
    report.qualityAfterChoice = kept;
    // Corrupt but parseable settings ("x", 5) are a first run again: Low.
    for (const junk of ['"x"', '5']) {
      await page.evaluate((j) => localStorage.setItem('skythread.settings.v1', j), junk);
      await page.reload();
      await open(page);
      expect(await page.evaluate(() => (window as any).__game.app.ui.settings.quality), junk).toBe(0);
    }

    saveResult('k-touch', report);
    expectClean(problems);
  });
});

// A desktop (no touch, fine pointer) gets no touch controls and keeps Medium; ?dokunmatik=1 forces them on.
test('k2. desktop keeps mouse and keyboard; ?dokunmatik=1 forces the touch controls', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  const problems = await open(page);
  const desktop = await page.evaluate(() => ({
    touchMode: (window as any).__game.app.touchMode,
    layer: document.querySelectorAll('.sk-touch, .sk-rotate').length,
    quality: (window as any).__game.app.ui.settings.quality,
    magnet: (window as any).__game.game.player.targeting.touchAim,
  }));
  await open(page, '/?dokunmatik=1');
  const forced = await page.evaluate(() => ({ touchMode: (window as any).__game.app.touchMode, layer: document.querySelectorAll('.sk-touch').length }));
  saveResult('k2-touch-desktop', { desktop, forced });
  expect(desktop).toEqual({ touchMode: false, layer: 0, quality: 1, magnet: false });
  expect(forced).toEqual({ touchMode: true, layer: 1 });
  expectClean(problems);
});
