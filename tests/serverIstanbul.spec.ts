import { test, expect } from '@playwright/test';
import { buildMapRuntime } from '../server/mapRuntime';
import { RoomManager, type Peer } from '../server/roomManager';
import { CombatRoomSim, combatSimFactory } from '../src/sim/combatRoomSim';
import { MAPS, MAP_IDS, isMapId } from '../src/net/maps';
import { MAP_IDS as CLIENT_MAP_IDS } from '../src/maps/ids';
import { AR, AR_NAMES, spotFree } from '../src/combat/spawnPoints';
import { EK } from '../src/combat/types';
import type { CombatSim } from '../src/combat/combatSim';
import type { ServerMsg } from '../src/net/protocol';
import { saveResult } from './helpers';

// M13 + M12: one map id list for the protocol, the server's public rooms and
// the client's map setting; an Istanbul public room runs CombatSim on the
// Istanbul world, with arenas of every type and enemies that stand there.

class FakePeer implements Peer {
  readonly got: Array<ServerMsg | Uint8Array> = [];
  deliver(m: ServerMsg | Uint8Array): void {
    this.got.push(m);
  }
  detach(): void {}
}

test('map ids: protocol, server and client agree', () => {
  expect([...MAP_IDS]).toEqual([...CLIENT_MAP_IDS]);
  expect(Object.keys(MAPS).sort()).toEqual([...CLIENT_MAP_IDS].sort());
  for (const id of CLIENT_MAP_IDS) expect(isMapId(id)).toBe(true);
  expect(isMapId('atlantis')).toBe(false);
});

test('istanbul room: arenas on the hills, a public room per map, enemies spawn and stand', () => {
  const t0 = Date.now();
  const rt = buildMapRuntime('istanbul');
  const buildMs = Date.now() - t0;
  expect(rt.layout.mapId).toBe('istanbul');
  const sp = rt.spawns;
  const counts = Object.fromEntries(AR_NAMES.map((n, i) => [n, sp.byType[i]!.length]));
  for (const t of [AR.STOREFRONT, AR.INTERSECTION, AR.ROOF, AR.AVENUE, AR.PLAZA, AR.PARK, AR.PIER]) expect(sp.byType[t]!.length, AR_NAMES[t]).toBeGreaterThan(0);
  expect(sp.loops.length).toBeGreaterThan(50);
  // Every spot stands on its arena's surface (terrain or roof), on land, with room for the brute.
  const w = rt.world;
  let spots = 0,
    bad = 0;
  const badSamples: Array<Record<string, unknown>> = [];
  for (const a of sp.arenas) {
    for (let i = 0; i < a.spots.length; i += 3) {
      const x = a.spots[i]!,
        y = a.spots[i + 1]!,
        z = a.spots[i + 2]!;
      spots++;
      const s = w.supportHeight(x, z, y + 1, 0);
      // Piers stand over the water on their decks; everything else on land, never under the ground.
      const wet = a.type !== AR.PIER && w.terrain.isWater(x, z);
      if (!spotFree(w, x, y, z) || Math.abs(s.y - y) > 0.06 || wet || y < w.terrain.height(x, z) - 0.06) {
        bad++;
        if (badSamples.length < 6) badSamples.push({ type: AR_NAMES[a.type], x, y, z, free: spotFree(w, x, y, z), sy: s.y, wet, h: w.terrain.height(x, z) });
      }
    }
  }
  expect(bad, JSON.stringify(badSamples)).toBe(0);

  // A public room on Istanbul, separate from Manhattan's.
  let sim: CombatSim | null = null;
  const mgr = new RoomManager({
    maxPlayersPerRoom: 16,
    maxRooms: 10,
    privateRoomIdleS: 60,
    reconnectGraceS: 30,
    testHooks: false,
    simFactory: (map, o) => {
      const s = combatSimFactory(map, o) as CombatRoomSim;
      if (map.id === 'istanbul') sim = s.sim;
      return s;
    },
  });
  const peer = new FakePeer();
  const r = mgr.hello(peer, { t: 'hello', v: 1, name: 'Gezgin', costume: 'redNavy', map: 'istanbul', join: { kind: 'public' } }, 0);
  expect(r.ok).toBe(true);
  expect(mgr.publicRooms('istanbul').length).toBe(1);
  expect(mgr.publicRooms('manhattan').length).toBe(0);
  expect(sim).not.toBeNull();
  const cs = sim as unknown as CombatSim;

  // Enemies at the arenas nearest the city spawn (street, crossing, roof, avenue, quay).
  const s0 = rt.layout.spawn;
  const spawned: number[] = [];
  for (const t of [AR.STOREFRONT, AR.INTERSECTION, AR.ROOF, AR.AVENUE, AR.PIER]) {
    const ids = [...sp.byType[t]!].sort((a, b) => Math.hypot(sp.arenas[a]!.x - s0[0], sp.arenas[a]!.z - s0[2]) - Math.hypot(sp.arenas[b]!.x - s0[0], sp.arenas[b]!.z - s0[2]) || a - b);
    const a = sp.arenas[ids[0]!]!;
    for (let k = 0; k < 3; k++) {
      const id = cs.debugSpawn(k === 2 ? EK.BAT : EK.THUG, a.spots[k * 3]!, a.spots[k * 3 + 1]!, a.spots[k * 3 + 2]!, -1, a.id);
      expect(id).toBeGreaterThan(0);
      spawned.push(id);
    }
  }
  for (let i = 0; i < 300; i++) mgr.tick(i * 33);
  for (let i = 0; i < 300; i++) cs.step();
  const report: Array<Record<string, unknown>> = [];
  let fallen = 0;
  for (const id of spawned) {
    const e = cs.enemy(id)!;
    expect(e).toBeTruthy();
    const p = e.pos;
    expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    const s = w.supportHeight(p.x, p.z, p.y + 0.5, 0.3);
    // Standing on its support (piers stand over the water), never in the water.
    if (p.y < w.terrain.waterLevelAt(p.x, p.z) || Math.abs(s.y - p.y) > 0.3) fallen++;
    report.push({ id, pos: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)], home: [+e.homeX.toFixed(1), +e.homeY.toFixed(1), +e.homeZ.toFixed(1)], sy: +s.y.toFixed(2), wet: w.terrain.isWater(p.x, p.z), hp: e.hp, state: e.state });
  }
  expect(fallen, JSON.stringify(report)).toBe(0);
  saveResult('server-istanbul', { buildMs, counts, loops: sp.loops.length, spots, enemies: report });
  console.log('istanbul room', JSON.stringify({ buildMs, counts, loops: sp.loops.length, spots }));
});
