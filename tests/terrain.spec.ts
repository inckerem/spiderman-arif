import { test, expect } from '@playwright/test';
import { expectClean, openGame, saveResult } from './helpers';

// M13 C4: heightfield terrain on the Istanbul land polygons and hills.
// Fast rays agree with a brute-force 5 cm march (hit t within 0.1 m), the
// bucketed water mask agrees with plain point-in-polygon, the road index
// with a plain segment scan, land slopes stay under 0.3, and a fall into
// water respawns on land next to a shore.
test('terrain: heightfield rays, water mask, roads, slope', async ({ page }) => {
  const problems = await openGame(page);
  const r = await page.evaluate(() => (window as any).__game.terrainSelfTest(20000, 100000));
  saveResult('terrain', r);
  console.log('terrain', JSON.stringify(r));
  expect(r.rays).toBe(20000);
  expect(r.hits).toBeGreaterThan(8000);
  expect(r.waterHits).toBeGreaterThan(500);
  expect(r.hitMismatch).toBe(0);
  expect(r.tMismatch).toBe(0);
  expect(r.maxErr).toBeLessThanOrEqual(0.1);
  expect(r.waterMismatch).toBe(0);
  expect(r.waterFraction).toBeGreaterThan(0.2);
  expect(r.waterFraction).toBeLessThan(0.6);
  expect(r.roadMismatch).toBe(0);
  expect(r.respawnTries).toBeGreaterThan(500);
  expect(r.respawnBad).toBe(0);
  expect(r.maxSlope).toBeLessThanOrEqual(0.3);
  expect(r.maxHeight).toBeGreaterThan(20);
  expectClean(problems);
});
