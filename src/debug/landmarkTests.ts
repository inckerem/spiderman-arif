import { tuning } from '../config/tuning';
import { Rng } from '../core/rng';
import type { Game } from '../game';
import { BOX, CYL, F_BRIDGE } from '../physics/collision';
import { emptyBotInput, stepWithInput } from './testDrivers';

/**
 * b2 on landmark parts (M13 C6): head-on impacts at 95 m/s into minarets,
 * towers and other cylinders, and into the thin boxes of cable chains,
 * rails and posts of colliders owned by landmarks and bridges (owner >=
 * `ownerMin`). Counts runs that end on the far side of the collider while
 * still overlapping it laterally and vertically, and ticks spent inside.
 */
export function landmarkTunnelTest(game: Game, trials: number, ownerMin = 200000): Record<string, number> {
  const rng = new Rng(9090);
  const w = game.world;
  const pl = game.player;
  const R = tuning.body.radius,
    H = tuning.body.height;
  // Two pools, drawn half and half: cylinders (minarets, towers, posts) and thin boxes (cable chains, rails, masts).
  const cylIds: number[] = [];
  const boxIds: number[] = [];
  for (let id = 0; id < w.count; id++) {
    if (w.owner[id]! < ownerMin) continue;
    const o = id * 6;
    if (w.kind[id] === CYL) {
      if (w.p[o + 3]! - w.p[o + 1]! >= 1) cylIds.push(id);
    } else if (w.kind[id] === BOX) {
      const dx = w.p[o + 3]! - w.p[o]!,
        dz = w.p[o + 5]! - w.p[o + 2]!;
      if (Math.min(dx, dz) <= 1.6 && w.p[o + 4]! - w.p[o + 1]! >= 0.8) boxIds.push(id);
    }
  }
  const samples: Array<Record<string, unknown>> = [];
  let tried = 0,
    tunneled = 0,
    inside = 0,
    cyls = 0,
    cables = 0,
    thin = 0;
  const prev = emptyBotInput();
  for (let attempt = 0; attempt < trials * 30 && tried < trials && cylIds.length + boxIds.length > 0; attempt++) {
    const pool = (rng.chance(0.5) && cylIds.length > 0) || boxIds.length === 0 ? cylIds : boxIds;
    const id = pool[rng.int(0, pool.length - 1)]!;
    const o = id * 6;
    const p = w.p;
    let cx: number, cz: number, y0: number, y1: number, half: number, lat: number, dx: number, dz: number;
    if (w.kind[id] === CYL) {
      cx = p[o]!;
      cz = p[o + 2]!;
      y0 = p[o + 1]!;
      y1 = p[o + 3]!;
      half = lat = p[o + 4]!;
      const a = rng.float() * Math.PI * 2;
      dx = Math.cos(a);
      dz = Math.sin(a);
    } else {
      cx = (p[o]! + p[o + 3]!) / 2;
      cz = (p[o + 2]! + p[o + 5]!) / 2;
      y0 = p[o + 1]!;
      y1 = p[o + 4]!;
      const ex = (p[o + 3]! - p[o]!) / 2,
        ez = (p[o + 5]! - p[o + 2]!) / 2;
      // Across the thin axis, up to 20 degrees off.
      const a = (ex < ez ? 0 : Math.PI / 2) + (rng.chance(0.5) ? 0 : Math.PI) + rng.range(-0.35, 0.35);
      dx = Math.cos(a);
      dz = Math.sin(a);
      half = Math.abs(dx) * ex + Math.abs(dz) * ez;
      lat = ex < ez ? ez : ex;
    }
    const start = half + R + 3;
    const sx = cx - dx * start,
      sz = cz - dz * start;
    // Above the water surface (a fall into the water respawns the hero elsewhere) and overlapping the part.
    const sy = Math.max(y0 - 1.2, Math.min(y1 - 0.6, (y0 + y1) / 2 - 0.9), w.terrain.waterLevelAt(sx, sz) + 0.3);
    if (sy >= y1 || sy + H <= y0 || !w.capsuleFree(sx, sy, sz, R, H)) continue;
    tried++;
    if (w.kind[id] === CYL) cyls++;
    else if ((w.flags[id]! & F_BRIDGE) !== 0) cables++;
    else thin++;
    pl.teleport(sx, sy, sz, dx * 95, 0, dz * 95);
    game.prevPos.copy(pl.pos);
    // Through it: beyond its far side within its lateral extent, without having gone over or under it.
    let passed = false,
      around = false;
    const splashes = pl.stats.splashes + pl.stats.recoveries;
    for (let k = 0; k < 24; k++) {
      stepWithInput(game, emptyBotInput(), prev);
      // A respawn or a recovery moves the hero away: the run ends there.
      if (pl.stats.splashes + pl.stats.recoveries !== splashes) break;
      const q = pl.pos;
      if (w.capsulePenetration(q.x, q.y, q.z, R, H) > 0.05) {
        inside++;
        if (samples.length < 6) {
          const dc = w.deepestContact(q.x, q.y, q.z, R, H);
          samples.push({ inside: true, target: id, deepest: dc.id, depth: +dc.depth.toFixed(3), kind: dc.id >= 0 ? w.kind[dc.id]! : -1, owner: dc.id >= 0 ? w.owner[dc.id]! : -1, p: dc.id >= 0 ? Array.from(w.p.subarray(dc.id * 6, dc.id * 6 + 6)).map((v) => +v.toFixed(2)) : [], pos: [+q.x.toFixed(2), +q.y.toFixed(2), +q.z.toFixed(2)], vel: [+pl.vel.x.toFixed(1), +pl.vel.y.toFixed(1), +pl.vel.z.toFixed(1)], tick: k });
        }
      }
      const along = (q.x - cx) * dx + (q.z - cz) * dz;
      const lateral = Math.abs(-(q.x - cx) * dz + (q.z - cz) * dx);
      const overlapY = q.y < y1 && q.y + H > y0;
      if (Math.abs(along) <= half + R && !overlapY) around = true;
      if (along > half + R && lateral < lat && !around) passed = true;
    }
    if (passed) {
      tunneled++;
      if (samples.length < 6) samples.push({ id, kind: w.kind[id]!, flags: w.flags[id]!, owner: w.owner[id]!, p: Array.from(p.subarray(o, o + 6)).map((v) => +v.toFixed(2)), start: [+sx.toFixed(2), +sy.toFixed(2), +sz.toFixed(2)], dir: [+dx.toFixed(3), +dz.toFixed(3)], end: [+pl.pos.x.toFixed(2), +pl.pos.y.toFixed(2), +pl.pos.z.toFixed(2)] });
    }
  }
  return { candidates: cylIds.length + boxIds.length, tried, cylinders: cyls, cables, thinBoxes: thin, tunneled, insideTicks: inside, samples: samples as unknown as number };
}
