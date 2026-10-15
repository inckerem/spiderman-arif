import { test, expect } from '@playwright/test';
import { expectClean, openGame, saveResult } from './helpers';

// (h, life) on Istanbul: traffic on the lane graph built from the road
// pieces (crossings, T-junctions, lights, slopes) and pedestrians on the
// sidewalks, never on the carriageway.
test('h-ist. traffic and pedestrians on Istanbul', async ({ page }) => {
  const problems = await openGame(page, '/?harita=istanbul');
  const life = await page.evaluate(() => (window as any).__game.lifeTest());
  saveResult('h-life-istanbul', life);
  console.log('h-ist. life', JSON.stringify(life));
  expect(life.nodes).toBeGreaterThan(300);
  expect(life.links).toBeGreaterThan(600);
  expect(life.q0cars).toBeLessThan(life.q1cars);
  expect(life.q1cars).toBeLessThan(life.q2cars);
  expect(life.q2cars).toBeLessThan(life.q3cars);
  expect(life.q0peds).toBeLessThan(life.q3peds);
  expect(life.carNaN).toBe(0);
  expect(life.carsOffRoad).toBe(0);
  expect(life.carYErr).toBeLessThan(0.05);
  expect(life.maxStoppedAtOnce).toBeGreaterThan(0);
  expect(life.maxTurningAtOnce).toBeGreaterThan(0);
  expect(life.meanSpeed).toBeGreaterThan(3);
  expect(life.pedsOnRoad).toBe(0);
  expectClean(problems);
});
