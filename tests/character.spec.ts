import { test, expect } from '@playwright/test';
import { expectClean, openGame, saveResult } from './helpers';

// (f) Character: procedural animation keeps planted feet fixed (no foot
// sliding), limbs out of solid geometry, and every bone finite, across
// locomotion, swinging, wall crawling, zipping and a hard landing crouch;
// strong releases do air tricks, which end on landing (a jump never replays one).
test('f. character: no foot sliding, no limb clipping, no NaN', async ({ page }) => {
  const problems = await openGame(page);
  const r = await page.evaluate(() => {
    const g = (window as any).__game;
    const res = g.characterTest();
    delete res.slideLog;
    delete res.clipLog;
    res.trickReplay = g.trickReplayTest();
    return res;
  });
  saveResult('f-character', r);
  console.log('f. character', JSON.stringify(r));
  // Feet: planted feet move less than 5 mm in any frame of a 26 s locomotion run.
  expect(r.footsteps).toBeGreaterThan(60);
  expect(r.maxSlidePerFrameMm).toBeLessThan(5);
  expect(r.framesSliding).toBe(0);
  // Limbs: extremities (3 cm probe spheres) deeper than 3 cm in under 0.5% of frames.
  expect(r.clipOver3cm / r.clipFrames).toBeLessThan(0.005);
  expect(r.clipMaxCm).toBeLessThan(15);
  expect(r.nanBones).toBe(0);
  expect(r.wallTicks).toBeGreaterThan(200);
  expect(r.zipTicks).toBeGreaterThan(50);
  for (const s of ['idle', 'run', 'air', 'swing', 'zip', 'wall', 'traverse', 'release']) expect(r.statesSeen).toContain(s);
  // Acrobatics: strong releases flip or corkscrew; a hard landing drops into the crouch.
  expect(r.tricksFlip + r.tricksTwist).toBeGreaterThan(0);
  expect(r.crouchPeak).toBeGreaterThan(0.4);
  expect(r.trickReplay.trickStarted).toBe(true);
  expect(r.trickReplay.landedMs).toBeLessThan(750);
  expect(r.trickReplay.jumped).toBe(true);
  expect(r.trickReplay.replayed).toBe(false);
  expectClean(problems);
});
