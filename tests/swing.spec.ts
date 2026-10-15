import { test, expect } from '@playwright/test';
import { expectClean, openGame, saveResult } from './helpers';

// (a) Rope and swing: a pendulum released from rest at 45 degrees, the catch,
// chaining, the line controls (holding fires where the crosshair points and
// keeps the line, letting go releases with a push, a tap gives none, Space
// cuts, presses at open sky do nothing, the pull line eases in and Space cuts
// it), camera auto-follow, and line edge cases (held state cleared without a
// release lets go, a click shorter than a tick fires, Space while a line from
// the ground is in flight jumps and keeps it).
test('a. rope and swing behave as designed', async ({ page }) => {
  const problems = await openGame(page);
  const r = await page.evaluate(() => {
    const g = (window as any).__game;
    return { noDrag: g.ropeTest(false), withDrag: g.ropeTest(true), catch: g.catchTest(), reattach: g.reattachLatency(), lines: g.lineControlsTest(), magnetismDeg: g.tuning.aim.magnetismDeg, follow: g.cameraFollowTest(), edges: g.lineEdgeCasesTest() };
  });
  saveResult('a-swing', r);
  console.log('a. swing', JSON.stringify(r, null, 1));
  const a = r.noDrag;
  // Pure rope mechanics: energy is conserved (documented drift < 0.05 % over 12 s).
  expect(a.nan).toBe(false);
  expect(a.stillAttached).toBe(true);
  expect(Math.abs(a.energyDriftPct)).toBeLessThan(0.05);
  expect(Math.abs(a.maxAngleDeg - 45)).toBeLessThan(0.5);
  expect(Math.abs(a.minAngleDeg + 45)).toBeLessThan(0.5);
  expect(Math.abs(a.periodMeasured - a.periodTheory) / a.periodTheory).toBeLessThan(0.01);
  expect(Math.abs(a.maxSpeed - a.theoreticalMaxSpeed) / a.theoreticalMaxSpeed).toBeLessThan(0.01);
  expect(a.maxRopeStretch).toBeLessThan(0.01);
  // With the designed air drag: bounded, monotonic decay, no explosion.
  const b = r.withDrag;
  expect(b.nan).toBe(false);
  expect(b.energyDriftPct).toBeLessThan(0);
  expect(b.energyDriftPct).toBeGreaterThan(-40);
  expect(b.maxSpeed).toBeLessThanOrEqual(a.theoreticalMaxSpeed * 1.001);
  // Catch: falling onto the line keeps most of the speed (no stall).
  expect(r.catch.stillSwinging).toBe(true);
  expect(r.catch.ratio).toBeGreaterThan(0.85);
  // Chaining: let go and press again attaches in under 150 ms.
  expect(r.reattach.trials).toBeGreaterThanOrEqual(4);
  expect(r.reattach.maxMs).toBeLessThan(150);
  // Line controls.
  const l = r.lines;
  expect(l.planned).toBe(true);
  expect(l.attached).toBe(true);
  expect(l.anchorAngleDeg).toBeLessThanOrEqual(r.magnetismDeg + 0.05);
  expect(l.stillAttachedWhileHeld).toBe(true);
  expect(l.releasedToAir).toBe(true);
  expect(l.releaseEvent).toBe(true);
  expect(l.releaseLift).toBeGreaterThan(4);
  expect(l.tapLift).toBeLessThan(1);
  expect(l.heldBeforeSpace).toBe(true);
  expect(l.spaceCut).toBe(true);
  expect(l.refiredWhileHeld).toBe(false);
  expect(l.skyClickFired).toBe(false);
  expect(l.zipPlanned).toBe(true);
  expect(l.zipMode).toBe(true);
  expect(l.zipStartSpeed).toBeLessThan(20);
  expect(l.zipSpeed200ms).toBeGreaterThan(l.zipStartSpeed);
  expect(l.zipCut).toBe(true);
  expect(l.zipCutLift).toBeGreaterThan(2);
  // Camera auto-follow turns toward the travel direction (and stays put when switched off).
  expect(r.follow.afterTwoSecondsOn).toBeLessThan(40);
  expect(r.follow.afterTwoSecondsOff).toBeGreaterThan(85);
  // Line edge cases.
  const e = r.edges;
  expect(e.clearPlanned).toBe(true);
  expect(e.attachedBeforeClear).toBe(true);
  expect(e.releasedAfterClear).toBe(true);
  expect(e.refiredAfterClear).toBe(false);
  expect(e.attachedBeforeBlur).toBe(true);
  expect(e.releasedAfterBlur).toBe(true);
  expect(e.tapPlanned).toBe(true);
  expect(e.subFrameFired).toBe(true);
  expect(e.subFrameLetGo).toBe(true);
  expect(e.subFrameLift).toBeLessThan(1);
  expect(e.groundStart).toBe(true);
  expect(e.groundPlanned).toBe(true);
  expect(e.firedFromGround).toBe(true);
  expect(e.jumpedInFlight).toBe(true);
  expect(e.lineKeptAfterSpace).toBe(true);
  expect(e.attachedAfterSpace).toBe(true);
  expectClean(problems);
});
