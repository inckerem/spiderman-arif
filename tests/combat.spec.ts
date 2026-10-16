import { test, expect, type Page } from '@playwright/test';
import { expectClean, openGame, saveResult } from './helpers';

// M11 combat in the page (manual stepping, combat switched on by the test):
// c1 the single-player room runs through the local link (enemies chase,
// telegraph and hurt the hero; a teleported hero is chased; the view
// interpolates the sim; down, then a roof respawn).

type Vec = [number, number, number];

const combat = (page: Page) => page.evaluate(() => (window as any).__game.combat.state());

test('c1. combat room in the page: chase, hits, view interpolation, down and roof respawn', async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);
  const problems = await openGame(page);
  const r = await page.evaluate(() => {
    const g = (window as any).__game;
    const game = g.game;
    const C = g.combat;
    C.enable(true);
    const spots: Vec[] = C.arenaSpots(0, 0);
    const [hx, hy, hz] = spots[0]!;
    g.teleport(hx, hy, hz);
    const ids = [C.spawn(0, ...spots[8]!), C.spawn(1, ...spots[12]!)];
    const dist = (id: number, x: number, z: number) => {
      const e = game.combatView.enemy(id);
      return e ? Math.hypot(e.x - x, e.z - z) : Infinity;
    };
    const start = ids.map((id: number) => dist(id, hx, hz));
    let minD = Infinity,
      maxLagErr = 0,
      nan = false;
    for (let i = 0; i < 120 * 6; i++) {
      g.step(1);
      for (const id of ids) {
        minD = Math.min(minD, dist(id, hx, hz));
        const v = game.combatView.enemy(id);
        const s = game.combatSim.enemy(id);
        if (v && s) {
          if (!Number.isFinite(v.x + v.y + v.z)) nan = true;
          // The view runs one combat tick behind the sim.
          maxLagErr = Math.max(maxLagErr, Math.hypot(v.x - s.pos.x, v.z - s.pos.z));
        }
      }
    }
    const afterFight = C.state();
    const hits = afterFight.events.filter((e: any) => e.e === 'hit' && e.tgt === 0x8000 + 1);
    const teles = afterFight.events.filter((e: any) => e.e === 'tele');
    // Teleport away along the sidewalk: they follow.
    let far = spots[0]!;
    for (const s of spots) if (Math.hypot(s[0] - hx, s[2] - hz) > Math.hypot(far[0] - hx, far[2] - hz)) far = s;
    g.teleport(far[0], far[1], far[2]);
    const farStart = ids.map((id: number) => dist(id, far[0], far[2]));
    let farMin = Infinity;
    for (let i = 0; i < 120 * 6; i++) {
      g.step(1);
      for (const id of ids) farMin = Math.min(farMin, dist(id, far[0], far[2]));
    }
    // The enemy rigs draw one instance per enemy near the hero.
    game.renderOnce();
    const capsules = game.enemyRender.visibleCount;
    // Down: health to 0, then a roof respawn after downTime.
    C.clear();
    C.setHp(0);
    let downAt = -1,
      respawnAt = -1;
    for (let i = 0; i < 120 * 8 && respawnAt < 0; i++) {
      g.step(1);
      const st = C.state();
      if (downAt < 0 && st.down) downAt = st.now;
      if (downAt > 0 && !st.down) respawnAt = st.now;
    }
    g.step(2);
    const p = game.player.pos;
    const sup = game.world.supportHeight(p.x, p.z, p.y + 0.5, 0);
    return {
      start,
      minD,
      maxLagErr,
      nan,
      hp: afterFight.hp,
      hits: hits.length,
      teles: teles.length,
      farDist: Math.hypot(far[0] - hx, far[2] - hz),
      farStart,
      farMin,
      capsules,
      downAt,
      respawnAt,
      respawnPos: [p.x, p.y, p.z],
      onBuilding: sup.id >= 0 && sup.id < game.world.count && game.world.owner[sup.id] >= 0,
      downTime: g.tuning.combat.downTime,
      hpAfter: C.state().hp,
    };
  });
  saveResult('c1-combat-room', r);
  console.log('c1. combat room', JSON.stringify(r));
  expect(r.nan).toBe(false);
  expect(r.minD).toBeLessThan(2.6);
  expect(r.teles).toBeGreaterThan(0);
  expect(r.hits).toBeGreaterThan(0);
  expect(r.hp).toBeLessThan(100);
  // One combat tick of motion at most (thug speed 4.5 m/s, 1/30 s) plus a little slack.
  expect(r.maxLagErr).toBeLessThan(0.35);
  expect(r.farDist).toBeGreaterThan(8);
  expect(r.farMin).toBeLessThan(2.6);
  expect(r.capsules).toBe(2);
  expect(r.downAt).toBeGreaterThan(0);
  expect(r.respawnAt - r.downAt).toBeGreaterThan(r.downTime - 0.05);
  expect(r.respawnAt - r.downAt).toBeLessThan(r.downTime + 0.1);
  expect(r.respawnPos[1]).toBeGreaterThanOrEqual(12);
  expect(r.onBuilding).toBe(true);
  expect(r.hpAfter).toBe(100);
  expect(await combat(page).then((s) => s.enabled)).toBe(true);
  expectClean(problems);
});

// c2. Routing: the context-sensitive left click (strike and lunge on an enemy,
// the web line exactly as before without one), F always strikes.
test('c2. combat routing: enemy under the crosshair strikes, otherwise the web line as before', async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);
  const problems = await openGame(page);
  const r = await page.evaluate(() => (window as any).__game.combat.routingTest());
  saveResult('c2-combat-routing', r);
  console.log('c2. routing', JSON.stringify({ ...r, lines: undefined, edges: undefined }));
  expect(r.startDist).toBeGreaterThan(6);
  expect(r.captured).toBe(1);
  expect(r.modeAfterPress).toBe('strike');
  expect(r.lungeKind).toBe(0);
  expect(r.ropeEver).toBe(false);
  expect(r.webFire).toBe(false);
  expect(r.lunge).toBe(true);
  expect(r.strike).toBe(true);
  expect(r.hits).toEqual([0]);
  expect(r.enemyAfter.hp).toBe(50);
  expect(r.distAfter).toBeLessThan(3);
  expect(r.rejected).toBe(0);
  expect(r.poseOk).toBe(true);
  expect(r.subFrameStrike).toBe(true);
  expect(r.subFrameHit).toBe(true);
  expect(r.anchorPlanned).toBe(true);
  expect(r.behindAttached).toBe(true);
  expect(r.behindWebFire).toBe(true);
  expect(r.autoStrike).toBe(true);
  expect(r.autoHit).toBe(true);
  expect(r.whiff).toBe(true);
  expect(r.whiffIntents).toBe(0);
  expect(r.poseFinite).toBe(true);
  // No enemy: the line drivers give what tests/swing.spec.ts expects.
  const l = r.lines;
  expect(r.combatOnDuringLines).toBe(true);
  for (const k of ['planned', 'attached', 'stillAttachedWhileHeld', 'releasedToAir', 'releaseEvent', 'heldBeforeSpace', 'spaceCut', 'zipPlanned', 'zipMode', 'zipCut']) expect(l[k], k).toBe(true);
  expect(l.refiredWhileHeld).toBe(false);
  expect(l.skyClickFired).toBe(false);
  expect(l.releaseLift).toBeGreaterThan(4);
  expect(l.tapLift).toBeLessThan(1);
  const e = r.edges;
  for (const k of ['clearPlanned', 'attachedBeforeClear', 'releasedAfterClear', 'attachedBeforeBlur', 'releasedAfterBlur', 'tapPlanned', 'subFrameFired', 'subFrameLetGo', 'groundStart', 'groundPlanned', 'firedFromGround', 'jumpedInFlight', 'lineKeptAfterSpace', 'attachedAfterSpace', 'wallClung', 'wallPlanned', 'firedFromWall', 'wallSpaceCut']) expect(e[k], k).toBe(true);
  expect(e.refiredAfterClear).toBe(false);
  expect(e.wallSpaceJumped).toBe(false);
  expectClean(problems);
});

// c3. Combo chain with the input buffer, the counter, the ground finisher on a downed thug, the window reset, a takedown.
test('c3. combat combo: chain, counter, ground finisher, window reset, takedown', async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);
  const problems = await openGame(page);
  const r = await page.evaluate(() => (window as any).__game.combat.comboTest());
  saveResult('c3-combat-combo', r);
  console.log('c3. combo', JSON.stringify(r));
  expect(r.moves).toEqual([0, 1, 2, 3, 5]);
  expect(r.combos).toEqual([1, 2, 3, 4, 5]);
  expect(r.stateAfterChain).toBe('down');
  expect(r.finalState).toBe('ko');
  expect(r.comboAfterFinisher).toBe(5);
  expect(r.rejected).toEqual([]);
  expect(r.hudComboAfterWindow).toBe(0);
  expect(r.simComboAfterWindow).toBe(0);
  expect(r.takedownMoves).toEqual([6]);
  expect(r.takedownState).toBe('ko');
  expect(r.focusAfter).toBeLessThan(100);
  expect(r.poseFinite).toBe(true);
  expectClean(problems);
});

// c4. Right click on an enemy: tap yanks, hold pins; no enemy: the pull line.
test('c4. combat web yank and pin; the pull line without an enemy', async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);
  const problems = await openGame(page);
  const r = await page.evaluate(() => (window as any).__game.combat.lineTest());
  saveResult('c4-combat-lines', r);
  console.log('c4. lines', JSON.stringify(r));
  expect(r.yankEvent).toBe(true);
  expect(r.yankZip).toBe(false);
  expect(r.yankFrac).toBeGreaterThan(0.6);
  expect(r.pinEvent).toBe(true);
  expect(r.pinZip).toBe(false);
  expect(r.pinDrift).toBeLessThan(0.2);
  expect(r.pinnedSeconds).toBeGreaterThan(3);
  expect(r.zipPlanned).toBe(true);
  expect(r.plainZip).toBe(true);
  expect(r.poseFinite).toBe(true);
  expectClean(problems);
});

// c5. Space dodges only while a telegraph is due; an air dodge keeps the line.
test('c5. combat dodge: Space in the window makes the swing miss; air dodge keeps the line', async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);
  const problems = await openGame(page);
  const r = await page.evaluate(() => (window as any).__game.combat.dodgeTest());
  saveResult('c5-combat-dodge', r);
  console.log('c5. dodge', JSON.stringify(r));
  expect(r.withDodge.telegraph).toBe(true);
  expect(r.withDodge.miss).toBe(true);
  expect(r.withDodge.hit).toBe(false);
  expect(r.withDodge.hpLost).toBe(0);
  expect(r.withDodge.dodgeEvent).toBe(true);
  expect(r.withDodge.jumped).toBe(false);
  expect(r.withoutDodge.telegraph).toBe(true);
  expect(r.withoutDodge.hit).toBe(true);
  expect(r.withoutDodge.hpLost).toBeGreaterThan(0);
  expect(r.rejected).toBe(0);
  expect(r.anchorPlanned).toBe(true);
  expect(r.airAttachedBefore).toBe(true);
  expect(r.airDodge).toBe(true);
  expect(r.airLineKept).toBe(true);
  expect(r.airAttachedAfter).toBe(true);
  expect(r.spaceCutWithoutThreat).toBe(true);
  expect(r.poseFinite).toBe(true);
  expectClean(problems);
});

// c6. Enemy rigs: 30 enemies of every archetype in view, draw calls within budget, no shader compiles
// after loading, LOD bands (near, far, hidden), finite poses.
test('c6. enemy rendering: 30 rigs, draw calls, programs flat, LOD', async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);
  const problems = await openGame(page);
  const r = await page.evaluate(() => {
    const g = (window as any).__game;
    const game = g.game;
    const C = g.combat;
    C.enable(true);
    const spots: Vec[] = C.arenaSpots(1, 0);
    const [hx, hy, hz] = spots[0]!;
    g.teleport(hx, hy, hz);
    g.setTime(12);
    g.step(4);
    // The widest view: high above and behind the hero.
    const wide = () => g.setCameraPose(hx + 26, hy + 30, hz + 26, hx, hy, hz, 70);
    wide();
    const before = g.stats();
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) {
      const kind = i % 5;
      const a = (i / 30) * Math.PI * 2;
      const d = 5 + (i % 3) * 3;
      ids.push(C.spawn(kind, hx + Math.cos(a) * d, kind === 4 ? hy + 4 : hy + 0.5, hz + Math.sin(a) * d));
    }
    g.step(120);
    wide();
    const after = g.stats();
    const st = { ...game.enemyRender.stats };
    // Close view: poses finite (the bone texture), calls.
    g.setCameraPose(hx + 6, hy + 2.5, hz + 6, hx, hy + 1, hz, 60);
    const close = g.stats();
    const closeSt = { ...game.enemyRender.stats };
    const bones: Float32Array = game.enemyRender.bones;
    let finite = true;
    for (let i = 0; i < bones.length; i++) if (!Number.isFinite(bones[i])) finite = false;
    // LOD: move the camera away so the ring sits beyond 40 m, then beyond 150 m.
    g.setCameraPose(hx + 50, hy + 20, hz + 50, hx, hy, hz, 60);
    g.renderFrame();
    const far = { ...game.enemyRender.stats };
    g.setCameraPose(hx + 140, hy + 60, hz + 140, hx, hy, hz, 60);
    g.renderFrame();
    const hidden = { ...game.enemyRender.stats };
    g.clearCameraPose();
    return { spawned: ids.filter((id) => id > 0).length, before, after, st, close, closeSt, finite, far, hidden };
  });
  saveResult('c6-enemy-render', r);
  console.log('c6. enemy rendering', JSON.stringify(r));
  expect(r.spawned).toBe(30);
  expect(r.st.visible).toBe(30);
  expect(r.st.near + r.st.far).toBe(30);
  expect(r.closeSt.near).toBe(30);
  expect(r.after.calls).toBeLessThanOrEqual(600);
  // Five archetype meshes and their shadow passes (plus a cocoon mesh at most).
  expect(r.after.calls - r.before.calls).toBeLessThanOrEqual(12);
  expect(r.after.programs).toBe(r.before.programs);
  expect(r.close.programs).toBe(r.before.programs);
  expect(r.finite).toBe(true);
  expect(r.far.far).toBeGreaterThan(0);
  expect(r.far.near).toBe(0);
  expect(r.hidden.visible).toBe(0);
  expectClean(problems);
});

// c7. Roster on the client: the dodge cue for gunshots and drone bolts, yanking a brute's shield, hitting a drone in the air.
test('c7. roster: shot and bolt threat cues with dodges, a brute shield yank, air strikes on a drone', async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);
  const problems = await openGame(page);
  const shot = await page.evaluate(() => (window as any).__game.combat.shotTest());
  saveResult('c7-combat-shots', shot);
  console.log('c7. shots', JSON.stringify(shot));
  expect(shot.gunDist).toBeGreaterThan(7);
  expect(shot.dodged.threat).toBe(true);
  expect(shot.dodged.atk).toBe(19);
  expect(shot.dodged.cue).toBe(true);
  expect(shot.dodged.shots).toBeGreaterThan(0);
  expect(shot.dodged.misses).toBeGreaterThan(0);
  expect(shot.dodged.hits).toBe(0);
  expect(shot.dodged.hpLost).toBe(0);
  expect(shot.dodged.dodgeEvent).toBe(true);
  expect(shot.dodged.jumped).toBe(false);
  expect(shot.plain.threat).toBe(true);
  expect(shot.plain.hits).toBeGreaterThan(0);
  expect(shot.plain.hpLost).toBeGreaterThan(0);
  expect(shot.projThreat).toBe(true);
  expect(shot.boltAtk).toBe(22);
  expect(shot.projLead).toBeGreaterThan(0.1);
  expect(shot.boltCue).toBe(true);
  expect(shot.boltDodge).toBe(true);
  expect(shot.boltEnded).toBe(true);
  expect(shot.boltHit).toBe(false);
  expect(shot.boltHpLost).toBe(0);
  expect(shot.rejected).toBe(0);
  expect(shot.poseFinite).toBe(true);

  const sh = await page.evaluate(() => (window as any).__game.combat.shieldTest());
  saveResult('c7-combat-shield', sh);
  console.log('c7. shield', JSON.stringify(sh));
  expect(sh.blockedFl.length).toBeGreaterThan(0);
  expect(sh.blockedFl[0] & 8).toBe(8);
  expect(sh.blockedDmg[0]).toBe(0);
  expect(sh.hpAfterBlock).toBe(sh.hp0);
  expect(sh.predictedOnBlock).toBe(0);
  expect(sh.bounced).toBeGreaterThan(0);
  expect(sh.shieldDrawnBefore).toBe(true);
  expect(sh.yankEvent).toBe(true);
  expect(sh.disarmHit).toBe(true);
  expect(sh.shieldless).toBe(true);
  expect(sh.moved).toBeLessThan(0.5);
  expect(sh.zip).toBe(false);
  expect(sh.shieldDrawnAfter).toBe(false);
  expect(sh.afterDmg.length).toBeGreaterThan(0);
  expect(sh.afterDmg[0]).toBeGreaterThan(0);
  expect(sh.afterFl[0] & 8).toBe(0);
  expect(sh.rejected).toBe(0);
  expect(sh.poseFinite).toBe(true);

  const dr = await page.evaluate(() => (window as any).__game.combat.droneTest());
  saveResult('c7-combat-drone', dr);
  console.log('c7. drone', JSON.stringify(dr));
  expect(dr.airLunge).toBe(true);
  expect(dr.maxRise).toBeGreaterThan(1.5);
  expect(dr.moves.length).toBeGreaterThanOrEqual(3);
  expect(dr.moves.every((m: number) => m === 4)).toBe(true);
  expect(dr.ko).toBe(true);
  expect(dr.fellTo).toBeLessThan(1);
  expect(dr.webFire).toBe(false);
  expect(dr.rejected).toBe(0);
  expect(dr.poseFinite).toBe(true);
  expectClean(problems);
});
