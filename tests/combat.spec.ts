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
    // Capsules render one instance per enemy.
    game.renderOnce();
    const capsules = game.combatCapsules.mesh.count;
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
