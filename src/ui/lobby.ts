/**
 * Multiplayer lobby (design M12 §8, Turkish UI): player name (remembered,
 * checked with the server's own rules as you type), map, then the public
 * room of that map, a new private room (with the PvP switch) or a room code.
 * Fills the UI's lobby screen; the online controller does the connecting.
 */
import './online.css';
import { tr } from '../i18n/tr';
import { checkName, NAME_MAX, NAME_STORAGE_KEY } from '../net/names';
import { MAP_IDS, DEFAULT_MAP, type MapId } from '../net/maps';
import { isRoomCode, normalizeRoomCode, NET } from '../net/protocol';
import type { UI } from './ui';

export interface LobbyHandlers {
  onPublic(name: string, map: MapId): void;
  onCreate(name: string, map: MapId, pvp: boolean): void;
  onCode(name: string, code: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function loadName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // Private mode: the name is simply not remembered.
  }
}

export class Lobby {
  readonly name: HTMLInputElement;
  readonly code: HTMLInputElement;
  readonly map: HTMLSelectElement;
  private readonly nameMsg: HTMLParagraphElement;
  private readonly codeMsg: HTMLParagraphElement;
  private readonly status: HTMLParagraphElement;
  private readonly pvpBtn: HTMLButtonElement;
  private readonly actions: HTMLButtonElement[] = [];
  private pvp = false;
  private busy = false;

  constructor(
    private readonly ui: UI,
    h: LobbyHandlers,
  ) {
    const L = tr.net.lobby;
    const host = ui.lobbyHost;
    const panel = el('section', 'sk-center sk-panel sk-lobby');
    const title = el('h2', 'sk-title');
    title.append(el('span', 'sk-title-text', L.title));

    // Name and map.
    const who = el('div', 'sk-lobby-card is-wide');
    const nameLabel = el('label', '', L.nameLabel);
    this.name = el('input');
    this.name.type = 'text';
    this.name.maxLength = NAME_MAX + 4;
    this.name.placeholder = L.namePlaceholder;
    this.name.autocomplete = 'off';
    this.name.spellcheck = false;
    this.name.value = loadName();
    this.name.className = 'sk-name';
    nameLabel.append(this.name);
    this.nameMsg = el('p', 'sk-lobby-msg', L.nameHint);
    const mapLabel = el('label', '', L.mapLabel);
    this.map = el('select');
    for (const id of MAP_IDS) {
      const o = el('option', '', L.maps[id] ?? id);
      o.value = id;
      this.map.append(o);
    }
    this.map.value = DEFAULT_MAP;
    mapLabel.append(this.map);
    who.append(nameLabel, this.nameMsg, mapLabel);

    // Public room.
    const pub = el('div', 'sk-lobby-card');
    const joinPublic = this.action(L.joinPublic, 'is-primary sk-join-public', () => {
      const n = this.validName();
      if (n) h.onPublic(n, this.mapId);
    });
    pub.append(el('h3', '', L.publicTitle), el('p', '', L.publicText), joinPublic);

    // Private room.
    const priv = el('div', 'sk-lobby-card');
    this.pvpBtn = el('button', 'sk-toggle sk-pvp');
    this.pvpBtn.type = 'button';
    this.pvpBtn.setAttribute('role', 'switch');
    const track = el('span', 'sk-toggle-track');
    track.append(el('span', 'sk-toggle-knob'));
    this.pvpBtn.append(track, el('span', 'sk-toggle-text', L.pvp));
    this.pvpBtn.addEventListener('click', () => this.setPvp(!this.pvp));
    this.setPvp(false);
    const create = this.action(L.createPrivate, 'sk-create', () => {
      const n = this.validName();
      if (n) h.onCreate(n, this.mapId, this.pvp);
    });
    priv.append(el('h3', '', L.privateTitle), el('p', '', L.privateText), this.pvpBtn, create);

    // Join by code.
    const byCode = el('div', 'sk-lobby-card is-wide');
    const codeLabel = el('label', '', L.codeLabel);
    this.code = el('input');
    this.code.type = 'text';
    this.code.className = 'sk-code';
    this.code.maxLength = NET.roomCodeLength + 2;
    this.code.placeholder = L.codePlaceholder;
    this.code.autocomplete = 'off';
    this.code.spellcheck = false;
    this.code.addEventListener('input', () => {
      const v = normalizeRoomCode(this.code.value);
      if (v !== this.code.value) this.code.value = v;
      this.codeMsg.textContent = '';
    });
    codeLabel.append(this.code);
    this.codeMsg = el('p', 'sk-lobby-msg is-bad');
    const join = this.action(L.joinCode, 'sk-join-code', () => {
      const n = this.validName();
      const c = normalizeRoomCode(this.code.value);
      if (!isRoomCode(c)) {
        this.codeMsg.textContent = L.codeInvalid;
        return;
      }
      if (n) h.onCode(n, c);
    });
    byCode.append(el('h3', '', L.codeTitle), codeLabel, this.codeMsg, join);

    const grid = el('div', 'sk-lobby-grid');
    grid.append(who, pub, priv, byCode);
    this.status = el('p', 'sk-lobby-status');
    this.status.setAttribute('aria-live', 'polite');
    const back = ui.makeButton(tr.menu.back, 'is-small', () => ui.closeLobby());
    panel.append(title, grid, this.status, back);
    host.append(panel);

    this.name.addEventListener('input', () => this.checkLive());
    this.checkLive();
  }

  private get mapId(): MapId {
    return (MAP_IDS as readonly string[]).includes(this.map.value) ? (this.map.value as MapId) : DEFAULT_MAP;
  }

  private action(label: string, variant: string, fn: () => void): HTMLButtonElement {
    const b = this.ui.makeButton(label, variant, () => {
      if (!this.busy) fn();
    });
    this.actions.push(b);
    return b;
  }

  private setPvp(on: boolean): void {
    this.pvp = on;
    this.pvpBtn.classList.toggle('is-on', on);
    this.pvpBtn.setAttribute('aria-checked', String(on));
  }

  private checkLive(): void {
    const raw = this.name.value;
    if (!raw.trim()) {
      this.nameMsg.textContent = tr.net.lobby.nameHint;
      this.nameMsg.classList.remove('is-bad');
      return;
    }
    const c = checkName(raw);
    this.nameMsg.textContent = c.ok ? tr.net.lobby.nameHint : tr.net.name[c.why];
    this.nameMsg.classList.toggle('is-bad', !c.ok);
  }

  /** The cleaned name, remembered; or null with the problem shown. */
  private validName(): string | null {
    const c = checkName(this.name.value);
    if (!c.ok) {
      this.nameMsg.textContent = tr.net.name[c.why];
      this.nameMsg.classList.add('is-bad');
      this.name.focus();
      return null;
    }
    saveName(c.name);
    return c.name;
  }

  /** Opens the lobby (with an invite code filled in). */
  open(code?: string): void {
    this.setBusy(false);
    this.status.textContent = code ? tr.net.lobby.invited(code) : '';
    this.status.classList.add('is-busy');
    if (code) this.code.value = normalizeRoomCode(code);
    this.ui.showLobby();
    this.checkLive();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    for (const b of this.actions) b.disabled = busy;
    if (busy) {
      this.status.textContent = tr.net.lobby.connecting;
      this.status.classList.add('is-busy');
    }
  }

  /** A refusal or problem, shown under the cards. */
  showError(msg: string): void {
    this.setBusy(false);
    this.status.textContent = msg;
    this.status.classList.remove('is-busy');
  }
}
