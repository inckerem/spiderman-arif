import { tuning } from '../../config/tuning';
import type { TickInput } from '../../input/input';
import type { CollisionWorld } from '../../physics/collision';
import { LOS_SKIP } from '../mover';
import {
  CA,
  MODE_STRIKE,
  MODE_TRAVERSE,
  STRIKE_DODGE,
  STRIKE_LUNGE,
  type Player,
  type PlayerEvent,
} from '../../player/player';
import { makeRayHit } from '../../physics/collision';
import { capsuleDistance, chainMove } from '../combatSim';
import { guardBlocks, kindInfo } from '../roster';
import { EF, ES, HIT, MOVE, type CombatEvent, type EnemyKind } from '../types';
import type { CombatView, ThreatInfo, ViewEnemy } from './combatView';
import type { CombatLink } from './link';

const DEG = Math.PI / 180;
/** Torso height above the feet for reach checks (matches the sim's validation). */
const HERO_TORSO = 1.0;
/** Alerted enemies this close make a ground click a strike (free-flow, design rule 4). */
const ENGAGED_RANGE = 8;
/** Auto-target (F, touch Saldırı): "in view" is within this angle of the camera direction. */
const AUTO_VIEW_DEG = 50;
/** A buffered strike is dropped after this long. */
const QUEUE_MAX_AGE = 0.6;
/** Extra reach accepted at the contact frame (the target moved a little since the pick). */
const CONTACT_SLACK = 0.35;

/** Contact time and full length of each move (live tuning). */
function moveTiming(move: number): { contact: number; dur: number; action: number } {
  const c = tuning.combat;
  switch (move) {
    case MOVE.JAB:
      return { contact: c.jabContact, dur: c.jabContact + c.jabRecover, action: CA.JAB };
    case MOVE.CROSS:
      return { contact: c.crossContact, dur: c.crossContact + c.crossRecover, action: CA.CROSS };
    case MOVE.KICK:
      return { contact: c.kickContact, dur: c.kickContact + c.kickRecover, action: CA.KICK };
    case MOVE.UPPER:
      return { contact: c.upperContact, dur: c.upperContact + c.upperRecover, action: CA.UPPER };
    case MOVE.AIR:
      return { contact: c.jabContact + 0.04, dur: c.jabContact + 0.04 + c.jabRecover, action: CA.AIR };
    case MOVE.GROUND:
      return { contact: 0.12, dur: 0.12 + c.kickRecover, action: CA.GROUND };
    case MOVE.TAKEDOWN:
      return { contact: 0.18, dur: 0.18 + c.upperRecover, action: CA.TAKEDOWN };
    default:
      return { contact: c.jabContact, dur: c.jabContact + c.jabRecover, action: CA.JAB };
  }
}

/** What the HUD shows (chunk 7) and tests read. */
export interface HeroCombatHud {
  combo: number;
  focus: number;
  /** Enemy id of the current or last strike target, or -1. */
  target: number;
  threat: ThreatInfo | null;
}

/**
 * The hero's side of combat (browser, no DOM): the input router that keeps
 * the swing feel, the combo chain, lunge and dodge orchestration and hit
 * prediction. Runs before `player.step` (`route`) and after it (`after`).
 *
 * Routing (design §4, evaluated on edges only; with no target nothing is
 * touched, so the web line behaves exactly as without combat):
 * 1. Left press: a DOWN enemy within 3 m (ground finisher), else any enemy
 *    within `closeRange` in the front 220°, else an enemy within `coneDeg` of
 *    the crosshair inside lunge range with line of sight, else during a combo
 *    or when engaged on the ground the best free-flow target. With a target
 *    the whole press-to-release gesture is captured: the swing fields read
 *    false every tick until the button is up, so no line fires, `holdSwing`
 *    never sets and the `byButton` release can never cut a live line (a
 *    capture starts only on a press, when no button-held line exists).
 * 2. F / the touch Saldırı button: the same picks, then the nearest enemy in
 *    view within lunge range, else a whiff jab.
 * 3. Right press on an enemy in a 6° cone within 35 m with line of sight: a
 *    tap yanks, holding `pinHold` pins; the pull line never fires. No enemy:
 *    the pull line as today.
 * 4. Space while an attack on this hero is due within the dodge lookahead:
 *    consumed (held Space stays masked until released) and a dodge: a
 *    sidestep on the ground, only animation plus i-frames in the air or on a
 *    line (the line stays).
 * 5. E with full focus and an enemy within 4 m: takedown.
 * 6. Knocked out: all movement and action input is zeroed.
 */
export class HeroCombat {
  enabled = true;
  readonly hud: HeroCombatHud = { combo: 0, focus: 0, target: -1, threat: null };
  /** Counters for tests and diagnostics. */
  readonly stats = { strikes: 0, lunges: 0, whiffs: 0, intents: 0, predicted: 0, yanks: 0, pins: 0, dodges: 0, takedowns: 0, captured: 0, rejected: 0, blocked: 0 };
  private captureL = false;
  private captureR = false;
  private rTarget = -1;
  private rHold = 0;
  private rFired = false;
  private maskJump = false;
  /** Enemy the current lunge or strike is aimed at (-1 none or a whiff). */
  private strikeTarget = -1;
  /** A press during a strike: the next one (target id, -2 = pick again; -1 = none) and when it was pressed. */
  private queued = -1;
  private queuedAt = 0;
  private queuedAuto = false;
  /** Local chain position (move choice), kept alive by contacts within the combo window. */
  private chain = 0;
  private chainUntil = -1e9;
  private seq = 0;
  private readonly ray = makeRayHit();
  /**
   * Actions decided by `route` and carried out in `after`: the player only
   * changes (and emits events) after its step, so every event reaches the
   * game's event loop.
   */
  private wantAttack = false;
  private wantTarget: ViewEnemy | null = null;
  private wantAuto = false;
  private wantDodge = false;
  private wantTakedown = false;
  private wantLine: 'yank' | 'pin' | null = null;
  private wantLineId = -1;

  constructor(
    private readonly player: Player,
    private readonly world: CollisionWorld,
    private readonly link: CombatLink,
  ) {}

  private get view(): CombatView {
    return this.link.view;
  }

  /** Forget gestures and the chain (a new game, combat switched off). */
  reset(): void {
    this.captureL = this.captureR = this.maskJump = false;
    this.strikeTarget = -1;
    this.queued = -1;
    this.chain = 0;
    this.chainUntil = -1e9;
    this.hud.target = -1;
    this.hud.threat = null;
    this.wantAttack = this.wantDodge = this.wantTakedown = false;
    this.wantLine = null;
  }

  private want(t: ViewEnemy | null, auto: boolean): void {
    this.wantAttack = true;
    this.wantTarget = t;
    this.wantAuto = auto;
  }

  // ---------------------------------------------------------------------------
  // Before player.step: routing
  // ---------------------------------------------------------------------------

  route(inp: TickInput, dt: number): void {
    if (!this.enabled) return;
    const pl = this.player;
    const now = this.link.now();
    // 6. Knocked out: nothing reaches the player.
    if (pl.down || this.view.self.down) {
      inp.moveX = inp.moveY = 0;
      inp.jump = inp.jumpPressed = inp.sprint = inp.groundSprint = inp.dive = false;
      inp.swing = inp.swingPressed = inp.swingReleased = inp.zip = inp.zipPressed = false;
      inp.attack = inp.attackPressed = inp.finisherPressed = false;
      inp.reel = 0;
      this.captureL = this.captureR = false;
      this.maskJump = inp.jump;
      return;
    }

    // A lunge follows its target.
    if (pl.mode === MODE_STRIKE && pl.strike.kind === STRIKE_LUNGE && this.strikeTarget >= 0) {
      const e = this.view.enemy(this.strikeTarget);
      if (e && e.state !== ES.KO) pl.retargetLunge(e.x, this.lungeY(e, pl.strike.air), e.z);
    }

    // 1 + 2. Left button: capture whole gestures that start on an enemy.
    if (this.captureL) {
      const end = !inp.swing || inp.swingReleased;
      inp.swing = inp.swingPressed = inp.swingReleased = false;
      if (end) this.captureL = false;
    } else if (inp.swingPressed) {
      const t = this.pick(inp, false);
      if (t) {
        // A press and release inside one tick (a sub-frame click) ends the capture at once.
        const end = !inp.swing || inp.swingReleased;
        inp.swing = inp.swingPressed = inp.swingReleased = false;
        this.captureL = !end;
        this.stats.captured++;
        this.want(t, false);
      }
    }
    if (inp.attackPressed) this.want(this.pick(inp, true), true);

    // Buffered strike: starts as soon as the current one allows (re-picked when its target is gone).
    if (this.queued !== -1 && !this.wantAttack) {
      if (now - this.queuedAt > QUEUE_MAX_AGE || pl.mode === MODE_TRAVERSE) this.queued = -1;
      else if (pl.strikeCancelable) {
        const id = this.queued;
        this.queued = -1;
        let t = id >= 0 ? this.view.enemy(id) : undefined;
        if (!t || t.state === ES.KO) t = this.pick(inp, this.queuedAuto) ?? undefined;
        // A buffered click whose target is gone does nothing; a buffered F still whiffs.
        if (t || this.queuedAuto) this.want(t ?? null, this.queuedAuto);
      }
    }

    // 3. Right button: yank (tap) or pin (hold) on an enemy, else the pull line.
    if (this.captureR) {
      this.rHold += dt;
      const up = !inp.zip;
      inp.zip = inp.zipPressed = false;
      if (!this.rFired && this.rHold >= tuning.combat.pinHold) {
        this.rFired = true;
        this.wantLine = 'pin';
        this.wantLineId = this.rTarget;
      }
      if (up) {
        if (!this.rFired) {
          this.wantLine = 'yank';
          this.wantLineId = this.rTarget;
        }
        this.captureR = false;
      }
    } else if (inp.zipPressed) {
      const t = this.pickLine(inp);
      if (t) {
        this.stats.captured++;
        this.rTarget = t.id;
        this.rHold = 0;
        this.rFired = false;
        const up = !inp.zip;
        inp.zip = inp.zipPressed = false;
        if (up) {
          this.wantLine = 'yank';
          this.wantLineId = t.id;
        } else this.captureR = true;
      }
    }

    // 4. Space dodges while an attack on this hero is due.
    if (this.maskJump) {
      if (!inp.jump) this.maskJump = false;
      inp.jump = inp.jumpPressed = false;
    } else if (inp.jumpPressed && this.dodgeWindow(now)) {
      this.maskJump = inp.jump;
      inp.jump = inp.jumpPressed = false;
      this.wantDodge = true;
    }

    // 5. Takedown.
    if (inp.finisherPressed) this.wantTakedown = true;
  }

  // ---------------------------------------------------------------------------
  // After player.step: contact frames, lunge arrival
  // ---------------------------------------------------------------------------

  after(events: readonly PlayerEvent[]): void {
    if (!this.enabled) return;
    const pl = this.player;
    const now = this.link.now();
    // Projectile threats are measured against where the hero is.
    this.view.setSelf(pl.pos.x, pl.pos.y, pl.pos.z);
    // Events of this step: a lunge arrived (strike now), a contact frame (reach check, intent).
    const n = events.length;
    for (let i = 0; i < n; i++) {
      const ev = events[i]!;
      if (ev.type === 'lungeEnd') {
        const e = ev.ok && this.strikeTarget >= 0 ? this.view.enemy(this.strikeTarget) : undefined;
        if (e && e.state !== ES.KO) this.strikeOn(e, now);
        else this.strikeTarget = -1;
      } else if (ev.type === 'strike') this.contact(ev.move, now);
    }
    // Then what the routing decided this tick.
    if (this.wantDodge) {
      this.wantDodge = false;
      this.dodge(now);
    }
    if (this.wantAttack) {
      this.wantAttack = false;
      this.attack(this.wantTarget, this.wantAuto, now);
      this.wantTarget = null;
    }
    if (this.wantLine) {
      this.lineIntent(this.wantLine, this.wantLineId);
      this.wantLine = null;
    }
    if (this.wantTakedown) {
      this.wantTakedown = false;
      this.takedown();
    }
    // HUD: the combo while its window lasts.
    const s = this.view.self;
    this.hud.combo = s.comboUntil > now ? s.combo : 0;
    this.hud.focus = s.focus;
    this.hud.threat = this.view.threat;
    if (pl.mode !== MODE_STRIKE && this.queued === -1 && now > this.chainUntil) this.strikeTarget = -1;
  }

  /** Combat events for this hero (from the view's queue, through the game). */
  onEvent(e: CombatEvent): void {
    const pl = this.player;
    const me = this.view.selfId;
    switch (e.e) {
      case 'hit':
        if (e.tgt === me) {
          pl.applyHit(e.kx, e.ky, e.kz, e.dmg);
          this.queued = -1;
          this.chain = 0;
          this.chainUntil = -1e9;
        } else if (e.src === me && (e.fl & HIT.BLOCKED) !== 0) {
          // Bounced off a shield: shoved back with a flinch, the buffered strike dropped.
          pl.applyHit(e.kx, e.ky, e.kz, 0);
          this.queued = -1;
          this.stats.blocked++;
        }
        break;
      case 'down':
        if (e.pid === this.link.selfPid) {
          pl.setDown(true);
          this.reset();
        }
        break;
      case 'respawn':
        if (e.pid === this.link.selfPid) pl.setDown(false);
        break;
      case 'rej':
        if (e.pid === this.link.selfPid) this.stats.rejected++;
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Targeting
  // ---------------------------------------------------------------------------

  /** Whether the hero is on the ground for combat (lunge ranges, moves). */
  private get grounded(): boolean {
    return this.player.combatGrounded;
  }

  /**
   * Strike target by the routing priorities (rule 1, and rule 5 for `auto`):
   * downed within 3 m, close range in front, crosshair cone, free-flow, then
   * (auto) the nearest enemy in view.
   */
  pick(inp: TickInput, auto: boolean): ViewEnemy | null {
    const C = tuning.combat;
    const pl = this.player;
    const v = this.view;
    if (v.enemies.length === 0) return null;
    const px = pl.pos.x,
      py = pl.pos.y,
      pz = pl.pos.z;
    const fx = -Math.sin(inp.yaw),
      fz = -Math.cos(inp.yaw);
    const range = this.grounded ? C.lungeRangeGround : C.lungeRangeAir;
    // 1. A downed enemy within finisher range.
    let best: ViewEnemy | null = null;
    let bestK = Infinity;
    for (const e of v.enemies) {
      if (e.state !== ES.DOWN) continue;
      const d = Math.hypot(e.x - px, e.z - pz);
      if (d <= C.groundFinisherRange && Math.abs(e.y - py) < 1.6 && d < bestK) {
        best = e;
        bestK = d;
      }
    }
    if (best) return best;
    // 2. Close range, front arc.
    const arcCos = Math.cos((C.closeArcDeg / 2) * DEG);
    for (const e of v.enemies) {
      if (!this.hittable(e)) continue;
      const dx = e.x - px,
        dz = e.z - pz;
      const d = Math.hypot(dx, dz);
      const surf = d - kindInfo(e.kind as EnemyKind).radius;
      if (surf > C.closeRange || Math.abs(e.y - py) > 1.8) continue;
      const cos = d > 1e-3 ? (dx * fx + dz * fz) / d : 1;
      if (cos < arcCos) continue;
      if (surf < bestK) {
        best = e;
        bestK = surf;
      }
    }
    if (best) return best;
    // 3. Crosshair cone within lunge range, line of sight.
    const o = inp.aimOrigin,
      a = inp.aimDir;
    const coneCos = Math.cos(C.coneDeg * DEG);
    let bestCos = coneCos;
    for (const e of v.enemies) {
      if (!this.hittable(e)) continue;
      const cy = this.chestY(e);
      const dx = e.x - o.x,
        dy = cy - o.y,
        dz = e.z - o.z;
      const dl = Math.hypot(dx, dy, dz);
      if (dl < 1e-3) continue;
      const cos = (dx * a.x + dy * a.y + dz * a.z) / dl;
      if (cos < bestCos) continue;
      if (Math.hypot(e.x - px, e.y - py, e.z - pz) > range) continue;
      if (!this.los(e)) continue;
      best = e;
      bestCos = cos;
    }
    if (best) return best;
    // 4. Free-flow during a combo, or engaged on the ground.
    const now = this.link.now();
    const inCombo = this.chainUntil > now || v.self.comboUntil > now;
    if (inCombo || (this.grounded && this.engaged())) {
      // Around the stick direction (camera relative), else the camera direction.
      let dirX = fx,
        dirZ = fz;
      const ml = Math.hypot(inp.moveX, inp.moveY);
      if (ml > 0.3) {
        const rx = Math.cos(inp.yaw),
          rz = -Math.sin(inp.yaw);
        dirX = (fx * inp.moveY + rx * inp.moveX) / ml;
        dirZ = (fz * inp.moveY + rz * inp.moveX) / ml;
      }
      const ffCos = Math.cos((C.freeflowConeDeg / 2) * DEG);
      let bestScore = -Infinity;
      for (const e of v.enemies) {
        if (!this.hittable(e)) continue;
        const dx = e.x - px,
          dz = e.z - pz;
        const d = Math.hypot(dx, dz);
        if (d > C.freeflowRange || Math.abs(e.y - py) > 3) continue;
        const cos = d > 1e-3 ? (dx * dirX + dz * dirZ) / d : 1;
        if (cos < ffCos) continue;
        const score = cos - d / C.freeflowRange;
        if (score > bestScore && this.los(e)) {
          best = e;
          bestScore = score;
        }
      }
      if (best) return best;
    }
    if (!auto) return null;
    // 5. Auto-target: the nearest enemy in view within lunge range.
    const viewCos = Math.cos(AUTO_VIEW_DEG * DEG);
    for (const e of v.enemies) {
      if (!this.hittable(e)) continue;
      const cy = this.chestY(e);
      const dx = e.x - o.x,
        dy = cy - o.y,
        dz = e.z - o.z;
      const dl = Math.hypot(dx, dy, dz);
      if (dl < 1e-3 || (dx * a.x + dy * a.y + dz * a.z) / dl < viewCos) continue;
      const d = Math.hypot(e.x - px, e.y - py, e.z - pz);
      if (d > range || d >= bestK) continue;
      if (!this.los(e)) continue;
      best = e;
      bestK = d;
    }
    return best;
  }

  /** Right-button target: an enemy within `yankConeDeg` of the crosshair, within `yankRange`, with line of sight. */
  pickLine(inp: TickInput): ViewEnemy | null {
    const C = tuning.combat;
    const pl = this.player;
    const o = inp.aimOrigin,
      a = inp.aimDir;
    const coneCos = Math.cos(C.yankConeDeg * DEG);
    let best: ViewEnemy | null = null;
    let bestCos = coneCos;
    for (const e of this.view.enemies) {
      if (!this.hittable(e)) continue;
      const cy = this.chestY(e);
      const dx = e.x - o.x,
        dy = cy - o.y,
        dz = e.z - o.z;
      const dl = Math.hypot(dx, dy, dz);
      if (dl < 1e-3) continue;
      const cos = (dx * a.x + dy * a.y + dz * a.z) / dl;
      if (cos < bestCos) continue;
      if (Math.hypot(e.x - pl.pos.x, cy - (pl.pos.y + tuning.body.chestHeight), e.z - pl.pos.z) > C.yankRange) continue;
      if (!this.los(e)) continue;
      best = e;
      bestCos = cos;
    }
    return best;
  }

  private hittable(e: ViewEnemy): boolean {
    return e.state !== ES.KO;
  }

  private chestY(e: ViewEnemy): number {
    const info = kindInfo(e.kind as EnemyKind);
    return info.flyer ? e.y : e.y + info.height * 0.6;
  }

  /** Lunge goal height: the feet for a ground lunge, a little below the chest in the air. */
  private lungeY(e: ViewEnemy, air: boolean): number {
    const info = kindInfo(e.kind as EnemyKind);
    return air ? (info.flyer ? e.y - 1.1 : e.y + Math.max(0, info.height - 1.9)) : e.y;
  }

  private los(e: ViewEnemy): boolean {
    const p = this.player.pos;
    const ax = p.x,
      ay = p.y + tuning.body.chestHeight,
      az = p.z;
    const bx = e.x,
      by = this.chestY(e),
      bz = e.z;
    const dx = bx - ax,
      dy = by - ay,
      dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-3) return true;
    return !this.world.raycast(ax, ay, az, dx / d, dy / d, dz / d, d, this.ray, LOS_SKIP, -1, 0, true);
  }

  /** An alerted enemy targeting this hero within 8 m. */
  private engaged(): boolean {
    const p = this.player.pos;
    const me = this.view.selfId;
    for (const e of this.view.enemies) {
      if (e.state === ES.KO || (e.flags & EF.ALERTED) === 0 || e.target !== me) continue;
      if (Math.hypot(e.x - p.x, e.z - p.z) <= ENGAGED_RANGE) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** A strike press: start it now, or buffer it while a strike is running. */
  private attack(t: ViewEnemy | null, auto: boolean, now: number): void {
    const pl = this.player;
    if (pl.mode === MODE_STRIKE && pl.strike.kind !== STRIKE_DODGE && !pl.strikeCancelable) {
      this.queued = t ? t.id : -2;
      this.queuedAt = now;
      this.queuedAuto = auto;
      return;
    }
    this.startAttack(t, now);
  }

  private startAttack(t: ViewEnemy | null, now: number): void {
    const pl = this.player;
    if (pl.mode === MODE_TRAVERSE || pl.down) return;
    if (!t) {
      // Nothing to hit (F with no enemy around): a whiff jab facing the camera.
      this.strikeTarget = -1;
      this.stats.whiffs++;
      const m = moveTiming(MOVE.JAB);
      const yaw = pl.facing;
      pl.beginStrike(MOVE.JAB, m.action, m.contact, m.dur, pl.pos.x - Math.sin(yaw), pl.pos.z - Math.cos(yaw));
      return;
    }
    this.strikeTarget = t.id;
    this.hud.target = t.id;
    const C = tuning.combat;
    const info = kindInfo(t.kind as EnemyKind);
    const surf = capsuleDistance(pl.pos.x, pl.pos.y + HERO_TORSO, pl.pos.z, t.x, info.flyer ? t.y - info.radius : t.y, t.z, info.radius, info.flyer ? info.radius * 2 : info.height);
    if (surf <= C.reach) {
      this.strikeOn(t, now);
      return;
    }
    // A flyer is always an air lunge (from the ground too): straight up to it.
    const air = !this.grounded || info.flyer;
    const stop = info.radius + C.reach - 0.2;
    if (pl.beginLunge(t.x, this.lungeY(t, air), t.z, stop, air)) this.stats.lunges++;
    else this.strikeTarget = -1;
  }

  /** The strike itself on a target within reach (after a lunge, or right away). */
  private strikeOn(t: ViewEnemy, now: number): void {
    const pl = this.player;
    const C = tuning.combat;
    if (now > this.chainUntil) this.chain = 0;
    const move = t.state === ES.DOWN ? MOVE.GROUND : !this.grounded ? MOVE.AIR : chainMove(this.chain);
    const m = moveTiming(move);
    this.strikeTarget = t.id;
    pl.beginStrike(move, m.action, m.contact, m.dur, t.x, t.z);
    this.stats.strikes++;
    // The chain stays alive through the strike (the server's window starts at the hit).
    this.chainUntil = Math.max(this.chainUntil, now + m.dur + C.comboWindow);
  }

  /** Contact frame: in reach of the view's target → predicted flinch and the intent; else a miss. */
  private contact(move: number, now: number): void {
    const pl = this.player;
    const C = tuning.combat;
    if (move !== MOVE.TAKEDOWN && move !== MOVE.GROUND) this.chain++;
    this.chainUntil = now + C.comboWindow;
    const id = this.strikeTarget;
    if (id < 0) return;
    const t = this.view.enemy(id);
    if (!t || t.state === ES.KO) return;
    const info = kindInfo(t.kind as EnemyKind);
    const surf = capsuleDistance(pl.pos.x, pl.pos.y + HERO_TORSO, pl.pos.z, t.x, info.flyer ? t.y - info.radius : t.y, t.z, info.radius, info.flyer ? info.radius * 2 : info.height);
    const range = move === MOVE.GROUND ? C.groundFinisherRange : move === MOVE.TAKEDOWN ? C.takedownRange : C.reach + CONTACT_SLACK;
    if (surf > range) return;
    // No predicted flinch when the strike will bounce off a raised shield.
    if (move === MOVE.TAKEDOWN || guardBlocks(t.kind, t.guard, t.flags, t.state, t.x, t.y, t.z, t.yaw, pl.pos.x, pl.pos.y, pl.pos.z) !== HIT.BLOCKED) {
      this.view.flinch(id, now + 0.2);
      this.stats.predicted++;
    }
    const p = pl.pos;
    if (move === MOVE.TAKEDOWN) {
      this.link.intent({ k: 'takedown', seq: ++this.seq, target: id, viewT: this.link.renderTime(), hx: p.x, hy: p.y, hz: p.z });
      this.stats.takedowns++;
    } else this.link.intent({ k: 'strike', seq: ++this.seq, target: id, move, viewT: this.link.renderTime(), hx: p.x, hy: p.y, hz: p.z });
    this.stats.intents++;
  }

  private lineIntent(k: 'yank' | 'pin', id: number): void {
    const pl = this.player;
    const e = this.view.enemy(id);
    if (!e || e.state === ES.KO) return;
    const p = pl.pos;
    // Face it unless a line or a move owns the body.
    pl.playCombatAnim(k === 'yank' ? CA.YANK : CA.PIN, k === 'yank' ? 0.4 : 0.35, pl.lastHand);
    this.link.intent({ k, seq: ++this.seq, target: id, viewT: this.link.renderTime(), hx: p.x, hy: p.y, hz: p.z });
    this.stats.intents++;
    if (k === 'yank') this.stats.yanks++;
    else this.stats.pins++;
    this.hud.target = id;
  }

  /** A telegraphed attack on this hero lands within the dodge lookahead (or just landed). */
  dodgeWindow(now: number): boolean {
    const t = this.view.threat;
    if (!t) return false;
    const dt = t.at - now;
    return dt >= -0.05 && dt <= tuning.combat.dodgeLookahead;
  }

  private dodge(now: number): void {
    const pl = this.player;
    const t = this.view.threat;
    // Sideways from the attacker, toward the stick side (or alternating).
    let ax = t ? pl.pos.x - t.x : Math.sin(pl.facing),
      az = t ? pl.pos.z - t.z : Math.cos(pl.facing);
    const al = Math.hypot(ax, az) || 1;
    ax /= al;
    az /= al;
    const side = this.stats.dodges % 2 === 0 ? 1 : -1;
    const dx = -az * side + ax * 0.35,
      dz = ax * side + az * 0.35;
    if (pl.mode === MODE_STRIKE && pl.strike.kind === STRIKE_LUNGE) this.strikeTarget = -1;
    this.queued = -1;
    pl.beginDodge(dx, dz, !this.grounded);
    this.link.intent({ k: 'dodge', seq: ++this.seq, t: now });
    this.stats.dodges++;
  }

  private takedown(): void {
    const C = tuning.combat;
    const pl = this.player;
    if (this.view.self.focus < C.takedownCost || pl.mode === MODE_TRAVERSE) return;
    let best: ViewEnemy | null = null;
    let bestD = C.takedownRange;
    for (const e of this.view.enemies) {
      if (!this.hittable(e)) continue;
      const d = Math.hypot(e.x - pl.pos.x, e.z - pl.pos.z) - kindInfo(e.kind as EnemyKind).radius;
      if (d <= bestD && Math.abs(e.y - pl.pos.y) < 2) {
        best = e;
        bestD = d;
      }
    }
    if (!best) return;
    const m = moveTiming(MOVE.TAKEDOWN);
    this.strikeTarget = best.id;
    this.queued = -1;
    pl.beginStrike(MOVE.TAKEDOWN, m.action, m.contact, m.dur, best.x, best.z);
  }

}

