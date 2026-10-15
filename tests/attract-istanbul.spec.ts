import { test, expect } from '@playwright/test';
import { expectClean, openGame, saveResult } from './helpers';

// The menu's attract hero on Istanbul: legs follow the roads (A*), goals stay
// on the landmass it stands on, so it never ends in the water.
test('j-ist. attract mode on Istanbul: no splashes, never stuck, never inside', async ({ page }) => {
  const problems = await openGame(page, '/?harita=istanbul');
  const runs: any[] = [];
  for (const seed of [1, 2]) {
    const a = await page.evaluate((sd) => (window as any).__game.attractTest(240, sd), seed);
    runs.push({ seed, splashes: a.splashes, inWater: a.inWater, stuck: a.stuckOver3s, ground: a.groundFraction, inside: a.insideGeometry, below: a.belowGround, nan: a.nan, distance: a.distance, swings: a.swings, rescues: a.rescues, camInside: a.camera.inside, msPerTick: a.msPerTick });
  }
  saveResult('j-attract-istanbul', runs);
  console.log('j-ist.', JSON.stringify(runs));
  for (const r of runs) {
    expect(r.splashes).toBe(0);
    expect(r.inWater).toBe(0);
    expect(r.stuck).toBe(0);
    expect(r.inside).toBe(0);
    expect(r.below).toBe(0);
    expect(r.nan).toBe(0);
    expect(r.ground).toBeLessThan(0.1);
    expect(r.distance).toBeGreaterThan(3000);
  }
  expectClean(problems);
});
