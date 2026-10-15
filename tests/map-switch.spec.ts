import { test, expect, type Page } from '@playwright/test';

// M13 map selection: `?harita=` wins over the stored setting, which wins over
// the default; invalid values fall back silently; the menu's map screen
// saves the pick and reloads with the map in the URL (other parameters kept).

const SETTINGS_KEY = 'skythread.settings.v1';

async function boot(page: Page, url: string): Promise<string[]> {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 120_000 });
  return problems;
}

const mapId = (page: Page) => page.evaluate(() => (window as any).__game.mapId as string);
const storedMap = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}').map, SETTINGS_KEY);

test('map selection precedence and the map screen', async ({ page }) => {
  // Default boot.
  let problems = await boot(page, '/');
  expect(await mapId(page)).toBe('manhattan');
  expect(await page.evaluate(() => (window as any).__game.app.ui.settings.map)).toBe('manhattan');
  expect(problems).toEqual([]);

  // Invalid parameter: falls back without console noise.
  problems = await boot(page, '/?harita=xyz');
  expect(await mapId(page)).toBe('manhattan');
  expect(problems).toEqual([]);

  // The URL a switch reloads to keeps the other parameters.
  const url = await page.evaluate(() => (window as any).__game.mapUrl('istanbul'));
  const u = new URL(url);
  expect(u.searchParams.get('harita')).toBe('istanbul');

  // A corrupt stored map falls back to the default; other settings survive.
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ map: 'atlantis', costume: 'blackGold' })), SETTINGS_KEY);
  problems = await boot(page, '/?seed=4242');
  expect(await mapId(page)).toBe('manhattan');
  expect(await page.evaluate(() => (window as any).__game.app.ui.settings)).toMatchObject({ map: 'manhattan', costume: 'blackGold' });
  const seeded = new URL(await page.evaluate(() => (window as any).__game.mapUrl('manhattan')));
  expect(seeded.searchParams.get('seed')).toBe('4242');
  expect(seeded.searchParams.get('harita')).toBe('manhattan');
  expect(problems).toEqual([]);

  // The main menu's map screen: one card per map, the running map checked.
  await page.getByRole('button', { name: 'Harita' }).first().click();
  const cards = page.locator('.sk-map');
  await expect(cards).toHaveCount(2);
  await expect(page.locator('.sk-map[data-map="manhattan"]')).toHaveAttribute('aria-checked', 'true');
  // Picking the running map saves it and does not reload.
  await page.locator('.sk-map[data-map="manhattan"]').click();
  expect(await storedMap(page)).toBe('manhattan');
  expect(await page.evaluate(() => (window as any).__game.ready)).toBe(true);
  // Picking İstanbul saves it and reloads with harita=istanbul; the seed stays in the URL.
  await page.locator('.sk-map[data-map="istanbul"]').click();
  await page.waitForURL(/harita=istanbul/, { timeout: 60_000 });
  problems = await boot(page, page.url());
  expect(await mapId(page)).toBe('istanbul');
  expect(await storedMap(page)).toBe('istanbul');
  const url2 = new URL(page.url());
  expect(url2.searchParams.get('harita')).toBe('istanbul');
  expect(url2.searchParams.get('seed')).toBe('4242');
  expect(problems).toEqual([]);

  // A plain reload (no parameter) stays on Istanbul: the setting decides.
  problems = await boot(page, '/');
  expect(await mapId(page)).toBe('istanbul');
  // The settings screen's reset keeps the map.
  await page.evaluate(() => (window as any).__game.showUi(true));
  await page.getByRole('button', { name: 'Ayarlar' }).first().click();
  await page.getByRole('button', { name: 'Varsayılanlara dön' }).click();
  expect(await storedMap(page)).toBe('istanbul');
  expect(problems).toEqual([]);

  // ?harita=manhattan wins over the stored setting (which stays Istanbul).
  problems = await boot(page, '/?harita=manhattan');
  expect(await mapId(page)).toBe('manhattan');
  expect(await storedMap(page)).toBe('istanbul');
  expect(problems).toEqual([]);
});
