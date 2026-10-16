import { expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/** Open the game, wait for the test API, switch to manual stepping and collect console problems. */
export async function openGame(page: Page, url = '/'): Promise<string[]> {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 120_000 });
  await page.evaluate(() => (window as any).__game.setManual(true));
  return problems;
}

export function saveResult(name: string, data: unknown): void {
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/${name}.json`, JSON.stringify(data, null, 2));
}

export function expectClean(problems: string[]): void {
  expect(problems, problems.join('\n')).toEqual([]);
}
