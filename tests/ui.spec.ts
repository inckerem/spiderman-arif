import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { expectClean, openGame, saveResult } from './helpers';

// (g) Shell: settings round-trip through the real settings screen and
// localStorage (including a corrupt entry), the costume picker, the audio
// graph and music decode after the first gesture (music in the menu, none in
// game outside the rooftop moment), M mute, pause on pointer-lock loss,
// resume, and photo mode PNG export.

async function openShell(page: Page): Promise<string[]> {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 120_000 });
  return problems;
}

const gameState = (page: Page) =>
  page.evaluate(() => {
    const g = (window as any).__game;
    const game = g.game;
    return {
      quality: game.qualityIndex,
      renderScale: game.renderScale,
      dynamicResolution: game.post.settings.dynamicResolution,
      fovOffset: game.rig.fovOffset,
      sensitivity: game.rig.sensitivity,
      invertY: game.rig.invertY,
      dayLength: game.dayNight.dayLengthMinutes,
      settings: { ...g.app.ui.settings },
      stored: localStorage.getItem('skythread.settings.v1'),
    };
  });

test('g. settings persist, audio decodes, pause/resume and photo export work', async ({ page }) => {
  test.setTimeout(20 * 60 * 1000);
  let problems = await openShell(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  problems = await openShell(page);

  // --- Settings screen -> game + localStorage --------------------------------
  await page.getByRole('button', { name: 'Ayarlar' }).first().click();
  await expect(page.locator('#sk-st-fovOffset')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('radio', { name: 'Yüksek' }).click();
  await page.locator('#sk-st-renderScale').fill('80');
  await page.locator('#sk-st-dynamicResolution').click();
  await page.locator('#sk-st-fovOffset').fill('8');
  await page.locator('#sk-st-sensitivity').fill('1.5');
  await page.locator('#sk-st-invertY').click();
  await page.locator('#sk-st-dayLengthMinutes').fill('20');
  await page.locator('#sk-st-showFps').click();
  await page.locator('#sk-st-masterVolume').fill('50');
  const applied = await gameState(page);
  const want = { quality: 2, renderScale: 0.8, dynamicResolution: false, fovOffset: 8, sensitivity: 1.5, invertY: true, dayLength: 20 };
  expect({ ...applied, settings: undefined, stored: undefined }).toEqual({ ...want, settings: undefined, stored: undefined });
  const stored = JSON.parse(applied.stored ?? '{}');
  expect(stored).toMatchObject({ quality: 2, renderScale: 0.8, dynamicResolution: false, fovOffset: 8, sensitivity: 1.5, invertY: true, dayLengthMinutes: 20, showFps: true, masterVolume: 0.5 });

  // --- Reload: everything comes back from storage ----------------------------
  await page.reload();
  problems = await openShell(page);
  const reloaded = await gameState(page);
  expect({ ...reloaded, settings: undefined, stored: undefined }).toEqual({ ...want, settings: undefined, stored: undefined });
  expect(reloaded.settings).toMatchObject({ showFps: true, masterVolume: 0.5 });

  // --- Defaults button -------------------------------------------------------
  await page.getByRole('button', { name: 'Ayarlar' }).first().click();
  await page.getByRole('button', { name: 'Varsayılanlara dön' }).click();
  const reset = await gameState(page);
  expect(reset.quality).toBe(1);
  expect(reset.settings).toMatchObject({ quality: 1, renderScale: 1, dynamicResolution: true, fovOffset: 0, sensitivity: 1, invertY: false, showFps: false });
  await page.keyboard.press('Escape');

  // --- Costume screen: a pick is worn at once, saved and kept on reload -------
  const costume = () =>
    page.evaluate(() => {
      const g = (window as any).__game;
      return { worn: g.game.hero.costume, setting: g.app.ui.settings.costume, stored: JSON.parse(localStorage.getItem('skythread.settings.v1') ?? '{}').costume };
    });
  expect((await costume()).worn).toBe('redNavy');
  await page.getByRole('button', { name: 'Kostüm' }).first().click();
  await expect(page.getByRole('radio', { name: 'Kırmızı-Lacivert' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Siyah-Altın' }).click();
  expect(await costume()).toEqual({ worn: 'blackGold', setting: 'blackGold', stored: 'blackGold' });
  // Arrow keys move the pick along the row.
  await page.getByRole('radio', { name: 'Siyah-Altın' }).press('ArrowRight');
  expect(await costume()).toEqual({ worn: 'blackWhite', setting: 'blackWhite', stored: 'blackWhite' });
  await expect(page.getByRole('radio', { name: 'Siyah-Beyaz' })).toBeFocused();
  await page.getByRole('radio', { name: 'Kırmızı-Altın' }).click();
  await page.keyboard.press('Escape');
  await page.reload();
  problems = await openShell(page);
  expect(await costume()).toEqual({ worn: 'redGold', setting: 'redGold', stored: 'redGold' });

  // --- Corrupt storage is clamped, never fatal --------------------------------
  await page.evaluate(() => localStorage.setItem('skythread.settings.v1', '{"quality":9,"fovOffset":"abc","sensitivity":1e9,"invertY":"yes"'));
  await page.reload();
  problems = await openShell(page);
  const corrupt = await gameState(page);
  expect(corrupt.settings).toMatchObject({ fovOffset: 0, invertY: false });
  await page.evaluate(() => localStorage.setItem('skythread.settings.v1', '{"quality":9,"fovOffset":"abc","sensitivity":1e9,"invertY":"yes","costume":"gold"}'));
  await page.reload();
  problems = await openShell(page);
  const clamped = await gameState(page);
  expect(clamped.settings).toMatchObject({ quality: 3, fovOffset: 0, sensitivity: 3, invertY: false, costume: 'redNavy' });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  problems = await openShell(page);

  // --- Menu: first gesture unlocks audio, music decodes and plays -------------
  await page.getByRole('button', { name: 'Kontroller' }).first().click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Oyna' })).toBeVisible();
  await page.waitForFunction(() => (window as any).__game.app.audio.getDebugInfo().musicLoaded === true, null, { timeout: 120_000 });
  const audio = await page.evaluate(() => (window as any).__game.app.audio.getDebugInfo());
  expect(audio.unlocked).toBe(true);
  expect(audio.state).toBe('running');
  expect(audio.musicError).toBeNull();
  expect(audio.musicDuration).toBeGreaterThan(30);
  expect(audio.loopsScheduled).toBeGreaterThan(0);
  // The music actually reaches the master bus: tap it with an analyser.
  const musicRms = await page.evaluate(async () => {
    const a = (window as any).__game.app.audio;
    const g = a.graph;
    const an = g.ctx.createAnalyser();
    an.fftSize = 2048;
    g.master.connect(an);
    let best = 0;
    const buf = new Float32Array(an.fftSize);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      best = Math.max(best, Math.sqrt(sum / buf.length));
    }
    g.master.disconnect(an);
    return best;
  });
  expect(musicRms).toBeGreaterThan(0.005);
  expect(audio.musicLevel).toBeGreaterThan(0);
  // Restarting from the top (the rooftop moment's cue) replaces the running
  // chain: the old instances stop, no extra sources are left behind.
  const restart = await page.evaluate(async () => {
    const a = (window as any).__game.app.audio;
    const before = a.getDebugInfo();
    a.restartMusic();
    await new Promise((r) => setTimeout(r, 500));
    const after = a.getDebugInfo();
    return { before: before.liveLoops, after: after.liveLoops, restarts: after.musicRestarts, scheduled: after.loopsScheduled - before.loopsScheduled };
  });
  expect(restart.restarts).toBe(1);
  expect(restart.scheduled).toBeGreaterThan(0);
  expect(restart.after).toBeGreaterThan(0);
  expect(restart.after).toBeLessThanOrEqual(restart.before);

  // --- Play: no music in game (it returns in the menus and the rooftop moment) ---
  await page.getByRole('button', { name: 'Oyna' }).click();
  await page.waitForFunction(() => (window as any).__game.game.playing === true, null, { timeout: 120_000 });
  await page.waitForFunction(() => (window as any).__game.app.audio.musicPresence === 0, null, { timeout: 60_000 });
  const inGame = await page.evaluate(() => {
    const a = (window as any).__game.app.audio;
    return { presence: a.musicPresence, level: a.getDebugInfo().musicLevel, loops: a.getDebugInfo().loopsScheduled };
  });
  expect(inGame.presence).toBe(0);
  expect(inGame.level).toBe(0);
  expect(inGame.loops).toBeGreaterThan(0);
  await page.keyboard.press('m');
  expect(await page.evaluate(() => (window as any).__game.app.audio.musicMuted)).toBe(true);
  await page.keyboard.press('m');
  expect(await page.evaluate(() => (window as any).__game.app.audio.musicMuted)).toBe(false);
  const voices = await page.evaluate(() => {
    const a = (window as any).__game.app.audio;
    a.webShot(0.5);
    a.attach(0.8);
    a.footstep(0, 0.6);
    return a.getDebugInfo().activeVoices;
  });
  expect(voices).toBeGreaterThan(0);

  // --- Losing pointer lock pauses; resume locks again --------------------------
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => (window as any).__game.app.state === 'paused', null, { timeout: 60_000 });
  expect(await page.evaluate(() => (window as any).__game.game.playing)).toBe(false);
  await page.getByRole('button', { name: 'Devam Et' }).click();
  await page.waitForFunction(() => (window as any).__game.game.playing === true, null, { timeout: 60_000 });

  // --- Photo mode: P freezes play, PNG export, P returns ------------------------
  await page.keyboard.press('p');
  await page.waitForFunction(() => (window as any).__game.app.state === 'photo', null, { timeout: 60_000 });
  expect(await page.evaluate(() => (window as any).__game.game.playing)).toBe(false);
  await page.evaluate(() => document.exitPointerLock());
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.getByRole('button', { name: 'PNG Kaydet' }).click(),
  ]);
  const name = download.suggestedFilename();
  const path = await download.path();
  const bytes = readFileSync(path);
  expect(name).toMatch(/^skythread-\d{8}-\d{6}\.png$/);
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(bytes.length).toBeGreaterThan(20_000);
  await page.keyboard.press('p');
  await page.waitForFunction(() => (window as any).__game.app.state === 'playing', null, { timeout: 60_000 });

  const result = { applied: want, reloadedOk: true, audio, musicRms, restart, inGame, voices, photo: { name, bytes: bytes.length } };
  saveResult('g-ui', result);
  console.log('g. ui', JSON.stringify(result));
  expectClean(problems);
});

// (g2) Dynamic resolution follows the render cost, not the frame interval: on a
// vsync-locked 60 Hz display a load spike lowers the scale to its floor (0.75 x
// the CSS pixels: 0.75 at pixel ratio 1, 0.5 at 1.5), and it returns to full
// resolution once the cost drops, without hunting. A marginal machine backs
// off to 30 s between raises; a calm minute clears the back-off.
test('g2. dynamic resolution recovers at 60 Hz', async ({ page }) => {
  const problems = await openGame(page);
  const r = await page.evaluate(() => (window as any).__game.dynResTest());
  saveResult('g2-dynres', r);
  console.log('g2. dynres', JSON.stringify(r));
  expect(r.start).toBe(1);
  expect(r.floor).toBeCloseTo(0.75, 5);
  expect(r.afterSpike).toBeCloseTo(0.75, 5);
  expect(r.recovered).toBe(1);
  expect(r.recoverSeconds).toBeLessThan(6);
  expect(r.bandChanges).toBe(0);
  expect(r.gpuBoundScale).toBeLessThan(1);
  expect(r.gpuBoundScale).toBeGreaterThanOrEqual(0.75);
  expect(r.gpuBoundChanges).toBe(0);
  expect(r.end).toBe(1);
  expect(r.hiDpiFloor).toBeCloseTo(0.5, 5);
  expect(r.hiDpiAfterSpike).toBeCloseTo(0.5, 5);
  expect(r.hiDpiRecovered).toBe(1);
  // Holds 2, 4, 8, 16, 30, 30 ... s: about a dozen raises in 300 s, then 30 s apart.
  expect(r.marginalRaises).toBeLessThanOrEqual(12);
  expect(r.marginalMinGap).toBeGreaterThanOrEqual(29.5);
  expect(r.marginalMinGap).toBeLessThan(1e9);
  expect(r.recoverAgainSeconds).toBeLessThan(6);
  expectClean(problems);
});
