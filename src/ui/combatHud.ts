import './combatHud.css';
import { tr } from '../i18n/tr';
import { clamp, el, formatInteger, setText, textNode } from './dom';

/** Health bar segments. */
const SEGMENTS = 10;
/** How long a banner stays (s): an announcement, a result. */
const BANNER_TIME = 5;
const RESULT_TIME = 4;
/** The damage "ghost" on the health bar catches up after this delay (s). */
const GHOST_DELAY = 0.45;

export type BannerKind = 'start' | 'clear' | 'expire' | 'fail';

/** Screen-space point (CSS px) with an "on screen" flag and the direction (radians, 0 = up, clockwise) for edge arrows. */
export interface ScreenMark {
  x: number;
  y: number;
  onScreen: boolean;
  angle: number;
}

/** Everything the combat HUD shows in a frame (filled by `CombatUi`; never allocated per frame there). */
export interface CombatHudState {
  /** Combat runs (play, combat enabled); everything hides otherwise. */
  on: boolean;
  hp: number;
  maxHp: number;
  /** Health is coming back (regeneration). */
  regen: boolean;
  down: boolean;
  /** Seconds until the roof respawn while down. */
  downLeft: number;
  combo: number;
  /** Share of the combo window left (0..1). */
  comboLeft: number;
  focus: number;
  /** Session score from cleared events. */
  score: number;
  /** Locked or engaged enemy: name, health share, screen point above its head (null = hidden). */
  target: { name: string; hp: number; guard: boolean; x: number; y: number } | null;
  /** An attack on the hero: direction on screen (radians, 0 = up, clockwise) and whether a dodge works now. */
  threat: { angle: number; now: boolean } | null;
  /** Key or button that dodges ("Boşluk", "ZIPLA"). */
  dodgeKey: string;
  /** Key that does the takedown when focus is full ("E"), empty on touch (long press). */
  takedownKey: string;
  /** The nearest active event: its label and where it is on screen (or the screen edge). */
  marker: { mark: ScreenMark; label: string; type: string } | null;
  /** At an event: what is left to do ("Soygun · 3 düşman kaldı"), shown as a chip instead of the marker. */
  objective: { text: string; type: string } | null;
}

export function makeCombatHudState(): CombatHudState {
  return {
    on: false,
    hp: 100,
    maxHp: 100,
    regen: false,
    down: false,
    downLeft: 0,
    combo: 0,
    comboLeft: 0,
    focus: 0,
    score: 0,
    target: null,
    threat: null,
    dodgeKey: '',
    takedownKey: '',
    marker: null,
    objective: null,
  };
}

/**
 * The combat HUD (M11): health bar with regeneration and a damage ghost,
 * focus meter, score, combo counter with a draining ring beside the
 * crosshair, spider-sense chevrons toward an attacker with the "Kaç!" prompt,
 * the target's name and health above it, the nearest event's marker (an
 * arrow at the screen edge when it is off screen), event banners and the
 * knocked-out overlay. One layer inside the HUD (so it hides with it and
 * fades in the rooftop moment); every DOM write is guarded by a cached
 * value and moving parts only change transforms.
 */
export class CombatHud {
  readonly el: HTMLDivElement;
  private readonly vitals: HTMLDivElement;
  private readonly segs: HTMLDivElement[] = [];
  private readonly hpGhost: HTMLDivElement;
  private readonly hpText: Text;
  private readonly focusFill: HTMLDivElement;
  private readonly focusBar: HTMLDivElement;
  private readonly focusKey: Text;
  private readonly scoreText: Text;
  private readonly combo: HTMLDivElement;
  private readonly comboNum: Text;
  private readonly sense: HTMLDivElement;
  private readonly senseRot: HTMLDivElement;
  private readonly dodge: HTMLDivElement;
  private readonly dodgeKeyText: Text;
  private readonly target: HTMLDivElement;
  private readonly targetName: Text;
  private readonly targetFill: HTMLDivElement;
  private readonly marker: HTMLDivElement;
  private readonly markerArrow: HTMLDivElement;
  private readonly markerText: Text;
  private readonly banner: HTMLDivElement;
  private readonly bannerTitle: Text;
  private readonly bannerSub: Text;
  private readonly downEl: HTMLDivElement;
  private readonly downText: Text;
  private readonly hurtEl: HTMLDivElement;
  private readonly obj: HTMLDivElement;
  private readonly objText: Text;

  private on = false;
  private hpShown = -1;
  private segShown = -1;
  private ghost = 1;
  private ghostHold = 0;
  private regenOn = false;
  private lowOn = false;
  private focusShown = -1;
  private focusFull = false;
  private focusKeyShown = '';
  private scoreShown = -1;
  private comboShown = -1;
  private comboOn = false;
  private comboP = -1;
  private senseOn = false;
  private senseNow = false;
  private senseA = Number.NaN;
  private dodgeKeyShown = '';
  private targetOn = false;
  private targetNameShown = '';
  private targetHp = -1;
  private targetGuard = false;
  private markerOn = false;
  private markerOff = false;
  private markerType = '';
  private markerLabel = '';
  private bannerT = 0;
  private bannerKind = '';
  private downOn = false;
  private downShown = -1;
  private hurtT = 1;
  private hurtShown = -1;
  private objOn = false;
  private objType = '';

  constructor() {
    this.el = el('div', 'sk-ch');

    // Health and focus (bottom-left above the speed panel; top-left on touch).
    this.vitals = el('div', 'sk-ch-vitals');
    const hpRow = el('div', 'sk-ch-row');
    const hpLabel = el('span', 'sk-ch-label', tr.combat.hp);
    const bar = el('div', 'sk-ch-hp');
    this.hpGhost = el('div', 'sk-ch-hp-ghost');
    const segBox = el('div', 'sk-ch-segs');
    for (let i = 0; i < SEGMENTS; i++) {
      const sgm = el('div', 'sk-ch-seg');
      sgm.append(el('div', 'sk-ch-seg-fill'));
      this.segs.push(sgm);
      segBox.append(sgm);
    }
    bar.append(this.hpGhost, segBox);
    const hpNum = el('span', 'sk-ch-num');
    this.hpText = textNode(hpNum, '100');
    hpRow.append(hpLabel, bar, hpNum);
    const fRow = el('div', 'sk-ch-row sk-ch-frow');
    this.focusBar = el('div', 'sk-ch-focus');
    this.focusFill = el('div', 'sk-ch-focus-fill');
    this.focusBar.append(this.focusFill);
    const fKey = el('span', 'sk-ch-fkey');
    this.focusKey = textNode(fKey);
    const score = el('span', 'sk-ch-score');
    score.append(el('span', 'sk-ch-score-label', tr.combat.score));
    const scoreNum = el('span', 'sk-ch-score-num');
    this.scoreText = textNode(scoreNum, '0');
    score.append(scoreNum);
    fRow.append(el('span', 'sk-ch-label sk-ch-flabel', tr.combat.focus), this.focusBar, fKey, score);
    this.vitals.append(hpRow, fRow);

    // Combo counter beside the crosshair.
    this.combo = el('div', 'sk-ch-combo');
    const cNum = el('span', 'sk-ch-combo-num');
    this.comboNum = textNode(cNum, 'x0');
    this.combo.append(el('div', 'sk-ch-combo-ring'), cNum, el('span', 'sk-ch-combo-label', tr.combat.combo));

    // Spider-sense: chevrons around the crosshair toward the attacker, and the dodge prompt.
    this.sense = el('div', 'sk-ch-sense');
    this.senseRot = el('div', 'sk-ch-sense-rot');
    this.senseRot.append(el('div', 'sk-ch-chev sk-ch-chev-a'), el('div', 'sk-ch-chev sk-ch-chev-b'));
    this.sense.append(this.senseRot);
    this.dodge = el('div', 'sk-ch-dodge');
    const dKey = el('span', 'sk-ch-dodge-key');
    this.dodgeKeyText = textNode(dKey);
    this.dodge.append(el('span', 'sk-ch-dodge-text', tr.combat.dodge), dKey);

    // Target bar (projected above the enemy).
    this.target = el('div', 'sk-ch-target');
    const tName = el('div', 'sk-ch-target-name');
    this.targetName = textNode(tName);
    const tBar = el('div', 'sk-ch-target-bar');
    this.targetFill = el('div', 'sk-ch-target-fill');
    tBar.append(this.targetFill);
    this.target.append(tName, tBar);

    // Event marker (on screen at the event, or an arrow at the edge).
    this.marker = el('div', 'sk-ch-marker');
    this.markerArrow = el('div', 'sk-ch-marker-arrow');
    const mText = el('div', 'sk-ch-marker-text');
    this.markerText = textNode(mText);
    this.marker.append(this.markerArrow, el('div', 'sk-ch-marker-pin'), mText);

    // Event banner.
    this.banner = el('div', 'sk-ch-banner');
    this.banner.setAttribute('role', 'status');
    this.banner.setAttribute('aria-live', 'polite');
    const bTitle = el('div', 'sk-ch-banner-title');
    this.bannerTitle = textNode(bTitle);
    const bSub = el('div', 'sk-ch-banner-sub');
    this.bannerSub = textNode(bSub);
    this.banner.append(bTitle, bSub);

    // Knocked out.
    this.downEl = el('div', 'sk-ch-down');
    const dBox = el('div', 'sk-ch-down-box');
    const dText = el('div', 'sk-ch-down-sub');
    this.downText = textNode(dText);
    dBox.append(el('div', 'sk-ch-down-title', tr.combat.down), dText);
    this.downEl.append(dBox);

    this.hurtEl = el('div', 'sk-ch-hurt');

    // Objective chip (at an event).
    this.obj = el('div', 'sk-ch-obj');
    const oText = el('span', 'sk-ch-obj-text');
    this.objText = textNode(oText);
    this.obj.append(oText);

    this.el.append(this.hurtEl, this.marker, this.target, this.sense, this.combo, this.dodge, this.vitals, this.obj, this.banner, this.downEl);
  }

  /** A hit on the hero: the screen edge flashes red. */
  hurt(): void {
    this.hurtT = 0;
  }

  /** Show a banner (an announcement or a result); `type` tints it (event type). */
  showBanner(kind: BannerKind, title: string, sub: string, type: string): void {
    setText(this.bannerTitle, title);
    setText(this.bannerSub, sub);
    const cls = `is-${kind} is-${type}`;
    if (cls !== this.bannerKind) {
      this.banner.className = `sk-ch-banner ${cls}`;
      this.bannerKind = cls;
    }
    // Restart the pop-in animation.
    this.banner.classList.remove('is-on');
    void this.banner.offsetWidth;
    this.banner.classList.add('is-on');
    this.bannerT = kind === 'start' ? BANNER_TIME : RESULT_TIME;
  }

  hideBanner(): void {
    this.bannerT = 0;
    this.banner.classList.remove('is-on');
  }

  get bannerShown(): boolean {
    return this.bannerT > 0;
  }

  update(dt: number, s: CombatHudState): void {
    const on = s.on;
    if (on !== this.on) {
      this.el.classList.toggle('is-on', on);
      this.on = on;
    }
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) this.banner.classList.remove('is-on');
    }
    if (!on) return;
    this.updateVitals(dt, s);
    this.updateCombo(s);
    this.updateSense(s);
    this.updateTarget(s);
    this.updateMarker(s);
    this.updateObjective(s);
    this.updateDown(s);
    this.hurtT += dt;
    const hurt = Math.round(clamp(1 - this.hurtT / 0.5, 0, 1) * 40) / 40;
    if (hurt !== this.hurtShown) {
      this.hurtShown = hurt;
      this.hurtEl.style.opacity = hurt.toFixed(3);
    }
  }

  private updateVitals(dt: number, s: CombatHudState): void {
    const max = Math.max(1, s.maxHp);
    const f = clamp(s.hp / max, 0, 1);
    const hp = Math.ceil(clamp(s.hp, 0, max));
    if (hp !== this.hpShown) {
      this.hpShown = hp;
      setText(this.hpText, formatInteger(hp));
    }
    // Segments: full ones, then the partial one (scaled).
    const step = Math.round(f * SEGMENTS * 40);
    if (step !== this.segShown) {
      this.segShown = step;
      for (let i = 0; i < SEGMENTS; i++) {
        const k = clamp(f * SEGMENTS - i, 0, 1);
        (this.segs[i]!.firstChild as HTMLElement).style.transform = `scaleX(${k.toFixed(3)})`;
      }
    }
    // Damage ghost: holds, then drains to the health.
    if (f > this.ghost) this.ghost = f;
    else if (f < this.ghost) {
      this.ghostHold += dt;
      if (this.ghostHold > GHOST_DELAY) this.ghost = Math.max(f, this.ghost - dt * 0.6);
    }
    if (f >= this.ghost) this.ghostHold = 0;
    this.hpGhost.style.transform = `scaleX(${this.ghost.toFixed(3)})`;
    const regen = s.regen && f < 1;
    if (regen !== this.regenOn) {
      this.vitals.classList.toggle('is-regen', regen);
      this.regenOn = regen;
    }
    const low = f < 0.3;
    if (low !== this.lowOn) {
      this.vitals.classList.toggle('is-low', low);
      this.lowOn = low;
    }
    const focus = Math.round(clamp(s.focus, 0, 100));
    if (focus !== this.focusShown) {
      this.focusShown = focus;
      this.focusFill.style.transform = `scaleX(${(focus / 100).toFixed(3)})`;
    }
    const full = focus >= 100;
    if (full !== this.focusFull) {
      this.focusBar.classList.toggle('is-full', full);
      this.vitals.classList.toggle('is-ready', full);
      this.focusFull = full;
    }
    const fk = full ? (s.takedownKey ? `${tr.combat.takedown} ${s.takedownKey}` : tr.combat.takedown) : '';
    if (fk !== this.focusKeyShown) {
      this.focusKeyShown = fk;
      setText(this.focusKey, fk);
    }
    const sc = Math.round(s.score);
    if (sc !== this.scoreShown) {
      this.scoreShown = sc;
      setText(this.scoreText, formatInteger(sc));
      this.vitals.classList.toggle('has-score', sc > 0);
    }
  }

  private updateCombo(s: CombatHudState): void {
    const on = s.combo >= 2 && s.comboLeft > 0 && !s.down;
    if (on !== this.comboOn) {
      this.combo.classList.toggle('is-on', on);
      this.comboOn = on;
    }
    if (!on) return;
    if (s.combo !== this.comboShown) {
      this.comboShown = s.combo;
      setText(this.comboNum, `x${formatInteger(s.combo)}`);
      // Pop on every new hit.
      this.combo.classList.remove('is-pop');
      void this.combo.offsetWidth;
      this.combo.classList.add('is-pop');
    }
    const p = Math.round(clamp(s.comboLeft, 0, 1) * 100);
    if (p !== this.comboP) {
      this.comboP = p;
      this.combo.style.setProperty('--p', `${p}%`);
    }
  }

  private updateSense(s: CombatHudState): void {
    const t = s.down ? null : s.threat;
    const on = t !== null;
    if (on !== this.senseOn) {
      this.sense.classList.toggle('is-on', on);
      this.senseOn = on;
    }
    const now = t !== null && t.now;
    if (now !== this.senseNow) {
      this.sense.classList.toggle('is-now', now);
      this.dodge.classList.toggle('is-on', now);
      this.senseNow = now;
    }
    if (s.dodgeKey !== this.dodgeKeyShown) {
      this.dodgeKeyShown = s.dodgeKey;
      setText(this.dodgeKeyText, s.dodgeKey);
    }
    if (!t) return;
    if (Math.abs(t.angle - this.senseA) < 0.01) return;
    this.senseA = t.angle;
    this.senseRot.style.transform = `rotate(${t.angle.toFixed(3)}rad)`;
  }

  private updateTarget(s: CombatHudState): void {
    const t = s.down ? null : s.target;
    const on = t !== null;
    if (on !== this.targetOn) {
      this.target.classList.toggle('is-on', on);
      this.targetOn = on;
    }
    if (!t) return;
    if (t.name !== this.targetNameShown) {
      this.targetNameShown = t.name;
      setText(this.targetName, t.name);
    }
    const hp = Math.round(clamp(t.hp, 0, 1) * 200) / 200;
    if (hp !== this.targetHp) {
      this.targetHp = hp;
      this.targetFill.style.transform = `scaleX(${hp.toFixed(3)})`;
    }
    if (t.guard !== this.targetGuard) {
      this.target.classList.toggle('is-guard', t.guard);
      this.targetGuard = t.guard;
    }
    this.target.style.transform = `translate3d(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px, 0)`;
  }

  private updateMarker(s: CombatHudState): void {
    const m = s.marker;
    const on = m !== null;
    if (on !== this.markerOn) {
      this.marker.classList.toggle('is-on', on);
      this.markerOn = on;
    }
    if (!m) return;
    if (m.type !== this.markerType) {
      if (this.markerType) this.marker.classList.remove(`is-${this.markerType}`);
      this.marker.classList.add(`is-${m.type}`);
      this.markerType = m.type;
    }
    if (m.label !== this.markerLabel) {
      this.markerLabel = m.label;
      setText(this.markerText, m.label);
    }
    const off = !m.mark.onScreen;
    if (off !== this.markerOff) {
      this.marker.classList.toggle('is-off', off);
      this.markerOff = off;
    }
    this.marker.style.transform = `translate3d(${m.mark.x.toFixed(1)}px, ${m.mark.y.toFixed(1)}px, 0)`;
    if (off) this.markerArrow.style.transform = `rotate(${m.mark.angle.toFixed(3)}rad)`;
  }

  private updateObjective(s: CombatHudState): void {
    const o = s.down ? null : s.objective;
    const on = o !== null;
    if (on !== this.objOn) {
      this.obj.classList.toggle('is-on', on);
      this.objOn = on;
    }
    if (!o) return;
    if (o.type !== this.objType) {
      if (this.objType) this.obj.classList.remove(`is-${this.objType}`);
      this.obj.classList.add(`is-${o.type}`);
      this.objType = o.type;
    }
    setText(this.objText, o.text);
  }

  private updateDown(s: CombatHudState): void {
    if (s.down !== this.downOn) {
      this.downEl.classList.toggle('is-on', s.down);
      this.downOn = s.down;
    }
    if (!s.down) return;
    const left = Math.max(0, Math.ceil(s.downLeft));
    if (left !== this.downShown) {
      this.downShown = left;
      setText(this.downText, tr.combat.respawnIn(left));
    }
  }
}
