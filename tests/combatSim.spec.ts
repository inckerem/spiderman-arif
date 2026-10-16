import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Vector3 } from 'three';
import { saveResult } from './helpers';
import { getMap } from '../src/maps/registry';
import { buildCollisionWorld } from '../src/world/cityCollision';
import { F_BUILDING } from '../src/physics/collision';
import { findRespawnRoof } from '../src/physics/safeSpot';
import { tuning } from '../src/config/tuning';
import { AR, AR_NAMES, arenaSuits, arenaTypesFor, buildSpawnPoints, spotFree, type SpawnPoints } from '../src/combat/spawnPoints';
import { ANIM, ATK, EF, EK, ES, HERO_ID_BASE, HIT, MOVE, PK, type CombatEvent, type CombatIntent } from '../src/combat/types';
import { CombatSim, capsuleDistance, chainMove } from '../src/combat/combatSim';
import { PosHistory } from '../src/combat/history';
import { kindInfo } from '../src/combat/roster';

// Node-side combat checks (no page): spawn points, respawn roofs and the
// import purity of the code that must also run on the Node server.

const SEED = 1337;
const root = resolve(process.cwd());

function buildWorld(seed = SEED) {
  const map = getMap('manhattan');
  const layout = map.generate(seed);
  const world = buildCollisionWorld(layout, map);
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
});

// --- Purity: the combat sim (and the shared room/protocol code) must run on the Node server ---

/** Modules the pure set may import (besides itself), relative to the repo root. */
const ALLOWED = [
  /^src\/config\/tuning\.ts$/,
  /^src\/core\/(math|rng)\.ts$/,
  /^src\/physics\/[^/]+\.ts$/,
  /^src\/world\/(types|cityGen|cityCollision)\.ts$/,
  // M13: the dependency-free map id list.
  /^src\/maps\/ids\.ts$/,
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

// --- Sim core (chunk 2): damage, regen, down -> roof respawn, dodges, strikes, validation, determinism ---


const DT = CombatSim.DT;
let W: { layout: ReturnType<typeof buildWorld>['layout']; world: ReturnType<typeof buildCollisionWorld>; spawns: SpawnPoints } | null = null;
function world() {
  if (!W) {
    const { layout, world } = buildWorld();
    W = { layout, world, spawns: buildSpawnPoints(layout, world) };
  }
  return W;
}

function makeSim(seed = 7, pvp = false, maxEnemies = 30): CombatSim {
  const w = world();
  return new CombatSim(w.world, w.layout, w.spawns, seed, { pvp, maxEnemies });
}

/** A storefront arena near the city spawn, its spots as [x, y, z][] (nearest the centre first). */
function arenaNear(k = 0): Array<[number, number, number]> {
  const w = world();
  const s = w.layout.spawn;
  const ids = [...w.spawns.byType[AR.STOREFRONT]!].sort((a, b) => {
    const A = w.spawns.arenas[a]!,
      B = w.spawns.arenas[b]!;
    return Math.hypot(A.x - s[0], A.z - s[2]) - Math.hypot(B.x - s[0], B.z - s[2]) || a - b;
  });
  const a = w.spawns.arenas[ids[k]!]!;
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < a.spots.length; i += 3) out.push([a.spots[i]!, a.spots[i + 1]!, a.spots[i + 2]!]);
  return out;
}

function hero(sim: CombatSim, pid: number, x: number, y: number, z: number, vx = 0, vz = 0, afk = false): void {
  sim.upsertHero({ pid, x, y, z, vx, vy: 0, vz, mode: 0, grounded: true, facing: 0, afk, t: sim.time });
}

function strike(seq: number, target: number, move: number, sim: CombatSim, x: number, y: number, z: number, viewT = sim.time - DT): CombatIntent {
  return { k: 'strike', seq, target, move, viewT, hx: x, hy: y, hz: z };
}

test('combat sim: thugs chase, telegraph and hurt; down, then a roof respawn; regeneration', () => {
  const { world: wd } = world();
  const sim = makeSim();
  const spots = arenaNear();
  const [hx, hy, hz] = spots[0]!;
  hero(sim, 1, hx, hy, hz);
  const ids = [sim.debugSpawn(0, ...spots[6]!), sim.debugSpawn(0, ...spots[9]!), sim.debugSpawn(1, ...spots[12]!)];
  expect(ids.every((id) => id > 0)).toBe(true);
  const startDist = ids.map((id) => Math.hypot(sim.enemy(id)!.pos.x - hx, sim.enemy(id)!.pos.z - hz));
  const evs: Array<CombatEvent & { step: number; time: number }> = [];
  const buf: CombatEvent[] = [];
  let pos: [number, number, number] = [hx, hy, hz];
  let downAt = -1,
    respawnAt = -1,
    respawn: { x: number; y: number; z: number } | null = null;
  let minDist = Infinity;
  for (let s = 0; s < 900; s++) {
    hero(sim, 1, ...pos);
    sim.step();
    buf.length = 0;
    sim.drainEvents(buf);
    for (const e of buf) {
      evs.push({ ...e, step: s, time: sim.time });
      if (e.e === 'down') downAt = sim.time;
      if (e.e === 'respawn') {
        respawnAt = sim.time;
        respawn = { x: e.x, y: e.y, z: e.z };
        pos = [e.x, e.y, e.z];
      }
    }
    for (const id of ids) {
      const en = sim.enemy(id);
      if (en && downAt < 0) minDist = Math.min(minDist, Math.hypot(en.pos.x - hx, en.pos.z - hz));
    }
    if (respawnAt > 0 && sim.time > respawnAt + 2) break;
  }
  const teles = evs.filter((e) => e.e === 'tele') as Array<Extract<CombatEvent, { e: 'tele' }> & { time: number }>;
  const hits = evs.filter((e) => e.e === 'hit' && e.tgt === HERO_ID_BASE + 1) as Array<Extract<CombatEvent, { e: 'hit' }> & { time: number }>;
  // Each hit lands in the step of its telegraph's impact time (single player: no grace).
  const lag = hits.map((h) => {
    const t = teles.filter((x) => x.src === h.src && x.at <= h.time + 1e-9).pop()!;
    return h.time - t.at;
  });
  const dmgByAtk: Record<number, number[]> = {};
  for (const h of hits) (dmgByAtk[h.move] ??= []).push(h.dmg);
  const after = evs.filter((e) => e.e === 'hit' && e.tgt === HERO_ID_BASE + 1 && e.time > downAt && e.time < respawnAt);
  const s = respawn ? wd.supportHeight(respawn.x, respawn.z, respawn.y + 0.5, 0) : { y: -Infinity, id: -1 };
  const r = {
    startDist,
    minDist,
    teles: teles.length,
    hits: hits.length,
    dmgByAtk,
    maxLag: Math.max(...lag),
    downAt,
    respawnAt,
    respawn,
    hp: sim.hero(1)!.hp,
    hitsWhileDown: after.length,
  };
  console.log('combat damage/down/respawn', JSON.stringify(r));
  expect(minDist).toBeLessThan(2.6);
  expect(teles.length).toBeGreaterThan(3);
  expect(hits.length).toBeGreaterThan(3);
  for (const l of lag) expect(l).toBeGreaterThanOrEqual(-1e-9), expect(l).toBeLessThan(DT + 1e-9);
  for (const d of dmgByAtk[ATK.PUNCH] ?? []) expect(d).toBe(tuning.enemies.thug.damage);
  for (const d of dmgByAtk[ATK.BAT_SWING] ?? []) expect(d).toBe(tuning.enemies.bat.damage);
  expect((dmgByAtk[ATK.BAT_SWING] ?? []).length).toBeGreaterThan(0);
  expect(downAt).toBeGreaterThan(0);
  expect(after.length).toBe(0);
  expect(respawnAt - downAt).toBeGreaterThanOrEqual(tuning.combat.downTime - 1e-6);
  expect(respawnAt - downAt).toBeLessThan(tuning.combat.downTime + DT + 1e-6);
  expect(respawn).not.toBeNull();
  expect(respawn!.y).toBeGreaterThanOrEqual(12);
  expect(s.id).toBeGreaterThanOrEqual(0);
  expect(wd.flags[s.id]! & F_BUILDING).not.toBe(0);
  expect(r.hp).toBe(tuning.combat.maxHp);

  // Regeneration: nothing for regenDelay after the last damage, then regenRate hp/s up to full.
  const sim2 = makeSim();
  hero(sim2, 1, hx, hy, hz);
  sim2.step();
  sim2.debugSetHp(1, 40);
  const t0 = sim2.time;
  let atDelay = 0,
    at2s = 0,
    full = -1;
  for (let i = 0; i < 30 * 12; i++) {
    hero(sim2, 1, hx, hy, hz);
    sim2.step();
    const hp = sim2.hero(1)!.hp;
    if (Math.abs(sim2.time - t0 - (tuning.combat.regenDelay - 0.1)) < DT / 2) atDelay = hp;
    if (Math.abs(sim2.time - t0 - (tuning.combat.regenDelay + 2)) < DT / 2) at2s = hp;
    if (full < 0 && hp >= tuning.combat.maxHp) full = sim2.time - t0;
  }
  console.log('combat regen', JSON.stringify({ atDelay, at2s, full }));
  expect(atDelay).toBe(40);
  expect(Math.abs(at2s - (40 + 2 * tuning.combat.regenRate))).toBeLessThan(tuning.combat.regenRate * DT * 1.5);
  expect(Math.abs(full - (tuning.combat.regenDelay + 60 / tuning.combat.regenRate))).toBeLessThan(0.1);
});

test('combat sim: dodges in the window avoid telegraphed hits, also with online grace', () => {
  const spots = arenaNear();
  const [hx, hy, hz] = spots[0]!;
  const run = (dodgeOffset: number | null, rtt = 0) => {
    const sim = makeSim(11);
    hero(sim, 1, hx, hy, hz);
    if (rtt > 0) sim.setRtt(1, rtt);
    sim.debugSpawn(1, ...spots[5]!);
    const buf: CombatEvent[] = [];
    const planned: Array<{ t: number; sent: boolean }> = [];
    let seq = 0,
      teles = 0,
      misses = 0,
      hits = 0;
    for (let s = 0; s < 30 * 20 && teles < 6; s++) {
      hero(sim, 1, hx, hy, hz);
      // Send planned dodges once their stamp time has come (a client presses Space at that moment).
      for (const p of planned) {
        if (!p.sent && sim.time + 1e-9 >= p.t) {
          sim.intent(1, { k: 'dodge', seq: ++seq, t: p.t });
          p.sent = true;
        }
      }
      sim.step();
      buf.length = 0;
      sim.drainEvents(buf);
      for (const e of buf) {
        if (e.e === 'tele' && e.tgt === HERO_ID_BASE + 1) {
          teles++;
          if (dodgeOffset !== null) planned.push({ t: e.at + dodgeOffset, sent: false });
        }
        if (e.e === 'miss') misses++;
        if (e.e === 'hit' && e.tgt === HERO_ID_BASE + 1) hits++;
        if (e.e === 'rej') throw new Error(`dodge rejected: ${e.why}`);
      }
    }
    return { teles, misses, hits, hp: sim.hero(1)!.hp };
  };
  const none = run(null);
  const inWindow = run(-0.15);
  const early = run(-0.6);
  const lateNoGrace = run(0.03);
  const lateWithGrace = run(0.03, 0.2);
  console.log('combat dodge', JSON.stringify({ none, inWindow, early, lateNoGrace, lateWithGrace }));
  expect(none.hits).toBeGreaterThan(2);
  expect(none.misses).toBe(0);
  expect(inWindow.hits).toBe(0);
  expect(inWindow.misses).toBeGreaterThan(2);
  expect(inWindow.hp).toBe(tuning.combat.maxHp);
  expect(early.hits).toBeGreaterThan(2);
  expect(early.misses).toBe(0);
  // A dodge 30 ms after the impact: too late in single player (the hit resolved at the impact)...
  expect(lateNoGrace.hits).toBeGreaterThan(2);
  // ...but online the hit waits RTT/2 + 50 ms, and a dodge stamped up to 50 ms after the impact still counts.
  expect(lateWithGrace.hits).toBe(0);
  expect(lateWithGrace.misses).toBeGreaterThan(2);
});

test('combat sim: strikes, combo, focus, knockdown, finishers, yank and pin', () => {
  const spots = arenaNear();
  const [hx, hy, hz] = spots[0]!;
  const sim = makeSim(5);
  const buf: CombatEvent[] = [];
  const stepN = (n: number, x = hx, y = hy, z = hz) => {
    for (let i = 0; i < n; i++) {
      hero(sim, 1, x, y, z);
      sim.step();
      sim.drainEvents(buf);
    }
  };
  hero(sim, 1, hx, hy, hz);
  // A thug right in front of the hero (1.2 m).
  const id = sim.debugSpawn(0, hx + 1.2, hy, hz);
  stepN(2);
  let seq = 0;
  const hitsOn = (tgt: number) => buf.filter((e) => e.e === 'hit' && e.tgt === tgt) as Array<Extract<CombatEvent, { e: 'hit' }>>;
  const combos: number[] = [];
  const moves: number[] = [];
  for (let k = 0; k < 4; k++) {
    const mv = chainMove(k);
    moves.push(mv);
    const e = sim.enemy(id)!;
    sim.intent(1, strike(++seq, id, mv, sim, e.pos.x - 1.1, hy, e.pos.z));
    stepN(1);
    combos.push(sim.hero(1)!.combo);
    stepN(8);
  }
  const chainHits = hitsOn(id);
  const afterChain = { hp: sim.enemy(id)!.hp, state: sim.enemy(id)!.state, focus: sim.hero(1)!.focus };
  // Combo resets after the window.
  stepN(Math.ceil(tuning.combat.comboWindow / DT) + 2);
  const comboAfterWindow = sim.hero(1)!.combo;
  // A fresh thug knocked down by an uppercut: the ground finisher KOs it (regular enemies, whatever their hp).
  const knockedDownState = afterChain.state;
  const idG = sim.debugSpawn(0, hx + 1.2, hy, hz - 1.5);
  stepN(12);
  let e = sim.enemy(idG)!;
  sim.intent(1, strike(++seq, idG, MOVE.UPPER, sim, e.pos.x - 1.1, hy, e.pos.z));
  stepN(1);
  const downState = sim.enemy(idG)!.state;
  stepN(5);
  e = sim.enemy(idG)!;
  sim.intent(1, strike(++seq, idG, MOVE.GROUND, sim, e.pos.x - 1.0, hy, e.pos.z));
  stepN(1);
  const ko = hitsOn(idG).pop()!;
  const koState = sim.enemy(idG)?.state;

  // Takedown needs full focus: KO in one.
  const id2 = sim.debugSpawn(0, hx + 2.5, hy, hz + 0.5);
  stepN(2);
  sim.hero(1)!.focus = 100;
  const e2 = sim.enemy(id2)!;
  sim.intent(1, { k: 'takedown', seq: ++seq, target: id2, viewT: sim.time - DT, hx: e2.pos.x - 1.2, hy, hz: e2.pos.z });
  stepN(1);
  const td = { state: sim.enemy(id2)?.state, focus: sim.hero(1)!.focus };

  // Yank from 14 m: it flies most of the way in.
  const far = spots.map((p) => ({ p, d: Math.hypot(p[0] - hx, p[2] - hz) })).filter((o) => o.d > 10 && o.d < 20).sort((a, b) => a.d - b.d)[0]!;
  const id3 = sim.debugSpawn(0, ...far.p);
  stepN(1);
  const before = sim.enemy(id3)!.pos.clone();
  const d0 = Math.hypot(before.x - hx, before.z - hz);
  sim.intent(1, { k: 'yank', seq: ++seq, target: id3, viewT: sim.time - DT, hx, hy, hz });
  stepN(Math.ceil(tuning.combat.yankTime / DT) + 3);
  const e3 = sim.enemy(id3)!;
  const d1 = Math.hypot(e3.pos.x - hx, e3.pos.z - hz);
  const yankFrac = (d0 - d1) / d0;

  // Pin: it stays put for pinTime.
  const id4 = sim.debugSpawn(1, ...spots[10]!);
  stepN(1);
  const p0 = sim.enemy(id4)!.pos.clone();
  sim.intent(1, { k: 'pin', seq: ++seq, target: id4, viewT: sim.time - DT, hx, hy, hz });
  let maxDrift = 0,
    pinnedSteps = 0;
  for (let i = 0; i < Math.floor(tuning.combat.pinTime / DT) - 2; i++) {
    stepN(1);
    const p = sim.enemy(id4)!;
    if (p.state === ES.PINNED) pinnedSteps++;
    maxDrift = Math.max(maxDrift, Math.hypot(p.pos.x - p0.x, p.pos.z - p0.z));
  }
  const rejections = buf.filter((x) => x.e === 'rej');
  const r = {
    moves,
    chainDmg: chainHits.map((h) => h.dmg),
    chainFl: chainHits.map((h) => h.fl),
    combos,
    afterChain,
    knockedDownState,
    downState,
    comboAfterWindow,
    ko: { dmg: ko.dmg, fl: ko.fl, hp: ko.hp, state: koState },
    td,
    yank: { d0, d1, yankFrac },
    pin: { maxDrift, pinnedSteps },
    rejections,
  };
  console.log('combat strikes', JSON.stringify(r));
  expect(rejections).toEqual([]);
  expect(moves).toEqual([MOVE.JAB, MOVE.CROSS, MOVE.KICK, MOVE.UPPER]);
  expect(chainHits.map((h) => h.dmg)).toEqual([tuning.combat.jabDmg, tuning.combat.crossDmg, tuning.combat.kickDmg, tuning.combat.upperDmg]);
  expect(chainHits[3]!.fl & HIT.KNOCKDOWN).not.toBe(0);
  expect(Math.hypot(chainHits[3]!.kx, chainHits[3]!.kz)).toBeCloseTo(tuning.combat.chainKnockback, 3);
  expect(combos).toEqual([1, 2, 3, 4]);
  expect(afterChain.hp).toBe(60 - 10 - 12 - 15 - 20);
  expect(afterChain.state).toBe(ES.DOWN);
  expect(afterChain.focus).toBe(4 * tuning.combat.focusPerHit);
  expect(comboAfterWindow).toBe(0);
  expect(downState).toBe(ES.DOWN);
  expect(ko.fl & HIT.KO).not.toBe(0);
  expect(ko.dmg).toBe(60 - tuning.combat.upperDmg);
  expect(ko.hp).toBe(0);
  expect(koState).toBe(ES.KO);
  expect(td.state).toBe(ES.KO);
  expect(td.focus).toBe(0);
  expect(yankFrac).toBeGreaterThanOrEqual(0.6);
  expect(maxDrift).toBeLessThan(0.2);
  expect(pinnedSteps).toBeGreaterThan(Math.floor(tuning.combat.pinTime / DT) - 4);
  // KO'd enemies leave after koLinger.
  stepN(Math.ceil(tuning.enemies.koLinger / DT) + 2);
  expect(sim.enemy(idG)).toBeUndefined();
  expect(sim.enemy(id2)).toBeUndefined();
});

test('combat sim: intent validation rejects range, rate, time, state and pvp', () => {
  const spots = arenaNear();
  const [hx, hy, hz] = spots[0]!;
  const sim = makeSim(3);
  const buf: CombatEvent[] = [];
  const stepN = (n: number) => {
    for (let i = 0; i < n; i++) {
      hero(sim, 1, hx, hy, hz);
      hero(sim, 2, hx - 1, hy, hz);
      sim.step();
      sim.drainEvents(buf);
    }
  };
  const id = sim.debugSpawn(0, hx + 1.2, hy, hz);
  stepN(2);
  const rej = (seq: number) => (buf.find((e) => e.e === 'rej' && e.seq === seq) as Extract<CombatEvent, { e: 'rej' }> | undefined)?.why ?? 'ok';
  const e = () => sim.enemy(id)!;
  // Too far: the hero claims to be 6 m away from the thug (but where it really is).
  sim.intent(1, strike(1, id, MOVE.JAB, sim, hx, hy, hz));
  stepN(1);
  const okFirst = rej(1);
  stepN(10);
  const far = e().pos.x - 6;
  hero(sim, 1, far, hy, hz);
  sim.intent(1, strike(2, id, MOVE.JAB, sim, far, hy, hz));
  stepN(1);
  // Claimed hero position far from its own samples.
  sim.intent(1, strike(3, id, MOVE.JAB, sim, e().pos.x - 1, hy, hz + 9));
  stepN(1);
  // Two strikes 50 ms apart (view time).
  stepN(10);
  sim.intent(1, strike(4, id, MOVE.JAB, sim, hx, hy, hz, sim.time - DT));
  sim.intent(1, strike(5, id, MOVE.CROSS, sim, hx, hy, hz, sim.time - DT + 0.05));
  stepN(1);
  // Stale view time.
  stepN(10);
  sim.intent(1, strike(6, id, MOVE.JAB, sim, hx, hy, hz, sim.time - 1));
  stepN(1);
  // Hero target without PvP.
  sim.intent(1, strike(7, HERO_ID_BASE + 2, MOVE.JAB, sim, hx, hy, hz));
  stepN(1);
  // Ground finisher on a standing enemy; takedown without focus.
  stepN(10);
  sim.intent(1, strike(8, id, MOVE.GROUND, sim, hx, hy, hz));
  sim.intent(1, { k: 'takedown', seq: 9, target: id, viewT: sim.time - DT, hx, hy, hz });
  stepN(1);
  // Burst of 20 intents in one step: the token bucket (15/s) rejects the overflow.
  for (let k = 0; k < 20; k++) sim.intent(1, { k: 'dodge', seq: 100 + k, t: sim.time });
  stepN(1);
  const rateRejected = buf.filter((x) => x.e === 'rej' && x.seq >= 100 && x.why === 'rate').length;
  // Down heroes cannot act.
  stepN(30);
  sim.debugSetHp(1, 0);
  stepN(1);
  sim.intent(1, strike(10, id, MOVE.JAB, sim, hx, hy, hz));
  stepN(1);
  const r = { okFirst, range: rej(2), heroPos: rej(3), first: rej(4), rate: rej(5), time: rej(6), pvp: rej(7), ground: rej(8), takedown: rej(9), rateRejected, down: rej(10) };
  console.log('combat validation', JSON.stringify(r));
  expect(r).toEqual({ okFirst: 'ok', range: 'range', heroPos: 'range', first: 'ok', rate: 'rate', time: 'time', pvp: 'pvp', ground: 'state', takedown: 'state', rateRejected: r.rateRejected, down: 'state' });
  expect(rateRejected).toBeGreaterThanOrEqual(4);

  // With PvP on, a hero target is hit like an enemy.
  const pv = makeSim(3, true);
  hero(pv, 1, hx, hy, hz);
  hero(pv, 2, hx + 1.2, hy, hz);
  pv.step();
  pv.step();
  pv.intent(1, strike(1, HERO_ID_BASE + 2, MOVE.JAB, pv, hx, hy, hz));
  hero(pv, 1, hx, hy, hz);
  hero(pv, 2, hx + 1.2, hy, hz);
  pv.step();
  const pvb: CombatEvent[] = [];
  pv.drainEvents(pvb);
  expect(pv.hero(2)!.hp).toBe(tuning.combat.maxHp - tuning.combat.jabDmg);
  expect(capsuleDistance(0, 1, 0, 0, 0, 2, 0.4, 1.8)).toBeCloseTo(1.6, 5);
});

/** A scripted minute: several thugs and bats around a hero that walks a sidewalk loop and fights back. Returns hashes every second plus checks. */
function scriptedRun(seed: number, enemies = 8, steps = 1800, strikeEvery = 24, spacing = 7) {
  const w = world();
  const sim = makeSim(seed, false, 30);
  const loops = [...w.spawns.loops].sort((a, b) => Math.hypot(a.cx - w.layout.spawn[0], a.cz - w.layout.spawn[2]) - Math.hypot(b.cx - w.layout.spawn[0], b.cz - w.layout.spawn[2]));
  const loop = loops[0]!;
  const at = (u: number): [number, number] => {
    u = ((u % loop.total) + loop.total) % loop.total;
    let k = 0;
    while (k < 3 && loop.cum[k + 1]! < u) k++;
    const f = (u - loop.cum[k]!) / (loop.cum[k + 1]! - loop.cum[k]!);
    return [loop.pts[k * 2]! + (loop.pts[k * 2 + 2]! - loop.pts[k * 2]!) * f, loop.pts[k * 2 + 1]! + (loop.pts[k * 2 + 3]! - loop.pts[k * 2 + 1]!) * f];
  };
  // Enemies on the loop ahead of and behind the hero.
  for (let i = 0; i < enemies; i++) {
    const [x, z] = at(8 + i * spacing);
    sim.debugSpawn(i % 3 === 2 ? 1 : 0, x, loop.y + 0.5, z);
  }
  const hashes: string[] = [];
  const buf: CombatEvent[] = [];
  let u = 0,
    seq = 0,
    hitsOnHero = 0,
    hitsOnEnemies = 0,
    nan = 0,
    maxPen = 0,
    below = 0,
    kos = 0,
    stepMs = 0;
  const speed = 3;
  for (let s = 0; s < steps; s++) {
    const h = sim.hero(1);
    const down = h?.down ?? false;
    // Walk the loop (stand still while fighting someone close).
    const [x, z] = at(u);
    const [x2, z2] = at(u + 0.1);
    const l = Math.hypot(x2 - x, z2 - z) || 1;
    let near = -1,
      nd = 1e9;
    for (const e of sim.enemies) {
      if (e.state === ES.KO) continue;
      const d = Math.hypot(e.pos.x - x, e.pos.z - z);
      if (d < nd) {
        nd = d;
        near = e.id;
      }
    }
    const walking = nd > 2.5 && !down;
    if (walking) u += speed * DT;
    sim.upsertHero({ pid: 1, x, y: loop.y, z, vx: walking ? ((x2 - x) / l) * speed : 0, vy: 0, vz: walking ? ((z2 - z) / l) * speed : 0, mode: 0, grounded: true, facing: 0, afk: false, t: sim.time });
    if (!down && near > 0 && nd < 2.4 && s % strikeEvery === 0) sim.intent(1, strike(++seq, near, chainMove(h?.combo ?? 0), sim, x, loop.y, z));
    const t0 = performance.now();
    sim.step();
    stepMs += performance.now() - t0;
    buf.length = 0;
    sim.drainEvents(buf);
    for (const e of buf) {
      if (e.e === 'hit' && e.tgt === HERO_ID_BASE + 1) hitsOnHero++;
      if (e.e === 'hit' && e.tgt < HERO_ID_BASE) {
        hitsOnEnemies++;
        if (e.fl & HIT.KO) kos++;
      }
      if (e.e === 'respawn') u = 0; // back to the loop (the test hero walks, it does not swing home)
    }
    for (const e of sim.enemies) {
      const p = e.pos;
      if (!Number.isFinite(p.x + p.y + p.z)) nan++;
      const info = kindInfo(e.kind);
      const pen = w.world.capsulePenetration(p.x, p.y, p.z, info.radius, info.height);
      if (pen > maxPen) maxPen = pen;
      if (!w.world.terrain.isWater(p.x, p.z) && p.y < w.world.terrain.height(p.x, p.z) - 0.01) below++;
    }
    if (s % 30 === 29) hashes.push(sim.hash());
  }
  return { hashes, hitsOnHero, hitsOnEnemies, kos, nan, maxPen, below, msPerStep: stepMs / steps, final: sim.hash() };
}

test('combat sim: deterministic across runs, no NaN, enemies stay out of geometry', () => {
  const a = scriptedRun(42);
  const b = scriptedRun(42);
  const c = scriptedRun(43);
  console.log('combat determinism', JSON.stringify({ a: { ...a, hashes: a.hashes.length }, b: b.final, c: c.final }));
  expect(b.hashes).toEqual(a.hashes);
  expect(c.final).not.toBe(a.final);
  expect(a.hitsOnHero).toBeGreaterThan(0);
  expect(a.hitsOnEnemies).toBeGreaterThan(0);
  expect(a.kos).toBeGreaterThan(0);
  expect(a.nan).toBe(0);
  expect(a.maxPen).toBeLessThan(0.03);
  expect(a.below).toBe(0);
  // 30 enemies in a crowd: step cost (budget 1 ms per step with 30 enemies; Node on a shared CPU gets slack).
  const big = scriptedRun(9, 30, 600, 12, 1.5);
  saveResult('combat-sim', { run: { ...a, hashes: undefined }, big: { ...big, hashes: undefined } });
  console.log('combat 30 enemies', JSON.stringify({ ...big, hashes: undefined }));
  expect(big.nan).toBe(0);
  expect(big.maxPen).toBeLessThan(0.03);
  expect(big.below).toBe(0);
  expect(big.msPerStep).toBeLessThan(2);
});

test('combat: position history interpolates, clamps and wraps @quick', () => {
  const h = new PosHistory(2, 4);
  const o = { x: 0, y: 0, z: 0 };
  expect(h.sample(0, 1, o)).toBe(false);
  for (let i = 0; i < 6; i++) h.record(0, i, i * 10, 0, -i);
  // Only the last 4 samples (t = 2..5) remain.
  expect(h.size(0)).toBe(4);
  h.sample(0, 3.25, o);
  expect([o.x, o.z]).toEqual([32.5, -3.25]);
  h.sample(0, 9, o);
  expect(o.x).toBe(50);
  h.sample(0, 0, o);
  expect(o.x).toBe(20);
  h.sample(0, 2, o);
  expect(o.x).toBe(20);
  expect(h.sample(1, 0, o)).toBe(false);
  h.clear(0);
  expect(h.sample(0, 3, o)).toBe(false);
});

// --- Roster (M11 chunk 6): gunmen, brutes, drones, bottles ---

/** The k-th arena of a type nearest the city spawn: centre and spots. */
function arenaOf(type: number, k = 0): { x: number; y: number; z: number; spots: Array<[number, number, number]> } {
  const w = world();
  const s = w.layout.spawn;
  const ids = [...w.spawns.byType[type]!].sort((a, b) => {
    const A = w.spawns.arenas[a]!,
      B = w.spawns.arenas[b]!;
    return Math.hypot(A.x - s[0], A.z - s[2]) - Math.hypot(B.x - s[0], B.z - s[2]) || a - b;
  });
  const a = w.spawns.arenas[ids[k]!]!;
  const spots: Array<[number, number, number]> = [];
  for (let i = 0; i < a.spots.length; i += 3) spots.push([a.spots[i]!, a.spots[i + 1]!, a.spots[i + 2]!]);
  return { x: a.x, y: a.y, z: a.z, spots };
}

type Hit = Extract<CombatEvent, { e: 'hit' }>;
const ME = HERO_ID_BASE + 1;

test('combat sim: gunmen keep their distance, aim, fire bursts at a moving hero; dodges make them miss; a yank disarms', () => {
  const ar = arenaOf(AR.INTERSECTION, 0);
  const g = tuning.enemies.gunman;
  const run = (dodge: boolean) => {
    const sim = makeSim(11);
    const buf: CombatEvent[] = [];
    // The hero flies a fast circle (a swing's speed) 6 m up around the crossing; the gunman stands at its edge.
    const R = 14,
      speed = 18,
      up = 6;
    const pos = (t: number): [number, number, number, number, number] => {
      const a = (t * speed) / R;
      return [ar.x + Math.cos(a) * R, ar.y + up, ar.z + Math.sin(a) * R, -Math.sin(a) * speed, Math.cos(a) * speed];
    };
    const [x0, y0, z0] = pos(0);
    sim.upsertHero({ pid: 1, x: x0, y: y0, z: z0, vx: 0, vy: 0, vz: 0, mode: 2, grounded: false, facing: 0, afk: false, t: sim.time });
    const id = sim.debugSpawn(EK.GUNMAN, ar.x + 4, ar.y + 0.5, ar.z - 3);
    let seq = 0;
    const teles: Array<{ at: number; done: boolean }> = [];
    let shots = 0,
      hitShots = 0,
      hits = 0,
      misses = 0,
      minD = Infinity,
      maxD = 0,
      aimAnim = 0;
    for (let s = 0; s < 30 * 25; s++) {
      const [x, y, z, vx, vz] = pos(sim.time);
      sim.upsertHero({ pid: 1, x, y, z, vx, vy: 0, vz, mode: 2, grounded: false, facing: 0, afk: false, t: sim.time });
      // The bot dodges once per telegraph, 0.1 s before its impact (the burst dodges as one).
      if (dodge) {
        for (const t of teles) {
          if (!t.done && sim.time >= t.at - 0.1 - 1e-9) {
            t.done = true;
            sim.intent(1, { k: 'dodge', seq: ++seq, t: sim.time });
          }
        }
      }
      sim.step();
      buf.length = 0;
      sim.drainEvents(buf);
      for (const e of buf) {
        if (e.e === 'tele' && e.src === id) teles.push({ at: e.at, done: false });
        if (e.e === 'shot' && e.src === id) {
          shots++;
          if (e.hit) hitShots++;
        }
        if (e.e === 'hit' && e.src === id && e.tgt === ME) hits++;
        if (e.e === 'miss' && e.src === id) misses++;
      }
      const en = sim.enemy(id)!;
      if (en.anim === ANIM.AIM) aimAnim++;
      if (s > 60) {
        const d = Math.hypot(en.pos.x - x, en.pos.z - z);
        minD = Math.min(minD, d);
        maxD = Math.max(maxD, d);
      }
    }
    return { teles: teles.length, shots, hitShots, hits, misses, minD, maxD, aimAnim, hp: sim.hero(1)!.hp, hash: sim.hash() };
  };
  const plain = run(false);
  const dodged = run(true);
  const again = run(false);

  // Distance keeping on the ground: a hero walks up to the gunman; he backs off.
  const sim = makeSim(12);
  const buf: CombatEvent[] = [];
  hero(sim, 1, ar.x, ar.y, ar.z);
  const gid = sim.debugSpawn(EK.GUNMAN, ar.x + 6, ar.y + 0.5, ar.z);
  for (let s = 0; s < 30 * 4; s++) {
    hero(sim, 1, ar.x, ar.y, ar.z);
    sim.step();
    sim.drainEvents(buf);
  }
  const kept = Math.hypot(sim.enemy(gid)!.pos.x - ar.x, sim.enemy(gid)!.pos.z - ar.z);
  // A yank disarms him: he brawls (punch telegraphs) from then on.
  const ge = sim.enemy(gid)!;
  sim.intent(1, { k: 'yank', seq: 1, target: gid, viewT: sim.time - DT, hx: ar.x, hy: ar.y, hz: ar.z });
  buf.length = 0;
  for (let s = 0; s < 30 * 6; s++) {
    hero(sim, 1, ar.x, ar.y, ar.z);
    sim.step();
    sim.drainEvents(buf);
  }
  const yankHit = buf.find((e) => e.e === 'hit' && e.tgt === gid && e.move === MOVE.YANK) as Hit | undefined;
  const afterYank = buf.filter((e) => e.e === 'tele' && e.src === gid).map((e) => (e as Extract<CombatEvent, { e: 'tele' }>).atk);
  const r = { plain, dodged, again: again.hash === plain.hash, kept, disarmed: (ge.flags & EF.DISARMED) !== 0, yankFl: yankHit?.fl, afterYank, shotsAfter: buf.filter((e) => e.e === 'shot' && e.src === gid).length };
  saveResult('combat-gunman', r);
  console.log('combat gunman', JSON.stringify(r));
  expect(plain.teles).toBeGreaterThan(3);
  expect(plain.aimAnim).toBeGreaterThan(0);
  expect(plain.shots).toBeGreaterThanOrEqual(plain.teles * g.burst - g.burst);
  expect(plain.hits).toBeGreaterThan(0);
  expect(plain.hp).toBeLessThan(tuning.combat.maxHp);
  expect(plain.minD).toBeGreaterThan(g.keepMin - 4);
  expect(r.again).toBe(true);
  expect(dodged.shots).toBeGreaterThan(0);
  expect(dodged.hits).toBe(0);
  expect(dodged.misses).toBeGreaterThan(0);
  expect(kept).toBeGreaterThan(g.keepMin * 0.6 + 2);
  expect(r.disarmed).toBe(true);
  expect(r.yankFl! & HIT.DISARM).toBe(HIT.DISARM);
  expect(r.afterYank.every((a) => a === ATK.PUNCH)).toBe(true);
  expect(r.afterYank.length).toBeGreaterThan(0);
  expect(r.shotsAfter).toBe(0);
});

test('combat sim: brutes block frontal strikes; behind, above, a torn shield, a pin stun and takedowns land; charges knock down', () => {
  const ar = arenaOf(AR.INTERSECTION, 1);
  const sim = makeSim(21);
  const buf: CombatEvent[] = [];
  const at = { x: ar.x, y: ar.y, z: ar.z };
  const stepN = (n: number) => {
    for (let i = 0; i < n; i++) {
      hero(sim, 1, at.x, at.y, at.z);
      sim.step();
      sim.drainEvents(buf);
    }
  };
  // Passive brutes (no attacks) for the guard checks.
  const E = tuning.enemies;
  const saved = E.aggroRange;
  E.aggroRange = 0;
  let seq = 0;
  const lastHit = (id: number) => buf.filter((e) => e.e === 'hit' && e.tgt === id).pop() as Hit | undefined;
  /** A brute 1.6 m away facing yaw `face` (radians from facing the hero). */
  const brute = (face: number) => {
    sim.debugClear();
    const id = sim.debugSpawn(EK.BRUTE, ar.x + 1.6, ar.y + 0.5, ar.z);
    const e = sim.enemy(id)!;
    // Facing the hero (at -x) is yaw = atan2(-dx, -dz) with dx = -1.6: +pi/2.
    e.yaw = Math.PI / 2 + face;
    at.x = ar.x;
    at.y = e.pos.y;
    at.z = ar.z;
    // (Strikes stay further apart than the room's minimum interval.)
    stepN(6);
    return id;
  };
  const jab = (id: number, hy = at.y) => {
    const e = sim.enemy(id)!;
    const hp0 = e.hp;
    sim.intent(1, strike(++seq, id, MOVE.JAB, sim, at.x, hy, at.z));
    stepN(1);
    const h = lastHit(id)!;
    return { fl: h.fl, dmg: h.dmg, lost: hp0 - sim.enemy(id)!.hp, combo: sim.hero(1)!.combo };
  };
  const front = jab(brute(0));
  const back = jab(brute(Math.PI));
  // From above: the hero 1.5 m up (on a ledge or in the air).
  const idA = brute(0);
  at.y += 1.5;
  stepN(2);
  const above = jab(idA, at.y);
  at.y -= 1.5;
  // Yank: the shield comes off, he is not pulled; then frontal hits land.
  const idY = brute(0);
  const p0 = sim.enemy(idY)!.pos.clone();
  sim.intent(1, { k: 'yank', seq: ++seq, target: idY, viewT: sim.time - DT, hx: at.x, hy: at.y, hz: at.z });
  stepN(1);
  const ey = sim.enemy(idY)!;
  const yank = { shieldless: (ey.flags & EF.SHIELDLESS) !== 0, guard: ey.guard, moved: Math.hypot(ey.pos.x - p0.x, ey.pos.z - p0.z), fl: lastHit(idY)!.fl };
  stepN(Math.ceil(1 / DT));
  sim.enemy(idY)!.yaw = Math.PI / 2;
  const afterYank = jab(idY);
  // Pin: stunned for pinStun (not pinTime), hits land meanwhile.
  const idP = brute(0);
  sim.intent(1, { k: 'pin', seq: ++seq, target: idP, viewT: sim.time - DT, hx: at.x, hy: at.y, hz: at.z });
  stepN(1);
  const pinEv = buf.filter((e) => e.e === 'pin' && e.tgt === idP).pop() as { dur: number } | undefined;
  const pinnedHit = jab(idP);
  let pinnedFor = 0;
  while (sim.enemy(idP)!.state === ES.PINNED && pinnedFor < 200) {
    stepN(1);
    pinnedFor++;
  }
  // Takedown ignores the guard.
  const idT = brute(0);
  sim.hero(1)!.focus = 100;
  sim.intent(1, { k: 'takedown', seq: ++seq, target: idT, viewT: sim.time - DT, hx: at.x, hy: at.y, hz: at.z });
  stepN(1);
  const takedown = sim.enemy(idT)!.state;
  E.aggroRange = saved;

  // Charge: an alerted brute with the hero 11 m away (the hero backs off to keep the distance) winds up and runs it down.
  sim.debugClear();
  const av = arenaOf(AR.AVENUE, 0);
  // Along the avenue: the hero 5.5 m one way from its centre, the brute 5.5 m the other.
  const fs = av.spots.reduce((b, p) => (Math.hypot(p[0] - av.x, p[2] - av.z) > Math.hypot(b[0] - av.x, b[2] - av.z) ? p : b), av.spots[0]!);
  const fl = Math.hypot(fs[0] - av.x, fs[2] - av.z) || 1;
  const ux = (fs[0] - av.x) / fl,
    uz = (fs[2] - av.z) / fl;
  at.x = av.x - ux * 5.5;
  at.z = av.z - uz * 5.5;
  at.y = sim.world.supportHeight(at.x, at.z, av.y + 1, 0).y;
  const idC = sim.debugSpawn(EK.BRUTE, av.x + ux * 5.5, av.y + 0.5, av.z + uz * 5.5);
  buf.length = 0;
  let chargeTele: Extract<CombatEvent, { e: 'tele' }> | undefined;
  for (let s = 0; s < 30 * 20 && !chargeTele; s++) {
    // Keep 11 m away from him along the line between.
    const e = sim.enemy(idC)!;
    const dx = at.x - e.pos.x,
      dz = at.z - e.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    if (d < 10) {
      at.x = e.pos.x + (dx / d) * 11;
      at.z = e.pos.z + (dz / d) * 11;
      at.y = sim.world.supportHeight(at.x, at.z, at.y + 1, 0).y;
    }
    stepN(1);
    chargeTele = buf.find((ev) => ev.e === 'tele' && ev.src === idC && ev.atk === ATK.CHARGE) as typeof chargeTele;
  }
  let chargeHit: Hit | undefined;
  let special = false;
  for (let s = 0; s < 30 * 4 && !chargeHit; s++) {
    stepN(1);
    if (sim.enemy(idC)!.state === ES.SPECIAL) special = true;
    chargeHit = buf.find((ev) => ev.e === 'hit' && ev.src === idC && ev.tgt === ME) as Hit | undefined;
  }
  const r = { front, back, above, yank, afterYank, pinDur: pinEv?.dur, pinnedHit, pinnedFor: pinnedFor * DT, takedown, chargeTele: !!chargeTele, special, chargeHit: chargeHit ? { move: chargeHit.move, dmg: chargeHit.dmg, fl: chargeHit.fl } : null };
  saveResult('combat-brute', r);
  console.log('combat brute', JSON.stringify(r));
  expect(front.fl & HIT.BLOCKED).toBe(HIT.BLOCKED);
  expect(front.dmg).toBe(0);
  expect(front.lost).toBe(0);
  expect(front.combo).toBe(0);
  expect(back.fl & HIT.BACK).toBe(HIT.BACK);
  expect(back.lost).toBe(tuning.combat.jabDmg);
  expect(above.fl & HIT.ABOVE).toBe(HIT.ABOVE);
  expect(above.lost).toBe(tuning.combat.jabDmg);
  expect(yank.shieldless).toBe(true);
  expect(yank.guard).toBe(0);
  expect(yank.moved).toBeLessThan(0.3);
  expect(yank.fl & HIT.DISARM).toBe(HIT.DISARM);
  expect(afterYank.fl & HIT.BLOCKED).toBe(0);
  expect(afterYank.lost).toBe(tuning.combat.jabDmg);
  expect(r.pinDur).toBe(tuning.enemies.brute.pinStun);
  expect(pinnedHit.lost).toBe(tuning.combat.jabDmg);
  expect(r.pinnedFor).toBeLessThan(tuning.enemies.brute.pinStun + 0.1);
  expect(takedown).toBe(ES.KO);
  expect(r.chargeTele).toBe(true);
  expect(special).toBe(true);
  expect(r.chargeHit).not.toBeNull();
  expect(r.chargeHit!.move).toBe(ATK.CHARGE);
  expect(r.chargeHit!.dmg).toBe(tuning.enemies.brute.chargeDamage);
  expect(r.chargeHit!.fl & HIT.KNOCKDOWN).toBe(HIT.KNOCKDOWN);
});

test('combat sim: drones fly above the hero, fire bolts (dodgeable), are juggled by air strikes and dropped by yank or pin', () => {
  const ar = arenaOf(AR.INTERSECTION, 2);
  const run = (dodge: boolean) => {
    const sim = makeSim(31);
    const buf: CombatEvent[] = [];
    hero(sim, 1, ar.x, ar.y, ar.z);
    const id = sim.debugSpawn(EK.DRONE, ar.x + 9, ar.y + 4, ar.z + 3);
    let seq = 0,
      bolts = 0,
      hits = 0,
      misses = 0,
      minUp = Infinity,
      maxD = 0,
      nan = false,
      moved = 0;
    const dodged = new Set<number>();
    const start = sim.enemy(id)!.pos.clone();
    for (let s = 0; s < 30 * 20; s++) {
      hero(sim, 1, ar.x, ar.y, ar.z);
      if (dodge) {
        // Dodge each bolt 0.15 s before it reaches the chest.
        for (const p of sim.projectiles.list) {
          if (dodged.has(p.id) || p.tgt !== ME) continue;
          const d = Math.hypot(p.x - ar.x, p.y - (ar.y + 1.1), p.z - ar.z);
          if (d / Math.hypot(p.vx, p.vy, p.vz) < 0.15 + DT) {
            dodged.add(p.id);
            sim.intent(1, { k: 'dodge', seq: ++seq, t: sim.time });
          }
        }
      }
      sim.step();
      buf.length = 0;
      sim.drainEvents(buf);
      for (const e of buf) {
        if (e.e === 'proj' && e.src === id) bolts++;
        if (e.e === 'hit' && e.src === id && e.tgt === ME) hits++;
        if (e.e === 'miss' && e.src === id) misses++;
      }
      const e = sim.enemy(id)!;
      if (!Number.isFinite(e.pos.x + e.pos.y + e.pos.z)) nan = true;
      if (s > 90) {
        minUp = Math.min(minUp, e.pos.y - ar.y);
        maxD = Math.max(maxD, Math.hypot(e.pos.x - ar.x, e.pos.z - ar.z));
      }
      moved = Math.max(moved, e.pos.distanceTo(start));
    }
    return { bolts, hits, misses, minUp, maxD, nan, moved, hash: sim.hash() };
  };
  const plain = run(false);
  const dodged = run(true);
  const again = run(false);

  // Juggle: three air strikes from below-beside it KO a drone; each pops it up; KO'd it falls to the ground.
  const sim = makeSim(32);
  const buf: CombatEvent[] = [];
  const E = tuning.enemies;
  const saved = E.aggroRange;
  E.aggroRange = 0;
  const hx = ar.x,
    hy = ar.y + 3,
    hz = ar.z;
  const stepN = (n: number) => {
    for (let i = 0; i < n; i++) {
      sim.upsertHero({ pid: 1, x: hx, y: hy, z: hz, vx: 0, vy: 0, vz: 0, mode: 1, grounded: false, facing: 0, afk: false, t: sim.time });
      sim.step();
      sim.drainEvents(buf);
    }
  };
  const id = sim.debugSpawn(EK.DRONE, hx + 1.6, hy + 1.2, hz);
  stepN(2);
  let seq = 0;
  const pops: number[] = [];
  const states: number[] = [];
  for (let k = 0; k < 3; k++) {
    const e = sim.enemy(id)!;
    // The hero hangs right below-beside it (an air lunge ends there).
    sim.upsertHero({ pid: 1, x: e.pos.x - 1.4, y: e.pos.y - 1.1, z: e.pos.z, vx: 0, vy: 0, vz: 0, mode: 1, grounded: false, facing: 0, afk: false, t: sim.time });
    sim.intent(1, strike(++seq, id, MOVE.AIR, sim, e.pos.x - 1.4, e.pos.y - 1.1, e.pos.z, sim.time));
    sim.step();
    sim.drainEvents(buf);
    pops.push(sim.enemy(id)!.vel.y);
    states.push(sim.enemy(id)!.state);
    stepN(8);
  }
  const airHits = buf.filter((e) => e.e === 'hit' && e.tgt === id && e.src === ME) as Hit[];
  const rej = buf.filter((e) => e.e === 'rej');
  let fellTo = NaN;
  for (let s = 0; s < 30 * 3; s++) stepN(1);
  const ko = sim.enemy(id);
  if (ko) fellTo = ko.pos.y - kindInfo(EK.DRONE).radius - sim.world.supportHeight(ko.pos.x, ko.pos.z, ko.pos.y, 0).y;
  // Yank and pin drop a drone at once.
  const idY = sim.debugSpawn(EK.DRONE, hx + 6, hy + 2, hz + 2);
  const idP = sim.debugSpawn(EK.DRONE, hx - 6, hy + 2, hz - 2);
  stepN(2);
  sim.intent(1, { k: 'yank', seq: ++seq, target: idY, viewT: sim.time - DT, hx, hy, hz });
  sim.intent(1, { k: 'pin', seq: ++seq, target: idP, viewT: sim.time - DT, hx, hy, hz });
  stepN(1);
  const yState = sim.enemy(idY)!.state,
    pState = sim.enemy(idP)!.state,
    pWebbed = (sim.enemy(idP)!.flags & EF.WEBBED) !== 0;
  E.aggroRange = saved;
  const r = { plain, dodged, again: again.hash === plain.hash, pops, states, airHits: airHits.map((h) => [h.move, h.dmg, h.fl]), rej: rej.length, koState: ko?.state, fellTo, yState, pState, pWebbed };
  saveResult('combat-drone', r);
  console.log('combat drone', JSON.stringify(r));
  expect(plain.nan).toBe(false);
  expect(plain.moved).toBeGreaterThan(3);
  expect(plain.minUp).toBeGreaterThan(2.5);
  expect(plain.maxD).toBeLessThan(20);
  expect(plain.bolts).toBeGreaterThan(3);
  expect(plain.hits).toBeGreaterThan(0);
  expect(r.again).toBe(true);
  expect(dodged.bolts).toBeGreaterThan(3);
  expect(dodged.hits).toBe(0);
  expect(dodged.misses).toBeGreaterThan(0);
  expect(r.rej).toBe(0);
  expect(airHits.length).toBe(3);
  expect(airHits.every((h) => h.move === MOVE.AIR)).toBe(true);
  expect(pops[0]).toBeGreaterThan(1);
  expect(states[0]).toBe(ES.STAGGER);
  expect(r.koState).toBe(ES.KO);
  expect(Math.abs(fellTo)).toBeLessThan(0.1);
  expect(yState).toBe(ES.KO);
  expect(pState).toBe(ES.KO);
  expect(pWebbed).toBe(true);
});

test('combat sim: thugs throw bottles at a hero above them', () => {
  const ar = arenaOf(AR.STOREFRONT, 0);
  const sim = makeSim(41);
  const buf: CombatEvent[] = [];
  const [sx, sy, sz] = ar.spots[0]!;
  // The hero clings 5 m up, 4 m from a thug (a wall, a fire escape).
  const hx = sx + 4,
    hy = sy + 5,
    hz = sz;
  const id = sim.debugSpawn(EK.THUG, sx, sy + 0.5, sz);
  let bottles = 0,
    hits: Hit[] = [],
    ends = 0;
  for (let s = 0; s < 30 * 10; s++) {
    sim.upsertHero({ pid: 1, x: hx, y: hy, z: hz, vx: 0, vy: 0, vz: 0, mode: 4, grounded: false, facing: 0, afk: false, t: sim.time });
    sim.step();
    buf.length = 0;
    sim.drainEvents(buf);
    for (const e of buf) {
      if (e.e === 'proj' && e.src === id && e.kind === PK.BOTTLE) bottles++;
      if (e.e === 'projEnd') ends++;
      if (e.e === 'hit' && e.src === id && e.tgt === ME) hits.push(e);
    }
  }
  const r = { bottles, ends, hits: hits.map((h) => [h.move, h.dmg]) };
  console.log('combat bottles', JSON.stringify(r));
  expect(bottles).toBeGreaterThan(1);
  expect(ends).toBeGreaterThan(0);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((h) => h.move === ATK.BOTTLE && h.dmg === tuning.enemies.thug.bottleDamage)).toBe(true);
});

test('combat sim: a mixed roster is deterministic and stays out of geometry', () => {
  const runMixed = (seed: number) => {
    const ar = arenaOf(AR.INTERSECTION, 3);
    const sim = makeSim(seed, false, 30);
    const buf: CombatEvent[] = [];
    for (let i = 0; i < 15; i++) {
      const s = ar.spots[(i * 3 + 2) % ar.spots.length]!;
      sim.debugSpawn((i % 5) as 0, s[0], i % 5 === EK.DRONE ? s[1] + 4 : s[1] + 0.5, s[2]);
    }
    const hashes: string[] = [];
    let nan = 0,
      maxPen = 0,
      events = 0,
      seq = 0,
      stepMs = 0;
    for (let s = 0; s < 30 * 30; s++) {
      const a = s * DT * 0.4;
      const x = ar.x + Math.cos(a) * 6,
        z = ar.z + Math.sin(a) * 6;
      const y = sim.world.supportHeight(x, z, ar.y + 2, 0).y;
      sim.upsertHero({ pid: 1, x, y, z, vx: -Math.sin(a) * 2.4, vy: 0, vz: Math.cos(a) * 2.4, mode: 0, grounded: true, facing: 0, afk: false, t: sim.time });
      // Fight back now and then: the nearest enemy in reach, yank or pin the farther ones.
      if (s % 20 === 0) {
        let best = -1,
          bd = 1e9;
        for (const e of sim.enemies) {
          if (e.state === ES.KO) continue;
          const d = Math.hypot(e.pos.x - x, e.pos.z - z);
          if (d < bd) {
            bd = d;
            best = e.id;
          }
        }
        if (best > 0 && bd < 2.5) sim.intent(1, strike(++seq, best, chainMove(sim.hero(1)!.combo), sim, x, y, z));
        else if (best > 0 && s % 60 === 0) sim.intent(1, { k: s % 120 === 0 ? 'pin' : 'yank', seq: ++seq, target: best, viewT: sim.time - DT, hx: x, hy: y, hz: z });
      }
      const t0 = performance.now();
      sim.step();
      stepMs += performance.now() - t0;
      buf.length = 0;
      sim.drainEvents(buf);
      events += buf.length;
      for (const e of sim.enemies) {
        if (!Number.isFinite(e.pos.x + e.pos.y + e.pos.z)) nan++;
        const info = kindInfo(e.kind);
        if (!info.flyer) maxPen = Math.max(maxPen, sim.world.capsulePenetration(e.pos.x, e.pos.y, e.pos.z, info.radius, info.height));
      }
      if (s % 30 === 29) hashes.push(sim.hash());
    }
    return { hashes, nan, maxPen, events, msPerStep: stepMs / 900 };
  };
  const a = runMixed(77);
  const b = runMixed(77);
  console.log('combat mixed roster', JSON.stringify({ ...a, hashes: a.hashes.length }));
  expect(b.hashes).toEqual(a.hashes);
  expect(a.nan).toBe(0);
  expect(a.maxPen).toBeLessThan(0.03);
  expect(a.events).toBeGreaterThan(50);
  expect(a.msPerStep).toBeLessThan(2);
});
