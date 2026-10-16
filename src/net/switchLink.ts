/**
 * The game's combat link: single player's `LocalCombatLink` or, while in an
 * online room, a `NetLink`. Everything that holds a link (the hero's combat
 * router, the game loop) holds this one, so switching modes swaps one target.
 */
import type { CombatIntent, HeroState } from '../combat/types';
import type { CombatView } from '../combat/client/combatView';
import type { CombatLink } from '../combat/client/link';

export class SwitchLink implements CombatLink {
  target: CombatLink;

  constructor(readonly local: CombatLink) {
    this.target = local;
  }

  get mode(): 'local' | 'online' {
    return this.target.mode;
  }

  get selfPid(): number {
    return this.target.selfPid;
  }

  get view(): CombatView {
    return this.target.view;
  }

  get online(): boolean {
    return this.target !== this.local;
  }

  now(): number {
    return this.target.now();
  }

  renderTime(): number {
    return this.target.renderTime();
  }

  tick(dt: number, self: HeroState): void {
    this.target.tick(dt, self);
  }

  intent(i: CombatIntent): void {
    this.target.intent(i);
  }

  setPaused(paused: boolean): void {
    this.target.setPaused(paused);
  }

  close(): void {
    this.target.close();
  }
}
