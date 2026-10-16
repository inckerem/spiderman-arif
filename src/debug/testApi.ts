import type { Game } from '../game';
import type { App } from '../app';
import { MODE_NAMES } from '../player/player';
import { tuning } from '../config/tuning';
import {
  anchorAvailability,
  cameraFollowTest,
  characterTest,
  lifeTest,
  lineControlsTest,
  lineEdgeCasesTest,
  trickReplayTest,
  dynResTest,
  ringTest,
  soakMinute,
  tunnelTest,
  catchTest,
  reattachLatency,
  cityRoute,
  emptyBotInput,
  fuzz,
  parkRoute,
  ropeTest,
  stepWithInput,
  traversalBot,
  attractTest,
  momentFrames,
  momentRoof,
  momentState,
  touchSpot,
  aimAt,
  planTarget,
  type BotInput,
} from './testDrivers';
import { goldenDigest } from './golden';
import { terrainSelfTest } from './terrainSelfTest';
import { landmarkTunnelTest } from './landmarkTests';
import { mapSwitchUrl } from '../maps/select';
import { getMap } from '../maps/registry';
import { buildCollisionWorld } from '../world/cityCollision';
import { makeAnchorResult } from '../player/targeting';
import { fillTickInput } from '../player/autopilot';
import { ES_NAMES, type EnemyKind } from '../combat/types';
import { CrimeDriver, combatHudDom } from './crimeDrivers';
import { combatComboTest, combatDodgeTest, combatDroneTest, combatLineTest, combatRoutingTest, combatShieldTest, combatShotTest } from './combatDrivers';

declare global {
  interface Window {
    __game?: Record<string, unknown>;
  }
}

/** Deterministic test API, installed in dev builds only. */
export function installTestApi(game: Game, app?: App): void {
  const held: BotInput = emptyBotInput();
  const prev: BotInput = emptyBotInput();
  const api = {
    ready: true,
    game,
    mapId: game.mapId,
    tuning,
    app,
    setManual(on: boolean): void {
      game.loop.manual = on;
      // The menu's attract mode never runs while tests step the game by hand.
      game.attractEnabled = !on;
      // Combat stays off in manual mode unless a test enables it (combat.enable), and never spawns on its own.
      game.combatEnabled = !on;
      // Crime events and roaming follow the setting outside manual mode, never in it.
      game.setCrimeEvents(game.crimeEvents);
      if (on) game.resetCombat();
      game.playing = true;
      game.view = 'play';
      // Deterministic stepping: the UI overlay is hidden unless a test shows it.
      api.showUi(false);
    },
    /** Run the app's per-frame UI/audio update once (manual mode has no frame hook). */
    uiFrame(dt = 1 / 60): void {
      (app as unknown as { frame(dt: number): void } | undefined)?.frame(dt);
    },
    /** Show or hide the DOM UI (menus, HUD) over the canvas for screenshots. */
    showUi(on: boolean): void {
      const root = document.getElementById('ui');
      if (root) root.style.display = on ? '' : 'none';
    },
    setInput(partial: Partial<BotInput>): void {
      Object.assign(held, partial);
    },
    /** Real-time loop (online tests): every tick takes the held input (setInput) instead of the keyboard; false restores it. */
    realtimeInput(on: boolean): void {
      if (on) {
        const last = emptyBotInput();
        game.injectInput = (out) => {
          fillTickInput(out, held, last);
          Object.assign(last, held);
        };
      } else game.injectInput = null;
    },
    /** Skip the final draw of every frame (simulation, network and animation still run); screenshots turn it back on. */
    drawPaused(on: boolean): void {
      game.drawPaused = on;
    },
    /** Start real-time play without the pointer lock (headless online tests). */
    forcePlay(): void {
      game.input.enabled = true;
      game.playing = true;
      game.view = 'play';
      app?.ui.showClickToResume(false);
    },
    setLook(yaw: number, pitch: number): void {
      game.rig.setLook(yaw, pitch);
    },
    step(n: number): unknown {
      for (let i = 0; i < n; i++) stepWithInput(game, held, prev);
      return api.state();
    },
    state(): Record<string, unknown> {
      const p = game.player;
      return {
        pos: [p.pos.x, p.pos.y, p.pos.z],
        vel: [p.vel.x, p.vel.y, p.vel.z],
        speed: p.speed,
        mode: MODE_NAMES[p.mode],
        grounded: p.grounded,
        rope: { attached: p.rope.attached, anchor: [p.rope.anchor.x, p.rope.anchor.y, p.rope.anchor.z], length: p.rope.length, good: p.rope.goodWindow },
        swingTarget: p.swingTarget.valid,
        zipTarget: p.zipTarget.valid,
        camera: [game.rig.position.x, game.rig.position.y, game.rig.position.z],
        yaw: game.rig.yaw,
        pitch: game.rig.pitch,
        stats: { ...p.stats },
        events: game.eventLog.slice(-20).map((e) => e.type),
      };
    },
    teleport(x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): void {
      game.player.teleport(x, y, z, vx, vy, vz);
      game.prevPos.copy(game.player.pos);
      game.snapCamera();
    },
    renderFrame(): Record<string, number> {
      game.renderOnce();
      const info = game.renderer.info;
      return { calls: game.frameStats.calls, triangles: game.frameStats.triangles, geometries: info.memory.geometries, textures: info.memory.textures };
    },
    setTime(hour: number): void {
      game.dayNight.setHour(hour);
      game.dayNight.apply();
    },
    /** Place the camera at a fixed pose (photo checks): position and look-at target. */
    setCameraPose(x: number, y: number, z: number, tx: number, ty: number, tz: number, fov = 70): void {
      const cam = game.rig.camera;
      game.cameraOverride = { x, y, z, tx, ty, tz, fov };
      cam.position.set(x, y, z);
      cam.fov = fov;
      cam.lookAt(tx, ty, tz);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
    },
    clearCameraPose(): void {
      game.cameraOverride = null;
    },
    setQuality(i: number): void {
      game.applyQuality(i);
    },
    stats(): Record<string, number> {
      game.renderFrame(0);
      const info = game.renderer.info;
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return {
        calls: game.frameStats.calls,
        triangles: game.frameStats.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length ?? 0,
        heapMB: mem ? mem.usedJSHeapSize / 1048576 : -1,
        internalWidth: game.post.internalWidth,
        internalHeight: game.post.internalHeight,
      };
    },
    layoutStats(): unknown {
      return { ...game.layout.stats, colliders: game.world.count, park: game.layout.park, spawn: game.layout.spawn };
    },
    ropeTest: (withDrag: boolean) => ropeTest(game, withDrag),
    catchTest: () => catchTest(game),
    reattachLatency: () => reattachLatency(game),
    lineControlsTest: () => lineControlsTest(game),
    lineEdgeCasesTest: () => lineEdgeCasesTest(game),
    trickReplayTest: () => trickReplayTest(game),
    dynResTest: () => dynResTest(game),
    cameraFollowTest: () => cameraFollowTest(game),
    fuzz: (seed: number, seconds: number) => fuzz(game, seed, seconds),
    anchorAvailability: (seed: number, count: number) => anchorAvailability(game, seed, count),
    cityBot: (maxSeconds = 300) => traversalBot(game, 'city', cityRoute(game), maxSeconds),
    parkBot: (maxSeconds = 200, diag = false) => traversalBot(game, 'park', parkRoute(game), maxSeconds, undefined, diag),
    cityBotDiag: (maxSeconds = 300) => traversalBot(game, 'city', cityRoute(game), maxSeconds, undefined, true),
    /** Run a traversal bot until `stop` returns true (screenshots of live states). */
    botUntil: (which: 'city' | 'park', maxSeconds: number, stop: () => boolean) =>
      traversalBot(game, which, which === 'city' ? cityRoute(game) : parkRoute(game), maxSeconds, undefined, false, stop),
    characterTest: () => characterTest(game),
    ringTest: () => ringTest(game),
    soakMinute: (minute: number) => soakMinute(game, app, minute),
    tunnelTest: (trials = 300) => tunnelTest(game, trials),
    /** 95 m/s impacts into landmark and bridge parts: minarets, towers, cable chains (M13). */
    landmarkTunnelTest: (trials = 300) => landmarkTunnelTest(game, trials),
    lifeTest: () => lifeTest(game),
    /** Attract mode headless (dev-only hook; the real loop never runs it in manual mode). */
    attractTest: (seconds = 240, seed = 1) => attractTest(game, seconds, seed),
    momentRoof: () => momentRoof(game),
    momentState: () => (app ? momentState(game, app) : null),
    /** Frames of play with the held input (the app's per-frame update drives the rooftop moment). */
    momentFrames: (seconds: number, sample = 0) => (app ? momentFrames(game, app, held, prev, seconds, sample) : null),
    updateLife: (dt = 1 / 60) => game.updateLife(dt),
    /** Hash of layout, colliders and deterministic driver outputs (M13 refactor gate). */
    goldenDigest: (attractSeconds = 120) => goldenDigest(game, attractSeconds),
    /** Heightfield terrain, water mask and road index checks (Istanbul data). */
    terrainSelfTest: (rays = 20000, points = 100000) => terrainSelfTest(rays, points),
    /** Times a fresh generation of this map (layout, terrain, colliders) in ms. */
    timeGeneration(): Record<string, number> {
      const map = getMap(game.mapId);
      const t0 = performance.now();
      const L = map.generate(game.layout.seed);
      const t1 = performance.now();
      const w = buildCollisionWorld(L, map);
      const t2 = performance.now();
      return { layoutMs: t1 - t0, collisionMs: t2 - t1, totalMs: t2 - t0, colliders: w.count, buildings: L.buildings.length };
    },
    /** What the traversal bots must reach on this map (minimum city distance, tree-only park). */
    routeExpect: () => getMap(game.mapId).routes.expect,
    /** The URL a map switch reloads to. */
    mapUrl: (id: string) => mapSwitchUrl(location.href, id as Parameters<typeof mapSwitchUrl>[1]),
    /** Touch spec: a place to measure a control (the real-time loop keeps running). */
    touchSpot: (kind: 'avenue' | 'wall' | 'air') => touchSpot(game, kind),
    /** Points the crosshair at the best swing anchor in view; false when there is none. */
    aimAtAnchor(): boolean {
      const t = makeAnchorResult();
      if (!planTarget(game, 0, t)) return false;
      aimAt(game, t.x, t.y, t.z);
      return true;
    },
    combat: {
      /** Turn combat on or off (manual mode starts with it off). */
      enable(on = true): void {
        game.combatEnabled = on;
      },
      /** Spawn an enemy standing at (x, z) (snapped to the support below y + 1); returns its id or -1. */
      spawn(kind: number, x: number, y: number, z: number): number {
        const id = game.combatSim.debugSpawn(kind as EnemyKind, x, y, z);
        game.combatLink.sync();
        game.combatView.update(game.combatLink.now(), game.combatLink.now());
        return id;
      },
      /** Spawn `dist` m ahead of the camera on the hero's level (yaw only); returns its id or -1. */
      spawnAhead(kind: number, dist: number, side = 0): number {
        const p = game.player.pos;
        const yaw = game.rig.yaw;
        const fx = -Math.sin(yaw),
          fz = -Math.cos(yaw);
        return api.combat.spawn(kind, p.x + fx * dist + fz * side, p.y + 0.5, p.z + fz * dist - fx * side);
      },
      /** Spawn spots ([x, y, z]) of the k-th arena of a type (spawnPoints `AR`) nearest the city spawn. */
      arenaSpots(type = 0, k = 0): Array<[number, number, number]> {
        const sp = game.spawns;
        const s = game.layout.spawn;
        const ids = [...sp.byType[type]!].sort((a, b) => {
          const A = sp.arenas[a]!,
            B = sp.arenas[b]!;
          return Math.hypot(A.x - s[0], A.z - s[2]) - Math.hypot(B.x - s[0], B.z - s[2]) || a - b;
        });
        const a = sp.arenas[ids[k]!]!;
        const out: Array<[number, number, number]> = [];
        for (let i = 0; i < a.spots.length; i += 3) out.push([a.spots[i]!, a.spots[i + 1]!, a.spots[i + 2]!]);
        return out;
      },
      /** Enemies as this client sees them (interpolated view). */
      enemies(): Array<Record<string, unknown>> {
        return game.combatView.enemies.map((e) => ({
          id: e.id,
          kind: e.kind,
          state: ES_NAMES[e.state],
          pos: [e.x, e.y, e.z],
          yaw: e.yaw,
          hp: e.hp,
          maxHp: e.maxHp,
          flags: e.flags,
          target: e.target,
        }));
      },
      /** Enemies in the sim itself (authoritative positions). */
      simEnemies(): Array<Record<string, unknown>> {
        return game.combatSim.enemies.map((e) => ({ id: e.id, kind: e.kind, state: ES_NAMES[e.state], pos: [e.pos.x, e.pos.y, e.pos.z], hp: e.hp, flags: e.flags }));
      },
      /** Remove every enemy. */
      clear(): void {
        game.combatSim.debugClear();
        game.combatLink.sync();
      },
      /** Set the hero's health (0 knocks it down at the next step). */
      setHp(v: number): void {
        game.combatSim.debugSetHp(game.combatLink.selfPid, v);
        game.combatLink.sync();
      },
      killAll(): void {
        game.combatSim.debugKillAll();
        game.combatLink.sync();
      },
      /** Step the combat sim alone `n` times (the hero is not moved). */
      stepSim(n = 1): void {
        for (let i = 0; i < n; i++) game.combatLink.stepNow();
        game.combatView.update(game.combatLink.now(), game.combatLink.renderTime());
      },
      startEvent: (type: 'robbery' | 'gang' | 'drones' | 'boss', x?: number, z?: number, boss?: number) => game.combatSim.startEvent(type, x, z, boss),
      setScheduler(on: boolean): void {
        game.combatSim.scheduler = on;
        game.combatSim.roaming = on;
      },
      /** Point the crosshair at an enemy's chest. */
      aimAt(id: number): boolean {
        const e = game.combatView.enemy(id);
        if (!e) return false;
        aimAt(game, e.x, e.y + 1.1, e.z);
        return true;
      },
      /** The hero's side: router counters, mode, combat animation, knocked out. */
      hero(): Record<string, unknown> {
        const p = game.player;
        return { stats: { ...game.heroCombat.stats }, hud: { ...game.heroCombat.hud, threat: null }, mode: MODE_NAMES[p.mode], strike: { ...p.strike }, anim: { ...p.combatAnim }, down: p.down };
      },
      routingTest: () => combatRoutingTest(game),
      comboTest: () => combatComboTest(game),
      lineTest: () => combatLineTest(game),
      dodgeTest: () => combatDodgeTest(game),
      shotTest: () => combatShotTest(game),
      shieldTest: () => combatShieldTest(game),
      droneTest: () => combatDroneTest(game),
      /** Crime events (chunk 7): what this client knows, the HUD's DOM, and the event driver (announce, then the bot). */
      crimes: () => game.combatView.crimes.map((c) => ({ ...c })),
      hudDom: () => combatHudDom(),
      crimeDriver: null as CrimeDriver | null,
      crimeAnnounce(): Record<string, unknown> {
        api.combat.crimeDriver?.restore();
        api.combat.crimeDriver = new CrimeDriver(game, app);
        return api.combat.crimeDriver.announce();
      },
      crimeBot(limit = 240, stop?: () => boolean): Record<string, unknown> {
        const d = api.combat.crimeDriver;
        if (!d) return { error: 'no driver' };
        const r = d.crimeBot(limit, stop);
        d.restore();
        api.combat.crimeDriver = null;
        return r;
      },
      /** Own combat state and the recent combat events (room time, event). */
      state(): Record<string, unknown> {
        const v = game.combatView;
        const h = game.combatSim.hero(game.combatLink.selfPid);
        return {
          enabled: game.combatEnabled,
          now: game.combatLink.now(),
          hp: v.self.hp,
          down: v.self.down,
          combo: v.self.combo,
          comboUntil: v.self.comboUntil,
          focus: v.self.focus,
          threat: v.threat ? { ...v.threat } : null,
          simHero: h ? { pos: [h.x, h.y, h.z], hp: h.hp, down: h.down } : null,
          enemies: v.enemies.length,
          events: v.recentEvents().slice(-48).map((l) => ({ time: l.time, ...l.ev })),
        };
      },
    },
    simTiming(): { msPerTick: number; ticks: number } {
      return { msPerTick: game.simTimeMs / Math.max(1, game.simTicksMeasured), ticks: game.simTicksMeasured };
    },
  };
  window.__game = api as unknown as Record<string, unknown>;
}
