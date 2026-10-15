import { Matrix4, Vector3 } from 'three';
import { tuning } from '../config/tuning';
import { Rng } from '../core/rng';
import type { Game } from '../game';
import type { App } from '../app';
import { BOX, CYL, F_ANCHOR, F_CAMERA, makeRayHit } from '../physics/collision';
import { SHOT_NAMES } from '../camera/director';
import { getMap } from '../maps/registry';
import { MODE_GROUND, MODE_SWING, MODE_NAMES, MODE_WALL, MODE_ZIP } from '../player/player';
import { makeAnchorResult } from '../player/targeting';
import { SwingBrain, aimAt, aimForClick, emptyBotInput, fillTickInput, planTarget, routeTarget, type BotInput } from '../player/autopilot';

// The bot play (input levels, aiming, the swing brain) ships in production
// for the menu autopilot; the drivers below use the same code.
export { aimAt, aimForClick, emptyBotInput, planTarget, type BotInput };

/** Run one tick with injected input (edges derived from the previous levels). */
export function stepWithInput(game: Game, inp: BotInput, prev: BotInput): void {
  game.injectInput = (out) => fillTickInput(out, inp, prev);
  game.manualTick();
  Object.assign(prev, inp);
}

// -----------------------------------------------------------------------------
// a. Rope and swing test
// -----------------------------------------------------------------------------

export function ropeTest(game: Game, withDrag: boolean): Record<string, number | boolean | string> {
  const pl = game.player;
  const L = game.layout;
  const ax = (L.park.minX + L.park.maxX) / 2,
    az = L.pond.cz,
    ay = 140;
  const len = 30;
  const off = tuning.body.ropeOffset;
  const ang = Math.PI / 4;
  const savedDrag = tuning.air.drag;
  if (!withDrag) tuning.air.drag = 0;
  // Start at rest, 45 degrees from vertical, rope taut, swinging in +X.
  pl.teleport(ax - Math.sin(ang) * len, ay - Math.cos(ang) * len - off, az, 0, 0, 0);
  pl.debugAttach(ax, ay, az, len);
  const g = tuning.air.gravity * tuning.swing.gravityScale;
  const energy = (): number => 0.5 * pl.vel.lengthSq() + g * (pl.pos.y + off - (ay - len));
  const e0 = energy();
  let maxSpeed = 0,
    minAngle = 0,
    maxAngle = 0,
    nan = false,
    maxStretch = 0;
  const prev = emptyBotInput();
  const inp = emptyBotInput();
  inp.swing = true;
  prev.swing = true;
  const ticks = 120 * 12;
  let firstReturn = -1;
  let lastSign = 0;
  let crossings = 0;
  const angles: number[] = [];
  for (let i = 0; i < ticks; i++) {
    stepWithInput(game, inp, prev);
    if (pl.mode !== MODE_SWING) break;
    const p = pl.pos;
    if (!Number.isFinite(p.x + p.y + p.z)) nan = true;
    const dx = p.x - ax,
      dy = p.y + off - ay;
    const a = Math.atan2(dx, -dy);
    angles.push(a);
    if (a < minAngle) minAngle = a;
    if (a > maxAngle) maxAngle = a;
    const sp = pl.vel.length();
    if (sp > maxSpeed) maxSpeed = sp;
    const stretch = Math.hypot(dx, dy, p.z - az) - len;
    if (stretch > maxStretch) maxStretch = stretch;
    const s = Math.sign(pl.vel.x);
    if (lastSign !== 0 && s !== lastSign) {
      crossings++;
      if (firstReturn < 0 && crossings === 2) firstReturn = i;
    }
    if (s !== 0) lastSign = s;
  }
  const e1 = energy();
  const seconds = ticks / 120;
  tuning.air.drag = savedDrag;
  // Theoretical small-angle-corrected period for g_eff.
  const T0 = 2 * Math.PI * Math.sqrt(len / g) * (1 + (1 / 16) * ang * ang + (11 / 3072) * ang ** 4);
  const measuredPeriod = firstReturn > 0 ? firstReturn / 120 : -1;
  return {
    withDrag,
    stillAttached: pl.mode === MODE_SWING,
    nan,
    energyStart: e0,
    energyEnd: e1,
    energyDriftPct: ((e1 - e0) / e0) * 100,
    energyDriftPctPerSecond: (((e1 - e0) / e0) * 100) / seconds,
    maxSpeed,
    theoreticalMaxSpeed: Math.sqrt(2 * g * len * (1 - Math.cos(ang))),
    minAngleDeg: (minAngle * 180) / Math.PI,
    maxAngleDeg: (maxAngle * 180) / Math.PI,
    maxRopeStretch: maxStretch,
    periodMeasured: measuredPeriod,
    periodTheory: T0,
    crossings,
  };
}

// -----------------------------------------------------------------------------
// b. Collision fuzz
// -----------------------------------------------------------------------------

export interface FuzzReport {
  seed: number;
  ticks: number;
  simSeconds: number;
  insideGeometry: number;
  maxPenetration: number;
  belowGround: number;
  outOfBounds: number;
  nan: number;
  stuckOver3s: number;
  maxNoProgress: number;
  cameraInside: number;
  maxCameraPenetration: number;
  recoveries: number;
  splashes: number;
  modeTicks: Record<string, number>;
  events: Record<string, number>;
  msPerTick: number;
  insideSamples: Array<Record<string, unknown>>;
  firstInsideHistory?: string[];
}

export function randomSpot(game: Game, rng: Rng, kind: number): Vector3 {
  const L = game.layout;
  const map = getMap(L.mapId);
  const pl = game.player;
  const out = new Vector3();
  for (let tries = 0; tries < 60; tries++) {
    let x: number, z: number, y: number;
    if (kind === 0) {
      // Street level anywhere on land.
      [x, y, z] = map.testSpots.street(rng, L, game.world.terrain);
    } else if (kind === 1) {
      const b = L.buildings[rng.int(0, L.buildings.length - 1)]!;
      const top = b.volumes[b.volumes.length - 1]!;
      x = rng.range(top.minX + 1, top.maxX - 1);
      z = rng.range(top.minZ + 1, top.maxZ - 1);
      y = top.maxY + 1;
    } else {
      [x, y, z] = map.testSpots.park(rng, L);
    }
    if (pl.findSafeSpot(x, y, z, out)) return out;
  }
  out.set(L.spawn[0], L.spawn[1] + 0.1, L.spawn[2]);
  return out;
}

export function fuzz(game: Game, seed: number, seconds: number): FuzzReport {
  const rng = new Rng(seed * 7919 + 13);
  const pl = game.player;
  const w = game.world;
  const r = tuning.body.radius,
    h = tuning.body.height;
  const ticks = Math.round(seconds * 120);
  const rep: FuzzReport = {
    seed,
    ticks,
    simSeconds: seconds,
    insideGeometry: 0,
    maxPenetration: 0,
    belowGround: 0,
    outOfBounds: 0,
    nan: 0,
    stuckOver3s: 0,
    maxNoProgress: 0,
    cameraInside: 0,
    maxCameraPenetration: 0,
    recoveries: 0,
    splashes: 0,
    modeTicks: {},
    events: {},
    msPerTick: 0,
    insideSamples: [],
  };
  const startStats = { ...pl.stats };
  const inp = emptyBotInput();
  const prev = emptyBotInput();
  let segLeft = 0;
  let yawRate = 0,
    pitchTarget = 0;
  let nextTeleport = 0;
  const history: string[] = [];
  const anchorPos = new Vector3().copy(pl.pos);
  let noProgress = 0;
  const b = game.layout.bounds;
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) {
    if (i >= nextTeleport) {
      const spot = randomSpot(game, rng, rng.int(0, 2));
      // Sometimes drop in from the air with speed.
      if (rng.chance(0.4)) {
        pl.teleport(spot.x, spot.y + rng.range(5, 60), spot.z, rng.range(-30, 30), rng.range(-10, 10), rng.range(-30, 30));
      } else pl.teleport(spot.x, spot.y, spot.z);
      game.snapCamera();
      game.prevPos.copy(pl.pos);
      nextTeleport = i + rng.int(120 * 15, 120 * 35);
      anchorPos.copy(pl.pos);
      noProgress = 0;
    }
    if (segLeft <= 0) {
      segLeft = rng.int(12, 200);
      inp.moveY = rng.weighted([1, 0, -1], [6, 2, 1]);
      inp.moveX = rng.weighted([0, 1, -1], [5, 1.5, 1.5]);
      inp.sprint = rng.chance(0.45);
      inp.dive = rng.chance(0.12);
      inp.swing = rng.chance(0.45);
      inp.zip = rng.chance(0.08);
      inp.jump = rng.chance(0.25);
      inp.reel = rng.chance(0.05) ? rng.int(-2, 2) : 0;
      yawRate = rng.range(-2.5, 2.5) * (rng.chance(0.3) ? 0 : 1);
      pitchTarget = rng.range(-0.6, 0.7);
    } else {
      segLeft--;
      if (inp.jump && rng.chance(0.2)) inp.jump = false;
      if (inp.zip && rng.chance(0.3)) inp.zip = false;
      inp.reel = 0;
    }
    game.rig.setLook(game.rig.yaw + yawRate / 120, game.rig.pitch + (pitchTarget - game.rig.pitch) * 0.05);
    stepWithInput(game, inp, prev);
    history.push(`${i} ${MODE_NAMES[pl.mode]} p=${pl.pos.x.toFixed(2)},${pl.pos.y.toFixed(2)},${pl.pos.z.toFixed(2)} v=${pl.vel.x.toFixed(1)},${pl.vel.y.toFixed(1)},${pl.vel.z.toFixed(1)} in=${inp.moveX},${inp.moveY},${inp.sprint ? 'S' : ''}${inp.jump ? 'J' : ''}${inp.swing ? 'L' : ''}${inp.zip ? 'R' : ''} ev=${pl.events.map((e) => e.type).join('/')}`);
    if (history.length > 50) history.shift();
    for (const e of pl.events) rep.events[e.type] = (rep.events[e.type] ?? 0) + 1;
    const mn = MODE_NAMES[pl.mode]!;
    rep.modeTicks[mn] = (rep.modeTicks[mn] ?? 0) + 1;
    const p = pl.pos;
    if (!Number.isFinite(p.x + p.y + p.z + pl.vel.x + pl.vel.y + pl.vel.z)) rep.nan++;
    const pen = w.capsulePenetration(p.x, p.y, p.z, r, h);
    if (pen > rep.maxPenetration) rep.maxPenetration = pen;
    if (pen > 0.03) {
      rep.insideGeometry++;
      if (!rep.firstInsideHistory) rep.firstInsideHistory = history.slice();
      if (rep.insideSamples.length < 12) {
        const dc = w.deepestContact(p.x, p.y, p.z, r, h);
        rep.insideSamples.push({
          tick: i,
          mode: MODE_NAMES[pl.mode]!,
          depth: +pen.toFixed(3),
          pos: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
          vel: [+pl.vel.x.toFixed(1), +pl.vel.y.toFixed(1), +pl.vel.z.toFixed(1)],
          kind: dc.id >= 0 ? w.kind[dc.id]! : dc.id,
          flags: dc.id >= 0 ? w.flags[dc.id]! : 0,
          box: dc.id >= 0 ? Array.from(w.p.subarray(dc.id * 6, dc.id * 6 + 6)).map((v) => +v.toFixed(2)) : [],
        });
      }
    }
    if (!w.terrain.isWater(p.x, p.z) && p.y < w.terrain.height(p.x, p.z) - 0.03) rep.belowGround++;
    if (p.x < b.minX - 0.01 || p.x > b.maxX + 0.01 || p.z < b.minZ - 0.01 || p.z > b.maxZ + 0.01) rep.outOfBounds++;
    // Stuck tracking (independent of the player's own detector).
    if (p.distanceTo(anchorPos) > 0.3) {
      anchorPos.copy(p);
      noProgress = 0;
    } else {
      const trying = inp.moveX !== 0 || inp.moveY !== 0;
      const airborne = pl.mode !== MODE_GROUND && pl.mode !== MODE_WALL && pl.mode !== MODE_SWING;
      if (airborne || (trying && pl.mode === MODE_GROUND)) noProgress += 1 / 120;
      else noProgress = 0;
      if (noProgress > rep.maxNoProgress) rep.maxNoProgress = noProgress;
      if (noProgress > 3.25) {
        // Blocked in one direction is fine (player can turn); count only true traps.
        if (!pl.hasFreeDirection()) rep.stuckOver3s++;
        noProgress = 0;
      }
    }
    // Camera
    const cp = game.rig.position;
    const cpen = w.spherePenetration(cp.x, cp.y, cp.z, 0.2);
    if (cpen > rep.maxCameraPenetration) rep.maxCameraPenetration = cpen;
    if (cpen > 0.02) rep.cameraInside++;
  }
  rep.msPerTick = (performance.now() - t0) / ticks;
  rep.recoveries = pl.stats.recoveries - startStats.recoveries;
  rep.splashes = pl.stats.splashes - startStats.splashes;
  return rep;
}

// -----------------------------------------------------------------------------
// c. Anchor availability
// -----------------------------------------------------------------------------

export function anchorAvailability(game: Game, seed: number, count: number): Record<string, number> {
  const rng = new Rng(seed);
  const pl = game.player;
  const w = game.world;
  const res = makeAnchorResult();
  const swingAim = makeAnchorResult(),
    zipAim = makeAnchorResult();
  let inRange = 0,
    found = 0,
    aimed = 0,
    foundAll = 0,
    total = 0;
  const kinds = [0, 0, 0];
  const foundByKind = [0, 0, 0];
  const rangeByKind = [0, 0, 0];
  const buf = new Int32Array(4096);
  let msTargeting = 0;
  const failures: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    const kind = i % 3;
    const spot = randomSpot(game, rng, kind);
    pl.teleport(spot.x, spot.y, spot.z);
    const yaw = rng.range(-Math.PI, Math.PI);
    const pitch = rng.range(-0.1, 0.3);
    game.rig.setLook(yaw, pitch);
    game.snapCamera();
    game.prevPos.copy(pl.pos);
    game.updateCameraForTest();
    const t0 = performance.now();
    pl.targeting.debug = true;
    const ok = planTarget(game, 0, res);
    msTargeting += performance.now() - t0;
    // A player aiming the crosshair at the planned point gets that line.
    let aimOk = false;
    if (ok) {
      aimAt(game, res.x, res.y, res.z);
      const c = game.rig.position,
        f = game.rig.fwd;
      pl.targeting.aim(pl.pos.x, pl.pos.y, pl.pos.z, c.x, c.y, c.z, f.x, f.y, f.z, swingAim, zipAim);
      aimOk = swingAim.valid;
    }
    total++;
    kinds[kind]!++;
    if (ok) foundAll++;
    // Brute-force existence check: any anchorable surface sample in the cone, >= 6 m above, with LOS.
    const hx = pl.pos.x,
      hy = pl.pos.y + tuning.body.ropeOffset,
      hz = pl.pos.z;
    const fx = -Math.sin(yaw),
      fz = -Math.cos(yaw);
    const cosMax = Math.cos((tuning.assist.maxAimAngleDeg * Math.PI) / 180);
    const R = Math.min(tuning.assist.range, tuning.swing.maxRange);
    const n = w.gatherAabb(hx - R, pl.pos.y + 5, hz - R, hx + R, hy + R, hz + R, buf, F_ANCHOR);
    const samples: Array<[number, number, number, number, number]> = [];
    const push = (x: number, y: number, z: number, id: number): void => {
      if (y < pl.pos.y + tuning.swing.minHeightAbove) return;
      const dx = x - hx,
        dy = y - hy,
        dz = z - hz;
      const d = Math.hypot(dx, dy, dz);
      if (d > R || d < tuning.assist.minDistance) return;
      if (dy < Math.sin((tuning.swing.minElevationDeg * Math.PI) / 180) * d) return;
      const hl = Math.hypot(dx, dz);
      if (hl > 0.5 && (dx * fx + dz * fz) / hl < cosMax) return;
      samples.push([d, x, y, z, id]);
    };
    for (let k = 0; k < n; k++) {
      const id = buf[k]!;
      const o = id * 6;
      const p = w.p;
      if (w.kind[id] === BOX) {
        // Sample the faces that face the player.
        const minX = p[o]!,
          minY = p[o + 1]!,
          minZ = p[o + 2]!,
          maxX = p[o + 3]!,
          maxY = p[o + 4]!,
          maxZ = p[o + 5]!;
        const ys: number[] = [];
        for (let y = Math.max(minY, pl.pos.y + 6); y <= maxY + 0.01; y += 4) ys.push(Math.min(y, maxY));
        ys.push(maxY);
        const faces: Array<[number, number, number, number, boolean]> = [];
        if (hx > maxX) faces.push([maxX, minZ, maxX, maxZ, true]);
        if (hx < minX) faces.push([minX, minZ, minX, maxZ, true]);
        if (hz > maxZ) faces.push([minX, maxZ, maxX, maxZ, false]);
        if (hz < minZ) faces.push([minX, minZ, maxX, minZ, false]);
        for (const f of faces) {
          const len = f[4] ? f[3] - f[1] : f[2] - f[0];
          const steps = Math.max(1, Math.ceil(len / 4));
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const x = f[4] ? f[0] : f[0] + (f[2] - f[0]) * t;
            const z = f[4] ? f[1] + (f[3] - f[1]) * t : f[1];
            for (const y of ys) push(x, y, z, id);
          }
        }
      } else if (w.kind[id] === CYL) {
        const cx = p[o]!,
          cz = p[o + 2]!,
          R2 = p[o + 4]!;
        const dx = hx - cx,
          dz = hz - cz;
        const dl = Math.hypot(dx, dz) || 1;
        for (let y = p[o + 1]!; y <= p[o + 3]!; y += 3) push(cx + (dx / dl) * R2, y, cz + (dz / dl) * R2, id);
        push(cx + (dx / dl) * R2, p[o + 3]!, cz + (dz / dl) * R2, id);
      } else {
        const cx = p[o]!,
          cy = p[o + 1]!,
          cz = p[o + 2]!;
        for (let a = 0; a < 8; a++) {
          const th = (a / 8) * Math.PI * 2;
          for (const el of [-0.5, 0, 0.5, 1.2]) {
            push(cx + Math.cos(th) * Math.cos(el) * p[o + 3]!, cy + Math.sin(el) * p[o + 4]!, cz + Math.sin(th) * Math.cos(el) * p[o + 5]!, id);
          }
        }
      }
    }
    samples.sort((a, b) => a[0] - b[0]);
    let exists = false;
    let witness: [number, number, number, number, number] | null = null;
    for (let s = 0; s < samples.length && s < 400; s++) {
      const [, x, y, z, id] = samples[s]!;
      if (pl.targeting.lineOfSight(hx, hy, hz, x, y, z, id)) {
        exists = true;
        witness = samples[s]!;
        break;
      }
    }
    if (exists) {
      inRange++;
      rangeByKind[kind]!++;
      if (ok) {
        found++;
        foundByKind[kind]!++;
        if (aimOk) aimed++;
      } else if (failures.length < 14 && witness) {
        failures.push({
          kind,
          pos: [+pl.pos.x.toFixed(1), +pl.pos.y.toFixed(1), +pl.pos.z.toFixed(1)],
          yaw: +yaw.toFixed(2),
          pitch: +pitch.toFixed(2),
          witness: { d: +witness[0].toFixed(1), y: +witness[2].toFixed(1), kind: w.kind[witness[4]]!, flags: w.flags[witness[4]]! },
          candidates: pl.targeting.lastCandidates,
          scored: pl.targeting.lastScored,
          los: pl.targeting.debugLog.slice(0, 4).map((e) => ({ ...e })),
        });
      }
    }
  }
  return {
    total,
    inRange,
    found,
    rate: inRange > 0 ? found / inRange : 0,
    aimRate: found > 0 ? aimed / found : 0,
    rawRate: foundAll / total,
    streetRate: rangeByKind[0]! ? foundByKind[0]! / rangeByKind[0]! : 0,
    roofRate: rangeByKind[1]! ? foundByKind[1]! / rangeByKind[1]! : 0,
    parkRate: rangeByKind[2]! ? foundByKind[2]! / rangeByKind[2]! : 0,
    inRangeStreet: rangeByKind[0]!,
    inRangeRoof: rangeByKind[1]!,
    inRangePark: rangeByKind[2]!,
    msPerQuery: msTargeting / total,
    failures: failures as unknown as number,
  };
}

// -----------------------------------------------------------------------------
// d. Traversal bots
// -----------------------------------------------------------------------------

export interface BotReport {
  name: string;
  reached: boolean;
  seconds: number;
  groundSeconds: number;
  groundFraction: number;
  distance: number;
  avgSpeed: number;
  swings: number;
  goodReleases: number;
  splashes: number;
  recoveries: number;
  maxAltitude: number;
  minAltitudeAir: number;
  medianSpeed: number;
  maxSpeed: number;
  swingLog: Array<Record<string, number | string>>;
  path: Array<[number, number, number]>;
}

/** Follow a polyline route by swinging. Uses only player inputs plus visible cues. */
export function traversalBot(
  game: Game,
  name: string,
  route: Array<[number, number]>,
  maxSeconds: number,
  startY?: number,
  diag = false,
  stop?: () => boolean,
): BotReport {
  const swingLog: Array<Record<string, number | string>> = [];
  let cur: { [k: string]: number | string; maxY: number; minY: number; ceil: number; wall: number; ground: number } | null = null;
  const pl = game.player;
  const out = new Vector3();
  const start = route[0]!;
  if (!pl.findSafeSpot(start[0], startY ?? 0.5, start[1], out)) out.set(start[0], 0.15, start[1]);
  pl.teleport(out.x, out.y, out.z);
  const first = route[1]!;
  game.rig.setLook(Math.atan2(-(first[0] - start[0]), -(first[1] - start[1])), 0.2);
  game.snapCamera();
  game.prevPos.copy(pl.pos);
  const brain = new SwingBrain(game);
  const follow = { seg: 0, x: 0, z: 0 };
  let ticks = 0,
    groundTicks = 0;
  const startStats = { ...pl.stats };
  let distance = 0;
  const last = new Vector3().copy(pl.pos);
  let maxAlt = 0,
    minAltAir = 1e9;
  const path: Array<[number, number, number]> = [];
  const speeds: number[] = [];
  const goal = route[route.length - 1]!;
  let reached = false;
  const maxTicks = maxSeconds * 120;
  while (ticks < maxTicks) {
    // Advance along the route; look-ahead target 70 m along it.
    const p = pl.pos;
    routeTarget(route, route.length, p.x, p.z, 70, follow);
    if (Math.hypot(p.x - goal[0], p.z - goal[1]) < 40) {
      reached = true;
      break;
    }
    // Pull back toward the route line when drifting sideways, then swing (shared brain).
    brain.steer(follow.x, follow.z);
    brain.choose();
    brain.press();
    stepWithInput(game, brain.inp, brain.prev);
    brain.after();
    if (diag) {
      for (const e of pl.events) {
        if (e.type === 'attach') {
          const id = pl.rope.anchor.id;
          cur = { t: +(ticks / 120).toFixed(2), ay: +e.y.toFixed(1), py: +pl.pos.y.toFixed(1), len: +pl.rope.length.toFixed(1), kind: id >= 0 ? game.world.kind[id]! : -1, maxY: pl.pos.y, minY: pl.pos.y, ceil: 0, wall: 0, ground: 0, spd: +pl.vel.length().toFixed(1), end: '' };
          swingLog.push(cur);
        }
        if (e.type === 'release' && cur) cur.end = e.good ? 'good' : e.broken ? 'broken' : 'rel';
      }
      if (cur && pl.mode === MODE_SWING) {
        cur.maxY = Math.max(cur.maxY, pl.pos.y);
        cur.minY = Math.min(cur.minY, pl.pos.y);
        if (pl.contact.ceiling) cur.ceil++;
        if (pl.contact.wall) cur.wall++;
        if (pl.contact.ground) cur.ground++;
      }
    }
    ticks++;
    if (pl.mode === MODE_GROUND) groundTicks++;
    distance += pl.pos.distanceTo(last);
    last.copy(pl.pos);
    if (pl.pos.y > maxAlt) maxAlt = pl.pos.y;
    speeds.push(pl.vel.length());
    if (pl.mode !== MODE_GROUND && pl.pos.y < minAltAir) minAltAir = pl.pos.y;
    if (ticks % 60 === 0) path.push([+pl.pos.x.toFixed(1), +pl.pos.y.toFixed(1), +pl.pos.z.toFixed(1)]);
    if (stop && stop()) break;
  }
  const seconds = ticks / 120;
  return {
    name,
    reached,
    seconds,
    groundSeconds: groundTicks / 120,
    groundFraction: groundTicks / Math.max(1, ticks),
    distance,
    avgSpeed: distance / Math.max(0.01, seconds),
    swings: brain.swings,
    goodReleases: brain.goodReleases,
    splashes: pl.stats.splashes - startStats.splashes,
    recoveries: pl.stats.recoveries - startStats.recoveries,
    maxAltitude: maxAlt,
    minAltitudeAir: minAltAir,
    swingLog: swingLog.map((c) => ({ ...c, maxY: +Number(c.maxY).toFixed(1), minY: +Number(c.minY).toFixed(1) })),
    medianSpeed: speeds.sort((a, b) => a - b)[Math.floor(speeds.length / 2)] ?? 0,
    maxSpeed: speeds[speeds.length - 1] ?? 0,
    path,
  };
}

export function cityRoute(game: Game): Array<[number, number]> {
  return getMap(game.layout.mapId).routes.city(game.layout);
}

export function parkRoute(game: Game): Array<[number, number]> {
  return getMap(game.layout.mapId).routes.park(game.layout);
}

// -----------------------------------------------------------------------------
// Extra swing checks: catch conversion and re-attach latency
// -----------------------------------------------------------------------------

/** Fall onto a slack rope from directly below the anchor: speed must survive the catch. */
export function catchTest(game: Game): Record<string, number | boolean> {
  const pl = game.player;
  const L = game.layout;
  const ax = (L.park.minX + L.park.maxX) / 2,
    az = L.pond.cz,
    ay = 150;
  const off = tuning.body.ropeOffset;
  game.rig.setLook(0, 0);
  game.snapCamera();
  // 4 m of slack, falling at 25 m/s with a little forward drift.
  pl.teleport(ax, ay - 26 - off, az, 0.5, -25, 0);
  pl.debugAttach(ax, ay, az, 30);
  pl.rope.wasTaut = false;
  pl.rope.taut = false;
  const inp = emptyBotInput();
  inp.swing = true;
  const prev = emptyBotInput();
  prev.swing = true;
  const before = pl.vel.length();
  let after = 0,
    minSpeed = 1e9;
  for (let i = 0; i < 60; i++) {
    stepWithInput(game, inp, prev);
    const sp = pl.vel.length();
    if (sp < minSpeed) minSpeed = sp;
    if (pl.rope.taut && after === 0) after = sp;
  }
  return { speedBefore: before, speedAfterCatch: after, minSpeedDuring: minSpeed, ratio: after / before, stillSwinging: pl.mode === MODE_SWING };
}

/** Let go of a swing and press again: time from the press until the new line is attached. */
export function reattachLatency(game: Game): Record<string, number> {
  const pl = game.player;
  const route = cityRoute(game);
  const start = route[0]!;
  const out = new Vector3();
  pl.findSafeSpot(start[0], 0.5, start[1], out);
  const results: number[] = [];
  const totals: number[] = [];
  const inp = emptyBotInput();
  const prev = emptyBotInput();
  const target = makeAnchorResult();
  const step = (): void => stepWithInput(game, inp, prev);
  for (let trial = 0; trial < 8; trial++) {
    inp.swing = false;
    step();
    pl.teleport(out.x, out.y + 18 + trial * 2, out.z - trial * 40, 0, 0, -20);
    game.rig.setLook(0, 0.35);
    game.snapCamera();
    inp.moveY = 1;
    let attachedAt = -1;
    for (let i = 0; i < 120 && attachedAt < 0; i++) {
      if (pl.mode !== MODE_SWING) {
        // Let go of a press that found nothing, then aim and press again.
        if (inp.swing) inp.swing = false;
        else if (i % 4 === 0) aimForClick(game, 0, inp, target);
      }
      step();
      if (pl.rope.attached) attachedAt = i;
    }
    if (attachedAt < 0) continue;
    for (let i = 0; i < 40; i++) step();
    // Let go, then press again as soon as an anchor is in view
    // (a player aims at the next point and presses).
    inp.swing = false;
    step();
    let waited = 0;
    while (!planTarget(game, 0, target) && waited < 120) {
      step();
      waited++;
    }
    aimForClick(game, 0, inp, target);
    let ticks = 0;
    while (ticks < 120) {
      step();
      ticks++;
      if (pl.rope.attached) break;
    }
    // Total from letting go to attached, including the wait for an anchor in view.
    results.push(((ticks + 1) * 1000) / 120);
    totals.push(((ticks + 1 + waited) * 1000) / 120);
  }
  results.sort((a, b) => a - b);
  totals.sort((a, b) => a - b);
  return {
    trials: results.length,
    minMs: results[0] ?? -1,
    medianMs: results[Math.floor(results.length / 2)] ?? -1,
    maxMs: results[results.length - 1] ?? -1,
    releaseToAttachMedianMs: totals[Math.floor(totals.length / 2)] ?? -1,
    releaseToAttachMaxMs: totals[totals.length - 1] ?? -1,
  };
}

/**
 * The line controls: holding the button fires where the crosshair points and
 * keeps the line; letting go releases it with a push; a tap gives no push;
 * Space cuts a held line and the held button does not fire again until a new
 * press; a press with nothing usable under the crosshair does nothing; the
 * pull line eases in and Space cuts it.
 */
export function lineControlsTest(game: Game): Record<string, number | boolean> {
  const pl = game.player;
  const route = cityRoute(game);
  const out = new Vector3();
  pl.findSafeSpot(route[0]![0], 0.5, route[0]![1], out);
  const inp = emptyBotInput();
  const prev = emptyBotInput();
  const a = makeAnchorResult(),
    z = makeAnchorResult();
  const step = (n = 1): void => {
    for (let i = 0; i < n; i++) stepWithInput(game, inp, prev);
  };
  const events = (from: number): string[] => game.eventLog.slice(from).map((e) => e.type);
  const r: Record<string, number | boolean> = {};
  const start = (): void => {
    Object.assign(inp, emptyBotInput());
    step();
    pl.teleport(out.x, out.y + 24, out.z, 0, 0, -18);
    game.rig.setLook(0, 0.35);
    game.snapCamera();
    step();
  };
  // 1. Hold: the line goes where the crosshair points and stays while held.
  start();
  r.planned = !!aimForClick(game, 0, inp, a);
  const c = game.rig.position.clone(),
    f = game.rig.fwd.clone();
  step(30);
  r.attached = pl.rope.attached;
  const an = pl.rope.anchor;
  const ad = Math.hypot(an.x - c.x, an.y - c.y, an.z - c.z) || 1;
  r.anchorAngleDeg = (Math.acos(Math.min(1, ((an.x - c.x) * f.x + (an.y - c.y) * f.y + (an.z - c.z) * f.z) / ad)) * 180) / Math.PI;
  step(120);
  r.stillAttachedWhileHeld = pl.rope.attached && pl.mode === MODE_SWING;
  // 2. Let go: released with a push.
  const vy0 = pl.vel.y,
    hs0 = Math.hypot(pl.vel.x, pl.vel.z);
  let e0 = game.eventLog.length;
  inp.swing = false;
  step();
  r.releasedToAir = pl.mode !== MODE_SWING && !pl.rope.attached;
  r.releaseEvent = events(e0).includes('release');
  r.releaseLift = pl.vel.y - Math.max(vy0, 0);
  r.releaseForward = Math.hypot(pl.vel.x, pl.vel.z) - hs0;
  // 3. A tap gives no push.
  start();
  aimForClick(game, 0, inp, a);
  step();
  const vyTap = pl.vel.y;
  inp.swing = false;
  step();
  r.tapLift = pl.vel.y - vyTap;
  // 4. Space cuts a held line; the held button waits for a new press.
  start();
  aimForClick(game, 0, inp, a);
  step(60);
  r.heldBeforeSpace = pl.rope.attached;
  e0 = game.eventLog.length;
  inp.jump = true;
  step();
  inp.jump = false;
  step(30);
  r.spaceCut = pl.mode !== MODE_SWING;
  r.refiredWhileHeld = events(e0).includes('webFire');
  inp.swing = false;
  step();
  // 5. A press at open sky does nothing.
  pl.teleport(out.x, out.y + 2, out.z);
  game.rig.setLook(0, 1.35);
  game.snapCamera();
  step(2);
  const e1 = game.eventLog.length;
  inp.swing = true;
  inp.zip = true;
  step(10);
  inp.swing = false;
  inp.zip = false;
  step();
  r.skyClickFired = events(e1).includes('webFire') || events(e1).includes('zipStart');
  // 6. Pull line: eases in, Space cuts it.
  pl.teleport(out.x, out.y, out.z);
  game.rig.setLook(0, 0.3);
  game.snapCamera();
  step(2);
  r.zipPlanned = !!aimForClick(game, 1, inp, z);
  step();
  inp.zip = false;
  r.zipMode = pl.mode === MODE_ZIP;
  r.zipStartSpeed = pl.vel.length();
  step(24);
  r.zipSpeed200ms = pl.vel.length();
  const e2 = game.eventLog.length;
  const zipVy = pl.vel.y;
  inp.jump = true;
  step();
  inp.jump = false;
  r.zipCut = pl.mode !== MODE_ZIP && events(e2).includes('zipEnd');
  r.zipCutLift = pl.vel.y - Math.max(zipVy, 0);
  return r;
}

/**
 * Line edge cases through the real mouse handlers: held state cleared without
 * a release (pause, lost lock or focus) lets go of the line; a click shorter
 * than a tick still fires (and lets go next tick, a tap); Space while a line
 * fired from the ground is in flight jumps and keeps the line, while one fired
 * from a wall is cut.
 */
export function lineEdgeCasesTest(game: Game): Record<string, number | boolean> {
  const pl = game.player;
  const input = game.input;
  const canvas = game.renderer.domElement;
  const route = cityRoute(game);
  const out = new Vector3();
  pl.findSafeSpot(route[0]![0], 0.5, route[0]![1], out);
  const a = makeAnchorResult();
  const events = (from: number): string[] => game.eventLog.slice(from).map((e) => e.type);
  const r: Record<string, number | boolean> = {};
  const mouse = (type: 'mousedown' | 'mouseup'): void => {
    (type === 'mousedown' ? canvas : window).dispatchEvent(new MouseEvent(type, { button: 0 }));
  };
  // Devices drive the ticks: the pointer counts as locked, no injected input.
  const aimInAir = (): boolean => {
    pl.teleport(out.x, out.y + 24, out.z, 0, 0, -18);
    game.rig.setLook(0, 0.35);
    game.snapCamera();
    if (!planTarget(game, 0, a)) return false;
    aimAt(game, a.x, a.y, a.z);
    return true;
  };
  game.injectInput = null;
  input.clearAll();
  input.enabled = true;
  input.pointerLocked = true;
  // 1. Held line, then held state cleared without a release edge (pause).
  r.clearPlanned = aimInAir();
  mouse('mousedown');
  for (let i = 0; i < 40; i++) game.manualTick();
  r.attachedBeforeClear = pl.rope.attached;
  input.clearAll();
  let e0 = game.eventLog.length;
  game.manualTick();
  r.releasedAfterClear = pl.mode !== MODE_SWING && events(e0).includes('release');
  for (let i = 0; i < 20; i++) game.manualTick();
  r.refiredAfterClear = events(e0).includes('webFire');
  mouse('mouseup');
  // 2. The same after the window loses focus.
  aimInAir();
  mouse('mousedown');
  for (let i = 0; i < 40; i++) game.manualTick();
  r.attachedBeforeBlur = pl.rope.attached;
  window.dispatchEvent(new Event('blur'));
  e0 = game.eventLog.length;
  game.manualTick();
  r.releasedAfterBlur = pl.mode !== MODE_SWING;
  mouse('mouseup');
  // 3. Press and release between two ticks: the line fires, then lets go as a tap.
  r.tapPlanned = aimInAir();
  e0 = game.eventLog.length;
  mouse('mousedown');
  mouse('mouseup');
  game.manualTick();
  r.subFrameFired = events(e0).includes('webFire');
  const vy = pl.vel.y;
  game.manualTick();
  r.subFrameLetGo = pl.mode !== MODE_SWING;
  r.subFrameLift = pl.vel.y - vy;
  input.clearAll();
  input.enabled = false;
  input.pointerLocked = false;
  // 4. Space while a line fired from the ground is in flight: jump, keep the line.
  const inp = emptyBotInput();
  const prev = emptyBotInput();
  const step = (): void => stepWithInput(game, inp, prev);
  pl.teleport(out.x, out.y, out.z);
  for (let i = 0; i < 20; i++) step();
  r.groundStart = pl.mode === MODE_GROUND;
  let planned = false;
  for (let k = 0; k < 16 && !planned; k++) {
    game.rig.setLook((k * Math.PI) / 8, 0.45);
    game.snapCamera();
    planned = planTarget(game, 0, a) && Math.hypot(a.x - pl.pos.x, a.y - pl.pos.y, a.z - pl.pos.z) > 20;
  }
  r.groundPlanned = planned;
  aimAt(game, a.x, a.y, a.z);
  e0 = game.eventLog.length;
  inp.swing = true;
  step();
  r.firedFromGround = pl.rope.firing && pl.rope.fromGround;
  inp.jump = true;
  step();
  inp.jump = false;
  r.jumpedInFlight = events(e0).includes('jump');
  r.lineKeptAfterSpace = pl.mode === MODE_SWING;
  for (let i = 0; i < 12 && !pl.rope.attached; i++) step();
  r.attachedAfterSpace = pl.rope.attached;
  inp.swing = false;
  step();
  // 5. Space while a line fired from a wall is in flight cuts it (no jump),
  // even clinging at the foot of the facade where the feet still have support.
  r.wallClung = false;
  r.wallPlanned = false;
  for (const b of game.layout.buildings) {
    if (b.height < 45) continue;
    const f = b.footprint;
    if (f.maxX - f.minX < 16) continue;
    const cx = (f.minX + f.maxX) / 2;
    if (!pl.findSafeSpot(cx, 0.6, f.maxZ + 0.5, out) || Math.abs(out.z - (f.maxZ + 0.5)) > 0.3 || out.y > 1) continue;
    Object.assign(inp, emptyBotInput());
    Object.assign(prev, inp);
    pl.teleport(out.x, out.y, out.z);
    game.rig.setLook(0, 0);
    game.snapCamera();
    for (let i = 0; i < 10; i++) step();
    // Lean into the facade with Shift held: cling with almost no run-up.
    Object.assign(inp, { moveY: 0.4, sprint: true });
    for (let i = 0; i < 30 && pl.mode !== MODE_WALL; i++) step();
    inp.moveY = 0;
    for (let i = 0; i < 12; i++) step();
    if (pl.mode !== MODE_WALL) continue;
    r.wallClung = true;
    let wallPlanned = false;
    for (let k = 0; k < 9 && !wallPlanned; k++) {
      game.rig.setLook(Math.PI + (k - 4) * 0.25, 0.45);
      game.snapCamera();
      wallPlanned = planTarget(game, 0, a) && Math.hypot(a.x - pl.pos.x, a.y - pl.pos.y, a.z - pl.pos.z) > 20;
    }
    if (!wallPlanned) continue;
    r.wallPlanned = true;
    aimAt(game, a.x, a.y, a.z);
    r.wallFeetHeight = pl.pos.y - out.y;
    e0 = game.eventLog.length;
    inp.swing = true;
    step();
    r.firedFromWall = pl.rope.firing && pl.rope.fromGround && !pl.rope.onGround;
    inp.jump = true;
    step();
    inp.jump = false;
    r.wallSpaceJumped = events(e0).includes('jump');
    r.wallSpaceCut = (pl.mode as number) !== MODE_SWING && !pl.rope.firing && !pl.rope.attached;
    inp.swing = false;
    Object.assign(inp, emptyBotInput());
    step();
    break;
  }
  return r;
}

/**
 * Release tricks end on landing: a strong release starts a trick, the hero
 * lands within the trick's time and jumps at once; the jump must not replay it.
 */
export function trickReplayTest(game: Game): Record<string, number | boolean> {
  const pl = game.player;
  const an = game.animator;
  const S_RELEASE = 9;
  const route = cityRoute(game);
  const out = new Vector3();
  pl.findSafeSpot(route[0]![0], 0.5, route[0]![1], out);
  const inp = emptyBotInput();
  const prev = emptyBotInput();
  const step = (): void => stepWithInput(game, inp, prev);
  pl.teleport(out.x, out.y, out.z);
  for (let i = 0; i < 20; i++) step();
  // Drop from 1 m with a good release (always a flip).
  pl.teleport(out.x, out.y + 1, out.z);
  an.onEvent({ type: 'release', good: true, broken: false, power: 1 });
  step();
  const trickStarted = an.state === S_RELEASE;
  let landTicks = 0;
  while (pl.mode !== MODE_GROUND && landTicks < 120) {
    step();
    landTicks++;
  }
  inp.jump = true;
  step();
  inp.jump = false;
  let replayed = false;
  for (let i = 0; i < 20; i++) {
    step();
    if (an.state === S_RELEASE) replayed = true;
  }
  return { trickStarted, landedMs: (landTicks * 1000) / 120, jumped: pl.airTime > 0 || pl.mode !== MODE_GROUND, replayed };
}

/**
 * Dynamic resolution on a vsync-locked 60 Hz display (every frame 16.7 ms):
 * a load spike lowers the scale to its floor, the scale returns to full once
 * the render cost drops, a cost inside the hysteresis band changes nothing,
 * and a GPU-bound cost that shrinks with the scale settles without hunting.
 * At a pixel ratio of 1.5 the floor is 0.5 (0.75 x the CSS pixels). A
 * marginal machine (fine one step lower, too slow at the next) backs off up
 * to 30 s between attempts, and a calm minute clears the back-off.
 */
export function dynResTest(game: Game): Record<string, number> {
  const post = game.post;
  const saved = { on: post.settings.dynamicResolution, max: post.settings.maxDynScale, pr: post.pixelRatio };
  post.settings.dynamicResolution = true;
  post.settings.maxDynScale = 1;
  post.pixelRatio = 1;
  const frames = (cost: (scale: number) => number, seconds: number): number => {
    let changes = 0;
    for (let i = 0; i < seconds * 60; i++) {
      const before = post.dynScale;
      post.stepDynamic(cost(post.dynScale), 16.7);
      if (post.dynScale !== before) changes++;
    }
    return changes;
  };
  // Settle first: a long calm period also clears any raise back-off from loading.
  frames(() => 5, 65);
  const start = post.dynScale;
  const floor = post.dynFloor;
  frames(() => 25, 3);
  const afterSpike = post.dynScale;
  let recoverFrames = 0;
  while (post.dynScale < 1 && recoverFrames < 60 * 30) {
    post.stepDynamic(5, 16.7);
    recoverFrames++;
  }
  const recovered = post.dynScale;
  const bandChanges = frames(() => 12, 10);
  frames((sc) => 20 * sc * sc, 20);
  const gpuBoundChanges = frames((sc) => 20 * sc * sc, 20);
  const gpuBoundScale = post.dynScale;
  frames(() => 5, 30);
  const end = post.dynScale;
  // HiDPI (pixel ratio 1.5): a long spike goes down to 0.75 x the CSS pixels.
  post.pixelRatio = 1.5;
  const hiDpiFloor = post.dynFloor;
  frames(() => 25, 8);
  const hiDpiAfterSpike = post.dynScale;
  frames(() => 5, 15);
  const hiDpiRecovered = post.dynScale;
  post.pixelRatio = 1;
  // Marginal machine: cheap enough at 0.85, too slow at 0.9. Each raise that
  // has to be undone doubles the hold, so attempts end up 30 s apart.
  const raises: number[] = [];
  for (let i = 0; i < 300 * 60; i++) {
    const before = post.dynScale;
    post.stepDynamic(post.dynScale > 0.875 ? 20 : 8, 16.7);
    if (post.dynScale > before) raises.push(i / 60);
  }
  let marginalMinGap = 1e9;
  for (let k = 1; k < raises.length; k++) if (raises[k - 1]! >= 150) marginalMinGap = Math.min(marginalMinGap, raises[k]! - raises[k - 1]!);
  const marginalRaises = raises.length;
  // A calm minute clears the back-off: the next spike recovers as fast as the first.
  frames(() => 5, 70);
  frames(() => 25, 3);
  let recoverAgainFrames = 0;
  while (post.dynScale < 1 && recoverAgainFrames < 60 * 40) {
    post.stepDynamic(5, 16.7);
    recoverAgainFrames++;
  }
  post.settings.dynamicResolution = saved.on;
  post.settings.maxDynScale = saved.max;
  post.pixelRatio = saved.pr;
  return {
    start,
    floor,
    afterSpike,
    recoverSeconds: recoverFrames / 60,
    recovered,
    bandChanges,
    gpuBoundScale,
    gpuBoundChanges,
    end,
    hiDpiFloor,
    hiDpiAfterSpike,
    hiDpiRecovered,
    marginalRaises,
    marginalMinGap,
    recoverAgainSeconds: recoverAgainFrames / 60,
  };
}

/**
 * Camera auto-follow: flying fast across the view with the mouse idle, the
 * yaw turns toward the travel direction; with the setting off it stays put.
 */
export function cameraFollowTest(game: Game): Record<string, number> {
  const pl = game.player;
  const L = game.layout;
  const x = (L.park.minX + L.park.maxX) / 2,
    z = L.pond.cz;
  const off = (): number => {
    const vy = Math.atan2(-pl.vel.x, -pl.vel.z);
    let d = vy - game.rig.yaw;
    d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
    return (Math.abs(d) * 180) / Math.PI;
  };
  const run = (follow: boolean): number => {
    const saved = game.rig.autoFollow;
    game.rig.autoFollow = follow;
    // Flying east at 30 m/s, looking north (90 degrees off), high above the park.
    pl.teleport(x, 160, z, 30, 0, 0);
    game.rig.setLook(0, -0.1);
    game.snapCamera();
    for (let i = 0; i < 240; i++) game.manualTick();
    game.rig.autoFollow = saved;
    return off();
  };
  return { startDeg: 90, afterTwoSecondsOn: run(true), afterTwoSecondsOff: run(false) };
}

// -----------------------------------------------------------------------------
// f. Character: planted feet never slide, limbs never clip into solid geometry
// -----------------------------------------------------------------------------

export function characterTest(game: Game): Record<string, number | string | boolean | Record<string, number>> {
  const pl = game.player;
  const an = game.animator;
  const L = game.layout;
  an.diagnostics = true;
  let steps = 0;
  an.onFootstep = () => {
    steps++;
  };
  // 1. Locomotion on an open avenue: idle, walk, run, sprint, curves, stops, zig-zags.
  const ave = L.avenues[2]!.center;
  const s0 = L.streets[L.streets.length - 2]!.center;
  const out = new Vector3();
  if (!pl.findSafeSpot(ave, 0.5, s0 - 30, out)) out.set(ave, 0.1, s0 - 30);
  pl.teleport(out.x, out.y, out.z);
  game.rig.setLook(0, -0.1);
  game.snapCamera();
  const inp = emptyBotInput();
  const prev = emptyBotInput();
  const phases: Array<[number, number, number, boolean, number]> = [
    // seconds, moveX, moveY, sprint, zigzag period
    [2, 0, 0, false, 0],
    [3, 0, 0.35, false, 0],
    [3, 0, 1, false, 0],
    [4, 0, 1, true, 0],
    [3, 0.6, 1, true, 0],
    [1.2, 0, 0, false, 0],
    [3, 0, 1, false, 0.5],
    [2, 0, 0, false, 0],
    [3, -0.8, 0.6, false, 0],
    [2, 0, 0, false, 0],
  ];
  const slideLog: string[] = [];
  let phaseIdx = 0;
  let slideMax = 0,
    slideSum = 0,
    slideFrames = 0,
    locoFrames = 0,
    nanBones = 0,
    groundTicks = 0;
  for (const [sec, mx, my, sprint, zz] of phases) {
    phaseIdx++;
    const n = Math.round(sec * 120);
    for (let i = 0; i < n; i++) {
      inp.moveX = zz > 0 ? (Math.floor(i / (zz * 120)) % 2 === 0 ? 1 : -1) * 0.8 : mx;
      inp.moveY = my;
      inp.sprint = sprint;
      inp.jump = false;
      inp.swing = false;
      inp.zip = false;
      stepWithInput(game, inp, prev);
      if (pl.mode === MODE_GROUND) groundTicks++;
      locoFrames++;
      slideMax = Math.max(slideMax, an.plantSlide);
      slideSum += an.plantSlide;
      if (an.plantSlide > 0.005) {
        slideFrames++;
        if (slideLog.length < 40) slideLog.push(`p${phaseIdx} i${i} ${(an.plantSlide * 1000).toFixed(0)}mm v${Math.hypot(pl.vel.x, pl.vel.z).toFixed(1)} ${MODE_NAMES[pl.mode]} s${an.state}`);
      }
      for (const b of game.hero.mesh.skeleton.bones) {
        const q = b.quaternion;
        if (!Number.isFinite(q.x + q.y + q.z + q.w)) nanBones++;
      }
    }
  }
  const locomotion = {
    seconds: locoFrames / 120,
    groundFraction: groundTicks / Math.max(1, locoFrames),
    footsteps: steps,
    maxSlidePerFrameMm: slideMax * 1000,
    totalSlideMm: slideSum * 1000,
    framesSliding: slideFrames,
    slideLog: slideLog.join(' | '),
  };
  // 2. Limb clipping while traversing the city, the park, climbing and zipping.
  const clip = { frames: 0, over3cm: 0, max: 0, joint: '' };
  const clipHist: Record<string, number> = {};
  const clipLog: string[] = [];
  const jp = new Vector3();
  const states = new Set<number>();
  const sample = (): boolean => {
    clip.frames++;
    states.add(an.state);
    const d = an.limbPenetration;
    if (d > 0.03) {
      clip.over3cm++;
      const k = `${an.limbPenetrationJoint}@${MODE_NAMES[pl.mode]}`;
      clipHist[k] = (clipHist[k] ?? 0) + 1;
      if (clipLog.length < 30) {
        const j = an.limbPenetrationJoint;
        if (j === 'handL' || j === 'handR') jp.copy(an.handPos[j === 'handL' ? 0 : 1]!);
        else game.hero.bones[j as 'head'].getWorldPosition(jp);
        const sup = game.world.supportHeight(jp.x, jp.z, jp.y + 0.5, 0.01);
        clipLog.push(
          `${k} ${(d * 100).toFixed(1)}cm j(${jp.x.toFixed(2)},${jp.y.toFixed(2)},${jp.z.toFixed(2)}) p(${pl.pos.x.toFixed(2)},${pl.pos.y.toFixed(2)},${pl.pos.z.toFixed(2)}) sup${sup.y.toFixed(2)}#${sup.id} st${an.state}`,
        );
      }
    }
    if (d > clip.max) {
      clip.max = d;
      clip.joint = `${an.limbPenetrationJoint}@${MODE_NAMES[pl.mode]}`;
    }
    for (const b of game.hero.mesh.skeleton.bones) {
      const q = b.quaternion;
      if (!Number.isFinite(q.x + q.y + q.z + q.w)) nanBones++;
    }
    return false;
  };
  traversalBot(game, 'city', cityRoute(game), 45, undefined, false, sample);
  traversalBot(game, 'park', parkRoute(game), 45, undefined, false, sample);
  // Wall climb and zip on a tall facade.
  const zipTarget = makeAnchorResult();
  let wallTicks = 0,
    zipTicks = 0;
  for (const b of L.buildings) {
    if (b.height < 45) continue;
    const f = b.footprint;
    if (f.maxX - f.minX < 16) continue;
    const cx = (f.minX + f.maxX) / 2;
    if (!pl.findSafeSpot(cx, 0.6, f.maxZ + 2.2, out) || Math.abs(out.z - (f.maxZ + 2.2)) > 0.5 || out.y > 1) continue;
    pl.teleport(out.x, out.y, out.z);
    game.rig.setLook(0, -0.05);
    game.snapCamera();
    Object.assign(inp, emptyBotInput(), { moveY: 1, sprint: true });
    for (let i = 0; i < 480; i++) {
      inp.moveX = Math.floor(i / 120) % 2 === 0 ? 0 : 0.7;
      stepWithInput(game, inp, prev);
      if (pl.mode === MODE_WALL) wallTicks++;
      sample();
    }
    break;
  }
  for (let k = 0; k < 4; k++) {
    // Let go, land and stand (the standing frames are sampled for the idle pose), then pull to a new point.
    Object.assign(inp, emptyBotInput());
    for (let i = 0; i < 110; i++) {
      stepWithInput(game, inp, prev);
      if (i >= 80 && pl.mode === MODE_GROUND) sample();
    }
    game.rig.setLook(game.rig.yaw + 1.1, 0.5);
    for (let i = 0; i < 4; i++) stepWithInput(game, inp, prev);
    aimForClick(game, 1, inp, zipTarget);
    stepWithInput(game, inp, prev);
    inp.zip = false;
    for (let i = 0; i < 150; i++) {
      stepWithInput(game, inp, prev);
      if (pl.mode === MODE_ZIP) zipTicks++;
      sample();
    }
  }
  // 3. Hard landing straight down onto the avenue: the crouch puts a hand on the ground.
  if (!pl.findSafeSpot(ave, 0.5, s0 - 30, out)) out.set(ave, 0.1, s0 - 30);
  pl.teleport(out.x, out.y + 14, out.z);
  game.rig.setLook(0, -0.1);
  game.snapCamera();
  Object.assign(inp, emptyBotInput());
  an.crouchPeak = 0;
  for (let i = 0; i < 300; i++) {
    stepWithInput(game, inp, prev);
    sample();
  }
  const crouchPeak = an.crouchPeak;
  an.diagnostics = false;
  an.onFootstep = null;
  const names = ['idle', 'run', 'air', 'swing', 'dive', 'zip', 'wall', 'traverse', 'roll', 'release'];
  return {
    ...locomotion,
    clipFrames: clip.frames,
    clipOver3cm: clip.over3cm,
    clipMaxCm: clip.max * 100,
    clipWorst: clip.joint,
    clipHist,
    clipLog: clipLog.join(' | '),
    wallTicks,
    zipTicks,
    nanBones,
    statesSeen: [...states].sort().map((i) => names[i]).join(','),
    crouchPeak,
    tricksSpread: an.tricks[0]!,
    tricksFlip: an.tricks[1]!,
    tricksTwist: an.tricks[2]!,
  };
}

// -----------------------------------------------------------------------------
// h. Ring races, traffic and pedestrians
// -----------------------------------------------------------------------------

export function ringTest(game: Game): Record<string, unknown> {
  const rings = game.rings;
  const pl = game.player;
  const w = game.world;
  const out: Record<string, unknown> = { routes: rings.routes.length, rings: rings.ringCount };
  // 1. Every ring is clear of geometry, the straight line to the next ring is open,
  //    and an anchor is available on the approach to each ring.
  const perRoute: Array<Record<string, number | string>> = [];
  const hit = makeRayHit();
  const target = makeAnchorResult();
  for (const r of rings.routes) {
    let clear = 0,
      lines = 0,
      anchors = 0,
      flags = '';
    for (let i = 0; i < r.rings.length; i++) {
      const g = r.rings[i]!;
      if (rings.clear(g.x, g.y, g.z)) clear++;
      if (i + 1 < r.rings.length) {
        const n = r.rings[i + 1]!;
        const dx = n.x - g.x,
          dy = n.y - g.y,
          dz = n.z - g.z;
        const d = Math.hypot(dx, dy, dz);
        if (!w.raycast(g.x, g.y, g.z, dx / d, dy / d, dz / d, d, hit, 0, -1, 1, true)) lines++;
      } else lines++;
      // Approach 20-30 m before the ring at 30 m/s along the route: is a swing
      // anchor available when looking ahead (or a little to either side)?
      let found = false;
      for (const back of [20, 30, 15, 40]) {
        for (const [dy, side] of [
          [-1, 0],
          [2, 0],
          [0, 6],
          [0, -6],
        ] as Array<[number, number]>) {
          const ax = g.x - g.nx * back - g.nz * side,
            ay = g.y + dy - 1.1,
            az = g.z - g.nz * back + g.nx * side;
          if (!w.capsuleFree(ax, ay, az, tuning.body.radius, tuning.body.height)) continue;
          for (const yawOff of [0, -0.35, 0.35]) {
            pl.teleport(ax, ay, az, g.nx * 30, 0, g.nz * 30);
            game.prevPos.copy(pl.pos);
            game.rig.setLook(Math.atan2(-g.nx, -g.nz) + yawOff, 0.35);
            game.snapCamera();
            const prev = emptyBotInput();
            for (let k = 0; k < 3; k++) stepWithInput(game, emptyBotInput(), prev);
            if (planTarget(game, 0, target)) {
              found = true;
              break;
            }
          }
          if (found) break;
        }
        if (found) break;
      }
      if (found) anchors++;
      flags += found ? '1' : '0';
    }
    perRoute.push({ id: r.id, rings: r.rings.length, clear, openLines: lines, anchorsOnApproach: anchors, anchorFlags: flags });
  }
  out.perRoute = perRoute;
  // 2. Race logic: fly each route kinematically through the ring centres.
  const fly = (route: number, speed: number): { events: string[]; time: number | null; newBest: boolean | null } => {
    const r = rings.routes[route]!;
    const events: string[] = [];
    let time: number | null = null,
      newBest: boolean | null = null;
    rings.onEvent = (e) => {
      events.push(e.type);
      if (e.type === 'finish') {
        time = e.time;
        newBest = e.newBest;
      }
    };
    const pts: Vector3[] = [];
    const g0 = r.rings[0]!;
    pts.push(new Vector3(g0.x - g0.nx * 20, g0.y - g0.ny * 20, g0.z - g0.nz * 20));
    for (const g of r.rings) pts.push(new Vector3(g.x, g.y, g.z));
    const gl = r.rings[r.rings.length - 1]!;
    pts.push(new Vector3(gl.x + gl.nx * 10, gl.y + gl.ny * 10, gl.z + gl.nz * 10));
    const dt = 1 / 120;
    const a = new Vector3(),
      b = new Vector3();
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i]!,
        q = pts[i + 1]!;
      const len = p.distanceTo(q);
      const steps = Math.max(1, Math.ceil(len / (speed * dt)));
      for (let k = 0; k < steps; k++) {
        a.lerpVectors(p, q, k / steps);
        b.lerpVectors(p, q, (k + 1) / steps);
        rings.check(a, b, dt);
      }
    }
    return { events, time, newBest };
  };
  const races: Array<Record<string, unknown>> = [];
  const savedHook = rings.onEvent;
  for (let r = 0; r < rings.routes.length; r++) {
    const first = fly(r, 30);
    const faster = fly(r, 45);
    const slower = fly(r, 20);
    races.push({
      id: rings.routes[r]!.id,
      passes: first.events.filter((e) => e === 'pass').length,
      finished: first.events.includes('finish'),
      time30: first.time,
      firstNewBest: first.newBest,
      time45: faster.time,
      fasterNewBest: faster.newBest,
      slowerNewBest: slower.newBest,
      best: rings.bestTime(rings.routes[r]!.id),
    });
  }
  out.races = races;
  rings.onEvent = savedHook;
  // 3. Abandoned run ends quietly.
  const g0 = rings.routes[0]!.rings[0]!;
  rings.check(new Vector3(g0.x - g0.nx, g0.y - g0.ny, g0.z - g0.nz), new Vector3(g0.x + g0.nx, g0.y + g0.ny, g0.z + g0.nz), 1 / 120);
  const started = rings.activeRoute;
  const far = new Vector3(0, 300, 0);
  for (let i = 0; i < 50 * 120; i++) rings.check(far, far, 1 / 120);
  out.abandon = { started, afterTimeout: rings.activeRoute, hud: rings.hud() };
  return out;
}

export function lifeTest(game: Game): Record<string, unknown> {
  const L = game.layout;
  const traffic = game.traffic;
  const peds = game.peds;
  const onRoad = (x: number, z: number): boolean =>
    L.avenues.some((a) => Math.abs(x - a.center) <= a.width / 2 + 0.5) || L.streets.some((s) => Math.abs(z - s.center) <= s.width / 2 + 0.5);
  const counts: Record<string, number> = {};
  for (let q = 0; q < 4; q++) {
    game.applyQuality(q);
    counts[`q${q}cars`] = traffic.count;
    counts[`q${q}peds`] = peds.count;
  }
  game.applyQuality(1);
  const pos: Array<[number, number]> = [];
  let offRoad = 0,
    nan = 0,
    samples = 0,
    stoppedMax = 0,
    turningMax = 0,
    speedSum = 0;
  const p = game.player.pos;
  for (let i = 0; i < 60 * 30; i++) {
    traffic.update(1 / 30, p.x, p.z);
    peds.update(1 / 30, p.x, p.z);
    if (i % 30 === 0) {
      traffic.positions(pos);
      for (const [x, z] of pos) {
        samples++;
        if (!Number.isFinite(x + z)) nan++;
        else if (!onRoad(x, z)) offRoad++;
      }
      const st = traffic.stats();
      stoppedMax = Math.max(stoppedMax, st.stopped);
      turningMax = Math.max(turningMax, st.turning);
      speedSum += st.meanSpeed;
    }
  }
  // Pedestrians stand on sidewalks or park paths, never on the carriageway.
  let pedOnRoad = 0;
  const m = new Matrix4(),
    v = new Vector3();
  for (let i = 0; i < peds.count; i++) {
    peds.mesh.getMatrixAt(i, m);
    v.setFromMatrixPosition(m);
    const inPark = v.x > L.park.minX && v.x < L.park.maxX && v.z > L.park.minZ && v.z < L.park.maxZ;
    if (!inPark && v.y < 0.1) pedOnRoad++;
  }
  return {
    ...counts,
    nodes: traffic.nodeCount,
    links: traffic.linkCount,
    loops: peds.loopCount,
    carSamples: samples,
    carsOffRoad: offRoad,
    carNaN: nan,
    maxStoppedAtOnce: stoppedMax,
    maxTurningAtOnce: turningMax,
    meanSpeed: speedSum / 60,
    pedsOnRoad: pedOnRoad,
    peds: peds.count,
  };
}

// -----------------------------------------------------------------------------
// e. Soak: one simulated minute of mixed play per call
// -----------------------------------------------------------------------------

const soakPixel = new Uint8Array(4);

export function soakMinute(game: Game, app: App | undefined, minute: number): Record<string, number> {
  const TICKS = 7200;
  let ticks = 0;
  const hook = (): boolean => {
    ticks++;
    if (ticks % 4 === 0) game.updateLife(4 / 120);
    if (ticks % 480 === 0) game.renderOnce();
    return ticks >= TICKS;
  };
  // Time of day and quality churn (a quality switch recompiles shaders, so only twice).
  game.dayNight.setHour((minute * 2.7 + 6) % 24);
  const qualitySwitch = minute % 10 === 9;
  if (qualitySwitch) game.applyQuality(Math.floor(minute / 10) % 2 === 0 ? 0 : 2);
  // Menu, pause and photo-mode churn through the real shell.
  if (app) {
    app.ui.showPause();
    app.ui.showSettings();
    app.ui.showControls();
    app.ui.hideMenus();
    app.ui.toast('soak');
    app.state = 'playing';
    app.enterPhoto();
    game.renderOnce();
    app.exitPhoto();
    app.ui.showClickToResume(false);
    game.view = 'play';
    game.playing = true;
  }
  // Attract mode behind the menu (10 simulated seconds) and a full rooftop-moment cycle (rain in, any input, back).
  if (app) {
    game.view = 'menu';
    const at = game.attract;
    for (let i = 0; i < 1200; i++) {
      at.tick(game.loop.dt);
      if (i % 2 === 1) at.frame(1, game.loop.dt * 2, game.rig.camera);
      if (i % 480 === 0) game.renderOnce();
    }
    game.view = 'play';
    // HUD off: 720 app frames would redraw the minimap canvas each time (GPU work the soak does not need).
    app.ui.setHudVisible(false);
    momentRoof(game);
    // The soak's minutes of swinging run outside the app frames that count play
    // time and movement for the moment's arming gate: count them here.
    app.moment.sinceSpawn = Math.max(app.moment.sinceSpawn, tuning.moment.minPlaySeconds);
    app.moment.usedLine = true;
    const still = emptyBotInput(),
      prevStill = emptyBotInput();
    momentFrames(game, app, still, prevStill, 8, 0, 4);
    game.input.activity++;
    momentFrames(game, app, still, prevStill, 4, 0, 4);
  }
  const kind = minute % 5;
  if (kind === 0) traversalBot(game, 'city', cityRoute(game), 60, undefined, false, hook);
  else if (kind === 2) traversalBot(game, 'park', parkRoute(game), 60, undefined, false, hook);
  else if (kind === 3) {
    // Ring runs (kinematic) then free swinging across the city.
    ringTest(game);
    traversalBot(game, 'city', cityRoute(game), 60, undefined, false, hook);
  }
  // Random-input fuzz fills the rest of the simulated minute.
  let k = 0;
  while (ticks < TICKS) {
    fuzz(game, 1000 + minute * 31 + k++, 2);
    ticks += 240;
    game.updateLife(0.5);
    if (k % 2 === 0) game.renderOnce();
  }
  if (qualitySwitch) game.applyQuality(1);
  // Wait for the GPU to finish this minute's frames, so software GL never builds up a backlog.
  const gl = game.renderer.getContext();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, soakPixel);
  const info = game.renderer.info;
  return {
    ticks,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs?.length ?? 0,
  };
}

// -----------------------------------------------------------------------------
// b2. Tunnelling: 95 m/s head-on into thin posts and walls never passes through
// -----------------------------------------------------------------------------

export function tunnelTest(game: Game, trials: number): Record<string, number> {
  const rng = new Rng(4242);
  const w = game.world;
  const pl = game.player;
  const R = tuning.body.radius;
  let tried = 0,
    tunneled = 0,
    inside = 0,
    posts = 0,
    walls = 0;
  const prev = emptyBotInput();
  for (let attempt = 0; attempt < trials * 20 && tried < trials; attempt++) {
    const id = rng.int(0, w.count - 1);
    const kind = w.kind[id]!;
    const o = id * 6;
    let cx: number, cz: number, y0: number, y1: number, half: number;
    if (kind === CYL) {
      cx = w.p[o]!;
      y0 = w.p[o + 1]!;
      cz = w.p[o + 2]!;
      y1 = w.p[o + 3]!;
      half = w.p[o + 4]!;
      if (half > 0.6 || y1 - y0 < 2.5) continue;
    } else if (kind === BOX) {
      cx = (w.p[o]! + w.p[o + 3]!) / 2;
      cz = (w.p[o + 2]! + w.p[o + 5]!) / 2;
      y0 = w.p[o + 1]!;
      y1 = w.p[o + 4]!;
      half = Math.min(w.p[o + 3]! - w.p[o]!, w.p[o + 5]! - w.p[o + 2]!) / 2;
      if (y1 - y0 < 4 || half > 30) continue;
    } else continue;
    const a = rng.float() * Math.PI * 2;
    const dx = Math.cos(a),
      dz = Math.sin(a);
    // Start outside along -d, aimed at the collider's axis, mid-height.
    const startDist = (kind === CYL ? half : Math.max(w.p[o + 3]! - w.p[o]!, w.p[o + 5]! - w.p[o + 2]!) * 0.75) + R + 3;
    const sx = cx - dx * startDist,
      sz = cz - dz * startDist;
    const sy = Math.max(y0 + 0.5, Math.min(y1 - 2.2, y0 + 1));
    if (!w.capsuleFree(sx, sy, sz, R, tuning.body.height)) continue;
    tried++;
    if (kind === CYL) posts++;
    else walls++;
    pl.teleport(sx, sy, sz, dx * 95, 0, dz * 95);
    game.prevPos.copy(pl.pos);
    let passed = false;
    for (let k = 0; k < 24; k++) {
      stepWithInput(game, emptyBotInput(), prev);
      if (w.capsulePenetration(pl.pos.x, pl.pos.y, pl.pos.z, R, tuning.body.height) > 0.05) inside++;
      // Through the collider: beyond its far side while still within its lateral extent.
      const along = (pl.pos.x - cx) * dx + (pl.pos.z - cz) * dz;
      const lateral = Math.abs(-(pl.pos.x - cx) * dz + (pl.pos.z - cz) * dx);
      if (kind === CYL ? along > half + R && lateral < half : w.capsulePenetration(pl.pos.x, pl.pos.y, pl.pos.z, R * 0.2, 0.2) > 0.3) passed = true;
      if (pl.pos.y < y0 - 0.5 || pl.pos.y > y1) break;
    }
    if (passed) tunneled++;
  }
  return { tried, posts, walls, tunneled, insideTicks: inside };
}

// -----------------------------------------------------------------------------
// M9. Attract mode (menu autopilot) and the rooftop moment
// -----------------------------------------------------------------------------

/**
 * Runs the menu's attract mode headless for `seconds` of simulation (the
 * director films every second tick, as at 60 fps) and checks the hero and
 * the camera: stuck, water, below ground, inside geometry, NaN, ground time,
 * distance, swings and variety; camera inside geometry, hero in frame.
 */
export function attractTest(game: Game, seconds: number, seed = 1): Record<string, unknown> {
  const at = game.attract;
  at.restart(seed);
  const pl = at.player;
  const ap = at.autopilot;
  const w = game.world;
  const terr = w.terrain;
  const dt = game.loop.dt;
  const cam = game.rig.camera;
  const r = tuning.body.radius,
    h = tuning.body.height;
  const ticks = Math.round(seconds * 120);
  const start = { ...pl.stats };
  const apStart = { ...ap.stats };
  const swings0 = ap.brain.swings,
    good0 = ap.brain.goodReleases;
  const ds = at.director.stats;
  const dir0 = { cuts: ds.cuts, blends: ds.blends, shots: ds.shots.slice() };
  const anchor = new Vector3().copy(pl.pos);
  const last = new Vector3().copy(pl.pos);
  const chest = new Vector3();
  const ndc = new Vector3();
  const hit = makeRayHit();
  let noProgress = 0,
    maxNoProgress = 0,
    stuckOver3s = 0,
    inWater = 0,
    belowGround = 0,
    inside = 0,
    maxPen = 0,
    nan = 0,
    groundTicks = 0,
    perchTicks = 0,
    distance = 0,
    frames = 0,
    camInside = 0,
    maxCamPen = 0,
    inFrame = 0,
    occluded = 0,
    maxSpeed = 0;
  const kinds = [0, 0, 0];
  const modeTicks: Record<string, number> = {};
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) {
    at.tick(dt);
    const p = pl.pos;
    if (!Number.isFinite(p.x + p.y + p.z + pl.vel.x + pl.vel.y + pl.vel.z)) nan++;
    if (terr.isWater(p.x, p.z) && p.y < terr.waterLevelAt(p.x, p.z) + 0.05) inWater++;
    if (!terr.isWater(p.x, p.z) && p.y < terr.height(p.x, p.z) - 0.03) belowGround++;
    const pen = w.capsulePenetration(p.x, p.y, p.z, r, h);
    if (pen > maxPen) maxPen = pen;
    if (pen > 0.03) inside++;
    const mn = MODE_NAMES[pl.mode]!;
    modeTicks[mn] = (modeTicks[mn] ?? 0) + 1;
    if (ap.perching) perchTicks++;
    else if (pl.mode === MODE_GROUND) groundTicks++;
    const step = p.distanceTo(last);
    if (step < 5) distance += step;
    last.copy(p);
    maxSpeed = Math.max(maxSpeed, pl.speed);
    if (i % 120 === 0) kinds[ap.goal.kind]!++;
    // Stuck: no 0.3 m of movement for 3 s while not perching on purpose.
    if (p.distanceTo(anchor) > 0.3 || ap.perching) {
      anchor.copy(p);
      noProgress = 0;
    } else {
      noProgress += dt;
      maxNoProgress = Math.max(maxNoProgress, noProgress);
      if (noProgress > 3) {
        stuckOver3s++;
        noProgress = 0;
      }
    }
    if (i % 2 === 1) {
      at.frame(1, dt * 2, cam);
      frames++;
      const cp = cam.position;
      const cpen = w.spherePenetration(cp.x, cp.y, cp.z, 0.2);
      if (cpen > maxCamPen) maxCamPen = cpen;
      if (cpen > 0.02) camInside++;
      chest.set(at.renderPos.x, at.renderPos.y + 1.1, at.renderPos.z);
      ndc.copy(chest).project(cam);
      if (ndc.z < 1 && Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1) inFrame++;
      const dx = chest.x - cp.x,
        dy = chest.y - cp.y,
        dz = chest.z - cp.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 1 && w.raycast(cp.x, cp.y, cp.z, dx / d, dy / d, dz / d, d - 0.8, hit, 0, -1, 0, false, F_CAMERA)) occluded++;
    }
  }
  const msPerTick = (performance.now() - t0) / ticks;
  const air = ticks - perchTicks;
  const st = ap.stats;
  return {
    seconds,
    msPerTick,
    stuckOver3s,
    maxNoProgress,
    splashes: pl.stats.splashes - start.splashes,
    inWater,
    belowGround,
    insideGeometry: inside,
    maxPenetration: maxPen,
    nan,
    groundFraction: groundTicks / Math.max(1, air),
    perchFraction: perchTicks / ticks,
    distance,
    avgSpeed: distance / seconds,
    maxSpeed,
    swings: ap.brain.swings - swings0,
    swingsPerMinute: ((ap.brain.swings - swings0) * 60) / seconds,
    goodReleases: ap.brain.goodReleases - good0,
    legs: st.legs - apStart.legs,
    zips: st.zips - apStart.zips,
    wallRuns: st.wallRuns - apStart.wallRuns,
    dives: st.dives - apStart.dives,
    perches: st.perches - apStart.perches,
    reroutes: st.reroutes - apStart.reroutes,
    rescues: st.rescues - apStart.rescues,
    recoveries: pl.stats.recoveries - start.recoveries,
    goalKindSeconds: { roof: kinds[0], park: kinds[1], waterfront: kinds[2] },
    modeTicks,
    camera: {
      frames,
      inside: camInside,
      maxPenetration: maxCamPen,
      heroInFrame: inFrame / Math.max(1, frames),
      occluded: occluded / Math.max(1, frames),
      cuts: ds.cuts - dir0.cuts,
      blends: ds.blends - dir0.blends,
      shots: Object.fromEntries(SHOT_NAMES.map((n, i) => [n, ds.shots[i]! - dir0.shots[i]!])),
    },
  };
}

/** A big, mid-height roof to stand on for the rooftop-moment test: feet position and street height below. */
export function momentRoof(game: Game): Record<string, number> {
  const pl = game.player;
  const out = new Vector3();
  let best: { x: number; y: number; z: number; area: number } | null = null;
  for (const b of game.layout.buildings) {
    const v = b.volumes[b.volumes.length - 1]!;
    const area = (v.maxX - v.minX) * (v.maxZ - v.minZ);
    if (v.maxY < 25 || v.maxY > 90 || area < 600) continue;
    if (!best || area > best.area) best = { x: (v.minX + v.maxX) / 2, y: v.maxY, z: (v.minZ + v.maxZ) / 2, area };
  }
  if (!best || !pl.findSafeSpot(best.x, best.y + 1, best.z, out)) throw new Error('no roof for the moment test');
  pl.teleport(out.x, out.y, out.z);
  game.prevPos.copy(pl.pos);
  game.snapCamera();
  return { x: out.x, y: out.y, z: out.z, street: game.world.terrain.height(out.x, out.z) };
}

/** Rooftop-moment state for the tests. */
export function momentState(game: Game, app: App): Record<string, unknown> {
  const m = app.moment;
  return {
    phase: m.phase,
    idleT: m.idleT,
    savedHour: m.savedHour,
    hour: game.dayNight.hour,
    hold: game.dayNight.hold,
    rain: game.weather.rain,
    rainVisible: game.rain.mesh.visible,
    mood: game.weather.mood,
    storm: game.dayNight.storm,
    orbit: game.cineOrbit,
    perch: game.animator.perch,
    music: m.music,
    musicPresence: app.audio.musicPresence,
    musicMuted: app.audio.musicMuted,
    cinematic: app.ui.cinematic,
    rootCine: document.querySelector('.sk-ui')?.classList.contains('sk-cine') ?? false,
    starts: m.stats.starts,
    ends: m.stats.ends,
    bolts: m.stats.bolts,
    onRoof: m.stillOnRoof(),
    ready: m.ready,
    sinceSpawn: m.sinceSpawn,
    travelled: m.travelled,
    usedLine: m.usedLine,
    hourTaken: m.hourTaken,
    flash: game.weather.flash,
    camDist: game.rig.camera.position.distanceTo(new Vector3(game.renderPos.x, game.renderPos.y + 1.2, game.renderPos.z)),
    mode: MODE_NAMES[game.player.mode],
    speed: game.player.speed,
    pos: [game.player.pos.x, game.player.pos.y, game.player.pos.z],
  };
}

/**
 * Plays `seconds` of the game as 60 fps frames (two ticks with the held test
 * input, then the app's frame update), the way the real loop drives the
 * rooftop moment, rendering one frame every `renderEvery` simulated seconds.
 * `sample` > 0 records the state every `sample` seconds.
 */
export function momentFrames(game: Game, app: App, inp: BotInput, prev: BotInput, seconds: number, sample = 0, renderEvery = 1): Record<string, unknown> {
  const frames = Math.round(seconds * 60);
  const samples: Array<Record<string, unknown>> = [];
  let maxPhase = 'idle';
  const order = ['idle', 'arming', 'in', 'active', 'out'];
  const frame = (app as unknown as { frame(dt: number): void }).frame.bind(app);
  for (let f = 0; f < frames; f++) {
    stepWithInput(game, inp, prev);
    stepWithInput(game, inp, prev);
    frame(1 / 60);
    // A rendered frame every `renderEvery` simulated seconds (software GL is slow); the last frame always renders.
    if (f % Math.round(renderEvery * 60) === Math.round(renderEvery * 60) - 1 || f === frames - 1) game.renderFrame(1 / 60);
    if (order.indexOf(app.moment.phase) > order.indexOf(maxPhase)) maxPhase = app.moment.phase;
    if (sample > 0 && f % Math.max(1, Math.round(sample * 60)) === 0) samples.push(momentState(game, app));
  }
  return { ...momentState(game, app), maxPhase, samples };
}

// -----------------------------------------------------------------------------
// k. Touch controls: places for the touch spec (the real-time loop keeps running)
// -----------------------------------------------------------------------------

/**
 * Puts the hero where a touch control can be measured: on an avenue with a
 * long straight run ahead (yaw 0 looks along it), in front of a tall facade
 * (yaw 0 faces it), or high in the air above an avenue.
 */
export function touchSpot(game: Game, kind: 'avenue' | 'wall' | 'air'): Record<string, number> | null {
  const pl = game.player;
  const L = game.layout;
  const out = new Vector3();
  const place = (x: number, y: number, z: number, yaw: number, pitch: number): Record<string, number> => {
    pl.teleport(x, y, z);
    game.prevPos.copy(pl.pos);
    game.rig.setLook(yaw, pitch);
    game.snapCamera();
    return { x, y, z };
  };
  if (kind === 'wall') {
    for (const b of L.buildings) {
      if (b.height < 45) continue;
      const f = b.footprint;
      if (f.maxX - f.minX < 16) continue;
      const cx = (f.minX + f.maxX) / 2;
      if (!pl.findSafeSpot(cx, 0.6, f.maxZ + 2.2, out) || Math.abs(out.z - (f.maxZ + 2.2)) > 0.5 || out.y > 1) continue;
      return place(out.x, out.y, out.z, 0, -0.05);
    }
    return null;
  }
  // The avenue nearest the middle of the land, its middle point.
  const mx = (L.land.minX + L.land.maxX) / 2;
  const mz = (L.land.minZ + L.land.maxZ) / 2;
  let ave = L.avenues[0]!;
  for (const a of L.avenues) if (!a.perimeter && Math.abs(a.center - mx) < Math.abs(ave.center - mx)) ave = a;
  if (kind === 'air') return place(ave.center, 90, mz, 0, -0.1);
  if (!pl.findSafeSpot(ave.center, 1, mz + 60, out)) return null;
  return place(out.x, out.y, out.z, 0, 0);
}
