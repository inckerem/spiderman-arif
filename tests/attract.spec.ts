import { test, expect, type Page } from '@playwright/test';
import { expectClean, openGame, saveResult } from './helpers';

// (j) M9: the menu's attract mode (autopilot hero, cinematic camera) and the
// rooftop moment (5 s still on a roof: music, night, rain, letterbox, orbit
// camera; any input restores everything).

test('j1. attract mode: the autopilot swings around the city for minutes', async ({ page }) => {
  test.setTimeout(20 * 60 * 1000);
  const problems = await openGame(page);
  // Manual (test) mode keeps the attract mode off; the dev hook runs it headless.
  const off = await page.evaluate(() => {
    const g = (window as any).__game;
    return { attractRunning: g.game.attractRunning, view: g.game.view };
  });
  expect(off).toEqual({ attractRunning: false, view: 'play' });
  const r = await page.evaluate(() => (window as any).__game.attractTest(360));
  saveResult('j1-attract', r);
  console.log('j1. attract', JSON.stringify(r));
  // Six simulated minutes: never stuck, in water, below ground, inside geometry or NaN.
  expect(r.stuckOver3s).toBe(0);
  expect(r.maxNoProgress).toBeLessThan(3);
  expect(r.splashes).toBe(0);
  expect(r.inWater).toBe(0);
  expect(r.belowGround).toBe(0);
  expect(r.insideGeometry).toBe(0);
  expect(r.nan).toBe(0);
  // Swinging, not running: little ground time outside the rooftop perches, real distance.
  expect(r.groundFraction).toBeLessThan(0.08);
  expect(r.perchFraction).toBeLessThan(0.2);
  expect(r.distance).toBeGreaterThan(6000);
  expect(r.swingsPerMinute).toBeGreaterThan(20);
  expect(r.legs).toBeGreaterThanOrEqual(8);
  // Variety: pull lines, wall runs and perches all happen; rescues stay rare.
  expect(r.zips).toBeGreaterThan(5);
  expect(r.wallRuns).toBeGreaterThan(0);
  expect(r.perches).toBeGreaterThan(0);
  expect(r.rescues).toBeLessThanOrEqual(1);
  // Waypoints on roofs, in the park and along the waterfront.
  expect(r.goalKindSeconds.roof).toBeGreaterThan(0);
  expect(r.goalKindSeconds.waterfront + r.goalKindSeconds.park).toBeGreaterThan(0);
  // Cinematic camera: never inside geometry, the hero in frame, several shot types.
  expect(r.camera.inside).toBe(0);
  expect(r.camera.heroInFrame).toBeGreaterThan(0.9);
  expect(r.camera.occluded).toBeLessThan(0.05);
  const shotTypes = Object.values(r.camera.shots as Record<string, number>).filter((n) => n > 0).length;
  expect(shotTypes).toBeGreaterThanOrEqual(4);
  expect(r.camera.cuts + r.camera.blends).toBeGreaterThan(20);
  expectClean(problems);
});

const state = (page: Page) => page.evaluate(() => (window as any).__game.momentState());
const frames = (page: Page, seconds: number, sample = 0) => page.evaluate(([s, k]) => (window as any).__game.momentFrames(s, k), [seconds, sample] as const);

test('j2. rooftop moment: starts only still on a roof, any input restores', async ({ page }) => {
  test.setTimeout(20 * 60 * 1000);
  const problems = await openGame(page);
  await page.evaluate(() => {
    const g = (window as any).__game;
    // Play state as after Oyna, with the UI shown (HUD and letterbox).
    g.app.state = 'playing';
    g.app.ui.setHudVisible(true);
    g.showUi(true);
    g.setTime(13);
    g.setInput({ moveX: 0, moveY: 0 });
  });
  const result: Record<string, unknown> = {};

  // Street level (an intersection downtown): standing still for 7 s never starts it.
  await page.evaluate(() => {
    const g = (window as any).__game;
    const L = g.game.layout;
    g.teleport(L.avenues[3].center, 0.3, L.streets[3].center);
  });
  const street = await frames(page, 7);
  result.street = { maxPhase: street.maxPhase, starts: street.starts, pos: street.pos };
  expect(street.mode).toBe('ground');
  expect(street.maxPhase === 'idle' || street.maxPhase === 'arming').toBe(true);
  expect(street.starts).toBe(0);
  expect(street.musicPresence).toBe(0);

  // On a roof but moving (back and forth): never starts.
  const roof = await page.evaluate(() => (window as any).__game.momentRoof());
  result.roof = roof;
  expect(roof.y - roof.street).toBeGreaterThan(20);
  await frames(page, 1);
  for (let k = 0; k < 14; k++) {
    await page.evaluate((dir) => (window as any).__game.setInput({ moveY: dir }), k % 2 ? 1 : -1);
    await frames(page, 0.5);
  }
  await page.evaluate(() => (window as any).__game.setInput({ moveY: 0 }));
  const moving = await state(page);
  expect(moving.starts).toBe(0);

  // A ring race in progress prevents it.
  await page.evaluate(() => {
    const g = (window as any).__game.game;
    const r = g.rings.routes[0].rings[0];
    const a = g.player.pos.clone().set(r.x - r.nx, r.y - r.ny, r.z - r.nz);
    const b = a.clone().set(r.x + r.nx, r.y + r.ny, r.z + r.nz);
    g.rings.check(a, b, 1 / 120);
  });
  await page.evaluate(() => (window as any).__game.momentRoof());
  const racing = await frames(page, 7);
  expect(await page.evaluate(() => (window as any).__game.game.rings.activeRoute)).toBe(0);
  expect(racing.starts).toBe(0);
  await page.evaluate(() => (window as any).__game.game.rings.abandon());

  // Still on the roof: 5 s later it starts; the hour moves through dusk to night, rain sets in.
  await page.evaluate(() => (window as any).__game.momentRoof());
  const h0 = await page.evaluate(() => (window as any).__game.game.dayNight.hour);
  const armed = await frames(page, 4.8);
  expect(armed.phase).toBe('arming');
  expect(armed.starts).toBe(0);
  const started = await frames(page, 0.6);
  expect(started.starts).toBe(1);
  expect(started.phase).toBe('in');
  const rising = await frames(page, 7.5, 0.5);
  const hours = rising.samples.map((s: any) => s.hour);
  result.momentIn = { h0, hours, rain: rising.rain, mood: rising.mood, phase: rising.phase };
  expect(rising.phase).toBe('active');
  expect(rising.savedHour).toBeCloseTo(h0, 6);
  expect(rising.hour).toBeCloseTo(22.6, 3);
  // Time-lapse: the hour passed dusk on the way (never jumped).
  expect(hours.some((h: number) => h > 18 && h < 21)).toBe(true);
  expect(rising.hold).toBe(true);
  expect(rising.rain).toBe(1);
  expect(rising.rainVisible).toBe(true);
  expect(rising.mood).toBeGreaterThan(0.99);
  expect(rising.storm).toBeGreaterThan(0.99);
  expect(rising.orbit).toBe(1);
  expect(rising.perch).toBe(1);
  expect(rising.music).toBe(1);
  expect(rising.musicPresence).toBe(1);
  expect(rising.cinematic).toBe(true);
  expect(rising.rootCine).toBe(true);
  await expect(page.locator('.sk-lb-top')).toHaveCSS('transform', 'none');
  await expect(page.locator('.sk-lb-bottom')).toHaveCSS('transform', 'none');
  await expect(page.locator('.sk-hud')).toHaveCSS('opacity', '0');

  // The music key toggles the music without ending it; mouse jitter does not end it.
  await page.keyboard.press('KeyM');
  expect((await frames(page, 0.5)).musicMuted).toBe(true);
  await page.keyboard.press('KeyM');
  const afterM = await frames(page, 0.5);
  expect(afterM.musicMuted).toBe(false);
  expect(afterM.phase).toBe('active');
  await page.evaluate(() => {
    const input = (window as any).__game.game.input;
    input.pointerLocked = true;
    for (let i = 0; i < 60; i++) window.dispatchEvent(new MouseEvent('mousemove', { movementX: i % 2 ? 1 : -1, movementY: 1 }));
  });
  const jitter = await frames(page, 1);
  expect(jitter.phase).toBe('active');

  // Pausing holds it: the hour and the rain stay, nothing advances.
  const beforePause = await state(page);
  await page.evaluate(() => (window as any).__game.app.pause());
  const paused = await frames(page, 2);
  expect(paused.phase).toBe('active');
  expect(paused.hour).toBe(beforePause.hour);
  expect(paused.rain).toBe(1);
  expect(paused.musicPresence).toBe(1);
  await page.evaluate(() => {
    const g = (window as any).__game;
    g.app.ui.hideMenus();
    g.app.ui.setHudVisible(true);
    g.app.state = 'playing';
    g.game.playing = true;
  });
  expect((await frames(page, 0.5)).phase).toBe('active');

  // A key press ends it: music, rain, grade, letterbox, orbit and the hour all go back.
  await page.keyboard.press('KeyW');
  const ending = await frames(page, 0.5);
  expect(ending.phase).toBe('out');
  expect(ending.musicPresence).toBe(0);
  expect(ending.cinematic).toBe(false);
  const ended = await frames(page, 4, 0.5);
  result.momentOut = { hours: ended.samples.map((s: any) => s.hour), final: ended.hour };
  expect(ended.phase === 'idle' || ended.phase === 'arming').toBe(true);
  expect(ended.ends).toBe(1);
  expect(ended.hour).toBeCloseTo(h0, 6);
  expect(ended.hold).toBe(false);
  expect(ended.rain).toBe(0);
  expect(ended.rainVisible).toBe(false);
  expect(ended.mood).toBe(0);
  expect(ended.storm).toBe(0);
  expect(ended.orbit).toBe(0);
  expect(ended.perch).toBe(0);
  expect(ended.musicPresence).toBe(0);
  expect(ended.rootCine).toBe(false);
  // The bars slide out of view (top bar above the top edge, bottom bar below the bottom edge).
  await expect.poll(() => page.evaluate(() => document.querySelector('.sk-lb-top')!.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0.5);
  await expect.poll(() => page.evaluate(() => document.querySelector('.sk-lb-bottom')!.getBoundingClientRect().top - window.innerHeight)).toBeGreaterThanOrEqual(-0.5);
  await expect(page.locator('.sk-hud')).toHaveCSS('opacity', '1');

  // Again: a deliberate mouse movement ends it, and so does a mouse button.
  for (const how of ['look', 'click'] as const) {
    await page.evaluate(() => (window as any).__game.momentRoof());
    const again = await frames(page, 6.5);
    expect(again.phase).toBe('in');
    if (how === 'look') {
      await page.evaluate(() => {
        for (let i = 0; i < 12; i++) window.dispatchEvent(new MouseEvent('mousemove', { movementX: 20, movementY: 4 }));
      });
    } else await page.mouse.click(640, 360);
    const out = await frames(page, 4);
    expect(out.phase === 'idle' || out.phase === 'arming').toBe(true);
    expect(out.hour).toBeCloseTo(h0, 6);
    expect(out.rain).toBe(0);
    expect(out.musicPresence).toBe(0);
    result[`end_${how}`] = { phase: out.phase, hour: out.hour };
  }
  const final = await state(page);
  expect(final.starts).toBe(3);
  expect(final.ends).toBe(3);
  saveResult('j2-moment', result);
  console.log('j2. moment', JSON.stringify(result));
  expectClean(problems);
});
