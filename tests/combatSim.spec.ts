import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Vector3 } from 'three';
import { saveResult } from './helpers';
import { generateCity } from '../src/world/cityGen';
import { buildCollisionWorld } from '../src/world/cityCollision';
import { F_BUILDING } from '../src/physics/collision';
import { findRespawnRoof } from '../src/physics/safeSpot';
import { tuning } from '../src/config/tuning';
import { AR, AR_NAMES, arenaSuits, arenaTypesFor, buildSpawnPoints, spotFree } from '../src/combat/spawnPoints';
import { EK } from '../src/combat/types';

// Node-side combat checks (no page): spawn points, respawn roofs and the
// import purity of the code that must also run on the Node server.

const SEED = 1337;
const root = resolve(process.cwd());

function buildWorld(seed = SEED) {
  const layout = generateCity(seed);
  const world = buildCollisionWorld(layout);
  return { layout, world };
}

test('combat: spawn points and respawn roofs @quick', () => {
  const t0 = Date.now();
  const { layout, world } = buildWorld();
  const tWorld = Date.now() - t0;
  const t1 = Date.now();
  const sp = buildSpawnPoints(layout, world);
  const tSpawn = Date.now() - t1;
  const counts: Record<string, number> = {};
  for (let t = 0; t < AR_NAMES.length; t++) counts[AR_NAMES[t]!] = sp.byType[t]!.length;

  // Every spot stands on its arena's surface, inside the arena, with room for the largest regular enemy.
  let spots = 0,
    bad = 0;
  for (const a of sp.arenas) {
    expect(a.spots.length % 3).toBe(0);
    expect(a.spots.length).toBeGreaterThanOrEqual(8 * 3);
    for (let i = 0; i < a.spots.length; i += 3) {
      const x = a.spots[i]!,
        y = a.spots[i + 1]!,
        z = a.spots[i + 2]!;
      spots++;
      const s = world.supportHeight(x, z, y + 1, 0);
      const inside = x >= a.rect.minX - 0.5 && x <= a.rect.maxX + 0.5 && z >= a.rect.minZ - 0.5 && z <= a.rect.maxZ + 0.5;
      if (!spotFree(world, x, y, z) || Math.abs(s.y - y) > 0.06 || Math.abs(y - a.y) > 0.06 || !inside) bad++;
    }
  }
  // Patrol loop corners are on the sidewalk and clear.
  let loopBad = 0;
  for (const l of sp.loops) {
    for (let k = 0; k < 4; k++) {
      const x = l.pts[k * 2]!,
        z = l.pts[k * 2 + 1]!;
      if (!world.capsuleFree(x, l.y + 0.02, z, 0.45, 1.8)) loopBad++;
    }
    expect(l.total).toBeGreaterThan(20);
  }
  // Each event type and boss has somewhere to happen.
  const suits = (type: 'robbery' | 'gang' | 'drones' | 'boss', boss = -1) =>
    arenaTypesFor(type, boss).reduce((n, t) => n + sp.byType[t]!.filter((id) => arenaSuits(sp.arenas[id]!, type, boss)).length, 0);
  const forEvent = {
    robbery: suits('robbery'),
    gang: suits('gang'),
    drones: suits('drones'),
    kocbasi: suits('boss', EK.KOCBASI),
    kuzgun: suits('boss', EK.KUZGUN),
    diken: suits('boss', EK.DIKEN),
  };
  // Deterministic: a second build gives the same data.
  const sp2 = buildSpawnPoints(layout, world);
  const sameAgain = JSON.stringify(sp2.arenas.map((a) => [a.type, a.x, a.z, Array.from(a.spots)])) === JSON.stringify(sp.arenas.map((a) => [a.type, a.x, a.z, Array.from(a.spots)]));

  // Respawn roofs from points spread over the island.
  const out = new Vector3();
  const roofs: Array<{ from: [number, number]; ok: boolean; y: number; d: number; building: boolean; free: boolean }> = [];
  const L = layout.land;
  for (let i = 0; i < 12; i++) {
    const x = L.minX + 60 + ((L.maxX - L.minX - 120) * ((i * 7) % 12)) / 11;
    const z = L.minZ + 60 + ((L.maxZ - L.minZ - 120) * i) / 11;
    const ok = findRespawnRoof(world, layout, x, z, out);
    const s = world.supportHeight(out.x, out.z, out.y + 0.5, 0);
    roofs.push({
      from: [Math.round(x), Math.round(z)],
      ok,
      y: out.y,
      d: Math.hypot(out.x - x, out.z - z),
      building: s.id >= 0 && (world.flags[s.id]! & F_BUILDING) !== 0,
      free: world.capsuleFree(out.x, out.y, out.z, tuning.body.radius, tuning.body.height),
    });
  }
  // `avoid` is honoured.
  const ax = (L.minX + L.maxX) / 2,
    az = (L.minZ + L.maxZ) / 2;
  findRespawnRoof(world, layout, ax, az, out);
  const first = out.clone();
  const avoidOk = findRespawnRoof(world, layout, ax, az, out, { avoid: (x, z) => Math.hypot(x - first.x, z - first.z) < 30 });
  const avoidDist = Math.hypot(out.x - first.x, out.z - first.z);

  const r = { tWorldMs: tWorld, tSpawnMs: tSpawn, arenas: sp.arenas.length, counts, spots, bad, loops: sp.loops.length, blocks: layout.blocks.length, loopBad, forEvent, sameAgain, roofs, avoidOk, avoidDist };
  saveResult('combat-spawn', r);
  console.log('combat spawn points', JSON.stringify({ ...r, roofs: undefined }));
  expect(bad).toBe(0);
  expect(loopBad).toBe(0);
  expect(sameAgain).toBe(true);
  expect(counts.storefront).toBeGreaterThanOrEqual(20);
  expect(counts.intersection).toBeGreaterThanOrEqual(20);
  expect(counts.roof).toBeGreaterThanOrEqual(20);
  expect(counts.avenue).toBeGreaterThanOrEqual(10);
  expect(counts.park! + counts.pier!).toBeGreaterThanOrEqual(3);
  expect(sp.loops.length).toBeGreaterThanOrEqual(layout.blocks.length * 0.5);
  for (const [k, n] of Object.entries(forEvent)) expect(n, k).toBeGreaterThanOrEqual(1);
  for (const rf of roofs) {
    expect(rf.ok, JSON.stringify(rf)).toBe(true);
    expect(rf.building, JSON.stringify(rf)).toBe(true);
    expect(rf.free, JSON.stringify(rf)).toBe(true);
    expect(rf.y).toBeGreaterThanOrEqual(tuning.combat.respawnRoofMinY);
    expect(rf.y).toBeLessThanOrEqual(tuning.combat.respawnRoofMaxY + 0.1);
    expect(rf.d).toBeGreaterThanOrEqual(tuning.combat.respawnRoofMin - 15);
  }
  expect(avoidOk).toBe(true);
  expect(avoidDist).toBeGreaterThanOrEqual(30);
  void AR;
});

// --- Purity: the combat sim (and the shared room/protocol code) must run on the Node server ---

/** Modules the pure set may import (besides itself), relative to the repo root. */
const ALLOWED = [
  /^src\/config\/tuning\.ts$/,
  /^src\/core\/(math|rng)\.ts$/,
  /^src\/physics\/[^/]+\.ts$/,
  /^src\/world\/(types|cityGen|cityCollision)\.ts$/,
];
/** Allowed for type-only imports. */
const ALLOWED_TYPES = [/^src\/player\/targeting\.ts$/];
const PURE_NET = ['protocol', 'codec', 'names', 'maps', 'clock', 'interp'].map((n) => `src/net/${n}.ts`);

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function importsOf(file: string): Array<{ spec: string; typeOnly: boolean }> {
  const src = stripComments(readFileSync(file, 'utf8'));
  const out: Array<{ spec: string; typeOnly: boolean }> = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[4]) {
      // `import { type A, type B } from` counts as type-only too.
      const names = m[3] ?? '';
      const braced = /^\{([\s\S]*)\}$/.exec(names.trim());
      const allTypes = !!braced && braced[1]!.split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '));
      out.push({ spec: m[4], typeOnly: !!m[2] || allTypes });
    } else out.push({ spec: (m[5] ?? m[6])!, typeOnly: false });
  }
  return out;
}

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, join(base, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

test('combat: pure modules import nothing from DOM or rendering code @quick', () => {
  const roots: string[] = [];
  const combat: string[] = [];
  walk(join(root, 'src/combat'), combat);
  for (const f of combat) {
    const rel = relative(root, f).replace(/\\/g, '/');
    if (rel.startsWith('src/combat/render/') || rel.startsWith('src/combat/client/')) continue;
    roots.push(f);
  }
  walk(join(root, 'src/sim'), roots);
  for (const n of PURE_NET) if (existsSync(join(root, n))) roots.push(join(root, n));
  expect(roots.length).toBeGreaterThan(0);
  const pureSet = new Set(roots.map((f) => relative(root, f).replace(/\\/g, '/')));
  const violations: string[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const f = queue.pop()!;
    const rel = relative(root, f).replace(/\\/g, '/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    // Global identifiers only: strings are dropped, member accesses (`x.window`) and object keys (`window: 1`) do not count.
    const code = stripComments(readFileSync(f, 'utf8')).replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");
    const usesGlobal = (tok: string) => new RegExp(`(?<![.\\w$])${tok}\\b(?!\\s*\\??:)`).test(code);
    for (const tok of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'requestAnimationFrame', 'HTMLElement', 'WebSocket', 'process', 'require', 'Buffer', '__dirname']) {
      if (usesGlobal(tok)) violations.push(`${rel}: uses '${tok}'`);
    }
    if (rel.startsWith('src/combat/') || rel.startsWith('src/sim/')) {
      // Determinism: one seeded Rng per sim, sim time only.
      for (const tok of ['Math\\.random', 'Date', 'performance']) if (usesGlobal(tok)) violations.push(`${rel}: uses '${tok.replace('\\', '')}' (non-deterministic)`);
    }
    for (const imp of importsOf(f)) {
      if (!imp.spec.startsWith('.')) {
        if (imp.spec !== 'three') violations.push(`${rel}: imports package '${imp.spec}'`);
        continue;
      }
      const target = resolveSpec(f, imp.spec);
      if (!target) {
        violations.push(`${rel}: cannot resolve '${imp.spec}'`);
        continue;
      }
      const trel = relative(root, target).replace(/\\/g, '/');
      const ok = pureSet.has(trel) || trel.startsWith('src/combat/') && !trel.startsWith('src/combat/render/') && !trel.startsWith('src/combat/client/') || ALLOWED.some((re) => re.test(trel)) || (imp.typeOnly && ALLOWED_TYPES.some((re) => re.test(trel)));
      if (!ok) {
        violations.push(`${rel}: imports '${trel}'${imp.typeOnly ? ' (type)' : ''}`);
        continue;
      }
      if (!imp.typeOnly) queue.push(target);
    }
  }
  // The checker itself catches DOM code and render imports.
  const domSrc = stripComments(readFileSync(join(root, 'src/ui/dom.ts'), 'utf8'));
  expect(/(?<![.\w$])document\b(?!\s*\??:)/.test(domSrc)).toBe(true);
  expect(importsOf(join(root, 'src/game.ts')).some((i) => i.spec.includes('/render/'))).toBe(true);
  saveResult('combat-purity', { files: [...seen].sort(), violations });
  console.log(`purity: ${seen.size} files walked`);
  expect(violations, violations.join('\n')).toEqual([]);
  // The walk really covers the combat sim and the world it is built on.
  expect(seen.has('src/combat/types.ts')).toBe(true);
  expect(seen.has('src/combat/spawnPoints.ts')).toBe(true);
  expect(seen.has('src/physics/collision.ts')).toBe(true);
});
