/**
 * Per-stage frame timing for the HUD.
 *
 * FPS alone says the frame is slow but not which part of it is; with fusion, incremental drawing,
 * carving and the preview all running in one animation loop, that leaves too many candidates to
 * fix by guesswork. Recording each stage separately and reporting the mean over the stats window
 * turns "it feels slow" into a number per stage, and — just as usefully — shows when the CPU
 * stages sum to far less than the frame period, which means the cost is on the GPU instead.
 *
 * The clock is injectable so the accounting is testable without a real one.
 */
export class StageTimer {
  private readonly totals = new Map<string, number>();
  private readonly now: () => number;
  private frames = 0;
  private mark = 0;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** Open a new frame; the first `lap` measures from here. */
  beginFrame(): void {
    this.frames++;
    this.mark = this.now();
  }

  /** Close the running stage, attribute the elapsed time to `stage`, and start the next. */
  lap(stage: string): void {
    const t = this.now();
    this.totals.set(stage, (this.totals.get(stage) ?? 0) + (t - this.mark));
    this.mark = t;
  }

  /** Frames recorded since the last reset. */
  get frameCount(): number {
    return this.frames;
  }

  /** Mean ms per frame spent in `stage` over the window (0 before any frame). */
  mean(stage: string): number {
    if (this.frames === 0) return 0;
    return (this.totals.get(stage) ?? 0) / this.frames;
  }

  /** Mean ms per frame across every recorded stage — the measured CPU cost of a frame. */
  meanTotal(): number {
    if (this.frames === 0) return 0;
    let sum = 0;
    for (const v of this.totals.values()) sum += v;
    return sum / this.frames;
  }

  reset(): void {
    this.totals.clear();
    this.frames = 0;
  }
}
