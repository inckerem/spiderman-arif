import { test, expect } from '@playwright/test';
import { expectClean, openGame, saveResult } from './helpers';

// (c) on Istanbul: anchor availability from 500 random street, rooftop and park positions.
test('c-ist. anchor availability on Istanbul >= 95%', async ({ page }) => {
  const problems = await openGame(page, '/?harita=istanbul');
  const r = await page.evaluate(() => {
    const res = (window as any).__game.anchorAvailability(2024, 500);
    res.failures = (res.failures as any[]).slice(0, 6);
    return res;
  });
  saveResult('c-anchors-istanbul', r);
  console.log('c-ist. anchors', JSON.stringify({ ...r, failures: undefined }));
  expect(r.total).toBe(500);
  expect(r.inRange).toBeGreaterThan(400);
  expect(r.rate).toBeGreaterThanOrEqual(0.95);
  expectClean(problems);
});
