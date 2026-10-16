import { Vector3 } from 'three';
import type { AudioEngine } from './audio/audio';
import type { CombatSound } from './audio/combatSfx';
import { tuning } from './config/tuning';
import type { Game } from './game';
import type { RooftopMoment } from './extras/rooftopMoment';
import { tr } from './i18n/tr';
import type { PlayerEvent } from './player/player';
import { kindInfo } from './combat/roster';
import { ATK, EF, EK, ES, HERO_ID_BASE, HIT, MOVE, PK, type CombatEvent, type CrimeEventInfo } from './combat/types';
import { CombatHud, makeCombatHudState, type ScreenMark } from './ui/combatHud';
import { paintMinimapCombat, type MinimapCombatStats } from './ui/minimapCombat';
import { primaryLabel } from './ui/keyLabels';
import type { UI } from './ui/ui';

/** Sounds this far away are silent (m); gunshots carry farther. */
const HEAR = 70;
const HEAR_SHOT = 140;
/** The drone whir is heard within this distance (m). */
const HUM_RANGE = 45;
/** The target bar shows for an engaged enemy within this distance (m). */
const TARGET_RANGE = 40;
/** Enemies alerted on the hero within this distance (m) keep the rooftop moment from arming and end it. */
const MOMENT_ENEMY_RANGE = 80;
/** Projectile kinds remembered for their `projEnd` (bottles smash). */
const PROJ_MEMORY = 64;

interface PendingBanner {
  kind: 'start' | 'clear' | 'expire' | 'fail';
  title: string;
  sub: string;
  type: string;
  sound: CombatSound | null;
}

/**
 * App-level combat presentation (M11 chunk 7): feeds the combat HUD, the
 * minimap layer and the world-space event marker from the client's
 * `CombatView`, turns combat events into banners and synthesized sounds,
 * keeps the drone whir on the nearest drone, keeps the session score, and
 * mediates with the rooftop moment: the moment does not arm while enemies
 * are engaged or an event is close by, a hit or an engaging enemy ends it,
 * and an event announced during it is held back (banner and sting) until the
 * moment is over, unless it starts close by, which ends the moment.
 */
export class CombatUi {
  readonly hud = new CombatHud();
  private readonly st = makeCombatHudState();
  private readonly target: { name: string; hp: number; guard: boolean; x: number; y: number } = { name: '', hp: 1, guard: false, x: 0, y: 0 };
  private readonly threat = { angle: 0, now: false };
  private readonly mark: ScreenMark = { x: 0, y: 0, onScreen: false, angle: 0 };
  private readonly marker = { mark: this.mark, label: '', type: '' };
  private readonly objective = { text: '', type: '' };
  private readonly v = new Vector3();
  private readonly known = new Map<number, CrimeEventInfo>();
  private readonly projKinds = new Map<number, number>();
  private readonly pending: PendingBanner[] = [];
  private lastHp = 100;
  private regenT = 0;
  private threatKey = '';
  private live = false;
  /** The objective chip while the hero is at an event (set by `eventMarker`). */
  private atEvent: CombatUi['objective'] | null = null;
  /** Session score from cleared events (this client's hero). */
  score = 0;
  /** What the minimap layer drew last (tests). */
  readonly minimapStats: MinimapCombatStats = { events: 0, rim: 0, enemies: 0 };

  constructor(
    private readonly game: Game,
    private readonly ui: UI,
    private readonly audio: AudioEngine,
    private readonly moment: RooftopMoment,
    private readonly touch: boolean,
  ) {
    ui.mountHud(this.hud.el);
    ui.setMinimapOverlay((g, R, k, cos, sin, u, px, pz) => {
      if (this.live && game.combatEnabled) paintMinimapCombat(g, game.combatView, R, k, cos, sin, u, px, pz, this.minimapStats);
    });
    const prev = game.onCombatEvent;
    game.onCombatEvent = (e) => {
      prev?.(e);
      this.onEvent(e);
    };
    moment.blocked = () => this.engaged(true);
  }

  /** A new game: score and pending banners start over. */
  reset(): void {
    this.score = 0;
    this.pending.length = 0;
    this.hud.hideBanner();
    this.known.clear();
    this.projKinds.clear();
  }

  /**
   * Once per frame. `live`: in play or paused under a menu (the HUD state is
   * kept); `playing`: the simulation runs (sounds that loop only then).
   */
  frame(dt: number, live: boolean, playing: boolean): void {
    const game = this.game;
    this.live = live;
    const s = this.st;
    s.on = live && game.combatEnabled;
    if (!s.on) {
      this.hud.update(dt, s);
      this.audio.droneHum(0, 0);
      return;
    }
    const view = game.combatView;
    const link = game.combatLink;
    const now = link.now();
    const self = view.self;
    const pl = game.player;
    s.hp = self.hp;
    s.maxHp = self.maxHp;
    // Regeneration: health rising (held a moment so the colour does not flicker between snapshots).
    if (self.hp > this.lastHp + 1e-3 && !self.down) this.regenT = 0.4;
    else this.regenT = Math.max(0, this.regenT - dt);
    this.lastHp = self.hp;
    s.regen = this.regenT > 0;
    s.down = self.down;
    s.downLeft = Math.max(0, self.downUntil - now);
    const hc = game.heroCombat.hud;
    s.combo = hc.combo;
    s.comboLeft = hc.combo > 0 ? Math.max(0, Math.min(1, (self.comboUntil - now) / tuning.combat.comboWindow)) : 0;
    s.focus = self.focus;
    s.score = this.score;
    s.dodgeKey = this.touch ? tr.touch.jump.toLocaleUpperCase('tr') : (primaryLabel(this.ui.settings.bindings.jump) ?? '');
    s.takedownKey = this.touch ? '' : (primaryLabel(this.ui.settings.bindings.finisher) ?? '');
    s.target = this.pickTarget(hc.target);
    s.threat = this.threatInfo(now);
    s.marker = this.eventMarker();
    s.objective = this.atEvent;
    // Deferred banners (held during the rooftop moment's cinematic).
    if (!this.moment.cine && this.pending.length > 0 && !this.hud.bannerShown) {
      const b = this.pending.shift()!;
      this.hud.showBanner(b.kind, b.title, b.sub, b.type);
      if (b.sound) this.audio.combat(b.sound);
    }
    this.hud.update(dt, s);
    // Enemies engaging the hero end a running rooftop moment.
    if (this.moment.cine && this.engaged(false)) this.moment.interrupt();
    // Drone whir: the nearest flying drone.
    let best = HUM_RANGE,
      bx = 0,
      bz = 0;
    if (playing) {
      for (const e of view.enemies) {
        if (e.kind !== EK.DRONE || e.state === ES.KO) continue;
        const d = Math.hypot(e.x - pl.pos.x, e.y - pl.pos.y, e.z - pl.pos.z);
        if (d < best) {
          best = d;
          bx = e.x;
          bz = e.z;
        }
      }
    }
    if (best < HUM_RANGE) this.audio.droneHum(Math.pow(1 - best / HUM_RANGE, 1.5), this.pan(bx, bz));
    else this.audio.droneHum(0, 0);
  }

  /** Player events with a combat sound (the dodge whoosh). */
  onPlayerEvent(e: PlayerEvent): void {
    if (e.type === 'dodge') this.audio.combat('dodge');
  }

  /**
   * Combat that keeps the rooftop moment away: an enemy alerted on the hero
   * within 80 m, or (`withEvents`) an active event within its expire radius.
   */
  engaged(withEvents: boolean): boolean {
    const game = this.game;
    if (!game.combatEnabled) return false;
    const view = game.combatView;
    const p = game.player.pos;
    const me = view.selfId;
    for (const e of view.enemies) {
      if (e.state === ES.KO || (e.flags & EF.ALERTED) === 0 || e.target !== me) continue;
      if (Math.hypot(e.x - p.x, e.z - p.z) < MOMENT_ENEMY_RANGE) return true;
    }
    if (withEvents) for (const ev of view.crimes) if (Math.hypot(ev.x - p.x, ev.z - p.z) < tuning.events.expireRadius) return true;
    return false;
  }

  // ---------------------------------------------------------------------------

  private onEvent(e: CombatEvent): void {
    const game = this.game;
    const view = game.combatView;
    const me = view.selfId;
    const a = this.audio;
    switch (e.e) {
      case 'hit': {
        if (e.tgt === me) {
          if (e.dmg > 0) {
            a.combat('hurt');
            this.hud.hurt();
            this.moment.interrupt();
          }
          break;
        }
        const en = view.enemy(e.tgt);
        const g = en ? this.gain(en.x, en.y, en.z, HEAR) : e.src === me ? 1 : 0;
        const pan = en ? this.pan(en.x, en.z) : 0;
        if (e.src === me) {
          if ((e.fl & HIT.BLOCKED) !== 0) a.combat('block', g, pan);
          else if (e.move !== MOVE.PIN && e.move !== MOVE.YANK) {
            const heavy = e.move === MOVE.KICK || e.move === MOVE.UPPER || e.move === MOVE.GROUND || e.move === MOVE.TAKEDOWN;
            a.combat(heavy ? 'kick' : 'punch', g, pan, view.self.combo);
          }
        }
        if ((e.fl & HIT.KO) !== 0 && e.tgt < HERO_ID_BASE) a.combat('ko', g, pan);
        break;
      }
      case 'shot':
        a.combat('gunshot', this.gain(e.x, e.y, e.z, HEAR_SHOT), this.pan(e.x, e.z));
        break;
      case 'tele':
        if (e.tgt === me) {
          if (e.atk === ATK.BURST) {
            const en = view.enemy(e.src);
            a.combat('laser', en ? this.gain(en.x, en.y, en.z, HEAR_SHOT) : 1, en ? this.pan(en.x, en.z) : 0);
          }
        }
        break;
      case 'proj':
        if (this.projKinds.size >= PROJ_MEMORY) this.projKinds.clear();
        this.projKinds.set(e.id, e.kind);
        if (e.kind === PK.BOLT) a.combat('bolt', this.gain(e.x, e.y, e.z, HEAR), this.pan(e.x, e.z));
        break;
      case 'projEnd': {
        const kind = this.projKinds.get(e.id);
        this.projKinds.delete(e.id);
        if (kind === PK.BOTTLE) a.combat('bottle', this.gain(e.x, e.y, e.z, HEAR), this.pan(e.x, e.z));
        break;
      }
      case 'down':
        if (e.pid === game.combatLink.selfPid) {
          a.combat('heroDown');
          this.moment.interrupt();
        }
        break;
      case 'evStart':
        this.known.set(e.ev.id, { ...e.ev });
        this.announce(e.ev);
        break;
      case 'evEnd': {
        const ev = this.known.get(e.id);
        this.known.delete(e.id);
        if (!ev) break;
        const type = ev.type;
        const mine = e.pids.indexOf(game.combatLink.selfPid) >= 0;
        if (e.result === 'clear') {
          if (mine) this.score += e.score;
          this.queue({ kind: 'clear', title: tr.combat.cleared, sub: mine ? tr.combat.reward(e.focus, e.score) : this.eventName(ev), type, sound: 'eventClear' });
        } else if (e.result === 'fail') this.queue({ kind: 'fail', title: tr.combat.failed, sub: tr.combat.failedSub, type, sound: 'eventFail' });
        else if (mine || Math.hypot(ev.x - game.player.pos.x, ev.z - game.player.pos.z) < tuning.events.distMax * 1.6)
          this.queue({ kind: 'expire', title: tr.combat.expired, sub: tr.combat.expiredSub, type, sound: 'eventFail' });
        break;
      }
      default:
        break;
    }
  }

  private announce(ev: CrimeEventInfo): void {
    const p = this.game.player.pos;
    const d = Math.hypot(ev.x - p.x, ev.z - p.z);
    const title = ev.type === 'boss' ? tr.combat.alerts.boss.replace('{name}', this.bossName(ev.boss)) : tr.combat.alerts[ev.type];
    const sub = `${this.placeName(ev)} · ${tr.combat.distance(String(Math.round(d)))}`;
    // An event starting close by ends the rooftop moment; a far one waits until the moment is over.
    if (d < tuning.events.expireRadius) this.moment.interrupt();
    this.queue({ kind: 'start', title, sub, type: ev.type, sound: 'eventStart' });
  }

  private queue(b: PendingBanner): void {
    if (this.moment.cine || this.hud.bannerShown) {
      if (this.pending.length >= 4) this.pending.shift();
      this.pending.push(b);
      return;
    }
    this.hud.showBanner(b.kind, b.title, b.sub, b.type);
    if (b.sound) this.audio.combat(b.sound);
  }

  private bossName(kind: number): string {
    const info = kind >= 0 ? kindInfo(kind as 0) : undefined;
    return info ? tr.combat.enemies[info.key] : '';
  }

  private eventName(ev: CrimeEventInfo): string {
    return ev.type === 'boss' ? tr.combat.events.boss.replace('{name}', this.bossName(ev.boss)) : tr.combat.events[ev.type];
  }

  /** "Kuleler · kavşak": the district (park for park lawns) and the kind of place. */
  private placeName(ev: CrimeEventInfo): string {
    const game = this.game;
    const a = game.spawns.arenas[ev.arena];
    const place = a ? (tr.combat.places[a.type] ?? '') : '';
    if (a && a.type === 5) return tr.combat.park;
    let district = a && a.buildingId >= 0 ? a.district : -1;
    if (district < 0) {
      let best = Infinity;
      for (const b of game.layout.blocks) {
        const dx = Math.max(b.minX - ev.x, 0, ev.x - b.maxX),
          dz = Math.max(b.minZ - ev.z, 0, ev.z - b.maxZ);
        const d = dx * dx + dz * dz;
        if (d < best) {
          best = d;
          district = b.district;
        }
      }
    }
    const dn = tr.combat.districts[district] ?? '';
    return dn && place ? `${dn} · ${place}` : dn || place;
  }

  /** The strike target, else the nearest enemy alerted on the hero close by; projected above its head. */
  private pickTarget(id: number): CombatUi['target'] | null {
    const view = this.game.combatView;
    const p = this.game.player.pos;
    let e = id >= 0 ? view.enemy(id) : undefined;
    if (e && (e.state === ES.KO || Math.hypot(e.x - p.x, e.z - p.z) > TARGET_RANGE)) e = undefined;
    if (!e) {
      let bd = 12;
      for (const o of view.enemies) {
        if (o.state === ES.KO || (o.flags & EF.ALERTED) === 0 || o.target !== view.selfId) continue;
        const d = Math.hypot(o.x - p.x, o.z - p.z);
        if (d < bd) {
          bd = d;
          e = o;
        }
      }
    }
    if (!e) return null;
    const info = kindInfo(e.kind as 0);
    const top = info.flyer ? e.y + info.radius + 0.5 : e.y + info.height + 0.45;
    if (!this.project(e.x, top, e.z, this.mark, false)) return null;
    const t = this.target;
    t.name = tr.combat.enemies[info.key];
    t.hp = e.maxHp > 0 ? e.hp / e.maxHp : 0;
    t.guard = e.kind === EK.BRUTE && e.guard > 0 && (e.flags & EF.SHIELDLESS) === 0;
    t.x = this.mark.x;
    t.y = this.mark.y;
    return t;
  }

  /** Spider-sense: where the soonest attack comes from (screen angle) and whether a dodge works now; ticks on a new one. */
  private threatInfo(now: number): CombatUi['threat'] | null {
    const t = this.game.combatView.threat;
    if (!t || this.game.combatView.self.down) {
      this.threatKey = '';
      return null;
    }
    const key = `${t.src}:${t.at.toFixed(2)}`;
    if (key !== this.threatKey) {
      if (!this.threatKey.startsWith(`${t.src}:`)) this.audio.combat('sense');
      this.threatKey = key;
    }
    const yaw = this.game.rig.yaw;
    const p = this.game.player.pos;
    const dx = t.x - p.x,
      dz = t.z - p.z;
    // Camera forward (-sin, -cos) is up on screen, right (cos, -sin) is right.
    const fwd = -Math.sin(yaw) * dx - Math.cos(yaw) * dz;
    const right = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
    this.threat.angle = Math.atan2(right, fwd);
    const left = t.at - now;
    this.threat.now = left <= tuning.combat.dodgeLookahead && left >= -0.05;
    return this.threat;
  }

  /**
   * The nearest active event: its marker on screen, or an arrow at the edge,
   * with the distance. At the event the marker gives way to the objective
   * chip (the enemies left), so it never covers the fight.
   */
  private eventMarker(): CombatUi['marker'] | null {
    this.atEvent = null;
    const game = this.game;
    const p = game.player.pos;
    let ev: CrimeEventInfo | null = null,
      bd = Infinity;
    for (const c of game.combatView.crimes) {
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d < bd) {
        bd = d;
        ev = c;
      }
    }
    if (!ev || game.combatView.self.down) return null;
    if (bd < ev.radius + 25) {
      const o = this.objective;
      o.type = ev.type;
      o.text = `${this.eventName(ev)} · ${tr.combat.left(ev.enemiesLeft)}`;
      this.atEvent = o;
      return null;
    }
    this.project(ev.x, ev.y + 2.5, ev.z, this.mark, true);
    const m = this.marker;
    m.type = ev.type;
    m.label = `${this.eventName(ev)} · ${tr.combat.distance(String(Math.round(bd)))}`;
    return m;
  }

  /**
   * Screen point (CSS px) of a world point. Off screen (or behind the
   * camera) it is clamped to the edge with the direction in `angle` when
   * `edge` is set, else the call returns false. Touch keeps clear of the
   * stick and the button pad (the bottom of the screen).
   */
  private project(x: number, y: number, z: number, out: ScreenMark, edge: boolean): boolean {
    const cam = this.game.rig.camera;
    const W = window.innerWidth,
      H = window.innerHeight;
    const v = this.v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
    const minX = this.touch ? 80 : 60,
      maxX = W - (this.touch ? 80 : 60),
      minY = this.touch ? 70 : 60,
      maxY = this.touch ? H * 0.58 : H - 60;
    let dx: number, dy: number;
    if (v.z < -0.2) {
      v.applyMatrix4(cam.projectionMatrix);
      const sx = (v.x * 0.5 + 0.5) * W,
        sy = (-v.y * 0.5 + 0.5) * H;
      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
        out.x = sx;
        out.y = sy;
        out.onScreen = true;
        out.angle = 0;
        return true;
      }
      dx = sx - W / 2;
      dy = sy - H / 2;
    } else {
      // Behind the camera: toward its side, at the bottom.
      dx = v.x;
      dy = Math.abs(v.y) + Math.abs(v.x) * 0.25 + 1e-3;
    }
    if (!edge) return false;
    const cx = (minX + maxX) / 2,
      cy = (minY + maxY) / 2;
    const hx = (maxX - minX) / 2,
      hy = (maxY - minY) / 2;
    const k = Math.min(hx / Math.max(1e-6, Math.abs(dx)), hy / Math.max(1e-6, Math.abs(dy)));
    out.x = cx + dx * k;
    out.y = cy + dy * k;
    out.onScreen = false;
    out.angle = Math.atan2(dx, -dy);
    return true;
  }

  /** Distance attenuation from the hero (0..1). */
  private gain(x: number, y: number, z: number, range: number): number {
    const p = this.game.player.pos;
    const d = Math.hypot(x - p.x, y - p.y, z - p.z);
    const k = Math.max(0, 1 - d / range);
    return k * (0.4 + 0.6 * k);
  }

  /** Stereo side of a world point from the camera's right vector (-1..1). */
  private pan(x: number, z: number): number {
    const p = this.game.player.pos;
    const yaw = this.game.rig.yaw;
    const dx = x - p.x,
      dz = z - p.z;
    const l = Math.hypot(dx, dz);
    if (l < 1e-3) return 0;
    return Math.max(-1, Math.min(1, (Math.cos(yaw) * dx - Math.sin(yaw) * dz) / l));
  }
}
