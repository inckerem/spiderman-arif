import { tr } from '../i18n/tr';
import { MAP_IDS, type MapId } from '../maps/ids';
import { isPlayableMap, reloadWithMap, resolveMapId } from '../maps/select';
import { el } from './dom';
import type { Settings } from './settings';
import './mapScreen.css';

/** What the map screen needs from the UI shell. */
export interface MapScreenHost {
  settings: Settings;
  title(text: string): HTMLElement;
  back(): HTMLElement;
  sound(kind: 'click' | 'hover'): void;
  /** Saves the settings (and applies them). */
  save(): void;
}

/** Card art: a skyline silhouette for each map. */
const ART: Record<MapId, string> = {
  manhattan:
    '<svg viewBox="0 0 120 70" aria-hidden="true"><rect width="120" height="70" fill="#9fd0e0"/>' +
    '<path fill="#2e4c63" d="M4 70V38h10V24h8v46h4V30h12v40h4V12h4V4h2v8h4v58h4V34h10v36h4V20h12v50h4V40h8v30h6V30h8v40z"/>' +
    '<rect y="62" width="120" height="8" fill="#3d84ad"/></svg>',
  istanbul:
    '<svg viewBox="0 0 120 70" aria-hidden="true"><rect width="120" height="70" fill="#f2c27a"/>' +
    '<path fill="#5b4a6b" d="M10 70V30h1.6V22l.9-4 .9 4v8H15v40h8V52c0-10 9-17 17-17s17 7 17 17v18h4V30h1.6V22l.9-4 .9 4v8H65v40h6V56c0-6 5-10 10-10s10 4 10 10v14h6V34h1.4v-7l.8-3 .8 3v7h1.4v36h9z"/>' +
    '<rect y="62" width="120" height="8" fill="#1d5a78"/></svg>',
};

/**
 * The "Harita" screen: one radio card per map. Picking another map saves the
 * setting and reloads the page with `?harita=<id>` (other URL parameters
 * stay); maps that are not playable yet show as disabled.
 */
export function buildMapScreen(host: MapScreenHost): HTMLDivElement {
  // The running map: the same resolution the boot used.
  const current = resolveMapId(location.search, host.settings.map);
  const screen = el('div', 'sk-screen sk-screen-sub');
  const panel = el('section', 'sk-center sk-panel sk-panel-maps');
  const title = host.title(tr.maps.title);
  title.id = 'sk-maps-title';
  const grid = el('div', 'sk-costumes sk-maps');
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-labelledby', title.id);
  const overlay = el('div', 'sk-map-loading');
  overlay.hidden = true;
  overlay.append(el('div', 'sk-map-loading-text', tr.maps.loading));
  const pick = (id: MapId): void => {
    if (!isPlayableMap(id)) return;
    host.settings.map = id;
    host.save();
    if (id === current) return;
    overlay.hidden = false;
    reloadWithMap(id);
  };
  const cards = MAP_IDS.map((id, i) => {
    const playable = isPlayableMap(id);
    const b = el('button', 'sk-costume sk-map');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.map = id;
    b.setAttribute('aria-checked', id === current ? 'true' : 'false');
    b.tabIndex = id === current ? 0 : -1;
    if (!playable) b.setAttribute('aria-disabled', 'true');
    const art = el('span', 'sk-map-art');
    art.innerHTML = ART[id];
    b.append(art, el('span', 'sk-costume-name', tr.maps.names[id]), el('span', 'sk-map-desc', playable ? tr.maps.desc[id] : tr.maps.soon));
    b.addEventListener('mouseenter', () => host.sound('hover'));
    b.addEventListener('click', () => {
      host.sound('click');
      pick(id);
    });
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      cards[(i + (e.key === 'ArrowRight' ? 1 : MAP_IDS.length - 1)) % MAP_IDS.length]?.focus();
    });
    return b;
  });
  grid.append(...cards);
  const actions = el('div', 'sk-actions');
  actions.append(host.back());
  panel.append(title, grid, el('p', 'sk-costume-hint', tr.maps.hint), actions);
  screen.append(panel, overlay);
  return screen;
}
