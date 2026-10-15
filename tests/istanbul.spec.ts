import { test, expect } from '@playwright/test';
import { expectClean, openGame, saveResult } from './helpers';

// M13 Istanbul: the map loads cleanly from ?harita=istanbul (no request
// leaves the origin), generates in under 2 s, and the collision fuzz finds
// the hero never below the ground and never inside geometry on its hills.

test('istanbul: loads, steps, renders, generates in < 2 s', async ({ page }) => {
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  const external: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(`${origin}/`) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
  });
  const problems = await openGame(page, '/?harita=istanbul');
  const res = await page.evaluate(() => {
    const g = (window as any).__game;
    const before = g.state();
    g.setInput({ moveY: 1, sprint: true });
    const after = g.step(240);
    g.setInput({ moveY: 0, sprint: false });
    const frame = g.renderFrame();
    const gen = g.timeGeneration();
    return { mapId: g.mapId, before, after, frame, gen, stats: g.layoutStats() };
  });
  saveResult('istanbul-smoke', res);
  console.log('istanbul smoke', JSON.stringify({ frame: res.frame, gen: res.gen, stats: res.stats }));
  expect(res.mapId).toBe('istanbul');
  expect(res.after.pos.every((v: number) => Number.isFinite(v))).toBe(true);
  expect(res.frame.calls).toBeGreaterThan(0);
  expect(res.frame.calls).toBeLessThanOrEqual(600);
  expect(res.frame.triangles).toBeLessThanOrEqual(2_000_000);
  expect(res.gen.totalMs).toBeLessThan(2000);
  expect(res.stats.buildings).toBeGreaterThan(1000);
  expect(external, external.join('\n')).toEqual([]);
  expectClean(problems);
});

// (b) on Istanbul: 4 seeds x 2 simulated minutes of random input.
test('istanbul: collision fuzz on the hills', async ({ page }) => {
  const problems = await openGame(page, '/?harita=istanbul');
  const seeds = [11, 22, 33, 44];
  const reports: any[] = [];
  for (const seed of seeds) {
    const rep = await page.evaluate((sd) => (window as any).__game.fuzz(sd, 120), seed);
    reports.push(rep);
    console.log(`istanbul fuzz ${seed}:`, JSON.stringify({ inside: rep.insideGeometry, maxPen: rep.maxPenetration, below: rep.belowGround, oob: rep.outOfBounds, nan: rep.nan, stuck: rep.stuckOver3s, cam: rep.cameraInside, rec: rep.recoveries, splash: rep.splashes, msPerTick: rep.msPerTick, samples: rep.insideSamples.slice(0, 3) }));
  }
  const sum = (k: string) => reports.reduce((a, r) => a + r[k], 0);
  const total = {
    insideGeometry: sum('insideGeometry'),
    belowGround: sum('belowGround'),
    outOfBounds: sum('outOfBounds'),
    nan: sum('nan'),
    stuckOver3s: sum('stuckOver3s'),
    cameraInside: sum('cameraInside'),
    maxPenetration: Math.max(...reports.map((r) => r.maxPenetration)),
    msPerTick: reports.reduce((a, r) => a + r.msPerTick, 0) / reports.length,
  };
  saveResult('istanbul-fuzz', { total, reports });
  console.log('istanbul fuzz total', JSON.stringify(total));
  expect(total.insideGeometry).toBe(0);
  expect(total.belowGround).toBe(0);
  expect(total.outOfBounds).toBe(0);
  expect(total.nan).toBe(0);
  expect(total.stuckOver3s).toBe(0);
  expect(total.cameraInside).toBe(0);
  expectClean(problems);
});
