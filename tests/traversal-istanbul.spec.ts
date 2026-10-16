import { test, expect } from '@playwright/test';
import { expectClean, openGame, saveResult } from './helpers';

// (d) on Istanbul: the city route from the Blue Mosque over the Haliç Metro
// Bridge to Levent, and the park route through Gülhane, tree to tree.
test('d-ist. traversal bots on Istanbul spend < 10% of the time on the ground', async ({ page }) => {
  const problems = await openGame(page, '/?harita=istanbul');
  const r = await page.evaluate(() => {
    const g = (window as any).__game;
    const city = g.cityBot(400);
    const park = g.parkBot(200, true);
    const parkAnchors = park.swingLog.map((s: any) => s.kind);
    const expectD = g.routeExpect();
    const path = city.path;
    delete city.path;
    delete park.path;
    delete park.swingLog;
    return { city, park, parkAnchorKinds: parkAnchors, expect: expectD, path };
  });
  saveResult('d-traversal-istanbul', r);
  console.log('d-ist. city', JSON.stringify(r.city));
  console.log('d-ist. park', JSON.stringify(r.park));
  expect(r.city.reached).toBe(true);
  expect(r.city.groundFraction).toBeLessThan(0.1);
  expect(r.city.distance).toBeGreaterThan(r.expect.minDistance);
  expect(r.city.splashes).toBe(0);
  expect(r.park.reached).toBe(true);
  expect(r.park.groundFraction).toBeLessThan(0.1);
  expect(r.parkAnchorKinds.length).toBeGreaterThan(2);
  expect(r.parkAnchorKinds.every((k: number) => k === 1 || k === 2)).toBe(true);
  expectClean(problems);
});
