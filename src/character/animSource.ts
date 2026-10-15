import type { Vector3 } from 'three';
import type { CollisionWorld } from '../physics/collision';
import type { CombatAnim } from '../player/player';

/**
 * What the character animator reads from the hero it poses. `Player`
 * satisfies it structurally; in M12 a remote hero implements it with fields
 * filled from replicated state, so the same animator poses other players.
 * Events (`land`, `release`, `attach`, ...) reach the animator separately
 * through `onEvent`.
 */
export interface AnimSource {
  /** Player mode (`MODE_*`). */
  readonly mode: number;
  readonly vel: Vector3;
  /** Body yaw (camera convention: forward = (-sin, -cos)). */
  readonly facing: number;
  readonly diving: boolean;
  /** Feet on a support (a combat stance plants its feet only then). */
  readonly grounded: boolean;
  /** Seconds left in a landing roll. */
  readonly rollTimer: number;
  /** Surface under the feet (footstep sounds). */
  readonly groundSurface: number;
  /** Collision world for foot planting and limb collision. */
  readonly world: CollisionWorld;
  /** Clock of `combatAnim.t0` (the player's sim time; a remote hero's render time). */
  readonly time: number;
  readonly rope: { readonly attached: boolean; readonly hand: number; readonly anchor: { readonly x: number; readonly y: number; readonly z: number } };
  readonly zip: { readonly tx: number; readonly ty: number; readonly tz: number; readonly ex: number; readonly ey: number; readonly ez: number; readonly hand: number };
  readonly wall: { readonly nx: number; readonly nz: number; readonly run: number };
  readonly trav: { readonly kind: number; readonly t: number; readonly dur: number };
  /** Combat overlay: action (`CA`), start time, length, side. */
  readonly combatAnim: Readonly<CombatAnim>;
  /** Support height under (x, z) searching down from y, or -Infinity. */
  groundBelow(x: number, y: number, z: number): number;
}
