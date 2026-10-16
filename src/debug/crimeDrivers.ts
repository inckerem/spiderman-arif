import { tuning } from '../config/tuning';
import type { Game } from '../game';
import type { App } from '../app';
import { MODE_NAMES } from '../player/player';
import { AR } from '../combat/spawnPoints';
import { EF, EK, ES, HERO_ID_BASE, type CombatEvent } from '../combat/types';
import { kindInfo } from '../combat/roster';
import { aimAt, emptyBotInput, stepWithInput, type BotInput } from './testDrivers';

// In-page crime-event drivers (dev builds, manual mode, combat switched on):
// an event announced in the distance (marker, beacon, banner), then a simple
// combat bot that clears it, and the HUD's health bar under damage and
// regeneration. They return numbers and DOM readings for tests/combat.spec.ts.

type R = Record<string, unknown>;

/** Text and classes of the combat HUD's parts (what a player sees). */
export function combatHudDom(): R {
  const q = (sel: string): HTMLElement | null => document.querySelector(sel);
  const on = (sel: string): boolean => q(sel)?.classList.contains('is-on') ?? false;
  const text = (sel: string): string => q(sel)?.textContent ?? '';
  const box = (sel: string): number[] | null => {
    const e = q(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return [r.left, r.top, r.right, r.bottom];
  };
  const segs = [...document.querySelectorAll<HTMLElement>('.sk-ch-seg-fill')].map((s) => {
    const m = /scaleX\(([\d.]+)\)/.exec(s.style.transform);
    return m ? Number(m[1]) : 1;
  });
  return {
    layer: on('.sk-ch'),
    hp: text('.sk-ch-num'),
    segs: segs.reduce((a, b) => a + b, 0),
    regen: q('.sk-ch-vitals')?.classList.contains('is-regen') ?? false,
    banner: on('.sk-ch-banner'),
    bannerTitle: text('.sk-ch-banner-title'),
    bannerSub: text('.sk-ch-banner-sub'),
    marker: on('.sk-ch-marker'),
    markerOff: q('.sk-ch-marker')?.classList.contains('is-off') ?? false,
    markerText: text('.sk-ch-marker-text'),
    target: on('.sk-ch-target'),
    objective: on('.sk-ch-obj'),
    objectiveText: text('.sk-ch-obj-text'),
    targetName: text('.sk-ch-target-name'),
    sense: on('.sk-ch-sense'),
    dodge: on('.sk-ch-dodge'),
    dodgeText: text('.sk-ch-dodge'),
    combo: on('.sk-ch-combo'),
    comboText: text('.sk-ch-combo-num'),
    score: text('.sk-ch-score-num'),
    down: on('.sk-ch-down'),
    boxes: { vitals: box('.sk-ch-vitals'), banner: box('.sk-ch-banner'), marker: box('.sk-ch-marker-text'), target: box('.sk-ch-target-name') },
  };
}

/**
 * Crime events end to end. Part 1: the hero stands at a street arena, a
 * robbery is started at a storefront 250-450 m away; after the
 * announcement the view, the minimap layer, the beacon and the HUD (banner,
 * marker) show it. Part 2 (`crimeBot`): the hero is put at the edge of the
 * arena and a bot clears it.
 */
export class CrimeDriver {
  readonly inp: BotInput = emptyBotInput();
  private readonly prev: BotInput = emptyBotInput();
  private readonly all: CombatEvent[] = [];
  private readonly hook: Game['onCombatEvent'];
  eventId = -1;

  constructor(
    readonly game: Game,
    readonly app: App | undefined,
  ) {
    game.combatEnabled = true;
    game.resetCombat();
    app?.combatUi.reset();
    this.hook = game.onCombatEvent;
    game.onCombatEvent = (e) => {
      this.all.push(e);
      this.hook?.(e);
    };
  }

  restore(): void {
    this.game.injectInput = null;
    this.game.onCombatEvent = this.hook;
  }

  step(n = 1): void {
    for (let i = 0; i < n; i++) stepWithInput(this.game, this.inp, this.prev);
  }

  /** Steps with the app's frame (HUD, minimap, beacon) every 4th tick. */
  play(seconds: number, each?: () => void): void {
    const n = Math.round(seconds * 120);
    for (let i = 0; i < n; i++) {
      each?.();
      this.step(1);
      if (i % 4 === 3) this.frame();
    }
  }

  frame(): void {
    (this.app as unknown as { frame(dt: number): void } | undefined)?.frame(1 / 30);
    this.game.updateCameraForTest();
  }

  place(x: number, y: number, z: number, yaw: number, pitch = -0.05): void {
    const g = this.game;
    Object.assign(this.inp, emptyBotInput());
    g.player.teleport(x, y, z);
    g.prevPos.copy(g.player.pos);
    g.rig.setLook(yaw, pitch);
    g.snapCamera();
    this.step(10);
  }

  events(): CombatEvent[] {
    return this.all;
  }

  /** Part 1: a robbery announced 250-450 m away, looked at from the street. */
  announce(): R {
    const g = this.game;
    const sp = g.spawns;
    const s = g.layout.spawn;
    // The street arena nearest the city spawn, and a storefront 250-450 m from it.
    const near = [...sp.byType[AR.INTERSECTION]!].map((id) => sp.arenas[id]!).sort((a, b) => Math.hypot(a.x - s[0], a.z - s[2]) - Math.hypot(b.x - s[0], b.z - s[2]))[0]!;
    const shop = sp.byType[AR.STOREFRONT]!.map((id) => sp.arenas[id]!).find((a) => {
      const d = Math.hypot(a.x - near.x, a.z - near.z);
      return d > 250 && d < 450;
    })!;
    const yaw = Math.atan2(-(shop.x - near.x), -(shop.z - near.z));
    this.place(near.x, near.y + 0.1, near.z, yaw, 0.08);
    this.eventId = g.combatSim.startEvent('robbery', shop.x, shop.z);
    const announced = g.combatView.crimes.length;
    this.play(0.5);
    const atAnnounce = combatHudDom();
    // The wave spawns after the announcement.
    this.play(tuning.events.announceTime + 0.5);
    g.renderOnce();
    const ev = g.combatSim.events.find((e) => e.id === this.eventId);
    const ui = this.app?.combatUi;
    return {
      eventId: this.eventId,
      dist: Math.hypot(shop.x - near.x, shop.z - near.z),
      viewCrimes: g.combatView.crimes.length,
      announcedInView: announced,
      total: ev?.total ?? 0,
      left: ev?.enemiesLeft ?? 0,
      waveInSim: g.combatSim.enemies.filter((e) => e.eventId === this.eventId).length,
      beacons: g.beacons.mesh.count,
      beaconVisible: g.beacons.mesh.visible,
      minimap: ui ? { ...ui.minimapStats } : null,
      atAnnounce,
      hud: combatHudDom(),
      starts: this.all.filter((e) => e.e === 'evStart').length,
    };
  }

  /**
   * Part 2: the bot, put at the arena's edge, fights until the event clears
   * (or `limit` seconds): it yanks gunmen and the brute's shield from range,
   * walks up to the nearest event enemy, presses F (auto-target strike) in
   * reach, and Space when the dodge cue says so. Knocked out, it waits for
   * the roof respawn and is put back at the arena (a shortcut, not swinging).
   */
  crimeBot(limit = 240, stop?: () => boolean): R {
    const g = this.game;
    const ev = g.combatSim.events.find((e) => e.id === this.eventId);
    if (!ev) return { error: 'no event' };
    const ex = ev.x,
      ez = ev.z;
    const startAt = () => {
      const p = g.player.pos;
      const yaw = Math.atan2(-(ex - p.x), -(ez - p.z));
      const a = g.spawns.arenas[ev.arena]!;
      // The spot farthest from the centre (the arena's edge), facing in.
      let best = 0;
      for (let i = 0; i < a.spots.length; i += 3) if (Math.hypot(a.spots[i]! - ex, a.spots[i + 2]! - ez) > Math.hypot(a.spots[best]! - ex, a.spots[best + 2]! - ez)) best = i;
      const sx = a.spots[best]!,
        sz = a.spots[best + 2]!;
      this.place(sx, a.spots[best + 1]! + 0.1, sz, Math.atan2(-(ex - sx), -(ez - sz)) || yaw);
    };
    startAt();
    const from = this.all.length;
    const me = HERO_ID_BASE + g.combatLink.selfPid;
    let t = 0,
      downs = 0,
      dodges = 0,
      presses = 0,
      yanks = 0,
      wasDown = false,
      nextPress = 0,
      nextYank = 0,
      lastThreat = '',
      ended: CombatEvent | null = null,
      hpMin = 100;
    const N = Math.round(limit * 120);
    for (let i = 0; i < N && !ended && !stop?.(); i++) {
      t = i / 120;
      const inp = this.inp;
      inp.attack = false;
      inp.jump = false;
      inp.zip = false;
      inp.moveX = 0;
      inp.moveY = 0;
      const view = g.combatView;
      const self = view.self;
      hpMin = Math.min(hpMin, self.hp);
      if (self.down) wasDown = true;
      else if (wasDown) {
        wasDown = false;
        downs++;
        this.step(30);
        startAt();
        continue;
      }
      if (!self.down) {
        // Dodge on the cue.
        const th = view.threat;
        const now = g.combatLink.now();
        if (th && th.at - now <= tuning.combat.dodgeLookahead * 0.6 && th.at - now >= -0.03) {
          const key = `${th.src}:${th.at.toFixed(2)}`;
          if (key !== lastThreat) {
            lastThreat = key;
            inp.jump = true;
            dodges++;
          }
        }
        // Target: the nearest standing enemy of the event (sim ids; the view has their positions).
        const p = g.player.pos;
        let tgt = -1,
          td = 1e9;
        for (const e of g.combatSim.enemies) {
          if (e.eventId !== ev.id || e.state === ES.KO) continue;
          const d = Math.hypot(e.pos.x - p.x, e.pos.z - p.z);
          if (d < td) {
            td = d;
            tgt = e.id;
          }
        }
        const ve = tgt >= 0 ? view.enemy(tgt) : undefined;
        if (ve && !inp.jump) {
          const info = kindInfo(ve.kind as 0);
          const shield = ve.kind === EK.BRUTE && ve.guard > 0 && (ve.flags & EF.SHIELDLESS) === 0;
          const gun = ve.kind === EK.GUNMAN && (ve.flags & EF.DISARMED) === 0;
          const chestY = info.flyer ? ve.y : ve.y + info.height * 0.6;
          if ((shield || gun) && td > 3.5 && td < 30 && t >= nextYank) {
            aimAt(g, ve.x, chestY, ve.z);
            inp.zip = true;
            nextYank = t + 0.7;
            yanks++;
          } else if (td > 6) {
            g.rig.setLook(Math.atan2(-(ve.x - p.x), -(ve.z - p.z)), -0.05);
            inp.moveY = 1;
          } else if (t >= nextPress) {
            aimAt(g, ve.x, chestY, ve.z);
            inp.attack = true;
            nextPress = t + 0.26;
            presses++;
          }
        }
      }
      this.step(1);
      if (i % 8 === 7) this.frame();
      for (let k = from; k < this.all.length; k++) {
        const e = this.all[k]!;
        if (e.e === 'evEnd' && e.id === ev.id) ended = e;
      }
    }
    Object.assign(this.inp, emptyBotInput());
    if (!stop) this.step(2);
    this.frame();
    const evs = this.all.slice(from);
    const hits = evs.filter((e) => e.e === 'hit' && e.src === me && e.dmg > 0).length;
    const hurt = evs.filter((e) => e.e === 'hit' && e.tgt === me && e.dmg > 0).length;
    return {
      seconds: t,
      ended,
      downs,
      dodges,
      presses,
      yanks,
      hits,
      hurt,
      hpMin,
      misses: evs.filter((e) => e.e === 'miss' && e.tgt === me).length,
      focus: g.combatView.self.focus,
      score: this.app?.combatUi.score ?? 0,
      mode: MODE_NAMES[g.player.mode],
      hud: combatHudDom(),
      viewCrimes: g.combatView.crimes.length,
    };
  }
}
