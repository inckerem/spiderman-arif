import { tuning } from '../config/tuning';

/**
 * Fixed-timestep loop with an accumulator. Rendering receives the
 * interpolation factor between the previous and current simulation state.
 */
export class FixedLoop {
  readonly dt: number;
  private acc = 0;
  private last = -1;
  private rafId = 0;
  private running = false;
  /** When true (tests), real time does not advance the simulation. */
  manual = false;
  /** Seconds of real time dropped because the frame budget was exceeded. */
  droppedTime = 0;
  lastFrameMs = 0;
  /** CPU time of the last frame's work (ticks and render), unlike the frame interval free of vsync waits. */
  lastWorkMs = 0;
  ticksLastFrame = 0;

  constructor(
    private readonly tick: (dt: number) => void,
    private readonly render: (alpha: number, frameDt: number) => void,
  ) {
    this.dt = 1 / tuning.sim.tickRate;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = -1;
    const frame = (now: number): void => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(frame);
      this.frame(now);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private frame(now: number): void {
    const t0 = performance.now();
    if (this.last < 0) this.last = now;
    let frameDt = (now - this.last) / 1000;
    this.last = now;
    this.lastFrameMs = frameDt * 1000;
    if (frameDt > 0.1) frameDt = 0.1;
    if (frameDt < 0) frameDt = 0;
    let ticks = 0;
    if (!this.manual) {
      this.acc += frameDt;
      const maxTicks = tuning.sim.maxTicksPerFrame;
      while (this.acc >= this.dt) {
        if (ticks >= maxTicks) {
          this.droppedTime += this.acc;
          this.acc = 0;
          break;
        }
        this.tick(this.dt);
        this.acc -= this.dt;
        ticks++;
      }
    }
    this.ticksLastFrame = ticks;
    const alpha = this.manual ? 1 : this.acc / this.dt;
    this.render(alpha, frameDt);
    this.lastWorkMs = performance.now() - t0;
  }

  /** Reset the accumulator (after loading, unpausing) so no burst of ticks runs. */
  resetClock(): void {
    this.acc = 0;
    this.last = -1;
  }
}
