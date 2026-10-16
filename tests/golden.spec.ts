import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { expectClean, openGame, saveResult } from './helpers';

// M13 golden digest: the Manhattan layout, colliders and the outputs of the
// deterministic drivers (fuzz, anchors, both traversal bots, attract mode)
// must hash exactly as recorded from the code before the map refactor.
// SKYTHREAD_GOLDEN_WRITE=1 records a new reference instead of comparing.
const FILE = 'tests/golden/manhattan.json';

test('golden digest of Manhattan is unchanged', async ({ page }) => {
  const problems = await openGame(page);
  const digest = await page.evaluate(() => (window as any).__game.goldenDigest(120));
  saveResult('golden-manhattan', digest);
  console.log('golden', JSON.stringify(digest));
  if (process.env.SKYTHREAD_GOLDEN_WRITE === '1') {
    mkdirSync('tests/golden', { recursive: true });
    writeFileSync(FILE, JSON.stringify(digest, null, 2) + '\n');
  }
  expect(existsSync(FILE), `missing ${FILE}`).toBe(true);
  const ref = JSON.parse(readFileSync(FILE, 'utf8'));
  expect(digest).toEqual(ref);
  expectClean(problems);
});
