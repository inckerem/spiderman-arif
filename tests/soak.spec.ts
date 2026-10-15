import { test, expect } from '@playwright/test';
import { expectClean, openGame, saveResult } from './helpers';

// (e) Soak: 30 simulated minutes of mixed play (traversal bots, random-input
// fuzz, ring runs, traffic and crowd, time-of-day and quality changes, menu,
// pause and photo-mode churn, the menu's attract mode and a rooftop-moment
// cycle with rain every minute) with frames rendered throughout. Passes when
// the console stays clean and the JS heap and GPU resource counts show no
// growth trend.
test('e. soak: 30 simulated minutes, clean console, no heap growth', async ({ page }) => {
  test.setTimeout(110 * 60 * 1000);
  await page.setViewportSize({ width: 640, height: 360 });
  const problems = await openGame(page);
  const samples: Array<{ minute: number; heapMB: number; geometries: number; textures: number; programs: number; ms: number }> = [];
  const t0 = Date.now();
  for (let minute = 0; minute < 30; minute++) {
    const s = await page.evaluate((m) => {
      const g = (window as any).__game;
      const t = performance.now();
      const info = g.soakMinute(m);
      (window as any).gc?.();
      (window as any).gc?.();
      const mem = (performance as any).memory;
      return { ...info, heapMB: mem ? mem.usedJSHeapSize / 1048576 : -1, ms: performance.now() - t };
    }, minute);
    expect(s.ticks).toBeGreaterThanOrEqual(7200);
    samples.push({ minute, heapMB: s.heapMB, geometries: s.geometries, textures: s.textures, programs: s.programs, ms: s.ms });
    saveResult('e-soak-progress', samples);
  }
  // Linear trend of the heap after warm-up (minutes 5..29).
  const pts = samples.filter((s) => s.minute >= 5);
  const n = pts.length;
  const mx = pts.reduce((a, s) => a + s.minute, 0) / n;
  const my = pts.reduce((a, s) => a + s.heapMB, 0) / n;
  let num = 0,
    den = 0;
  for (const s of pts) {
    num += (s.minute - mx) * (s.heapMB - my);
    den += (s.minute - mx) ** 2;
  }
  const slopeMBPerMin = num / den;
  const first = pts[0]!,
    last = pts[pts.length - 1]!;
  const result = {
    simulatedMinutes: samples.length,
    wallSeconds: (Date.now() - t0) / 1000,
    heapStartMB: first.heapMB,
    heapEndMB: last.heapMB,
    heapMinMB: Math.min(...pts.map((s) => s.heapMB)),
    heapMaxMB: Math.max(...pts.map((s) => s.heapMB)),
    slopeMBPerMin,
    geometries: [first.geometries, last.geometries],
    textures: [first.textures, last.textures],
    programs: [first.programs, samples.find((s) => s.minute === 10)!.programs, last.programs],
    consoleProblems: problems.length,
    samples,
  };
  saveResult('e-soak', result);
  console.log('e. soak', JSON.stringify({ ...result, samples: undefined }));
  expect(samples.length).toBe(30);
  // No growth trend: under 0.25 MB per simulated minute and no more than 8 MB net.
  expect(slopeMBPerMin).toBeLessThan(0.25);
  expect(last.heapMB - first.heapMB).toBeLessThan(8);
  expect(last.geometries).toBeLessThanOrEqual(first.geometries + 2);
  expect(last.textures).toBeLessThanOrEqual(first.textures + 2);
  // Shader programs: the first quality switch (minute 9) compiles the low-quality
  // variants once; after that every variant is cached and the count must stay flat.
  const settled = samples.find((s) => s.minute === 10)!;
  expect(last.programs).toBeLessThanOrEqual(settled.programs + 2);
  expectClean(problems);
});
