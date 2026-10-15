import './styles.css';
import { tr } from '../i18n/tr';
import type { CityLayout } from '../world/types';
import {
  DEFAULT_SETTINGS,
  SETTINGS_LIMITS,
  loadSettings,
  saveSettings,
  type BooleanSettingKey,
  type NumericSettingKey,
  type Settings,
} from './settings';
import { Hud } from './hud';
import { Minimap } from './minimap';
import {
  DEFAULT_BINDINGS,
  MOUSE_BUTTONS,
  assignBinding,
  isBindableCode,
  mouseCode,
  type Action,
} from '../input/bindings';
import { keyLabel, learnKey, loadKeyboardLayout, primaryLabel, slotLabels } from './keyLabels';
import { COSTUME_IDS, slotCss, type CostumeId } from '../character/costumes';
import {
  clamp,
  el,
  formatClock,
  formatDecimal2,
  formatInteger,
  formatPercent,
  formatSigned,
  icon,
  roundToStep,
  setText,
  textNode,
} from './dom';

export { formatTime } from './dom';
export type { Settings } from './settings';

export interface HudState {
  /** m/s; shown as km/h (rounded). */
  speed: number;
  /** metres. */
  altitude: number;
  /** Crosshair: valid swing anchor = highlighted amber ring; none = dimmed grey. */
  anchorValid: boolean;
  /** Zip target available; when only this is true the crosshair shows a small secondary tick. */
  zipValid: boolean;
  /** CSS px of the current anchor point on screen (diamond marker when valid), null = hidden. */
  anchorScreen: { x: number; y: number } | null;
  /** Rope in the good-release window: the crosshair pulses before the player releases. */
  goodWindow: boolean;
  /** Seconds since the last good release (use Infinity before the first one); burst shows for 0.9 s. */
  goodFlash: number;
  ring: null | {
    routeName: string;
    index: number;
    total: number;
    time: number;
    best: number | null;
    finished: null | { time: number; best: number; newBest: boolean };
  };
  /** null = hidden. */
  fps: number | null;
}

export interface MinimapRing {
  x: number;
  z: number;
  next: boolean;
  done: boolean;
  route: number;
}

export interface PhotoOptions {
  fov: number;
  hour: number;
  onChange: (fov: number, hour: number) => void;
  onSave: () => void;
  onExit: () => void;
}

type MenuScreen = 'main' | 'pause' | 'controls' | 'settings' | 'bindings' | 'costume';
type SubScreen = 'controls' | 'settings' | 'bindings' | 'costume';
type UiSound = 'click' | 'hover';
type ControlRowId = (typeof tr.controls.rows)[number][0];

interface BindingSlotView {
  action: Action;
  slot: 0 | 1;
  btn: HTMLButtonElement;
  text: Text;
}

interface SliderSpec {
  min: number;
  max: number;
  step: number;
  toUi: (v: number) => number;
  fromUi: (u: number) => number;
  format: (v: number) => string;
}

const SCREEN_NAMES: readonly MenuScreen[] = ['main', 'pause', 'controls', 'settings', 'bindings', 'costume'];
/** Movement keys in the order players read them ("W A S D"). */
const MOVE_ACTIONS: readonly Action[] = ['forward', 'left', 'back', 'right'];
/** Controls-screen rows whose keys come from the bindings; the others use tr.controls.fixedKeys. */
const CONTROL_ROW_ACTIONS: Partial<Record<ControlRowId, readonly Action[]>> = {
  move: MOVE_ACTIONS,
  swing: ['swing'],
  zip: ['zip'],
  jump: ['jump'],
  sprint: ['sprint'],
  dive: ['dive'],
  music: ['music'],
  photo: ['photo'],
  timePause: ['timePause'],
  timeFast: ['timeFast'],
};
const HOLD_ROWS: ReadonlySet<ControlRowId> = new Set<ControlRowId>(['swing', 'timeFast']);
/** Menu card art for a costume: mask with lenses over the shoulders, in the costume's colours. */
function costumeArt(id: CostumeId): string {
  const c = (slot: Parameters<typeof slotCss>[1]): string => slotCss(id, slot);
  const ink = '#111';
  return (
    `<svg viewBox="0 0 80 96" aria-hidden="true" focusable="false">` +
    `<path d="M4 97C6 76 17 67 40 65C63 67 74 76 76 97Z" fill="${c('secondary')}" stroke="${ink}" stroke-width="2.5"/>` +
    `<path d="M24 97L26 69Q40 63 54 69L56 97Z" fill="${c('primary')}" stroke="${ink}" stroke-width="2"/>` +
    `<path d="M40 70L43.5 78.5L40 91L36.5 78.5Z M42 76L53 69.5 M38 76L27 69.5" fill="${c('accent')}" stroke="${c('accent')}" stroke-width="2.4" stroke-linecap="round"/>` +
    `<path d="M40 6C57 6 65 19 65 34C65 51 54 63 40 65C26 63 15 51 15 34C15 19 23 6 40 6Z" fill="${c('primary')}" stroke="${ink}" stroke-width="2.5"/>` +
    `<path d="M44.5 42C44 33 50 24 57.5 24.5C62 25 63 30 61 35.5C58.5 41 51.5 44 44.5 42Z" fill="${c('lens')}" stroke="${c('rim')}" stroke-width="2.6" stroke-linejoin="round"/>` +
    `<path d="M35.5 42C36 33 30 24 22.5 24.5C18 25 17 30 19 35.5C21.5 41 28.5 44 35.5 42Z" fill="${c('lens')}" stroke="${c('rim')}" stroke-width="2.6" stroke-linejoin="round"/>` +
    `</svg>`
  );
}

const CAPTURE_MOUSE_EVENTS = ['mousedown', 'mouseup', 'click', 'auxclick', 'contextmenu'] as const;
const TOAST_MS = 1600;
const LOADING_FADE_MS = 480;
const PHOTO_FOV = { min: 30, max: 110, step: 1 };
const PHOTO_MINUTES = { min: 0, max: 24 * 60, step: 5 };
const LOADING_STAGES: Readonly<Record<string, string>> = tr.loading;

const ICON_SPEAKER =
  '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 9.2v5.6h4.2l5.3 4.2V5L7.2 9.2z"/>' +
  '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M15.8 8.6a4.8 4.8 0 0 1 0 6.8M18.6 5.9a8.6 8.6 0 0 1 0 12.2"/></svg>';
const ICON_MOUSE =
  '<svg viewBox="0 0 24 24"><rect x="5.5" y="2.5" width="13" height="19" rx="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/>' +
  '<path fill="currentColor" d="M12 3.7V10H6.6V9A5.4 5.4 0 0 1 12 3.7z"/><path d="M12 2.5v7.5" stroke="currentColor" stroke-width="2"/></svg>';
const ICON_PHONE =
  '<svg viewBox="0 0 64 64"><rect x="20" y="6" width="24" height="44" rx="4" fill="none" stroke="currentColor" stroke-width="4"/>' +
  '<circle cx="32" cy="43" r="2.6" fill="currentColor"/>' +
  '<path d="M10 40a24 24 0 0 0 20 18" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>' +
  '<path d="M24 52l6 6-7 4" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CAMERA =
  '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 7h3.2l1.9-2.6h5.8L16.8 7H20a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5v-10A1.5 1.5 0 0 1 4 7z"/>' +
  '<circle cx="12" cy="13.2" r="4" fill="none" stroke="#111" stroke-width="2.2"/></svg>';

const noop = (): void => {};

function stageLabel(label: string): string {
  return Object.prototype.hasOwnProperty.call(LOADING_STAGES, label) ? (LOADING_STAGES[label] ?? label) : label;
}

function asQuality(i: number): Settings['quality'] {
  const q = clamp(Math.round(i), 0, 3);
  return q === 0 ? 0 : q === 1 ? 1 : q === 2 ? 2 : 3;
}

function setFill(input: HTMLInputElement): void {
  const min = Number(input.min);
  const max = Number(input.max);
  const t = max > min ? (Number(input.value) - min) / (max - min) : 0;
  input.style.setProperty('--fill', `${(clamp(t, 0, 1) * 100).toFixed(2)}%`);
}

function wrapHour(hour: number): number {
  if (!Number.isFinite(hour)) return 12;
  return ((hour % 24) + 24) % 24;
}

/**
 * Renders a controls key string such as "W A S D", "C veya Q", "1 / 2 / 3 / 4"
 * or "Sol tık (basılı tut)" as key caps. Separators, joining words and the
 * trailing note are taken from the string itself, so the text stays in tr.ts.
 */
function buildKeyCaps(spec: string): HTMLSpanElement {
  const wrap = el('span', 'sk-keys');
  let main = spec.trim();
  let note = '';
  const m = /^(.*?)\s*(\([^)]*\))\s*$/.exec(main);
  if (m && m[1]) {
    main = m[1];
    note = m[2] ?? '';
  }
  const kbd = (text: string): HTMLElement => {
    const k = el('kbd', 'sk-kbd', text);
    if ([...text].length > 3) k.classList.add('sk-kbd-wide');
    return k;
  };
  const parts = main.split(/(\s+\/\s+)/);
  for (const part of parts) {
    if (/^\s+\/\s+$/.test(part)) {
      wrap.append(el('span', 'sk-keys-sep', part.trim()));
      continue;
    }
    const tokens = part.split(/\s+/).filter(Boolean);
    const groups: Array<{ cap: boolean; words: string[] }> = [];
    tokens.forEach((tok, i) => {
      // A lower-case word between two caps ("C veya Q") joins them instead of being part of a cap.
      const next = tokens[i + 1];
      const joiner = i > 0 && next !== undefined && /^\p{Ll}+$/u.test(tok) && !/^\p{Ll}/u.test(next);
      const last = groups[groups.length - 1];
      if (joiner) groups.push({ cap: false, words: [tok] });
      else if (last && last.cap) last.words.push(tok);
      else groups.push({ cap: true, words: [tok] });
    });
    for (const g of groups) {
      if (!g.cap) {
        wrap.append(el('span', 'sk-keys-word', g.words.join(' ')));
      } else if (g.words.length > 1 && g.words.every((w) => [...w].length === 1)) {
        for (const w of g.words) wrap.append(kbd(w));
      } else {
        wrap.append(kbd(g.words.join(' ')));
      }
    }
  }
  if (note) wrap.append(el('span', 'sk-keys-note', note));
  return wrap;
}

/**
 * Key caps for bound keys: "W A S D" (no joiner), "C veya Q", "Sol tık
 * (basılı tut)"; reads "atanmadı" when nothing is bound.
 */
function bindingCaps(labels: readonly string[], joiner: string | null, note: string | null): HTMLSpanElement {
  const wrap = el('span', 'sk-keys');
  if (labels.length === 0) wrap.append(el('span', 'sk-keys-word', tr.controls.unbound));
  labels.forEach((label, i) => {
    if (i > 0 && joiner) wrap.append(el('span', 'sk-keys-word', joiner));
    const k = el('kbd', 'sk-kbd', label);
    if ([...label].length > 3) k.classList.add('sk-kbd-wide');
    wrap.append(k);
  });
  if (note) wrap.append(el('span', 'sk-keys-note', note));
  return wrap;
}

/**
 * DOM user interface: loading screen, main/pause menus, controls and settings
 * screens, HUD, rotating minimap, toasts and the photo-mode panel. All text
 * comes from src/i18n/tr.ts. The game drives it through the public members.
 */
export class UI {
  onPlay: () => void = noop;
  onResume: () => void = noop;
  /** Touch: the rotate prompt's "play anyway" button. */
  onDismissRotate: () => void = noop;
  onMainMenu: () => void = noop;
  /** Touch pause menu: photo mode and the music toggle (keys P and M on desktop). */
  onPhoto: () => void = noop;
  onMusic: () => void = noop;
  onUiSound: (kind: UiSound) => void = noop;
  /** Called on every settings change, after the settings were saved. */
  onSettingsChange: (s: Settings) => void = noop;
  /** Live settings object (loaded from localStorage); mutated in place by the settings screen. */
  readonly settings: Settings;
  /** Touch device: touch texts and settings, no key-binding screen, phone-sized HUD. */
  readonly touch: boolean;
  /** What "reset to defaults" restores (touch devices default to Low quality). */
  private readonly defaults: Settings;

  private readonly root: HTMLElement;
  private readonly hud: Hud;
  private readonly minimap: Minimap;
  private readonly loadingEl: HTMLDivElement;
  private readonly loadingBar: HTMLDivElement;
  private readonly loadingFill: HTMLDivElement;
  private readonly loadingPct: Text;
  private readonly loadingStage: Text;
  private readonly menuLayer: HTMLDivElement;
  private readonly screens: Record<MenuScreen, HTMLDivElement>;
  private readonly audioHint: HTMLElement;
  private readonly toastEl: HTMLDivElement;
  private readonly toastText: Text;
  private readonly resumeEl: HTMLDivElement;
  private readonly letterbox: HTMLDivElement;
  private readonly photoEl: HTMLElement;
  private readonly photoFov: HTMLInputElement;
  private readonly photoFovVal: Text;
  private readonly photoTime: HTMLInputElement;
  private readonly photoTimeVal: Text;
  private readonly photoExitLabel: HTMLElement;
  private readonly photoHint: HTMLElement;
  private readonly settingSyncers: Array<() => void> = [];
  private readonly controlsTables: HTMLDivElement = el('div', 'sk-ctl-tables');
  private readonly bindingSlots: BindingSlotView[] = [];
  private musicLabel: Text | null = null;
  private rotateEl: HTMLDivElement | null = null;

  private screen: MenuScreen | null = null;
  /** Screens to return to with Back, each with the button that opened the next one. */
  private readonly backStack: Array<{ screen: MenuScreen; focus: HTMLElement | null }> = [];
  /** Slot waiting for a key or mouse button on the bindings screen. */
  private capture: BindingSlotView | null = null;
  /** The mouse press that filled a slot: its mouseup/click must not reach the buttons below. */
  private swallowClick = false;
  /** Bumped by every screen change, so button defaults can tell whether a callback already navigated. */
  private screenVersion = 0;
  private keyboardMode = false;
  private hudWanted = false;
  private hudOn = false;
  private photo: PhotoOptions | null = null;
  private toastTimer = 0;
  private loadingTimer = 0;
  private loadingVisible = true;
  private resumeShown = false;
  private cine = false;

  constructor(root: HTMLElement, opts: { touch?: boolean } = {}) {
    this.touch = opts.touch === true;
    // First run on a touch device starts on Low quality (a stored choice always wins).
    this.defaults = this.touch ? Object.freeze<Settings>({ ...DEFAULT_SETTINGS, quality: 0 }) : DEFAULT_SETTINGS;
    this.settings = loadSettings(this.touch ? { quality: 0 } : {});
    this.root = root;
    root.classList.add('sk-ui');
    root.classList.toggle('sk-is-touch', this.touch);
    root.setAttribute('lang', 'tr');

    this.hud = new Hud();
    this.minimap = new Minimap(tr.hud.north, tr.hud.minimap);
    this.hud.layer.append(this.minimap.el);

    const top = el('div', 'sk-top');
    this.toastEl = el('div', 'sk-toast');
    this.toastEl.setAttribute('role', 'status');
    this.toastEl.setAttribute('aria-live', 'polite');
    const toastSpan = el('span', 'sk-toast-text');
    this.toastText = textNode(toastSpan);
    this.toastEl.append(toastSpan);
    top.append(this.hud.ringPanel, this.toastEl);

    // Cinematic letterbox bars (rooftop moment), slid in by the sk-cine class.
    this.letterbox = el('div', 'sk-letterbox');
    this.letterbox.setAttribute('aria-hidden', 'true');
    this.letterbox.append(el('div', 'sk-lb sk-lb-top'), el('div', 'sk-lb sk-lb-bottom'));

    this.resumeEl = el('div', 'sk-resume');
    this.resumeEl.append(icon(ICON_MOUSE), el('span', 'sk-resume-text', tr.hud.clickToResume));

    const photo = this.buildPhoto();
    this.photoEl = photo.panel;
    this.photoFov = photo.fov;
    this.photoFovVal = photo.fovVal;
    this.photoTime = photo.time;
    this.photoTimeVal = photo.timeVal;
    this.photoExitLabel = photo.exitLabel;
    this.photoHint = photo.hint;

    const main = this.buildMain();
    this.audioHint = main.audioHint;
    this.screens = {
      main: main.screen,
      pause: this.buildPause(),
      controls: this.buildControls(),
      settings: this.buildSettings(),
      bindings: this.buildBindings(),
      costume: this.buildCostume(),
    };
    this.menuLayer = el('div', 'sk-menu-layer');
    for (const name of SCREEN_NAMES) this.menuLayer.append(this.screens[name]);

    const loading = this.buildLoading();
    this.loadingEl = loading.root;
    this.loadingBar = loading.bar;
    this.loadingFill = loading.fill;
    this.loadingPct = loading.pct;
    this.loadingStage = loading.stage;

    root.append(this.hud.layer, this.letterbox, this.hud.fpsEl, this.resumeEl, this.photoEl, this.menuLayer, top, this.loadingEl);
    if (this.touch) {
      // Portrait prompt: above everything, including the loading screen.
      const rotate = el('div', 'sk-rotate');
      rotate.setAttribute('role', 'alert');
      const box = el('div', 'sk-rotate-box');
      box.append(
        icon(ICON_PHONE, 'sk-icon sk-rotate-icon'),
        el('p', 'sk-rotate-title', tr.touch.rotateTitle),
        el('p', 'sk-rotate-text', tr.touch.rotateText),
        // Never a lock-out: a window the check misjudges can still be played.
        this.button(tr.touch.rotateDismiss, 'is-small sk-rotate-dismiss', () => this.onDismissRotate()),
      );
      rotate.append(box);
      root.append(rotate);
      this.rotateEl = rotate;
    }

    window.addEventListener('resize', this.onResize);
    window.addEventListener('pointerdown', this.onPointerDown, true);
    // Key captions follow the player's keyboard layout (see keyLabels.ts).
    window.addEventListener(
      'keydown',
      (e) => {
        if (learnKey(e) && (this.screen !== null || this.photo !== null)) this.refreshKeyViews();
      },
      true,
    );
    this.refreshKeyViews();
    this.reloadKeyboardLayout();
    this.onResize();
    this.setLoading(0, '');
  }

  /** True while any menu screen or the photo-mode panel is open. */
  get menuOpen(): boolean {
    return this.screen !== null || this.photo !== null;
  }

  /** True while the photo-mode panel is open. */
  get photoOpen(): boolean {
    return this.photo !== null;
  }

  /** Places the on-screen touch controls above the HUD and below the photo panel and menus. */
  mountTouch(layer: HTMLElement): void {
    this.root.insertBefore(layer, this.photoEl);
  }

  /** Touch mode in portrait: the rotate prompt covers the screen. */
  setPortrait(on: boolean): void {
    this.root.classList.toggle('sk-portrait', on);
    if (this.rotateEl) this.rotateEl.classList.toggle('is-on', on);
  }

  get portraitPrompt(): boolean {
    return this.rotateEl?.classList.contains('is-on') ?? false;
  }

  /** Label of the touch pause menu's music button. */
  setMusicOn(on: boolean): void {
    if (this.musicLabel) setText(this.musicLabel, tr.menu.music(on));
  }

  // ---------------------------------------------------------------- loading

  setLoading(fraction: number, label: string): void {
    const f = Number.isFinite(fraction) ? clamp(fraction, 0, 1) : 0;
    this.loadingFill.style.width = `${(f * 100).toFixed(1)}%`;
    this.loadingBar.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    setText(this.loadingPct, formatPercent(f));
    setText(this.loadingStage, stageLabel(label));
  }

  hideLoading(): void {
    if (!this.loadingVisible) return;
    this.loadingVisible = false;
    this.loadingEl.classList.add('is-hiding');
    window.clearTimeout(this.loadingTimer);
    this.loadingTimer = window.setTimeout(() => {
      this.loadingEl.hidden = true;
    }, LOADING_FADE_MS);
  }

  // ------------------------------------------------------------------ menus

  showMainMenu(): void {
    this.backStack.length = 0;
    this.setScreen('main', null);
  }

  showPause(): void {
    this.backStack.length = 0;
    this.setScreen('pause', null);
  }

  hideMenus(): void {
    this.backStack.length = 0;
    this.setScreen(null, null);
  }

  showControls(): void {
    this.enterSub('controls', null);
  }

  showSettings(): void {
    this.enterSub('settings', null);
  }

  showClickToResume(show: boolean): void {
    if (show === this.resumeShown) return;
    this.resumeShown = show;
    this.resumeEl.classList.toggle('is-on', show);
  }

  notifyAudioUnlocked(): void {
    this.audioHint.hidden = true;
  }

  toast(msg: string): void {
    setText(this.toastText, msg);
    this.toastEl.classList.add('is-on');
    this.toastEl.animate(
      [
        { transform: 'translateY(-0.4rem) scale(0.86) rotate(-2deg)', opacity: 0.3 },
        { transform: 'scale(1.06) rotate(1deg)', opacity: 1, offset: 0.6 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 240, easing: 'ease-out' },
    );
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('is-on'), TOAST_MS);
  }

  // -------------------------------------------------------------------- HUD

  setHudVisible(v: boolean): void {
    this.hudWanted = v;
    this.applyHudVisibility();
  }

  /** Cinematic look (rooftop moment): the HUD fades out and letterbox bars slide in. */
  setCinematic(on: boolean): void {
    if (on === this.cine) return;
    this.cine = on;
    this.root.classList.toggle('sk-cine', on);
  }

  get cinematic(): boolean {
    return this.cine;
  }

  updateHud(s: HudState): void {
    this.hud.updateFps(s.fps);
    if (this.hudOn) this.hud.update(s);
  }

  setLayout(layout: CityLayout): void {
    this.minimap.setLayout(layout);
  }

  updateMinimap(x: number, z: number, yaw: number, rings: MinimapRing[]): void {
    this.minimap.update(x, z, yaw, rings);
  }

  // ------------------------------------------------------------- photo mode

  showPhoto(opts: PhotoOptions): void {
    this.photo = opts;
    const fov = clamp(Math.round(Number.isFinite(opts.fov) ? opts.fov : 70), PHOTO_FOV.min, PHOTO_FOV.max);
    const hour = wrapHour(opts.hour);
    this.photoFov.value = String(fov);
    this.photoTime.value = String(roundToStep(hour * 60, PHOTO_MINUTES.step));
    setFill(this.photoFov);
    setFill(this.photoTime);
    setText(this.photoFovVal, `${formatInteger(fov)}${tr.settings.unitDegrees}`);
    setText(this.photoTimeVal, formatClock(hour));
    this.photoEl.classList.add('is-on');
    this.root.classList.add('sk-photo-open');
    window.addEventListener('keydown', this.onPhotoKey, true);
    this.applyHudVisibility();
  }

  hidePhoto(): void {
    if (this.photo === null) return;
    this.photo = null;
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.photoEl.contains(active)) active.blur();
    this.photoEl.classList.remove('is-on');
    this.root.classList.remove('sk-photo-open');
    window.removeEventListener('keydown', this.onPhotoKey, true);
    this.applyHudVisibility();
  }

  // ---------------------------------------------------------------- private

  private sound(kind: UiSound): void {
    // A tap also fires mouseenter: no hover blip before every click on touch screens.
    if (this.touch && kind === 'hover') return;
    this.onUiSound(kind);
  }

  private applyHudVisibility(): void {
    const on = this.hudWanted && this.photo === null;
    if (on === this.hudOn) return;
    this.hudOn = on;
    this.root.classList.toggle('sk-hud-on', on);
    this.minimap.setVisible(on);
  }

  private readonly onResize = (): void => {
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const rem = Number.isFinite(rootPx) && rootPx > 0 ? rootPx : 16;
    // Touch: a small map in the top-right corner, clear of the buttons.
    const size = this.touch ? clamp(Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.3), 96, 150) : clamp(Math.round(rem * 12.5), 176, 250);
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const headFont = getComputedStyle(this.root).getPropertyValue('--sk-font-head').trim();
    this.minimap.resize(size, dpr, headFont || 'Impact, sans-serif');
  };

  private readonly onPointerDown = (): void => {
    this.keyboardMode = false;
  };

  /** Runs a game callback; applies the default navigation only if the callback did not change screens itself. */
  private runWithDefault(callback: () => void, fallback: () => void): void {
    const version = this.screenVersion;
    callback();
    if (version === this.screenVersion) fallback();
  }

  /** Opens a sub screen on top of the current one; Back returns there and refocuses `invoker`. */
  private enterSub(target: SubScreen, invoker: HTMLElement | null): void {
    if (target === 'settings') this.syncSettings();
    else {
      this.refreshKeyViews();
      this.reloadKeyboardLayout();
    }
    if (this.screen !== null && this.screen !== target) this.backStack.push({ screen: this.screen, focus: invoker });
    this.setScreen(target, null);
  }

  private openSub(target: SubScreen, invoker: HTMLElement): void {
    this.enterSub(target, invoker);
  }

  private back(): void {
    const prev = this.backStack.pop();
    this.setScreen(prev ? prev.screen : null, prev ? prev.focus : null);
  }

  private setScreen(next: MenuScreen | null, focusTarget: HTMLElement | null): void {
    this.screenVersion++;
    const open = next !== null;
    if (next !== this.screen) {
      if (this.screen === 'bindings') this.setBindingsMouse(false);
      if (next === 'bindings') this.setBindingsMouse(true);
      if (this.capture) this.endCapture();
      const active = document.activeElement;
      if (active instanceof HTMLElement && this.menuLayer.contains(active)) active.blur();
      for (const name of SCREEN_NAMES) this.screens[name].classList.toggle('is-active', name === next);
      this.screen = next;
      this.menuLayer.classList.toggle('is-open', open);
      this.root.classList.toggle('sk-menu-open', open);
      if (next !== null && this.keyboardMode) {
        const container = this.screens[next];
        const target = focusTarget && container.contains(focusTarget) ? focusTarget : this.focusables(container)[0];
        target?.focus();
      }
    }
    // Keys are only intercepted while a menu screen is open.
    if (open) window.addEventListener('keydown', this.onMenuKey, true);
    else window.removeEventListener('keydown', this.onMenuKey, true);
  }

  private focusables(container: HTMLElement): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const node of container.querySelectorAll<HTMLElement>('button, input')) {
      if (node.tabIndex < 0 || node.matches(':disabled') || node.getClientRects().length === 0) continue;
      out.push(node);
    }
    return out;
  }

  private moveFocus(container: HTMLElement, dir: 1 | -1): void {
    const items = this.focusables(container);
    if (items.length === 0) return;
    const active = document.activeElement;
    const idx = active instanceof HTMLElement ? items.indexOf(active) : -1;
    const next = idx < 0 ? (dir > 0 ? 0 : items.length - 1) : (idx + dir + items.length) % items.length;
    items[next]?.focus();
    this.sound('hover');
  }

  /** Capture-phase key handler, attached only while a menu screen is open. */
  private readonly onMenuKey = (e: KeyboardEvent): void => {
    const screen = this.screen;
    if (screen === null) return;
    if (this.capture) {
      // Rebinding: the next key belongs to the slot and never reaches the game.
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) this.onCaptureKey(e);
      return;
    }
    const key = e.key;
    if ((key === 'Escape' || key === 'Backspace') && screen !== 'main' && screen !== 'pause') {
      // Handled here: keep it from also reaching the game's own Esc handling.
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) {
        this.keyboardMode = true;
        this.sound('click');
        this.back();
      }
      return;
    }
    const container = this.screens[screen];
    if (screen === 'bindings' && key.startsWith('Arrow') && this.moveSlotFocus(key, container)) {
      e.preventDefault();
      this.keyboardMode = true;
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Tab') {
      // Up/Down move between rows (Left/Right still adjust sliders and options).
      e.preventDefault();
      this.keyboardMode = true;
      this.moveFocus(container, key === 'ArrowUp' || (key === 'Tab' && e.shiftKey) ? -1 : 1);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      const target = document.activeElement;
      if (target instanceof HTMLButtonElement && container.contains(target)) {
        // Activate exactly once, independent of other listeners that cancel Space.
        e.preventDefault();
        this.keyboardMode = true;
        if (!e.repeat) target.click();
      }
    }
  };

  /**
   * Photo mode: only Tab is handled (cycles the panel's controls), because the
   * free camera uses the other keys. Menu screens take precedence when open.
   */
  private readonly onPhotoKey = (e: KeyboardEvent): void => {
    if (this.photo === null || this.screen !== null || e.key !== 'Tab') return;
    e.preventDefault();
    this.keyboardMode = true;
    this.moveFocus(this.photoEl, e.shiftKey ? -1 : 1);
  };

  private button(
    label: string,
    variant: string,
    onClick: (b: HTMLButtonElement) => void,
    extra?: HTMLElement,
  ): HTMLButtonElement {
    const b = el('button', variant ? `sk-btn ${variant}` : 'sk-btn');
    b.type = 'button';
    b.append(el('span', 'sk-btn-label', label));
    if (extra) b.append(extra);
    b.addEventListener('mouseenter', () => this.sound('hover'));
    b.addEventListener('click', () => {
      this.sound('click');
      onClick(b);
    });
    return b;
  }

  private backButton(): HTMLButtonElement {
    return this.button(tr.menu.back, 'is-small', () => this.back(), el('kbd', 'sk-kbd sk-kbd-sm', tr.menu.backKey));
  }

  private panelTitle(text: string): HTMLHeadingElement {
    const h = el('h2', 'sk-title');
    h.append(el('span', 'sk-title-text', text));
    return h;
  }

  // ------------------------------------------------------------ loading DOM

  private buildLoading(): { root: HTMLDivElement; bar: HTMLDivElement; fill: HTMLDivElement; pct: Text; stage: Text } {
    const root = el('div', 'sk-loading');
    const box = el('div', 'sk-loading-box');
    const logo = el('div', 'sk-logo sk-logo-loading', tr.title);
    const tagline = el('p', 'sk-loading-tagline', tr.tagline);
    const row = el('div', 'sk-loading-row');
    const pctEl = el('span', 'sk-loading-pct');
    const pct = textNode(pctEl);
    row.append(el('span', 'sk-loading-title', tr.loading.title), pctEl);
    const bar = el('div', 'sk-progress');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-label', tr.loading.title);
    const fill = el('div', 'sk-progress-fill');
    bar.append(fill);
    const stageEl = el('div', 'sk-loading-stage');
    stageEl.setAttribute('aria-live', 'polite');
    const stage = textNode(stageEl);
    box.append(logo, tagline, row, bar, stageEl);
    root.append(box);
    return { root, bar, fill, pct, stage };
  }

  // -------------------------------------------------------------- main menu

  private buildMain(): { screen: HTMLDivElement; audioHint: HTMLElement } {
    const screen = el('div', 'sk-screen sk-screen-main');
    const wrap = el('div', 'sk-center sk-main');
    const tagline = el('p', 'sk-tagline');
    tagline.append(el('span', 'sk-tagline-text', tr.tagline));
    const nav = el('nav', 'sk-menu');
    nav.append(
      this.button(tr.menu.play, 'is-primary is-big', () => this.runWithDefault(this.onPlay, () => this.hideMenus())),
      this.button(tr.menu.costume, '', (b) => this.openSub('costume', b)),
      this.button(tr.menu.controls, '', (b) => this.openSub('controls', b)),
      this.button(tr.menu.settings, '', (b) => this.openSub('settings', b)),
    );
    const audioHint = el('p', 'sk-audio-hint');
    audioHint.append(icon(ICON_SPEAKER), el('span', 'sk-audio-hint-text', this.touch ? tr.menu.audioHintTouch : tr.menu.audioHint));
    wrap.append(el('div', 'sk-sunburst'), el('h1', 'sk-logo', tr.title), tagline, nav, audioHint);
    screen.append(wrap, el('p', 'sk-credits', tr.menu.credits));
    return { screen, audioHint };
  }

  private buildPause(): HTMLDivElement {
    const screen = el('div', 'sk-screen sk-screen-pause');
    const panel = el('section', 'sk-center sk-panel sk-panel-pause');
    const nav = el('nav', 'sk-menu');
    nav.append(
      this.button(tr.menu.resume, 'is-primary', () => this.runWithDefault(this.onResume, () => this.hideMenus())),
      this.button(tr.menu.costume, '', (b) => this.openSub('costume', b)),
      this.button(tr.menu.controls, '', (b) => this.openSub('controls', b)),
      this.button(tr.menu.settings, '', (b) => this.openSub('settings', b)),
    );
    if (this.touch) {
      // No P and M keys on a phone: photo mode and the music toggle live here.
      const music = this.button(tr.menu.music(true), '', () => this.onMusic());
      const label = music.querySelector('.sk-btn-label');
      if (label) {
        label.textContent = '';
        this.musicLabel = textNode(label, tr.menu.music(true));
      }
      nav.append(this.button(tr.menu.photo, '', () => this.onPhoto()), music);
    }
    nav.append(this.button(tr.menu.mainMenu, '', () => this.runWithDefault(this.onMainMenu, () => this.showMainMenu())));
    panel.append(this.panelTitle(tr.menu.paused), nav);
    screen.append(panel);
    return screen;
  }

  // ---------------------------------------------------------------- costume

  /** Four costume cards (a radio group); a pick is worn and saved at once. */
  private buildCostume(): HTMLDivElement {
    const screen = el('div', 'sk-screen sk-screen-sub');
    const panel = el('section', 'sk-center sk-panel sk-panel-costume');
    const title = this.panelTitle(tr.costume.title);
    title.id = 'sk-costume-title';
    const grid = el('div', 'sk-costumes');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-labelledby', title.id);
    const pick = (id: CostumeId): void => {
      if (this.settings.costume === id) return;
      this.settings.costume = id;
      sync();
      this.commitSettings();
    };
    const cards = COSTUME_IDS.map((id, i) => {
      const b = el('button', 'sk-costume');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.costume = id;
      const art = el('span', 'sk-costume-art');
      art.innerHTML = costumeArt(id);
      b.append(art, el('span', 'sk-costume-name', tr.costume.names[id]));
      b.addEventListener('mouseenter', () => this.sound('hover'));
      b.addEventListener('click', () => {
        this.sound('click');
        pick(id);
      });
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const next = COSTUME_IDS[(i + (e.key === 'ArrowRight' ? 1 : COSTUME_IDS.length - 1)) % COSTUME_IDS.length]!;
        this.sound('click');
        pick(next);
        cards[COSTUME_IDS.indexOf(next)]?.focus();
      });
      return b;
    });
    grid.append(...cards);
    const sync = (): void => {
      cards.forEach((b, i) => {
        const on = COSTUME_IDS[i] === this.settings.costume;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
    };
    this.settingSyncers.push(sync);
    sync();
    const actions = el('div', 'sk-actions');
    actions.append(this.backButton());
    panel.append(title, grid, el('p', 'sk-costume-hint', tr.costume.hint), actions);
    screen.append(panel);
    return screen;
  }

  // --------------------------------------------------------------- controls

  private buildControls(): HTMLDivElement {
    const screen = el('div', 'sk-screen sk-screen-sub');
    const panel = el('section', 'sk-center sk-panel sk-panel-wide');
    const tips = el('div', 'sk-tips');
    const list = el('ul');
    for (const tip of tr.controls.tips) list.append(el('li', '', tip));
    tips.append(el('h3', 'sk-tips-title', tr.controls.tipsTitle), list);
    const actions = el('div', 'sk-actions');
    if (this.touch) {
      // Touch: the on-screen controls instead of keys; no key-binding screen.
      actions.append(this.backButton());
      panel.append(this.panelTitle(tr.controls.title), this.touchControlsTable(), tips, actions);
    } else {
      actions.append(
        this.button(tr.controls.rebind, 'is-small is-ghost', (b) => this.openSub('bindings', b)),
        this.backButton(),
      );
      panel.append(this.panelTitle(tr.controls.title), this.controlsTables, tips, actions);
    }
    screen.append(panel);
    return screen;
  }

  /** The touch controls card: on-screen button captions and what they do. */
  private touchControlsTable(): HTMLDivElement {
    const wrap = el('div', 'sk-ctl-tables');
    const rows = tr.controls.touchRows;
    const half = Math.ceil(rows.length / 2);
    for (const part of [rows.slice(0, half), rows.slice(half)]) {
      const table = el('table', 'sk-ctl-table');
      const body = el('tbody');
      for (const [cap, note, text] of part) {
        const row = el('tr');
        const th = el('th');
        th.scope = 'row';
        const keys = el('span', 'sk-keys');
        keys.append(el('span', 'sk-tcap', cap));
        if (note) keys.append(el('span', 'sk-keys-note', note));
        th.append(keys);
        row.append(th, el('td', '', text));
        body.append(row);
      }
      table.append(body);
      wrap.append(table);
    }
    return wrap;
  }

  /** Fills the two controls tables from the current bindings. */
  private renderControls(): void {
    const rows = tr.controls.rows;
    const half = Math.ceil(rows.length / 2);
    const tables: HTMLTableElement[] = [];
    for (const part of [rows.slice(0, half), rows.slice(half)]) {
      if (part.length === 0) continue;
      const table = el('table', 'sk-ctl-table');
      const body = el('tbody');
      for (const [id, text] of part) {
        const row = el('tr');
        const th = el('th');
        th.scope = 'row';
        th.append(this.controlKeys(id));
        row.append(th, el('td', '', text));
        body.append(row);
      }
      table.append(body);
      tables.push(table);
    }
    this.controlsTables.replaceChildren(...tables);
  }

  private controlKeys(id: ControlRowId): HTMLSpanElement {
    const actions = CONTROL_ROW_ACTIONS[id];
    if (!actions) return buildKeyCaps(tr.controls.fixedKeys[id as keyof typeof tr.controls.fixedKeys]);
    const b = this.settings.bindings;
    if (actions.length > 1) return bindingCaps(actions.map((a) => primaryLabel(b[a]) ?? tr.bindings.empty), null, null);
    const action = actions[0]!;
    return bindingCaps(slotLabels(b[action]), tr.controls.or, HOLD_ROWS.has(id) ? tr.controls.hold : null);
  }

  // --------------------------------------------------------------- settings

  private buildSettings(): HTMLDivElement {
    const screen = el('div', 'sk-screen sk-screen-sub');
    const panel = el('section', 'sk-center sk-panel sk-panel-wide sk-panel-settings');
    const S = tr.settings;
    const pct = (key: NumericSettingKey): SliderSpec => ({
      min: SETTINGS_LIMITS[key].min * 100,
      max: SETTINGS_LIMITS[key].max * 100,
      step: key === 'renderScale' ? 5 : 1,
      toUi: (v) => v * 100,
      fromUi: (u) => roundToStep(u / 100, 0.01),
      format: (v) => formatPercent(v),
    });
    const cols = el('div', 'sk-st-cols');
    const left = el('div', 'sk-st-col');
    const right = el('div', 'sk-st-col');
    left.append(
      this.group(S.groupGraphics, [
        this.qualityRow(),
        this.sliderRow('renderScale', S.renderScale, pct('renderScale')),
        this.toggleRow('dynamicResolution', S.dynamicRes),
        this.sliderRow('fovOffset', S.fov, {
          min: SETTINGS_LIMITS.fovOffset.min,
          max: SETTINGS_LIMITS.fovOffset.max,
          step: 1,
          toUi: (v) => v,
          fromUi: (u) => Math.round(u),
          format: (v) => `${formatSigned(v)}${S.unitDegrees}`,
        }),
        this.toggleRow('showFps', S.fpsCounter),
      ]),
      this.group(S.groupTime, [
        this.sliderRow('dayLengthMinutes', S.dayLength, {
          min: SETTINGS_LIMITS.dayLengthMinutes.min,
          max: SETTINGS_LIMITS.dayLengthMinutes.max,
          step: 1,
          toUi: (v) => v,
          fromUi: (u) => Math.round(u),
          format: (v) => `${formatInteger(v)} ${S.unitMinutes}`,
        }),
      ]),
    );
    const sens = (key: 'sensitivity' | 'touchSensitivity'): SliderSpec => ({
      min: SETTINGS_LIMITS[key].min,
      max: SETTINGS_LIMITS[key].max,
      step: 0.05,
      toUi: (v) => v,
      fromUi: (u) => roundToStep(u, 0.05),
      format: (v) => `${formatDecimal2(v)}${S.unitTimes}`,
    });
    // Touch: look-drag sensitivity instead of the mouse's, and no key bindings.
    right.append(
      this.group(
        S.groupControls,
        this.touch
          ? [this.sliderRow('touchSensitivity', S.touchSensitivity, sens('touchSensitivity')), this.toggleRow('invertY', S.invertY), this.toggleRow('cameraFollow', S.cameraFollow)]
          : [this.sliderRow('sensitivity', S.sensitivity, sens('sensitivity')), this.toggleRow('invertY', S.invertY), this.toggleRow('cameraFollow', S.cameraFollow), this.bindingsRow()],
      ),
      this.group(S.groupAudio, [
        this.sliderRow('masterVolume', S.master, pct('masterVolume')),
        this.sliderRow('musicVolume', S.music, pct('musicVolume')),
        this.sliderRow('sfxVolume', S.sfx, pct('sfxVolume')),
      ]),
    );
    cols.append(left, right);
    const actions = el('div', 'sk-actions');
    actions.append(
      this.button(S.reset, 'is-small is-ghost', () => this.resetSettings()),
      this.backButton(),
    );
    panel.append(this.panelTitle(S.title), cols, actions);
    screen.append(panel);
    return screen;
  }

  private group(title: string, rows: HTMLElement[]): HTMLElement {
    const g = el('section', 'sk-st-group');
    g.append(el('h3', 'sk-st-group-title', title), ...rows);
    return g;
  }

  private syncSettings(): void {
    for (const sync of this.settingSyncers) sync();
  }

  private commitSettings(): void {
    saveSettings(this.settings);
    this.onSettingsChange(this.settings);
  }

  /** Resets this screen's settings; key bindings and the costume have their own screens. */
  private resetSettings(): void {
    Object.assign(this.settings, this.defaults, { bindings: this.settings.bindings, costume: this.settings.costume });
    this.syncSettings();
    this.commitSettings();
  }

  private bindingsRow(): HTMLElement {
    const row = el('div', 'sk-st-row');
    const ctrl = el('div', 'sk-st-ctrl');
    ctrl.append(this.button(tr.bindings.open, 'is-small', (b) => this.openSub('bindings', b)));
    row.append(el('span', 'sk-st-label', tr.bindings.settingLabel), ctrl);
    return row;
  }

  private sliderRow(key: NumericSettingKey, label: string, spec: SliderSpec): HTMLElement {
    const id = `sk-st-${key}`;
    const row = el('div', 'sk-st-row');
    const lab = el('label', 'sk-st-label', label);
    lab.htmlFor = id;
    const ctrl = el('div', 'sk-st-ctrl');
    const input = el('input', 'sk-range');
    input.type = 'range';
    input.id = id;
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    const out = el('output', 'sk-st-val');
    out.setAttribute('for', id);
    const valText = textNode(out);
    ctrl.append(input, out);
    row.append(lab, ctrl);
    const limits = SETTINGS_LIMITS[key];
    const sync = (): void => {
      const v = this.settings[key];
      input.value = String(spec.toUi(v));
      setFill(input);
      setText(valText, spec.format(v));
    };
    input.addEventListener('input', () => {
      const v = clamp(spec.fromUi(Number(input.value)), limits.min, limits.max);
      this.settings[key] = v;
      setFill(input);
      setText(valText, spec.format(v));
      this.commitSettings();
    });
    input.addEventListener('change', () => this.sound('click'));
    this.settingSyncers.push(sync);
    sync();
    return row;
  }

  private toggleRow(key: BooleanSettingKey, label: string): HTMLElement {
    const id = `sk-st-${key}`;
    const row = el('div', 'sk-st-row');
    const lab = el('label', 'sk-st-label', label);
    lab.htmlFor = id;
    const ctrl = el('div', 'sk-st-ctrl');
    const btn = el('button', 'sk-toggle');
    btn.type = 'button';
    btn.id = id;
    btn.setAttribute('role', 'switch');
    const track = el('span', 'sk-toggle-track');
    track.append(el('span', 'sk-toggle-knob'));
    const textEl = el('span', 'sk-toggle-text');
    const text = textNode(textEl);
    btn.append(track, textEl);
    ctrl.append(btn);
    row.append(lab, ctrl);
    const sync = (): void => {
      const on = this.settings[key];
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.classList.toggle('is-on', on);
      setText(text, on ? tr.settings.on : tr.settings.off);
    };
    btn.addEventListener('mouseenter', () => this.sound('hover'));
    btn.addEventListener('click', () => {
      this.sound('click');
      this.settings[key] = !this.settings[key];
      sync();
      this.commitSettings();
    });
    this.settingSyncers.push(sync);
    sync();
    return row;
  }

  private qualityRow(): HTMLElement {
    const row = el('div', 'sk-st-row sk-st-stack');
    const lab = el('span', 'sk-st-label', tr.settings.quality);
    lab.id = 'sk-st-quality-label';
    const seg = el('div', 'sk-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-labelledby', lab.id);
    const options = tr.settings.qualityNames.map((name, i) => {
      const b = el('button', 'sk-seg-opt');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.append(el('span', 'sk-seg-text', name));
      b.addEventListener('mouseenter', () => this.sound('hover'));
      b.addEventListener('click', () => {
        this.sound('click');
        this.setQuality(i);
      });
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const next = this.settings.quality + (e.key === 'ArrowRight' ? 1 : -1);
        if (next >= 0 && next <= 3) {
          this.sound('click');
          this.setQuality(next);
        }
        options[this.settings.quality]?.focus();
      });
      return b;
    });
    seg.append(...options);
    row.append(lab, seg);
    const sync = (): void => {
      options.forEach((b, i) => {
        const on = i === this.settings.quality;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
    };
    this.settingSyncers.push(sync);
    sync();
    return row;
  }

  private setQuality(i: number): void {
    const q = asQuality(i);
    if (q === this.settings.quality) return;
    this.settings.quality = q;
    this.syncSettings();
    this.commitSettings();
  }

  // ------------------------------------------------------------ key bindings

  private buildBindings(): HTMLDivElement {
    const screen = el('div', 'sk-screen sk-screen-sub');
    const panel = el('section', 'sk-center sk-panel sk-panel-wide');
    const B = tr.bindings;
    const rows = (actions: readonly Action[]): HTMLElement[] => actions.map((a) => this.bindingRow(a));
    const cols = el('div', 'sk-st-cols');
    const left = el('div', 'sk-st-col');
    const right = el('div', 'sk-st-col');
    left.append(this.group(B.groupMove, rows(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'dive'])));
    right.append(
      this.group(B.groupWeb, rows(['swing', 'zip'])),
      this.group(B.groupOther, rows(['music', 'photo', 'timePause', 'timeFast'])),
    );
    cols.append(left, right);
    const actions = el('div', 'sk-actions');
    actions.append(this.button(B.reset, 'is-small is-ghost', () => this.resetBindings()), this.backButton());
    panel.append(this.panelTitle(B.title), el('p', 'sk-bd-help', B.help), cols, el('p', 'sk-bd-fixed', B.fixed), actions);
    screen.append(panel);
    return screen;
  }

  private bindingRow(action: Action): HTMLElement {
    const row = el('div', 'sk-st-row');
    const slots = el('div', 'sk-bd-slots');
    for (const slot of [0, 1] as const) {
      const btn = el('button', 'sk-bd-slot');
      btn.type = 'button';
      const key = el('span', 'sk-bd-key');
      const view: BindingSlotView = { action, slot, btn, text: textNode(key) };
      btn.append(key);
      btn.addEventListener('mouseenter', () => this.sound('hover'));
      btn.addEventListener('click', () => {
        this.sound('click');
        this.capture = view;
        this.syncBindings();
      });
      this.bindingSlots.push(view);
      slots.append(btn);
    }
    row.append(el('span', 'sk-st-label', tr.bindings.actions[action]), slots);
    return row;
  }

  private syncBindings(): void {
    const B = tr.bindings;
    const b = this.settings.bindings;
    for (const v of this.bindingSlots) {
      const code = b[v.action][v.slot];
      const capturing = this.capture === v;
      const label = code === null ? null : keyLabel(code);
      setText(v.text, capturing ? B.press : (label ?? B.empty));
      v.btn.classList.toggle('is-capturing', capturing);
      v.btn.classList.toggle('is-empty', !capturing && code === null);
      v.btn.setAttribute('aria-label', B.slotAria(B.actions[v.action], v.slot + 1, capturing ? B.press : (label ?? B.emptyAria)));
    }
  }

  /** Re-renders every text that names a bound key. */
  private refreshKeyViews(): void {
    this.syncBindings();
    this.renderControls();
    this.syncPhotoKeys();
  }

  private reloadKeyboardLayout(): void {
    void loadKeyboardLayout().then((changed) => {
      if (changed) this.refreshKeyViews();
    });
  }

  private endCapture(): void {
    this.capture = null;
    this.syncBindings();
  }

  /** Stores `code` (null = empty) in the slot being captured, saves and applies it. */
  private finishCapture(code: string | null): void {
    const view = this.capture;
    if (!view) return;
    this.capture = null;
    const { bindings, takenFrom } = assignBinding(this.settings.bindings, view.action, view.slot, code);
    this.settings.bindings = bindings;
    this.commitSettings();
    this.refreshKeyViews();
    this.sound('click');
    if (code !== null && takenFrom) this.toast(tr.bindings.taken(keyLabel(code), tr.bindings.actions[takenFrom]));
  }

  private onCaptureKey(e: KeyboardEvent): void {
    const code = e.code;
    if (code === 'Escape') {
      this.sound('click');
      this.endCapture();
    } else if (code === 'Backspace' || code === 'Delete') {
      this.finishCapture(null);
    } else if (isBindableCode(code)) {
      this.finishCapture(code);
    } else {
      this.toast(tr.bindings.reserved(code ? keyLabel(code) : e.key));
    }
  }

  private setBindingsMouse(on: boolean): void {
    for (const type of CAPTURE_MOUSE_EVENTS) {
      if (on) window.addEventListener(type, this.onBindingsMouse, true);
      else window.removeEventListener(type, this.onBindingsMouse, true);
    }
    this.swallowClick = false;
  }

  /** Mouse buttons fill the waiting slot; the press must not also click the button under the cursor. */
  private readonly onBindingsMouse = (e: MouseEvent): void => {
    if (e.type === 'contextmenu') {
      e.preventDefault();
      return;
    }
    if (e.type === 'mousedown') {
      this.swallowClick = false;
      if (!this.capture || e.button >= MOUSE_BUTTONS) return;
      e.preventDefault();
      e.stopPropagation();
      this.swallowClick = true;
      this.finishCapture(mouseCode(e.button));
      return;
    }
    if (!this.swallowClick) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type !== 'mouseup') this.swallowClick = false;
  };

  /** Arrow keys on a slot: Left/Right between the two slots, Up/Down along the column. */
  private moveSlotFocus(key: string, container: HTMLElement): boolean {
    const slots = this.bindingSlots;
    const i = slots.findIndex((v) => v.btn === document.activeElement);
    if (i < 0) return false;
    let j = i;
    if (key === 'ArrowLeft') j = i - (i % 2);
    else if (key === 'ArrowRight') j = i - (i % 2) + 1;
    else if (key === 'ArrowDown') j = i + 2;
    else if (key === 'ArrowUp') j = i - 2;
    else return false;
    let target: HTMLElement | undefined = slots[j]?.btn;
    if (!target) {
      // Past the last row: on to the buttons below; above the first row: wrap to the last control.
      const items = this.focusables(container);
      const k = items.indexOf(slots[i]!.btn);
      target = key === 'ArrowDown' ? items.find((node, n) => n > k && !slots.some((v) => v.btn === node)) : items[items.length - 1];
    }
    if (target && target !== document.activeElement) {
      target.focus();
      this.sound('hover');
    }
    return true;
  }

  private resetBindings(): void {
    this.capture = null;
    this.settings.bindings = DEFAULT_BINDINGS;
    this.commitSettings();
    this.refreshKeyViews();
  }

  // ------------------------------------------------------------- photo panel

  private buildPhoto(): {
    panel: HTMLElement;
    fov: HTMLInputElement;
    fovVal: Text;
    time: HTMLInputElement;
    timeVal: Text;
    exitLabel: HTMLElement;
    hint: HTMLElement;
  } {
    const panel = el('aside', 'sk-panel sk-photo');
    const title = el('h2', 'sk-title');
    title.append(icon(ICON_CAMERA, 'sk-icon sk-title-icon'), el('span', 'sk-title-text', tr.photo.title));
    const fov = this.photoSlider('sk-photo-fov', tr.photo.fov, PHOTO_FOV);
    const time = this.photoSlider('sk-photo-time', tr.photo.time, PHOTO_MINUTES);
    const onInput = (): void => {
      const f = Number(fov.input.value);
      const minutes = Number(time.input.value);
      setFill(fov.input);
      setFill(time.input);
      setText(fov.val, `${formatInteger(f)}${tr.settings.unitDegrees}`);
      setText(time.val, formatClock(minutes / 60));
      this.photo?.onChange(f, minutes / 60);
    };
    fov.input.addEventListener('input', onInput);
    time.input.addEventListener('input', onInput);
    const actions = el('div', 'sk-photo-actions');
    const exit = this.button(tr.photo.exit(null), 'is-small', () => {
      const p = this.photo;
      if (!p) return;
      p.onExit();
      this.hidePhoto();
    });
    actions.append(
      this.button(tr.photo.save, 'is-primary is-small', (b) => {
        // Mouse users get focus back on the canvas side; keyboard users keep their place.
        if (!this.keyboardMode) b.blur();
        const p = this.photo;
        if (!p) return;
        p.onSave();
        this.toast(tr.photo.saved);
      }),
      exit,
    );
    const hint = el('p', 'sk-photo-hint');
    panel.append(title, fov.row, time.row, actions, hint);
    const exitLabel = exit.querySelector<HTMLElement>('.sk-btn-label') ?? exit;
    return { panel, fov: fov.input, fovVal: fov.val, time: time.input, timeVal: time.val, exitLabel, hint };
  }

  /** Photo panel texts that name keys: the exit button and the free-camera hint. */
  private syncPhotoKeys(): void {
    const b = this.settings.bindings;
    const key = (a: Action): string => primaryLabel(b[a]) ?? tr.bindings.empty;
    const move = MOVE_ACTIONS.map(key);
    const moveText = move.every((m) => [...m].length === 1) ? move.join('') : move.join(' ');
    if (this.touch) {
      this.photoExitLabel.textContent = tr.photo.exit(null);
      this.photoHint.textContent = tr.photo.touchHint;
      return;
    }
    this.photoExitLabel.textContent = tr.photo.exit(primaryLabel(b.photo));
    this.photoHint.textContent = tr.photo.hint(moveText, key('jump'), key('dive'), key('sprint'));
  }

  private photoSlider(
    id: string,
    label: string,
    range: { min: number; max: number; step: number },
  ): { row: HTMLElement; input: HTMLInputElement; val: Text } {
    const row = el('div', 'sk-ph-row');
    const head = el('div', 'sk-ph-head');
    const lab = el('label', 'sk-st-label', label);
    lab.htmlFor = id;
    const out = el('output', 'sk-st-val');
    out.setAttribute('for', id);
    const val = textNode(out);
    head.append(lab, out);
    const input = el('input', 'sk-range');
    input.type = 'range';
    input.id = id;
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.addEventListener('change', () => this.sound('click'));
    // Release keyboard focus after dragging so free-camera keys never nudge the slider.
    input.addEventListener('pointerup', () => input.blur());
    row.append(head, input);
    return { row, input, val };
  }
}
