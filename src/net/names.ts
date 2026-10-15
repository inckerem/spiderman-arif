/**
 * Player names (design M12 §6): validation, a basic Turkish + English
 * profanity filter and per-room unique display names. Shared by the server
 * (authoritative) and the client (instant feedback). PURE.
 */

export const NAME_MIN = 3;
export const NAME_MAX = 16;
/** localStorage key where the client keeps the bare name. */
export const NAME_STORAGE_KEY = 'skythread.name.v1';

export type NameProblem = 'empty' | 'short' | 'long' | 'chars' | 'profanity';
export type NameCheck = { ok: true; name: string } | { ok: false; why: NameProblem };

const ALLOWED = /^[A-Za-z0-9ÇĞİÖŞÜçğıöşü _.\-]+$/;
const ALNUM = /[A-Za-z0-9ÇĞİÖŞÜçğıöşü]/;
// Zero-width and other format characters, controls, bidi overrides.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤﻿]/;

/**
 * NFC, trim, collapse inner whitespace, then: 3–16 characters of letters
 * (including Turkish), digits, space, `_ . -`, at least one letter or digit,
 * and nothing profane. Returns the cleaned name.
 */
export function checkName(raw: string): NameCheck {
  if (typeof raw !== 'string') return { ok: false, why: 'empty' };
  if (INVISIBLE.test(raw)) return { ok: false, why: 'chars' };
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length === 0) return { ok: false, why: 'empty' };
  if (name.length < NAME_MIN) return { ok: false, why: 'short' };
  if (name.length > NAME_MAX) return { ok: false, why: 'long' };
  if (!ALLOWED.test(name) || !ALNUM.test(name)) return { ok: false, why: 'chars' };
  if (isProfane(name)) return { ok: false, why: 'profanity' };
  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// Profanity

const LEET: Readonly<Record<string, string>> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '|': 'i', '€': 'e',
  // Turkish letters fold to ASCII so "şerefsiz" and "serefsiz" read the same.
  ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u',
};

/**
 * Lowercase (Turkish rules: I → ı, İ → i), map leetspeak and Turkish letters,
 * drop everything that is not a-z (separators), collapse repeated letters.
 */
export function profanityKey(s: string): string {
  const lower = s.normalize('NFC').toLocaleLowerCase('tr');
  let out = '';
  let prev = '';
  for (const ch of lower) {
    const m = LEET[ch] ?? ch;
    if (m < 'a' || m > 'z' || m.length !== 1) continue;
    if (m === prev) continue;
    out += m;
    prev = m;
  }
  return out;
}

/**
 * Stems, written as profanityKey would produce them (folded, no doubled
 * letters), matched as substrings. Short risky stems ("sik", "göt", "am")
 * are only listed in derived forms.
 */
const STEMS: readonly string[] = [
  // Turkish
  'amcik', 'aminako', 'amk', 'orospu', 'orosbu', 'pezevenk', 'kahpe', 'kaltak', 'ibne', 'ipne', 'gavat',
  'yavsak', 'serefsiz', 'surtuk', 'yarak', 'yarag', 'tasak', 'pust', 'kancik', 'siktir', 'sikis', 'sikik',
  'sikim', 'siker', 'sikey', 'sikiy', 'siksen', 'sikicem', 'gotveren', 'gotlek', 'gotos',
  // English
  'fuck', 'fck', 'shit', 'cunt', 'bitch', 'biatch', 'niger', 'niga', 'fagot', 'ashole', 'dick', 'cock',
  'pusy', 'whore', 'slut', 'bastard', 'wank', 'twat', 'porn', 'penis', 'vagina', 'retard', 'hitler',
  'rapist', 'molest', 'pedo',
];

/** Stems too short for substring matching: they count only as a whole word of the name. */
const WORD_ONLY: ReadonlySet<string> = new Set(['oc', 'pic', 'fuk']);

/** Ordinary words that contain a stem; masked out before matching. */
const ALLOW: readonly string[] = [
  'sikke', 'sikayet', 'sikinti', 'sikisik', 'eksik', 'kesik', 'basik', 'esik', 'musiki', 'kasik', 'hamk',
  'scunthorpe', 'peacock', 'hancock', 'hitchcock', 'babcock', 'cockpit', 'cocktail', 'woodcock', 'shuttlecock',
  'dickens', 'dickinson', 'dickson', 'mishit', 'shitake', 'nigar', 'nigeria', 'therapist', 'torpedo', 'speedo',
  'pedometer', 'pedometre', 'swank',
].map(profanityKey);

function maskAllowed(key: string): string {
  let k = key;
  for (const a of ALLOW) {
    for (let i = k.indexOf(a); i >= 0; i = k.indexOf(a, i + a.length)) {
      k = k.slice(0, i) + '_'.repeat(a.length) + k.slice(i + a.length);
    }
  }
  return k;
}

export function isProfane(name: string): boolean {
  const whole = profanityKey(name);
  if (!whole) return false;
  const masked = maskAllowed(whole);
  for (const s of STEMS) if (masked.includes(s)) return true;
  if (WORD_ONLY.has(whole)) return true;
  for (const token of name.normalize('NFC').split(/[\s_.\-]+/)) if (WORD_ONLY.has(profanityKey(token))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Unique display names

/** Case-insensitive (Turkish rules) key for uniqueness within a room. */
export const nameKey = (name: string): string => name.toLocaleLowerCase('tr');

/**
 * `base` if no player in the room uses it, else `base#2`, `base#3`, ...
 * `taken` holds nameKey() of every display name in the room.
 */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(nameKey(base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}#${n}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}
