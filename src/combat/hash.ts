import type { Projectile } from './projectiles';
import type { CombatHero, Enemy } from './types';

/**
 * Determinism digest: FNV-1a over the sim state with positions quantized to
 * 1 mm. Two sims fed the same intents at the same steps must hash equal, in
 * the browser and on the Node server alike.
 */
export class StateHash {
  private h = 0x811c9dc5;

  int(v: number): this {
    let x = v | 0;
    for (let i = 0; i < 4; i++) {
      this.h ^= x & 0xff;
      this.h = Math.imul(this.h, 0x01000193);
      x >>>= 8;
    }
    return this;
  }

  /** A real number quantized to 1 / scale (NaN and infinities hash as fixed markers). */
  num(v: number, scale = 1000): this {
    if (Number.isNaN(v)) return this.int(0x7fc00000);
    if (!Number.isFinite(v)) return this.int(v > 0 ? 0x7f800000 : -0x800000);
    return this.int(Math.round(v * scale));
  }

  bool(v: boolean): this {
    return this.int(v ? 1 : 0);
  }

  value(): number {
    return this.h >>> 0;
  }

  hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, '0');
  }
}

/** `extra` adds more sim state (the crime scheduler) to the digest. */
export function hashCombat(
  time: number,
  enemies: readonly Enemy[],
  heroes: ReadonlyMap<number, CombatHero>,
  projectiles: readonly Projectile[] = [],
  extra?: (h: StateHash) => void,
): string {
  const h = new StateHash();
  h.num(time, 1e6).int(enemies.length);
  for (const e of enemies) {
    h.int(e.id).int(e.kind).int(e.state).num(e.stateT).num(e.pos.x).num(e.pos.y).num(e.pos.z).num(e.vel.x).num(e.vel.y).num(e.vel.z).num(e.yaw);
    h.num(e.hp).num(e.guard).int(e.target).int(e.flags).int(e.anim).num(e.animT0).int(e.slot);
    if (e.tele) h.int(e.tele.atk).int(e.tele.target).num(e.tele.impactAt);
    else h.int(-1);
  }
  h.int(heroes.size);
  for (const c of heroes.values()) {
    h.int(c.pid).num(c.hp).bool(c.down).num(c.downUntil).num(c.lastHurt).num(c.iframesUntil).int(c.combo).num(c.comboUntil).num(c.focus).num(c.lastStrike);
    h.num(c.x).num(c.y).num(c.z);
  }
  h.int(projectiles.length);
  for (const p of projectiles) h.int(p.id).int(p.kind).int(p.src).int(p.tgt).num(p.x).num(p.y).num(p.z).num(p.vx).num(p.vy).num(p.vz);
  extra?.(h);
  return h.hex();
}
