import { tuning } from '../config/tuning';
import type { Game } from '../game';
import { CA, MODE_NAMES } from '../player/player';
import { makeAnchorResult } from '../player/targeting';
import { ES_NAMES, HERO_ID_BASE, type CombatEvent } from '../combat/types';
import { kindInfo } from '../combat/roster';
import { aimAt, emptyBotInput, planTarget, stepWithInput, lineControlsTest, lineEdgeCasesTest, type BotInput } from './testDrivers';

// In-page combat drivers (dev builds): routing of the context-sensitive
// buttons, the combo chain and finishers, web yank and pin, dodges. Each runs
// in manual mode with combat switched on and returns numbers for the spec.

type Spot = [number, number, number];
type R = Record<string, unknown>;

/** Spawn spots of the k-th storefront arena nearest the city spawn. */
function arenaSpots(game: Game, k = 0): Spot[] {
  const sp = game.spawns;
  const s = game.layout.spawn;
  const ids = [...sp.byType[0]!].sort((a, b) => {
    const A = sp.arenas[a]!,
      B = sp.arenas[b]!;
    return Math.hypot(A.x - s[0], A.z - s[2]) - Math.hypot(B.x - s[0], B.z - s[2]) || a - b;
  });
  const a = sp.arenas[ids[k]!]!;
  const out: Spot[] = [];
  for (let i = 0; i < a.spots.length; i += 3) out.push([a.spots[i]!, a.spots[i + 1]!, a.spots[i + 2]!]);
  return out;
}

/** The spot whose distance from `from` is closest to `d`. */
function spotAt(spots: Spot[], from: Spot, d: number): Spot {
  let best = spots[0]!;
  for (const s of spots) if (Math.abs(Math.hypot(s[0] - from[0], s[2] - from[2]) - d) < Math.abs(Math.hypot(best[0] - from[0], best[2] - from[2]) - d)) best = s;
  return best;
}

class Bench {
  readonly inp: BotInput = emptyBotInput();
  readonly prev: BotInput = emptyBotInput();
  /** Every combat event the game handled since the bench started. */
  private readonly all: CombatEvent[] = [];
  private readonly saved: number[];
  private readonly hook: Game['onCombatEvent'];

  constructor(readonly game: Game, passive: boolean) {
    game.combatEnabled = true;
    game.resetCombat();
    const E = tuning.enemies;
    // Passive enemies: no aggro and wind-ups that never land, so nothing hits back while routing is measured.
    this.saved = [E.aggroRange, E.thug.telegraph, E.bat.telegraph];
    if (passive) {
      E.aggroRange = 0;
      E.thug.telegraph = 1e3;
      E.bat.telegraph = 1e3;
    }
    this.hook = game.onCombatEvent;
    game.onCombatEvent = (e) => {
      this.all.push(e);
      this.hook?.(e);
    };
  }

  restore(): void {
    const E = tuning.enemies;
    E.aggroRange = this.saved[0]!;
    E.thug.telegraph = this.saved[1]!;
    E.bat.telegraph = this.saved[2]!;
    this.game.injectInput = null;
    this.game.onCombatEvent = this.hook;
  }

  step(n = 1): void {
    for (let i = 0; i < n; i++) stepWithInput(this.game, this.inp, this.prev);
  }

  place(x: number, y: number, z: number, yaw: number, pitch = -0.1): void {
    const g = this.game;
    Object.assign(this.inp, emptyBotInput());
    g.player.teleport(x, y, z);
    g.prevPos.copy(g.player.pos);
    g.rig.setLook(yaw, pitch);
    g.snapCamera();
    this.step(10);
  }

  spawn(kind: number, s: Spot): number {
    const g = this.game;
    const id = g.combatSim.debugSpawn(kind as 0, s[0], s[1], s[2]);
    g.combatLink.sync();
    g.combatView.update(g.combatLink.now(), g.combatLink.now());
    return id;
  }

  /** Crosshair on the enemy's chest. */
  aim(id: number): void {
    const e = this.game.combatView.enemy(id);
    if (!e) return;
    const info = kindInfo(e.kind as 0);
    aimAt(this.game, e.x, e.y + info.height * 0.6, e.z);
  }

  yawTo(s: Spot): number {
    const p = this.game.player.pos;
    return Math.atan2(-(s[0] - p.x), -(s[2] - p.z));
  }

  /** Combat events handled since index `from`. */
  events(from: number): CombatEvent[] {
    return this.all.slice(from);
  }

  get logLen(): number {
    return this.all.length;
  }

  playerEvents(from: number): string[] {
    return this.game.eventLog.slice(from).map((e) => e.type);
  }

  enemy(id: number): { state: string; hp: number; pos: Spot } | null {
    const e = this.game.combatSim.enemy(id);
    return e ? { state: ES_NAMES[e.state], hp: e.hp, pos: [e.pos.x, e.pos.y, e.pos.z] } : null;
  }

  heroDist(id: number): number {
    const e = this.game.combatSim.enemy(id);
    const p = this.game.player.pos;
    return e ? Math.hypot(e.pos.x - p.x, e.pos.z - p.z) : Infinity;
  }
}

const SELF = HERO_ID_BASE + 1;
const isHit = (e: CombatEvent, src: number, tgt: number): e is Extract<CombatEvent, { e: 'hit' }> => e.e === 'hit' && e.src === src && e.tgt === tgt;

/** Bones and the hero mesh are finite. */
function poseFinite(game: Game): boolean {
  for (const b of Object.values(game.hero.bones)) {
    const q = b.quaternion;
    if (!Number.isFinite(q.x + q.y + q.z + q.w) || !Number.isFinite(b.position.x + b.position.y + b.position.z)) return false;
  }
  const m = game.hero.mesh.position;
  return Number.isFinite(m.x + m.y + m.z);
}

/**
 * Routing: an enemy under the crosshair takes the left click (lunge, strike,
 * hit, no line), a sub-frame click on it too; with no enemy the line works
 * exactly as before (line control and edge-case drivers rerun with combat on);
 * an enemy out of reach and off the crosshair leaves the click to the line;
 * F always strikes (auto-target beside the crosshair, else a whiff).
 */
export function combatRoutingTest(game: Game): R {
  const b = new Bench(game, true);
  const r: R = {};
  const hc = game.heroCombat;
  const pl = game.player;
  try {
    const spots = arenaSpots(game, 0);
    const home = spots[0]!;
    const far = spotAt(spots, home, 8);
    b.place(home[0], home[1], home[2], b.yawTo(far));
    const id = b.spawn(0, far);
    b.step(4);
    b.aim(id);
    r.startDist = b.heroDist(id);
    let pe = game.eventLog.length,
      ce = b.logLen;
    const captured0 = hc.stats.captured;
    // Press and hold the left button with the thug in the crosshair.
    b.inp.swing = true;
    b.step(1);
    r.captured = hc.stats.captured - captured0;
    r.modeAfterPress = MODE_NAMES[pl.mode];
    r.lungeKind = pl.strike.kind;
    let ropeEver = false,
      poseOk = true;
    for (let i = 0; i < 50; i++) {
      b.step(1);
      if (pl.rope.attached || pl.rope.firing) ropeEver = true;
      if (!poseFinite(game)) poseOk = false;
    }
    b.inp.swing = false;
    b.step(40);
    const pev = b.playerEvents(pe);
    const cev = b.events(ce);
    const hits = cev.filter((e) => isHit(e, SELF, id));
    r.playerEvents = pev;
    r.ropeEver = ropeEver;
    r.webFire = pev.includes('webFire');
    r.lunge = pev.includes('lunge') && pev.includes('lungeEnd');
    r.strike = pev.includes('strike');
    r.hits = hits.map((h) => (h as Extract<CombatEvent, { e: 'hit' }>).move);
    r.enemyAfter = b.enemy(id);
    r.distAfter = b.heroDist(id);
    r.rejected = cev.filter((e) => e.e === 'rej').length;
    r.poseOk = poseOk;

    // A click shorter than a tick on the enemy: still a strike, no line, no capture left behind.
    b.step(30);
    b.aim(id);
    pe = game.eventLog.length;
    ce = b.logLen;
    game.injectInput = (out) => {
      out.swing = false;
      out.swingPressed = true;
      out.swingReleased = true;
    };
    game.manualTick();
    game.injectInput = null;
    b.step(40);
    const sub = b.playerEvents(pe);
    r.subFrameStrike = sub.includes('strike') && !sub.includes('webFire');
    r.subFrameHit = b.events(ce).some((e) => isHit(e, SELF, id));

    // An enemy 30 m behind (off the crosshair, out of lunge range): the click is a line.
    game.combatSim.debugClear();
    game.combatLink.sync();
    b.place(home[0], home[1] + 24, home[2], b.yawTo(far), 0.35);
    const behind: Spot = [home[0] - (far[0] - home[0]) * 4, home[1], home[2] - (far[2] - home[2]) * 4];
    b.spawn(0, behind);
    const a = makeAnchorResult();
    r.anchorPlanned = planTarget(game, 0, a);
    if (r.anchorPlanned) aimAt(game, a.x, a.y, a.z);
    pe = game.eventLog.length;
    b.inp.swing = true;
    b.step(40);
    r.behindAttached = pl.rope.attached;
    b.inp.swing = false;
    b.step(2);
    r.behindWebFire = b.playerEvents(pe).includes('webFire');

    // F: always a strike. An enemy beside the crosshair (in view, in range) is auto-targeted.
    game.combatSim.debugClear();
    game.combatLink.sync();
    b.place(home[0], home[1], home[2], b.yawTo(far));
    const side = spotAt(spots, home, 6);
    const sid = b.spawn(0, side);
    // Look 30 degrees off the enemy.
    game.rig.setLook(b.yawTo(side) + 0.52, -0.05);
    game.snapCamera();
    b.step(2);
    pe = game.eventLog.length;
    ce = b.logLen;
    b.inp.attack = true;
    b.step(1);
    b.inp.attack = false;
    b.step(60);
    const fev = b.playerEvents(pe);
    r.autoStrike = fev.includes('strike') && !fev.includes('webFire');
    r.autoHit = b.events(ce).some((e) => isHit(e, SELF, sid));
    // F with nobody around: a whiff jab (no intent).
    game.combatSim.debugClear();
    game.combatLink.sync();
    b.step(4);
    pe = game.eventLog.length;
    const intents0 = hc.stats.intents;
    b.inp.attack = true;
    b.step(1);
    b.inp.attack = false;
    b.step(50);
    r.whiff = b.playerEvents(pe).includes('strike');
    r.whiffIntents = hc.stats.intents - intents0;
    r.poseFinite = poseFinite(game);
  } finally {
    b.restore();
  }
  // No enemy at all: the line drivers behave as without combat.
  game.combatEnabled = true;
  game.resetCombat();
  r.lines = lineControlsTest(game);
  r.edges = lineEdgeCasesTest(game);
  r.combatOnDuringLines = game.combatEnabled;
  return r;
}

/**
 * Combo: four presses in a row (each during the previous strike: the input
 * buffer) give jab, cross, kick, uppercut with the combo counter 1..4; the
 * uppercut knocks the thug down and the next click is the ground finisher
 * (KO). The counter resets after the combo window. A takedown (E) with full
 * focus KOs a fresh thug at once.
 */
export function combatComboTest(game: Game): R {
  const b = new Bench(game, true);
  const r: R = {};
  const pl = game.player;
  const hc = game.heroCombat;
  try {
    const spots = arenaSpots(game, 0);
    const home = spots[0]!;
    const near = spotAt(spots, home, 2.2);
    b.place(home[0], home[1], home[2], b.yawTo(near));
    const id = b.spawn(0, near);
    b.step(2);
    b.aim(id);
    const ce = b.logLen;
    // The counter as the HUD shows it right after each confirmed hit.
    const combos: number[] = [];
    let seen = 0;
    const tick = (n: number): void => {
      for (let i = 0; i < n; i++) {
        b.step(1);
        const n2 = b.events(ce).filter((e) => isHit(e, SELF, id)).length;
        if (n2 > seen) {
          seen = n2;
          combos.push(game.combatView.self.combo);
        }
      }
    };
    const press = (): void => {
      b.inp.swing = true;
      tick(1);
      b.inp.swing = false;
      tick(1);
    };
    // Each press lands during the previous strike: the input buffer chains them.
    for (let k = 0; k < 4; k++) {
      press();
      tick(16);
    }
    tick(40);
    r.stateAfterChain = b.enemy(id)?.state;
    // The downed thug: the next click is the ground finisher.
    b.aim(id);
    press();
    tick(60);
    const cev = b.events(ce);
    const hits = cev.filter((e) => isHit(e, SELF, id)) as Array<Extract<CombatEvent, { e: 'hit' }>>;
    r.moves = hits.map((h) => h.move);
    r.dmg = hits.map((h) => h.dmg);
    r.combos = combos;
    r.comboAfterFinisher = game.combatView.self.combo;
    r.finalState = b.enemy(id)?.state;
    r.strikes = hc.stats.strikes;
    r.rejected = cev.filter((e) => e.e === 'rej').map((e) => (e as Extract<CombatEvent, { e: 'rej' }>).why);
    // The combo counter resets after the window.
    b.step(Math.ceil((tuning.combat.comboWindow + 0.3) * 120));
    r.hudComboAfterWindow = hc.hud.combo;
    r.simComboAfterWindow = game.combatSim.hero(1)?.combo ?? -1;
    // Takedown: full focus, a fresh thug within 4 m.
    const tid = b.spawn(0, near);
    b.step(4);
    const h = game.combatSim.hero(1);
    if (h) h.focus = 100;
    game.combatLink.sync();
    const ce2 = b.logLen;
    b.inp.finisher = true;
    b.step(1);
    b.inp.finisher = false;
    b.step(60);
    const td = b.events(ce2).filter((e) => isHit(e, SELF, tid)) as Array<Extract<CombatEvent, { e: 'hit' }>>;
    r.takedownMoves = td.map((e) => e.move);
    r.takedownState = b.enemy(tid)?.state;
    r.focusAfter = game.combatView.self.focus;
    r.takedownAnim = pl.combatAnim.action === CA.TAKEDOWN || td.length > 0;
    r.poseFinite = poseFinite(game);
  } finally {
    b.restore();
  }
  return r;
}

/**
 * Right button on an enemy: a tap yanks it toward the hero (no pull line), a
 * hold pins it in place for `pinTime`; with no enemy the pull line fires.
 */
export function combatLineTest(game: Game): R {
  const b = new Bench(game, true);
  const r: R = {};
  const pl = game.player;
  try {
    const spots = arenaSpots(game, 0);
    const home = spots[0]!;
    const far = spotAt(spots, home, 14);
    b.place(home[0], home[1], home[2], b.yawTo(far));
    const id = b.spawn(0, far);
    b.step(2);
    b.aim(id);
    const d0 = b.heroDist(id);
    let pe = game.eventLog.length,
      ce = b.logLen;
    b.inp.zip = true;
    b.step(1);
    b.inp.zip = false;
    b.step(70);
    const d1 = b.heroDist(id);
    r.yankD0 = d0;
    r.yankD1 = d1;
    r.yankFrac = (d0 - d1) / d0;
    r.yankEvent = b.events(ce).some((e) => e.e === 'yank' && e.tgt === id);
    r.yankZip = b.playerEvents(pe).includes('zipStart');
    // Hold: pin.
    b.step(30);
    b.aim(id);
    pe = game.eventLog.length;
    ce = b.logLen;
    b.inp.zip = true;
    b.step(Math.ceil(tuning.combat.pinHold * 120) + 6);
    b.inp.zip = false;
    b.step(2);
    const e0 = game.combatSim.enemy(id);
    const p0 = e0 ? e0.pos.clone() : null;
    let drift = 0;
    let pinnedSteps = 0;
    for (let i = 0; i < Math.floor((tuning.combat.pinTime - 0.6) * 120); i++) {
      b.step(1);
      const e = game.combatSim.enemy(id);
      if (e && p0) drift = Math.max(drift, Math.hypot(e.pos.x - p0.x, e.pos.z - p0.z));
      if (e && ES_NAMES[e.state] === 'pinned') pinnedSteps++;
    }
    r.pinEvent = b.events(ce).some((e) => e.e === 'pin' && e.tgt === id);
    r.pinDrift = drift;
    r.pinnedSeconds = pinnedSteps / 120;
    r.pinZip = b.playerEvents(pe).includes('zipStart');
    // No enemy under the crosshair: the pull line as today.
    game.combatSim.debugClear();
    game.combatLink.sync();
    b.place(home[0], home[1] + 24, home[2], b.yawTo(far), 0.2);
    const a = makeAnchorResult();
    r.zipPlanned = planTarget(game, 1, a);
    if (r.zipPlanned) aimAt(game, a.x, a.y, a.z);
    pe = game.eventLog.length;
    b.inp.zip = true;
    b.step(2);
    b.inp.zip = false;
    b.step(4);
    r.plainZip = b.playerEvents(pe).includes('zipStart');
    r.mode = MODE_NAMES[pl.mode];
    r.poseFinite = poseFinite(game);
  } finally {
    b.restore();
  }
  return r;
}

/**
 * Dodge: Space while a bat thug's swing is due (inside the i-frame window)
 * makes it miss (no jump, no damage); without Space it hits. In the air on a
 * held swing line, Space during a telegraph dodges and the line stays; with
 * no telegraph Space cuts the line as always.
 */
export function combatDodgeTest(game: Game): R {
  const b = new Bench(game, false);
  const r: R = {};
  const pl = game.player;
  const view = game.combatView;
  try {
    const spots = arenaSpots(game, 0);
    const home = spots[0]!;
    const near = spotAt(spots, home, 3);
    b.place(home[0], home[1], home[2], b.yawTo(near));
    const id = b.spawn(1, near);
    const ce = b.logLen;
    const runOne = (dodge: boolean): R => {
      // Wait for a telegraph on the hero.
      let t = 0;
      while (t++ < 120 * 8 && !(view.threat && view.threat.src === id && view.threat.at - game.combatLink.now() > 0.2)) b.step(1);
      const thr = view.threat;
      if (!thr) return { telegraph: false };
      const at = thr.at;
      const hp0 = view.self.hp;
      const pe = game.eventLog.length;
      const c0 = b.logLen;
      if (dodge) {
        // Into the i-frame window: 0.2 s before the impact.
        while (at - game.combatLink.now() > 0.2) b.step(1);
        b.inp.jump = true;
        b.step(1);
        b.inp.jump = false;
      }
      while (game.combatLink.now() < at + 0.3) b.step(1);
      const evs = b.events(c0);
      const pev = b.playerEvents(pe);
      return {
        telegraph: true,
        miss: evs.some((e) => e.e === 'miss' && e.src === id),
        hit: evs.some((e) => isHit(e, id, SELF)),
        hpLost: hp0 - view.self.hp,
        dodgeEvent: pev.includes('dodge'),
        jumped: pev.includes('jump'),
      };
    };
    r.withDodge = runOne(true);
    b.step(30);
    r.withoutDodge = runOne(false);
    r.rejected = b.events(ce).filter((e) => e.e === 'rej').length;

    // Air: a held swing line, a telegraph aimed at the hero (injected into the view), Space.
    game.combatSim.debugClear();
    game.combatLink.sync();
    b.place(home[0], home[1] + 24, home[2], b.yawTo(near), 0.35);
    const a = makeAnchorResult();
    r.anchorPlanned = planTarget(game, 0, a);
    if (r.anchorPlanned) aimAt(game, a.x, a.y, a.z);
    b.inp.swing = true;
    b.step(40);
    r.airAttachedBefore = pl.rope.attached;
    const fake = b.spawn(0, near);
    const now = game.combatLink.now();
    view.apply({ t: 'ce', time: now, ev: [{ e: 'tele', src: fake, tgt: SELF, atk: 17, at: now + 0.3 }] });
    view.update(now, game.combatLink.renderTime());
    let pe = game.eventLog.length;
    b.inp.jump = true;
    b.step(1);
    b.inp.jump = false;
    b.step(20);
    let pev = b.playerEvents(pe);
    r.airDodge = pev.includes('dodge');
    r.airDodgeAnim = pl.combatAnim.action === CA.DODGE;
    r.airLineKept = pl.rope.attached && !pev.includes('release');
    // No telegraph: Space cuts the line as always.
    game.combatSim.debugClear();
    game.combatLink.sync();
    b.step(30);
    r.airAttachedAfter = pl.rope.attached;
    pe = game.eventLog.length;
    b.inp.jump = true;
    b.step(1);
    b.inp.jump = false;
    b.step(4);
    pev = b.playerEvents(pe);
    r.spaceCutWithoutThreat = pev.includes('release') && !pl.rope.attached;
    b.inp.swing = false;
    b.step(2);
    r.poseFinite = poseFinite(game);
  } finally {
    b.restore();
  }
  return r;
}
