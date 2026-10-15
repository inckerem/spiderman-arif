import { Vector3 } from 'three';
import { DEFAULT_BINDINGS, MOUSE_BUTTONS, actionsForCode, mouseCode, type Action, type Bindings } from './bindings';

/** Snapshot of the player's intent for one simulation tick. */
export interface TickInput {
  /** Strafe right (+1) / left (-1). Keys give exactly -1, 0 or +1; the touch stick anything in between. */
  moveX: number;
  /** Forward (+1) / back (-1), analog like moveX. */
  moveY: number;
  jump: boolean;
  jumpPressed: boolean;
  sprint: boolean;
  /** Sprint speed on the ground without the wall cling of `sprint` (the touch stick pushed to its rim). */
  groundSprint: boolean;
  dive: boolean;
  swing: boolean;
  swingPressed: boolean;
  swingReleased: boolean;
  zip: boolean;
  zipPressed: boolean;
  /** Melee attack held / pressed (F, the touch Saldırı button): always a strike, auto-targeted (M11). */
  attack: boolean;
  attackPressed: boolean;
  /** Takedown pressed (E, a long press on Saldırı). */
  finisherPressed: boolean;
  /** Mouse wheel notches this tick: positive reels in. */
  reel: number;
  yaw: number;
  pitch: number;
  /** Aim ray (camera centre ray) used for targeting. */
  aimOrigin: Vector3;
  aimDir: Vector3;
}

/** Mouse travel (px, decaying with a 0.3 s time constant) that counts as deliberate movement. */
export const LOOK_ACTIVITY_PX = 140;
/** Actions whose keys never count as activity: they work during the rooftop moment without ending it. */
const QUIET_ACTIONS: readonly Action[] = ['music', 'photo'];

function clampAxis(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

export function emptyTickInput(): TickInput {
  return {
    moveX: 0,
    moveY: 0,
    jump: false,
    jumpPressed: false,
    sprint: false,
    groundSprint: false,
    dive: false,
    swing: false,
    swingPressed: false,
    swingReleased: false,
    zip: false,
    zipPressed: false,
    attack: false,
    attackPressed: false,
    finisherPressed: false,
    reel: 0,
    yaw: 0,
    pitch: 0,
    aimOrigin: new Vector3(),
    aimDir: new Vector3(0, 0, -1),
  };
}

/**
 * Keyboard and mouse state with pointer lock, read through the player's
 * bindings (src/input/bindings.ts). Keys and mouse buttons share one code
 * space (`KeyW`, `Mouse0`). Edges (press/release) are latched until the next
 * simulation tick consumes them, so short taps between ticks are never lost.
 * The on-screen touch controls (src/input/touch.ts) write into the same
 * state: an analog stick, buttons that hold actions (with the same latched
 * edges) and look drags added to the mouse deltas.
 */
export class Input {
  /** Held input codes: keys and `MouseN` buttons. */
  private held = new Set<string>();
  private pressedSinceTick = new Set<string>();
  private releasedSinceTick = new Set<string>();
  private bindings: Bindings = DEFAULT_BINDINGS;
  /** Every bound code; their browser defaults are suppressed while playing. */
  private bound = new Set<string>();
  private wheelAcc = 0;
  /** Actions held through on-screen buttons, with their own latched edges. */
  private readonly virtualHeld = new Set<Action>();
  private readonly virtualPressed = new Set<Action>();
  private readonly virtualReleased = new Set<Action>();
  /** Touch stick: analog axes (-1..1, dead zone applied) and the rim sprint. */
  stickX = 0;
  stickY = 0;
  stickSprint = false;
  mouseDX = 0;
  mouseDY = 0;
  pointerLocked = false;
  /** Gameplay input is ignored while false (menus open). */
  enabled = false;
  /**
   * Counts deliberate input for idle detection (the rooftop moment): key and
   * mouse-button presses, wheel notches, touches and a deliberate mouse
   * movement. Mouse jitter never counts: movement adds up with a 0.3 s decay
   * and only crossing LOOK_ACTIVITY_PX counts. Keys bound only to the quiet
   * actions (music toggle, photo mode) do not count either.
   */
  activity = 0;
  private lookTravel = 0;
  private lookAt = 0;
  private keyListeners: Array<(code: string, e: KeyboardEvent) => void> = [];
  private actionListeners: Array<(action: Action, e: KeyboardEvent | MouseEvent) => void> = [];
  private settleUntil = 0;
  private settleEvents = 0;
  private lockListeners: Array<(locked: boolean) => void> = [];

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    element.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('pointerdown', this.bump, true);
    window.addEventListener('touchstart', this.bump, { capture: true, passive: true });
    window.addEventListener('wheel', this.bump, { capture: true, passive: true });
    // Middle-click paste and the back/forward side buttons must not act while playing.
    window.addEventListener('auxclick', (e) => {
      if (this.pointerLocked) e.preventDefault();
    });
    this.setBindings(DEFAULT_BINDINGS);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('pointerlockerror', () => {
      this.pointerLocked = false;
    });
  }

  /** Raw key presses (fixed keys such as the debug panel and time-of-day presets). */
  onKey(listener: (code: string, e: KeyboardEvent) => void): void {
    this.keyListeners.push(listener);
  }

  /** Presses of bound actions, from keys or (while the pointer is locked) mouse buttons. */
  onAction(listener: (action: Action, e: KeyboardEvent | MouseEvent) => void): void {
    this.actionListeners.push(listener);
  }

  setBindings(b: Bindings): void {
    this.bindings = b;
    this.bound.clear();
    for (const slots of Object.values(b)) for (const code of slots) if (code !== null) this.bound.add(code);
  }

  onLock(listener: (locked: boolean) => void): void {
    this.lockListeners.push(listener);
  }

  requestLock(): void {
    if (document.pointerLockElement === this.element) return;
    try {
      const result = this.element.requestPointerLock() as unknown;
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => {
          /* Browser refused (e.g. too soon after Esc); the next click retries. */
        });
      }
    } catch {
      /* Pointer lock unsupported; mouse look still works while dragging is not required. */
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isHeld(action: Action): boolean {
    if (this.virtualHeld.has(action)) return true;
    for (const code of this.bindings[action]) if (code !== null && this.held.has(code)) return true;
    return false;
  }

  private wasPressed(action: Action): boolean {
    if (this.virtualPressed.has(action)) return true;
    for (const code of this.bindings[action]) if (code !== null && this.pressedSinceTick.has(code)) return true;
    return false;
  }

  /** A bound code (or on-screen button) went up since the last tick and nothing else still holds the action. */
  private wasReleased(action: Action): boolean {
    if (this.virtualHeld.has(action)) return false;
    let released = this.virtualReleased.has(action);
    for (const code of this.bindings[action]) {
      if (code === null) continue;
      if (this.releasedSinceTick.has(code)) released = true;
      else if (this.held.has(code)) return false;
    }
    return released;
  }

  /** Fill a tick snapshot from live device state and clear latched edges. */
  sample(out: TickInput, yaw: number, pitch: number): void {
    const on = this.enabled;
    const f = on && this.isHeld('forward') ? 1 : 0;
    const b = on && this.isHeld('back') ? 1 : 0;
    const l = on && this.isHeld('left') ? 1 : 0;
    const r = on && this.isHeld('right') ? 1 : 0;
    // Keys alone give exactly -1/0/+1; the touch stick adds its analog axes.
    out.moveX = on ? clampAxis(r - l + this.stickX) : 0;
    out.moveY = on ? clampAxis(f - b + this.stickY) : 0;
    out.jump = on && this.isHeld('jump');
    out.jumpPressed = on && this.wasPressed('jump');
    out.sprint = on && this.isHeld('sprint');
    out.groundSprint = on && this.stickSprint;
    out.dive = on && this.isHeld('dive');
    out.swing = on && this.isHeld('swing');
    out.swingPressed = on && this.wasPressed('swing');
    out.swingReleased = on && this.wasReleased('swing');
    out.zip = on && this.isHeld('zip');
    out.zipPressed = on && this.wasPressed('zip');
    out.attack = on && this.isHeld('attack');
    out.attackPressed = on && this.wasPressed('attack');
    out.finisherPressed = on && this.wasPressed('finisher');
    out.reel = on ? this.wheelAcc : 0;
    out.yaw = yaw;
    out.pitch = pitch;
    this.pressedSinceTick.clear();
    this.releasedSinceTick.clear();
    this.virtualPressed.clear();
    this.virtualReleased.clear();
    this.wheelAcc = 0;
  }

  /** An on-screen button went down: the action is held, with a press edge, like a key. */
  pressVirtual(action: Action): void {
    if (this.virtualHeld.has(action)) return;
    this.virtualHeld.add(action);
    this.virtualPressed.add(action);
  }

  /** An on-screen button went up (a press and release between two ticks still reaches the tick as a tap). */
  releaseVirtual(action: Action): void {
    if (this.virtualHeld.delete(action)) this.virtualReleased.add(action);
  }

  /**
   * Touch stick axes (-1..1) and whether it is pushed to its rim (ground
   * sprint). Leaving the dead zone counts as activity (like a key press), so a
   * thumb resting on the stick that starts to push ends the rooftop moment.
   */
  setStick(x: number, y: number, sprint: boolean): void {
    if ((x !== 0 || y !== 0) && this.stickX === 0 && this.stickY === 0) this.activity++;
    this.stickX = x;
    this.stickY = y;
    this.stickSprint = sprint;
  }

  /** Look drag from the touch controls, in mouse units: it goes through the mouse-look path. */
  addLook(dx: number, dy: number): void {
    this.mouseDX += dx;
    this.mouseDY += dy;
    this.trackLook(Math.abs(dx) + Math.abs(dy));
  }

  /** Reel notches from the touch reel buttons (positive reels in, like wheel up). */
  addReel(notches: number): void {
    this.wheelAcc += notches;
  }

  consumeMouse(): { dx: number; dy: number } {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  clearAll(): void {
    this.held.clear();
    this.pressedSinceTick.clear();
    this.releasedSinceTick.clear();
    this.virtualHeld.clear();
    this.virtualPressed.clear();
    this.virtualReleased.clear();
    this.setStick(0, 0, false);
    this.wheelAcc = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
  }

  private dispatch(code: string, e: KeyboardEvent | MouseEvent): void {
    if (this.actionListeners.length === 0) return;
    for (const action of actionsForCode(this.bindings, code)) for (const l of this.actionListeners) l(action, e);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const gameKey =
      e.code === 'Space' ||
      e.code.startsWith('Arrow') ||
      e.code === 'Backquote' ||
      e.code === 'Tab' ||
      (this.pointerLocked && this.bound.has(e.code));
    if (gameKey && !(e.target instanceof HTMLInputElement)) e.preventDefault();
    if (!e.repeat) {
      if (!this.quiet(e.code)) this.activity++;
      this.held.add(e.code);
      this.pressedSinceTick.add(e.code);
      for (const l of this.keyListeners) l(e.code, e);
      this.dispatch(e.code, e);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (this.held.delete(e.code)) this.releasedSinceTick.add(e.code);
  };

  /** Lost focus: nothing stays held, keys or on-screen buttons and the stick (no release edges, like a pause). */
  private onBlur = (): void => {
    this.held.clear();
    this.virtualHeld.clear();
    this.setStick(0, 0, false);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button >= MOUSE_BUTTONS || !this.pointerLocked) return;
    // Middle-button autoscroll and side-button navigation start on press.
    if (e.button === 1 || e.button >= 3) e.preventDefault();
    const code = mouseCode(e.button);
    this.held.add(code);
    this.pressedSinceTick.add(code);
    this.dispatch(code, e);
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button >= MOUSE_BUTTONS) return;
    if (this.pointerLocked && e.button >= 3) e.preventDefault();
    const code = mouseCode(e.button);
    if (this.held.delete(code)) this.releasedSinceTick.add(code);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    // Browsers can report the jump from the cursor position to the lock
    // centre as movement right after locking: ignore that settle window.
    if (performance.now() < this.settleUntil || this.settleEvents > 0) {
      this.settleEvents--;
      return;
    }
    // Guard against the occasional huge spike some browsers emit on lock.
    const dx = Math.abs(e.movementX) > 600 ? 0 : e.movementX;
    const dy = Math.abs(e.movementY) > 600 ? 0 : e.movementY;
    this.mouseDX += dx;
    this.mouseDY += dy;
    this.trackLook(Math.abs(dx) + Math.abs(dy));
  };

  /** Look travel adds up with a 0.3 s decay; crossing LOOK_ACTIVITY_PX counts as activity. */
  private trackLook(travel: number): void {
    const now = performance.now();
    this.lookTravel = this.lookTravel * Math.exp(-(now - this.lookAt) / 300) + travel;
    this.lookAt = now;
    if (this.lookTravel > LOOK_ACTIVITY_PX) {
      this.lookTravel = 0;
      this.activity++;
    }
  }

  private bump = (): void => {
    this.activity++;
  };

  /** True for a key bound only to quiet actions (an unbound key is not quiet). */
  private quiet(code: string): boolean {
    const actions = actionsForCode(this.bindings, code);
    if (actions.length === 0) return false;
    for (const a of actions) if (!QUIET_ACTIONS.includes(a)) return false;
    return true;
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.pointerLocked) return;
    e.preventDefault();
    // Wheel up (negative deltaY) reels in.
    this.wheelAcc += e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
  };

  private onLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.element;
    this.settleUntil = performance.now() + 150;
    this.settleEvents = 2;
    if (!this.pointerLocked) {
      for (let b = 0; b < MOUSE_BUTTONS; b++) this.held.delete(mouseCode(b));
      this.mouseDX = 0;
      this.mouseDY = 0;
    }
    for (const l of this.lockListeners) l(this.pointerLocked);
  };
}
