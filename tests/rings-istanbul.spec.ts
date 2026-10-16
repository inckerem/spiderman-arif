import { test, expect } from '@playwright/test';
import { expectClean, openGame, saveResult } from './helpers';

// (h, rings) on Istanbul: the three ist- routes are clear, open from ring to
// ring, have anchors on the approach and race to a finish; their best times
// are stored under ist- ids and never touch Manhattan's. The minimap paints
// water over the Bosphorus and land over the peninsula.
test('h-ist. ring races on Istanbul, best times per map, minimap water', async ({ page }) => {
  // Manhattan best times stored before the game loads.
  await page.goto('/?harita=istanbul');
  await page.evaluate(() => localStorage.setItem('skythread.bestTimes.v1', JSON.stringify({ park: 99, downtown: 98, waterfront: 97 })));
  const problems = await openGame(page, '/?harita=istanbul');
  const r = await page.evaluate(() => {
    const g = (window as any).__game;
    const rings = g.ringTest();
    const stored = JSON.parse(localStorage.getItem('skythread.bestTimes.v1') ?? '{}');
    // Minimap base: pixel colours at world points.
    g.showUi(true);
    g.game.view = 'play';
    g.app.ui.setHudVisible(true);
    g.uiFrame();
    const mm = (g.app.ui as any).minimap;
    // One readback of the whole base map (several small ones make the browser warn).
    const c = mm.base as HTMLCanvasElement;
    const img = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const px = (x: number, z: number): number[] => {
      const e = mm.baseExt;
      const k = mm.basePxPerM;
      const o = (Math.round((z - e.minZ) * k) * c.width + Math.round((x - e.minX) * k)) * 4;
      return [img[o]!, img[o + 1]!, img[o + 2]!];
    };
    return { rings, stored, bosphorus: px(560, -300), goldenHorn: px(-150, -40), peninsula: px(-400, 400) };
  });
  saveResult('h-rings-istanbul', r);
  console.log('h-ist. rings', JSON.stringify(r.rings.perRoute), JSON.stringify(r.rings.races), JSON.stringify(r.stored), r.bosphorus, r.goldenHorn, r.peninsula);
  expect(r.rings.routes).toBe(3);
  const ids = r.rings.perRoute.map((p: any) => p.id);
  expect(ids).toEqual(['ist-minare', 'ist-halic', 'ist-bogaz']);
  for (const p of r.rings.perRoute) {
    expect(p.clear).toBe(p.rings);
    expect(p.anchorsOnApproach).toBe(p.rings);
  }
  for (const race of r.rings.races) {
    expect(race.finished).toBe(true);
    expect(race.firstNewBest).toBe(true);
    expect(race.time45).toBeLessThan(race.time30);
  }
  // Manhattan's stored times are untouched; Istanbul's live under ist- ids.
  expect(r.stored).toMatchObject({ park: 99, downtown: 98, waterfront: 97 });
  for (const id of ids) expect(r.stored[id]).toBeGreaterThan(0);
  // Water colour (#123d50) at sea, not at land.
  const water = [0x12, 0x3d, 0x50];
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 6);
  expect(near(r.bosphorus, water)).toBe(true);
  expect(near(r.goldenHorn, water)).toBe(true);
  expect(near(r.peninsula, water)).toBe(false);
  expectClean(problems);
});
