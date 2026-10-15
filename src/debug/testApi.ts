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
  type BotInput,
} from './testDrivers';

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
    tuning,
    app,
    setManual(on: boolean): void {
      game.loop.manual = on;
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
    lifeTest: () => lifeTest(game),
    updateLife: (dt = 1 / 60) => game.updateLife(dt),
    simTiming(): { msPerTick: number; ticks: number } {
      return { msPerTick: game.simTimeMs / Math.max(1, game.simTicksMeasured), ticks: game.simTicksMeasured };
    },
  };
  window.__game = api as unknown as Record<string, unknown>;
}
