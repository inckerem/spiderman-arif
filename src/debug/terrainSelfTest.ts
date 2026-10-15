import { Rng } from '../core/rng';
import { HeightfieldTerrain } from '../physics/heightfield';
import { RoadIndex, type RoadSegment } from '../physics/roadIndex';
import { makeTerrainHit } from '../physics/terrain';
import { WaterMask } from '../physics/waterMask';
import { IST_EXTENT, LAND_POLYGONS, MAX_SLOPE } from '../maps/istanbul/data';
import { bakeIstanbulHeights, maxLandSlope } from '../maps/istanbul/terrain';

/**
 * In-page check of the heightfield terrain (M13 C4), built from the
 * Istanbul land polygons and hills: fast rays against a brute-force 5 cm
 * march, the bucketed water mask against plain point-in-polygon, the road
 * index against a plain segment scan, the slope limit and nearestLand.
 */
export function terrainSelfTest(rays = 20000, points = 100000, seed = 7): Record<string, number> {
  const rng = new Rng(seed);
  const E = IST_EXTENT;
  const t0 = performance.now();
  const mask = new WaterMask(LAND_POLYGONS, E);
  const t1 = performance.now();
  const grid = bakeIstanbulHeights(mask, E);
  const t2 = performance.now();
  // A few random roads for the road index check.
  const segs: RoadSegment[] = [];
  for (let i = 0; i < 300; i++) {
    const ax = rng.range(E.minX, E.maxX),
      az = rng.range(E.minZ, E.maxZ);
    const a = rng.range(0, Math.PI * 2),
      l = rng.range(10, 200);
    segs.push({ ax, az, bx: ax + Math.cos(a) * l, bz: az + Math.sin(a) * l, width: rng.range(6, 24) });
  }
  const roads = new RoadIndex(segs, E);
  const terr = new HeightfieldTerrain(grid, mask, new RoadIndex([], E));

  // Water mask vs plain point-in-polygon.
  let waterMismatch = 0,
    waterPts = 0;
  const tm0 = performance.now();
  for (let i = 0; i < points; i++) {
    const x = rng.range(E.minX, E.maxX),
      z = rng.range(E.minZ, E.maxZ);
    if (mask.isWater(x, z) !== !mask.insideBrute(x, z)) waterMismatch++;
    if (mask.isWater(x, z)) waterPts++;
  }
  const tm1 = performance.now();
  let roadMismatch = 0;
  for (let i = 0; i < 20000; i++) {
    const x = rng.range(E.minX, E.maxX),
      z = rng.range(E.minZ, E.maxZ);
    if (roads.isRoad(x, z) !== roads.isRoadBrute(x, z)) roadMismatch++;
  }

  // Rays vs brute force.
  const hit = makeTerrainHit();
  let hits = 0,
    waterHits = 0,
    hitMismatch = 0,
    tMismatch = 0,
    maxErr = 0,
    fastMs = 0;
  const STEP = 0.05;
  for (let i = 0; i < rays; i++) {
    const ox = rng.range(E.minX + 50, E.maxX - 50),
      oz = rng.range(E.minZ + 50, E.maxZ - 50);
    const oy = terr.baseHeight(ox, oz) + rng.range(0.3, rng.chance(0.3) ? 120 : 25);
    const yaw = rng.range(0, Math.PI * 2);
    const pitch = rng.chance(0.2) ? rng.range(-0.05, 0.35) : rng.range(-1.5, -0.02);
    const dx = Math.cos(pitch) * Math.cos(yaw),
      dy = Math.sin(pitch),
      dz = Math.cos(pitch) * Math.sin(yaw);
    const maxT = rng.range(20, 160);
    const inflate = rng.chance(0.3) ? 0.35 : 0;
    const f0 = performance.now();
    const ok = terr.rayIntersect(ox, oy, oz, dx, dy, dz, maxT, inflate, hit);
    fastMs += performance.now() - f0;
    // Brute force: first sample below the (inflated) ground on land, or at the water surface over water.
    let bt = Infinity,
      above = false;
    for (let t = 0; t < maxT; t += STEP) {
      const x = ox + dx * t,
        y = oy + dy * t,
        z = oz + dz * t;
      const g = y - inflate - terr.baseHeight(x, z);
      if (dy < -1e-9 && y <= terr.waterLevel + inflate && mask.isWater(x, z)) {
        bt = t;
        break;
      }
      if (g > 0) above = true;
      else if (above && !mask.isWater(x, z)) {
        bt = t;
        break;
      }
    }
    const bok = bt < Infinity;
    if (ok) {
      hits++;
      if (hit.water) waterHits++;
    }
    if (ok !== bok) {
      // A crossing within one brute-force step of maxT may fall on either side.
      if (!(Math.abs((ok ? hit.t : bt) - maxT) < 0.1)) hitMismatch++;
      continue;
    }
    if (ok) {
      const err = Math.abs(hit.t - bt);
      if (err > maxErr) maxErr = err;
      if (err > 0.1) tMismatch++;
    }
  }

  // nearestLand from water points: on land, near a shore.
  let respawnBad = 0,
    respawnTries = 0;
  const spot = { x: 0, z: 0 };
  const shore = { x: 0, z: 0 };
  for (let i = 0; i < 4000 && respawnTries < 1000; i++) {
    const x = rng.range(-760, 980),
      z = rng.range(-960, 860);
    if (!mask.isWater(x, z)) continue;
    respawnTries++;
    terr.nearestLand(x, z, spot);
    const d = mask.nearestShore(spot.x, spot.z, shore);
    if (mask.isWater(spot.x, spot.z) || d > 30) respawnBad++;
  }

  const isWaterVertex = (i: number, j: number): boolean => mask.isWater(grid.x0 + i * grid.cell, grid.z0 + j * grid.cell);
  const slope = maxLandSlope(grid, isWaterVertex);
  return {
    rays,
    hits,
    waterHits,
    hitMismatch,
    tMismatch,
    maxErr,
    usPerRay: (fastMs * 1000) / rays,
    points,
    waterFraction: waterPts / points,
    waterMismatch,
    usPerWaterQuery: ((tm1 - tm0) * 1000) / (points * 2),
    roadMismatch,
    respawnTries,
    respawnBad,
    maxSlope: slope,
    slopeLimit: MAX_SLOPE,
    maxHeight: terr.maxY,
    maskMs: t1 - t0,
    bakeMs: t2 - t1,
  };
}
