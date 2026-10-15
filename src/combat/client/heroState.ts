import type { Vector3 } from 'three';
import type { HeroState } from '../types';

/** What the combat link needs from the local hero (the `Player` satisfies it). */
export interface HeroSource {
  readonly pos: Vector3;
  readonly vel: Vector3;
  readonly mode: number;
  readonly grounded: boolean;
  readonly facing: number;
}

/** Copy the hero's movement into a `HeroState` sample (the link stamps `pid` and `t`). */
export function fillHeroState(p: HeroSource, afk: boolean, out: HeroState): HeroState {
  out.x = p.pos.x;
  out.y = p.pos.y;
  out.z = p.pos.z;
  out.vx = p.vel.x;
  out.vy = p.vel.y;
  out.vz = p.vel.z;
  out.mode = p.mode;
  out.grounded = p.grounded;
  out.facing = p.facing;
  out.afk = afk;
  return out;
}
