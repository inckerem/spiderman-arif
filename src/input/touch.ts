import { tuning } from '../config/tuning';
import { tr } from '../i18n/tr';
import { el } from '../ui/dom';
import type { Action } from './bindings';
import type { Input } from './input';

/** What the touch layer shows: nothing (menus), the full play controls, or only stick and look (photo mode). */
export type TouchView = 'off' | 'play' | 'photo';

/** Hook for an action button the simulation does not own yet (the M11 Attack button). */
export interface TouchButtonHandler {
  press(): void;
  release(): void;
}

/**
 * Touch play: the primary pointer is coarse and the device reports touch
 * points (phones, tablets). A laptop or desktop with a touchscreen has a fine
 * primary pointer and keeps mouse and keyboard. `?dokunmatik=1` forces the
 * touch controls on (testing on a desktop), `?dokunmatik=0` forces them off.
 */
export function detectTouchMode(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('dokunmatik');
    if (q === '1') return true;
    if (q === '0') return false;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    return coarse && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window);
  } catch {
    return false;
  }
}

interface PadButton {
  readonly el: HTMLButtonElement;
  /** Bound action held while the button is down (null: custom handler or one-shot). */
  readonly action: Action | null;
  /** Pointer holding the button (-1 = up). */
  pointer: number;
  /** Reel buttons: notches per press and the repeat countdown while held. */
  readonly reel: number;
  repeatT: number;
  handler: TouchButtonHandler | null;
}

const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1" fill="currentColor"/><rect x="13.8" y="5" width="4.2" height="14" rx="1" fill="currentColor"/></svg>';

function capture(target: Element, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // The pointer is already gone (released between the event and this call).
  }
}

/**
 * On-screen touch controls, built with Pointer Events and tracked per pointer
 * id, so the stick, a look drag and any number of buttons work at once.
 *
 * - Left side: a floating analog stick that appears where the thumb lands.
 *   Deflection past a dead zone maps linearly to 0..1 (full at `fullAt`);
 *   the knob at its rim (`sprintAt`) sprints on the ground (`groundSprint`).
 * - Right side: drag to look. Pixels become mouse units for `rig.applyMouse`,
 *   so invert Y and the pitch limits apply exactly as for the mouse.
 * - Bottom right: Ağ (hold = left button), Çek (right button), Zıpla, Dalış
 *   (hold), Tırman (hold = sprint: wall cling and climb), reel + and − while
 *   swinging (wheel notches, repeating while held) and the hidden Saldırı
 *   button for M11 (`setAttackHandler`). Top left: pause.
 *
 * Everything writes into `Input` (held actions with latched edges, stick axes,
 * mouse deltas, wheel notches), so the simulation sees one input path. The DOM
 * is touched only on pointer events and view changes (transforms and classes,
 * written only when they change); nothing is allocated per frame.
 */
export class TouchControls {
  readonly el: HTMLDivElement;
  /** Pause button tapped. */
  onPause: () => void = () => {};
  /** Touch look sensitivity (settings) and the mouse sensitivity the look path multiplies by. */
  lookSensitivity = 1;
  mouseSensitivity = 1;

  private readonly stickZone: HTMLDivElement;
  private readonly lookZone: HTMLDivElement;
  private readonly stickBase: HTMLDivElement;
  private readonly stickKnob: HTMLDivElement;
  private readonly buttons: PadButton[] = [];
  private readonly attack: PadButton;
  private view: TouchView = 'off';
  private swinging = false;
  private stickId = -1;
  private stickCX = 0;
  private stickCY = 0;
  private stickSprint = false;
  private knobX = 0;
  private knobY = 0;
  private lookId = -1;
  private lookX = 0;
  private lookY = 0;

  constructor(private readonly input: Input) {
    const T = tr.touch;
    const layer = el('div', 'sk-touch');
    layer.dataset.view = 'off';
    layer.style.setProperty('--sk-stick-r', `${Math.round(tuning.touch.stickRadius)}px`);
    this.el = layer;
    layer.addEventListener('contextmenu', (e) => e.preventDefault());

    this.stickZone = el('div', 'sk-tz sk-tz-stick');
    this.lookZone = el('div', 'sk-tz sk-tz-look');
    this.stickBase = el('div', 'sk-stick');
    this.stickBase.setAttribute('aria-hidden', 'true');
    this.stickKnob = el('div', 'sk-stick-knob');
    this.stickBase.append(this.stickKnob);
    this.stickZone.append(this.stickBase);

    const pad = el('div', 'sk-pad');
    const make = (cls: string, label: string, action: Action | null, reel = 0): PadButton => {
      const b = el('button', `sk-tb ${cls}`);
      b.type = 'button';
      b.tabIndex = -1;
      b.setAttribute('aria-label', label);
      b.append(el('span', 'sk-tb-label', reel > 0 ? '+' : reel < 0 ? '−' : label));
      const btn: PadButton = { el: b, action, pointer: -1, reel, repeatT: 0, handler: null };
      this.buttons.push(btn);
      pad.append(b);
      return btn;
    };
    make('sk-tb-web', T.web, 'swing');
    make('sk-tb-pull', T.pull, 'zip');
    make('sk-tb-jump', T.jump, 'jump');
    make('sk-tb-dive', T.dive, 'dive');
    make('sk-tb-climb', T.climb, 'sprint');
    make('sk-tb-reel sk-tb-reel-in', T.reelIn, null, 1);
    make('sk-tb-reel sk-tb-reel-out', T.reelOut, null, -1);
    this.attack = make('sk-tb-attack', T.attack, null);
    this.attack.el.hidden = true;

    const pause = el('button', 'sk-tb sk-tb-pause');
    pause.type = 'button';
    pause.tabIndex = -1;
    pause.setAttribute('aria-label', T.pause);
    pause.innerHTML = ICON_PAUSE;
    pause.addEventListener('pointerdown', (e) => e.preventDefault());
    pause.addEventListener('click', () => this.onPause());

    layer.append(this.stickZone, this.lookZone, pad, pause);
    for (const b of this.buttons) this.wireButton(b);
    this.wireStick();
    this.wireLook();
  }

  get currentView(): TouchView {
    return this.view;
  }

  /** Show the controls for play, only stick and look for photo mode, or nothing; leaving a view lets everything go. */
  setView(v: TouchView): void {
    if (v === this.view) return;
    this.view = v;
    this.el.dataset.view = v;
    this.releaseAll();
  }

  /** The reel buttons show while a line is attached. */
  setSwinging(on: boolean): void {
    if (on === this.swinging) return;
    this.swinging = on;
    this.el.classList.toggle('is-swinging', on);
  }

  /**
   * M11 hook: a handler shows the Saldırı button and receives its press and
   * release (M11 turns them into `attack`/`attackPressed`); null hides it.
   */
  setAttackHandler(handler: TouchButtonHandler | null): void {
    if (this.attack.pointer !== -1) this.release(this.attack);
    this.attack.handler = handler;
    this.attack.el.hidden = handler === null;
  }

  /** Per frame: held reel buttons repeat a notch. */
  update(dt: number): void {
    for (const b of this.buttons) {
      if (b.reel === 0 || b.pointer === -1) continue;
      b.repeatT -= dt;
      if (b.repeatT <= 0) {
        b.repeatT += tuning.touch.reelRepeat;
        this.input.addReel(b.reel);
      }
    }
  }

  /** Let go of every pointer: buttons up (with release edges), stick centred, look drag ended. */
  releaseAll(): void {
    for (const b of this.buttons) if (b.pointer !== -1) this.release(b);
    this.endStick();
    this.lookId = -1;
  }

  // ------------------------------------------------------------- buttons

  private wireButton(b: PadButton): void {
    b.el.addEventListener('pointerdown', (e) => {
      // No focus, no emulated mouse events, no click.
      e.preventDefault();
      if (b.pointer !== -1) return;
      b.pointer = e.pointerId;
      capture(b.el, e.pointerId);
      this.press(b);
    });
    const up = (e: PointerEvent): void => {
      if (e.pointerId === b.pointer) this.release(b);
    };
    b.el.addEventListener('pointerup', up);
    b.el.addEventListener('pointercancel', up);
    b.el.addEventListener('lostpointercapture', up);
  }

  private press(b: PadButton): void {
    b.el.classList.add('is-down');
    if (b.action) this.input.pressVirtual(b.action);
    else if (b.handler) b.handler.press();
    else if (b.reel !== 0) {
      this.input.addReel(b.reel);
      b.repeatT = tuning.touch.reelRepeat * 2;
    }
  }

  private release(b: PadButton): void {
    b.pointer = -1;
    b.el.classList.remove('is-down');
    if (b.action) this.input.releaseVirtual(b.action);
    else if (b.handler) b.handler.release();
  }

  // --------------------------------------------------------------- stick

  private wireStick(): void {
    const z = this.stickZone;
    z.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.stickId !== -1) return;
      this.stickId = e.pointerId;
      capture(z, e.pointerId);
      this.stickCX = e.clientX;
      this.stickCY = e.clientY;
      // The base jumps under the thumb (a layout write once per touch, not per move).
      this.stickBase.style.left = `${e.clientX}px`;
      this.stickBase.style.top = `${e.clientY}px`;
      this.stickBase.classList.add('is-active');
      this.moveStick(e.clientX, e.clientY);
    });
    z.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) this.moveStick(e.clientX, e.clientY);
    });
    const up = (e: PointerEvent): void => {
      if (e.pointerId === this.stickId) this.endStick();
    };
    z.addEventListener('pointerup', up);
    z.addEventListener('pointercancel', up);
    z.addEventListener('lostpointercapture', up);
  }

  private moveStick(x: number, y: number): void {
    const T = tuning.touch;
    const R = Math.max(1, T.stickRadius);
    const dx = x - this.stickCX;
    const dy = y - this.stickCY;
    const d = Math.hypot(dx, dy);
    const r = d / R;
    const mag = r <= T.deadZone ? 0 : Math.min(1, (r - T.deadZone) / Math.max(1e-3, T.fullAt - T.deadZone));
    const sprint = r >= T.sprintAt;
    // Screen up is forward.
    this.input.setStick(mag > 0 ? (dx / d) * mag : 0, mag > 0 ? (-dy / d) * mag : 0, sprint);
    const k = d > R ? R / d : 1;
    this.setKnob(Math.round(dx * k), Math.round(dy * k));
    if (sprint !== this.stickSprint) {
      this.stickSprint = sprint;
      this.stickBase.classList.toggle('is-sprint', sprint);
    }
  }

  private endStick(): void {
    this.stickId = -1;
    this.input.setStick(0, 0, false);
    this.setKnob(0, 0);
    if (this.stickSprint) {
      this.stickSprint = false;
      this.stickBase.classList.remove('is-sprint');
    }
    if (this.stickBase.classList.contains('is-active')) {
      this.stickBase.classList.remove('is-active');
      this.stickBase.style.left = '';
      this.stickBase.style.top = '';
    }
  }

  private setKnob(x: number, y: number): void {
    if (x === this.knobX && y === this.knobY) return;
    this.knobX = x;
    this.knobY = y;
    this.stickKnob.style.transform = x === 0 && y === 0 ? '' : `translate(${x}px, ${y}px)`;
  }

  // ---------------------------------------------------------------- look

  private wireLook(): void {
    const z = this.lookZone;
    z.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.lookId !== -1) return;
      this.lookId = e.pointerId;
      capture(z, e.pointerId);
      this.lookX = e.clientX;
      this.lookY = e.clientY;
    });
    z.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      const dx = e.clientX - this.lookX;
      const dy = e.clientY - this.lookY;
      this.lookX = e.clientX;
      this.lookY = e.clientY;
      // CSS px to mouse units: rig.applyMouse turns them into radians with the mouse sensitivity.
      const k = (tuning.touch.lookRadPerPx * this.lookSensitivity) / Math.max(1e-6, tuning.camera.baseSensitivity * this.mouseSensitivity);
      if (dx !== 0 || dy !== 0) this.input.addLook(dx * k, dy * k);
    });
    const up = (e: PointerEvent): void => {
      if (e.pointerId === this.lookId) this.lookId = -1;
    };
    z.addEventListener('pointerup', up);
    z.addEventListener('pointercancel', up);
    z.addEventListener('lostpointercapture', up);
  }
}
