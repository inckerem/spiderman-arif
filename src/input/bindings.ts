/**
 * Rebindable controls. Each action has two slots holding input codes:
 * KeyboardEvent.code values (physical key positions, so the defaults sit under
 * the same fingers on every keyboard layout) or `Mouse0`..`Mouse4` for mouse
 * buttons. Bindings are plain data, validated like the rest of the settings,
 * and never mutated in place: every change returns a new object.
 */

export const ACTIONS = [
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'sprint',
  'dive',
  'swing',
  'zip',
  'music',
  'photo',
  'timePause',
  'timeFast',
] as const;

export type Action = (typeof ACTIONS)[number];

/** Primary and secondary input code; null = slot empty. */
export type BindingSlots = readonly [string | null, string | null];

export type Bindings = Readonly<Record<Action, BindingSlots>>;

function freezeBindings(b: Record<Action, BindingSlots>): Bindings {
  for (const a of ACTIONS) Object.freeze(b[a]);
  return Object.freeze(b);
}

export const DEFAULT_BINDINGS: Bindings = freezeBindings({
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space', null],
  sprint: ['ShiftLeft', 'ShiftRight'],
  dive: ['KeyC', 'KeyQ'],
  swing: ['Mouse0', null],
  zip: ['Mouse2', null],
  music: ['KeyM', null],
  photo: ['KeyP', null],
  timePause: ['KeyT', null],
  timeFast: ['KeyY', null],
});

/** Mouse buttons 0..4: left, middle, right, back, forward. */
export const MOUSE_BUTTONS = 5;

export function mouseCode(button: number): string {
  return `Mouse${button}`;
}

/**
 * Keys that can never be bound: Esc releases the mouse (the browser owns it),
 * Tab moves focus in menus and the photo panel, ` and 1-4 are the fixed debug
 * and time-of-day keys, Backspace/Delete clear a slot while rebinding, and
 * modifier, function, lock and media keys collide with browser and system
 * shortcuts (Ctrl+W closes the tab) or do not report reliable key-up events.
 */
const RESERVED = new Set([
  'Escape',
  'Tab',
  'Backquote',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Backspace',
  'Delete',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'ContextMenu',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Pause',
  'PrintScreen',
  'Fn',
  'FnLock',
  'Unidentified',
]);
const RESERVED_PATTERN = /^(F\d+|Audio\w*|Media\w*|Browser\w*|Launch\w*|Power|Sleep|WakeUp|Eject)$/;
const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

export function isReservedCode(code: string): boolean {
  return RESERVED.has(code) || RESERVED_PATTERN.test(code);
}

/** True for a code that may be stored in a slot. */
export function isBindableCode(code: unknown): code is string {
  if (typeof code !== 'string' || !CODE_PATTERN.test(code) || isReservedCode(code)) return false;
  // No key reports a code named like an Object.prototype member (`toString`).
  if (code in Object.prototype) return false;
  if (code.startsWith('Mouse')) return /^Mouse[0-4]$/.test(code);
  return true;
}

/** The actions that list `code` in one of their slots (at most one after sanitizing). */
export function actionsForCode(b: Bindings, code: string): Action[] {
  return ACTIONS.filter((a) => b[a][0] === code || b[a][1] === code);
}

/**
 * Puts `code` (or null to clear) into one slot. The code is removed from every
 * other slot first, so a code always triggers exactly one action. Returns the
 * new bindings and the action the code was taken from, if any.
 */
export function assignBinding(
  b: Bindings,
  action: Action,
  slot: 0 | 1,
  code: string | null,
): { bindings: Bindings; takenFrom: Action | null } {
  let takenFrom: Action | null = null;
  const next = {} as Record<Action, BindingSlots>;
  for (const a of ACTIONS) {
    let s0 = b[a][0];
    let s1 = b[a][1];
    if (code !== null) {
      if (s0 === code) s0 = null;
      if (s1 === code) s1 = null;
      if ((s0 !== b[a][0] || s1 !== b[a][1]) && a !== action) takenFrom = a;
    }
    next[a] = [s0, s1];
  }
  const own = next[action];
  next[action] = slot === 0 ? [code, own[1]] : [own[0], code];
  return { bindings: next, takenFrom };
}

/**
 * Builds valid bindings from untrusted data (storage). Stored slots are kept
 * when they hold bindable codes; any other slot value reads as empty, and an
 * action whose entry is missing or malformed gets its default. A code bound
 * twice keeps only its first occurrence, with explicitly stored actions taking
 * priority over defaults filled in for missing ones.
 */
export function sanitizeBindings(data: unknown): Bindings {
  const o = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const used = new Set<string>();
  const out = {} as Record<Action, BindingSlots>;
  const take = (code: unknown): string | null => {
    if (!isBindableCode(code) || used.has(code)) return null;
    used.add(code);
    return code;
  };
  const stored = (a: Action): unknown[] | null => {
    const v = Object.prototype.hasOwnProperty.call(o, a) ? o[a] : undefined;
    return Array.isArray(v) && v.length === 2 ? v : null;
  };
  for (const a of ACTIONS) {
    const v = stored(a);
    if (v) out[a] = [take(v[0]), take(v[1])];
  }
  for (const a of ACTIONS) {
    if (!out[a]) out[a] = [take(DEFAULT_BINDINGS[a][0]), take(DEFAULT_BINDINGS[a][1])];
  }
  return out;
}
