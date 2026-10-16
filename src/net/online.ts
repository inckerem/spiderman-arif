/**
 * Online play (M12): the lobby flow, the NetLink session and everything the
 * game does differently in a room. Remote heroes (roster, name tags,
 * minimap dots, their sounds), the shared clock (hour keys off, the local
 * hour pulled to the room's, the rooftop moment restores to it), pause = afk,
 * server corrections, reconnects, the pause-menu room panel and the fallback
 * to single player when the server is unreachable or the session ends.
 */
import type { App } from '../app';
import { tr } from '../i18n/tr';
import { MAPS, type MapId } from './maps';
import { HOUR_BLEND_S, HOUR_SNAP, hourDelta, hoursPerSecond, wrapHour } from './clock';
import { NetLink, type NetStatus } from './netLink';
import { RemoteRoster, type RemoteView } from './remoteRoster';
import type { JoinRequest, KickWhy, LeftWhy, RoomInfo } from './protocol';
import { NameTags } from '../ui/nameTags';
import { Lobby } from '../ui/lobby';
import type { CombatIntent } from '../combat/types';
import type { DebugOp } from '../sim/types';

const TOKEN_KEY = 'skythread.net.session.v1';
/** Remote hero sounds fade out over this distance (m). */
const SFX_RANGE = 45;

interface StoredSession {
  token: string;
  roomId: string;
  map: MapId;
  code?: string;
  public: boolean;
}

/** The WebSocket address: `ws` next to the page (works under any subpath); `?ws=` overrides it in development. */
export function wsUrl(): string {
  const q = new URLSearchParams(location.search).get('ws');
  if (q && import.meta.env.DEV) return q;
  const u = new URL('ws', location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.search = '';
  u.hash = '';
  return u.href;
}

function readSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

function writeSession(s: StoredSession | null): void {
  try {
    if (s) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: reconnects within the tab still work (the link keeps the token).
  }
}

export class Online {
  link: NetLink | null = null;
  roster: RemoteRoster | null = null;
  readonly tags: NameTags;
  readonly lobby: Lobby;
  private readonly views: RemoteView[] = [];
  private roomHourAt = 0;
  private roomHourValue = 0;
  private roomDayLen = 12;
  private savedDayLen = 12;
  /** Shown hour = room hour + this offset, which eases to 0 (a new clock message never jumps the sky). */
  private hourOffset = 0;
  private lastFrameT = 0;
  private lastRender = 0;
  private connecting = false;

  constructor(
    private readonly app: App,
    uiRoot: HTMLElement,
  ) {
    this.tags = new NameTags(uiRoot);
    this.lobby = new Lobby(app.ui, {
      onPublic: (name, map) => void this.start(name, map, { kind: 'public' }),
      onCreate: (name, map, pvp) => void this.start(name, map, { kind: 'create', pvp }),
      onCode: (name, code) => void this.start(name, MAPS.manhattan.id, { kind: 'code', code }),
    });
  }

  get active(): boolean {
    return this.link !== null;
  }

  get room(): RoomInfo | null {
    return this.link?.room ?? null;
  }

  openLobby(code?: string): void {
    this.lobby.open(code);
  }

  /** Room hour now (extrapolated from the last `clock`). */
  roomHour(): number {
    return wrapHour(this.roomHourValue + ((performance.now() - this.roomHourAt) / 1000) * hoursPerSecond(this.roomDayLen));
  }

  // ---------------------------------------------------------------- session

  private async start(name: string, map: MapId, join: JoinRequest): Promise<void> {
    if (this.connecting || this.link) return;
    const app = this.app;
    const game = app.game;
    if (join.kind !== 'code' && MAPS[map].seed !== app.seed) {
      this.lobby.showError(tr.net.lobby.seedMismatch);
      return;
    }
    this.connecting = true;
    this.lobby.setBusy(true);
    const stored = readSession();
    const sameRoom = stored && ((join.kind === 'code' && stored.code === join.code) || (join.kind === 'public' && stored.public && stored.map === map));
    const link = new NetLink({
      url: wsUrl(),
      name,
      costume: app.ui.settings.costume,
      map,
      join,
      token: sameRoom ? stored.token : undefined,
      player: game.player,
      view: game.combatView,
    });
    const r = await link.connect();
    this.connecting = false;
    if (!r.ok) {
      link.close();
      if (r.why === 'unreachable') {
        // No server: single player at once.
        this.lobby.setBusy(false);
        app.ui.toast(tr.net.unreachable);
        app.play();
      } else this.lobby.showError(tr.net.reject[r.why]);
      return;
    }
    if (r.room.seed !== app.seed) {
      link.close();
      this.lobby.showError(tr.net.lobby.seedMismatch);
      return;
    }
    this.lobby.setBusy(false);
    this.activate(link);
    app.play();
    // The new game reset the combat view: the room's running crime events (welcome) go back in.
    link.syncCrimes();
    app.ui.toast(join.kind === 'create' ? tr.net.room.created(r.room.code ?? '') : tr.net.room.joined(`${this.roomName(r.room)}${r.room.code ? ` ${r.room.code}` : ''}`));
  }

  private activate(link: NetLink): void {
    const app = this.app;
    const game = app.game;
    this.link = link;
    game.link.target = link;
    game.combatView.reset();
    game.enemyRender.reset();
    game.heroCombat.reset();
    game.player.clearCombat();
    const roster = new RemoteRoster(game.scene, game.world);
    roster.onEvent = (r, e) => this.remoteSound(r.pos.x, r.pos.y, r.pos.z, e);
    this.roster = roster;
    for (const p of link.players.values()) roster.add(p);
    link.onRemoteState = (pid, s) => roster.push(pid, s);
    link.onJoin = (p) => {
      roster.add(p);
      app.ui.toast(tr.net.joined(p.name));
      this.refreshPanel();
    };
    link.onLeft = (pid, why) => this.onLeft(pid, why);
    link.onClock = (hour, dayLen) => {
      const d = hourDelta(hour, game.dayNight.hour);
      this.hourOffset = Math.abs(d) > HOUR_SNAP ? 0 : d;
      this.roomHourValue = hour;
      this.roomHourAt = performance.now();
      this.roomDayLen = dayLen;
      game.dayNight.dayLengthMinutes = dayLen;
    };
    link.onCorrect = (x, y, z) => game.teleportHero(x, y, z);
    link.onKick = (why) => this.ended(why);
    link.onStatus = (s) => this.onStatus(s);
    link.onWelcome = (resumed) => {
      if (resumed) app.ui.toast(tr.net.reconnected);
      else {
        // A new slot (the old one expired): rebuild the roster.
        roster.clear();
        for (const p of link.players.values()) roster.add(p);
      }
      this.save();
      this.refreshPanel();
    };
    // The shared clock.
    this.savedDayLen = game.dayNight.dayLengthMinutes;
    game.dayNight.dayLengthMinutes = this.roomDayLen;
    // The room drives the hour (frame()); the local advance stays off while online.
    game.dayNight.paused = true;
    this.hourOffset = 0;
    this.lastFrameT = performance.now();
    game.dayNight.hour = this.roomHour();
    game.hourLock = () => app.ui.toast(tr.net.timeShared);
    app.moment.restoreHour = () => this.roomHour();
    this.lastRender = performance.now();
    game.onBeforeRender = () => this.beforeRender();
    this.save();
    this.refreshPanel();
  }

  private save(): void {
    const l = this.link;
    if (!l || !l.room) return;
    writeSession({ token: l.token, roomId: l.room.id, map: l.room.map, code: l.room.code, public: l.room.public });
  }

  /** Leave the room (menu or kick): back to single player where the hero is. */
  leave(): void {
    const link = this.link;
    if (!link) return;
    link.onStatus = null;
    link.onKick = null;
    link.close();
    this.detach();
    writeSession(null);
  }

  private detach(): void {
    const game = this.app.game;
    this.link = null;
    game.link.target = game.link.local;
    game.combatView.reset();
    game.enemyRender.reset();
    game.heroCombat.reset();
    game.player.clearCombat();
    this.app.combatUi.reset();
    this.roster?.dispose();
    this.roster = null;
    this.tags.clear();
    game.hourLock = null;
    this.app.moment.restoreHour = null;
    game.dayNight.dayLengthMinutes = this.savedDayLen;
    game.dayNight.paused = false;
    game.onBeforeRender = null;
    this.app.ui.setPauseExtra(null);
    this.app.ui.setMinimapPlayers([]);
  }

  /** Kicked, or the connection could not be restored: single player carries on. */
  private ended(why: KickWhy): void {
    const ui = this.app.ui;
    if (!this.link) return;
    ui.toast(why === 'timeout' ? tr.net.offline : tr.net.kick[why]);
    this.link.onKick = null;
    this.link.onStatus = null;
    this.link.close();
    this.detach();
    writeSession(null);
  }

  private onStatus(s: NetStatus): void {
    if (s === 'reconnecting') this.app.ui.toast(tr.net.reconnecting);
  }

  private onLeft(pid: number, why: LeftWhy): void {
    const r = this.roster?.players.get(pid);
    const name = r?.name ?? '';
    this.roster?.remove(pid);
    if (name) {
      const ui = this.app.ui;
      if (why === 'timeout' || why === 'disconnect') ui.toast(tr.net.lost(name));
      else if (why === 'cheat' || why === 'rate' || why === 'garbage') ui.toast(tr.net.kicked(name));
      else ui.toast(tr.net.left(name));
    }
    this.refreshPanel();
  }

  // ------------------------------------------------------------------ frame

  /** Every app frame: pause = afk, the shared hour, the minimap dots. */
  frame(_dt: number): void {
    const link = this.link;
    if (!link) return;
    const app = this.app;
    const game = app.game;
    link.setPaused(app.state !== 'playing' || !game.playing);
    // Real time (frame deltas are clamped on a slow machine; the room's clock is not).
    const t = performance.now();
    const dt = (t - this.lastFrameT) / 1000;
    this.lastFrameT = t;
    if (game.dayNight.hold) this.hourOffset = 0; // the rooftop moment drives the hour, then restores the room's
    else {
      this.hourOffset *= Math.exp((-3 * dt) / HOUR_BLEND_S);
      game.dayNight.hour = wrapHour(this.roomHour() + this.hourOffset);
    }
    game.dayNight.paused = true;
    this.app.ui.setMinimapPlayers(this.views);
  }

  /** Before each rendered frame: pose remote heroes, place name tags; paused, keep the enemies moving. */
  private beforeRender(): void {
    const link = this.link;
    const roster = this.roster;
    if (!link || !roster) return;
    const game = this.app.game;
    const t = performance.now();
    const dt = Math.min(0.1, (t - this.lastRender) / 1000);
    this.lastRender = t;
    const now = link.now();
    if (!game.playing) game.combatView.update(now, link.renderTime());
    const cam = game.rig.camera;
    roster.update(now, dt, cam, game.dayNight.night);
    roster.views(this.views);
    this.tags.update(this.views, cam, game.world, game.view === 'play');
  }

  private remoteSound(x: number, y: number, z: number, e: { type: string }): void {
    const p = this.app.game.player.pos;
    const d = Math.hypot(x - p.x, y - p.y, z - p.z);
    if (d > SFX_RANGE) return;
    const k = 1 - d / SFX_RANGE;
    const a = this.app.audio;
    const ev = e as { type: string; good?: boolean; impact?: number; surface?: number };
    if (ev.type === 'webFire' && k > 0.35) a.webShot(0);
    else if (ev.type === 'attach') a.attach(0.6 * k);
    else if (ev.type === 'release' && k > 0.5) a.release(!!ev.good);
    else if (ev.type === 'land') a.land((ev.impact ?? 0) * k, ev.surface ?? 0);
  }

  // ------------------------------------------------------------ room panel

  private roomName(r: RoomInfo): string {
    const map = tr.net.lobby.maps[r.map] ?? r.map;
    return r.public ? tr.net.room.publicName(map, r.index) : tr.net.room.privateName(map);
  }

  inviteUrl(): string {
    const code = this.link?.room?.code;
    return code ? `${location.origin}${location.pathname}?oda=${code}` : '';
  }

  private refreshPanel(): void {
    const link = this.link;
    const room = link?.room;
    if (!link || !room) return;
    const ui = this.app.ui;
    const R = tr.net.room;
    const box = document.createElement('div');
    box.className = 'sk-room';
    const name = document.createElement('div');
    name.className = 'sk-room-name';
    name.textContent = this.roomName(room);
    box.append(name);
    if (room.code) {
      const code = document.createElement('div');
      code.className = 'sk-room-code';
      code.textContent = room.code;
      box.append(code);
    }
    const meta = document.createElement('div');
    meta.className = 'sk-room-meta';
    meta.textContent = `${room.pvp ? R.pvpOn : R.pvpOff} · ${R.players(link.players.size + 1)}`;
    const list = document.createElement('ul');
    list.className = 'sk-room-list';
    const me = document.createElement('li');
    me.className = 'is-self';
    me.textContent = `${link.name} ${R.you}`;
    list.append(me);
    for (const p of link.players.values()) {
      const li = document.createElement('li');
      li.textContent = p.name;
      list.append(li);
    }
    box.append(meta, list);
    if (room.code) {
      box.append(
        ui.makeButton(R.copyInvite, 'is-small sk-copy-invite', () => {
          const url = this.inviteUrl();
          const done = (): void => ui.toast(R.copied);
          if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => window.prompt(R.copyInvite, url));
          else window.prompt(R.copyInvite, url);
        }),
      );
    }
    box.append(
      ui.makeButton(R.leave, 'is-small sk-leave-room', () => {
        this.leave();
        this.app.toMainMenu();
      }),
    );
    ui.setPauseExtra(box);
  }

  // ------------------------------------------------------------- test hooks

  /** `window.__net` in development builds. */
  testApi() {
    return {
      state: () => {
        const l = this.link;
        return {
          active: !!l,
          status: l?.status ?? 'idle',
          pid: l?.selfPid ?? 0,
          name: l?.name ?? '',
          room: l?.room ?? null,
          tp: l?.tp ?? 0,
          players: l ? [...l.players.values()] : [],
          remotes: this.views.map((v) => ({ ...v })),
          tags: this.tags.shown(),
          hour: this.app.game.dayNight.hour,
          roomHour: this.link ? this.roomHour() : null,
          hourOffset: this.hourOffset,
          now: l ? l.now() : 0,
          self: { ...this.app.game.combatView.self },
          enemies: this.app.game.combatView.enemies.map((e) => ({ id: e.id, hp: e.hp, x: e.x, y: e.y, z: e.z, state: e.state })),
          invite: this.inviteUrl(),
          bytesIn: l?.bytesIn ?? 0,
          bytesOut: l?.bytesOut ?? 0,
          drops: l?.drops ?? 0,
          appState: this.app.state,
          playing: this.app.game.playing,
          roster: this.roster ? [...this.roster.players.values()].map((r) => ({ pid: r.pid, samples: r.buf.size, newest: r.buf.newest, lod: r.lod })) : [],
        };
      },
      dropSocket: () => this.link?.dropSocket(),
      intent: (i: CombatIntent) => this.link?.intent(i),
      dbg: (op: DebugOp, a: number[]) => this.link?.debug(op, a),
      leave: () => this.leave(),
      corrections: () => this.link?.tp ?? 0,
    };
  }
}
