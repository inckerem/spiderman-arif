/**
 * Display names for input codes. Bindings store physical key positions
 * (KeyboardEvent.code), so the caption has to come from the player's own
 * layout: Chromium exposes it through navigator.keyboard.getLayoutMap(); other
 * browsers learn it from the keys the player actually presses. Until then
 * letters and symbols fall back to the US layout. Turkish names for named keys
 * and mouse buttons live in tr.ts.
 */
import { tr } from '../i18n/tr';
import type { BindingSlots } from '../input/bindings';

const US_SYMBOLS: Readonly<Record<string, string>> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  IntlBackslash: '<',
  Backquote: '`',
};

const NUMPAD_SYMBOLS: Readonly<Record<string, string>> = {
  Add: '+',
  Subtract: '−',
  Multiply: '×',
  Divide: '÷',
  Decimal: ',',
  Comma: ',',
  Equal: '=',
};

interface LayoutMapKeyboard {
  getLayoutMap?: () => Promise<Iterable<[string, string]>>;
}

let layout: ReadonlyMap<string, string> | null = null;
const learned = new Map<string, string>();

/** Reads the layout map where the browser offers one. Resolves true when it changed. */
export async function loadKeyboardLayout(): Promise<boolean> {
  const kb = (navigator as Navigator & { keyboard?: LayoutMapKeyboard }).keyboard;
  if (!kb?.getLayoutMap) return false;
  try {
    const next = new Map(await kb.getLayoutMap());
    const changed = !layout || layout.size !== next.size || [...next].some(([code, key]) => layout?.get(code) !== key);
    layout = next;
    return changed;
  } catch {
    // Not allowed here (e.g. inside a cross-origin frame): keep the fallbacks.
    return false;
  }
}

/** Learns the character an unmodified key press types. Returns true when a caption changed. */
export function learnKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.getModifierState('AltGraph')) return false;
  const key = e.key;
  if ([...key].length !== 1 || /\s/.test(key) || learned.get(e.code) === key) return false;
  learned.set(e.code, key);
  return true;
}

/** Own entries only: a stored code such as `toString` must not find Object.prototype members. */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function upper(ch: string, code: string): string {
  // Turkish layouts type the dotted i on another key than KeyI (which types ı there).
  if (ch === 'i') return code === 'KeyI' ? 'I' : 'İ';
  return ch.toUpperCase();
}

/** Caption for one input code: "W", "Boşluk", "Sol tık", "Num +". */
export function keyLabel(code: string): string {
  const mouse = /^Mouse([0-4])$/.exec(code);
  if (mouse) return tr.keys.mouse[Number(mouse[1])] ?? code;
  const named = own<string>(tr.keys.named, code);
  if (named) return named;
  const numpad = /^Numpad(\w+)$/.exec(code);
  if (numpad) {
    const rest = numpad[1] ?? '';
    return tr.keys.numpad(own(NUMPAD_SYMBOLS, rest) ?? rest);
  }
  const us = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : own(US_SYMBOLS, code);
  const ch = layout?.get(code) || learned.get(code) || us;
  return ch ? upper(ch, code) : code;
}

/** Captions for an action's bound slots; Left + Right Shift read as one "Shift". */
export function slotLabels(slots: BindingSlots): string[] {
  const codes = slots.filter((c): c is string => c !== null);
  if (codes.length === 2 && codes.includes('ShiftLeft') && codes.includes('ShiftRight')) return [tr.keys.shift];
  return codes.map(keyLabel);
}

/** Caption of the first bound slot, or null when the action has no key. */
export function primaryLabel(slots: BindingSlots): string | null {
  const labels = slotLabels(slots);
  return labels[0] ?? null;
}
