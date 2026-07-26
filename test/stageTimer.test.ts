import { describe, it, expect } from 'vitest';
import { StageTimer } from '../src/ui/stageTimer';

/** Deterministic clock: each read advances by the next queued delta. */
function fakeClock(deltas: number[]): () => number {
  let t = 0;
  let i = 0;
  return () => {
    if (i > 0) t += deltas[(i - 1) % deltas.length];
    i++;
    return t;
  };
}

describe('StageTimer', () => {
  it('attributes each interval to the stage that closed it', () => {
    const timer = new StageTimer(fakeClock([2, 5, 3]));
    timer.beginFrame(); // t = 0
    timer.lap('a'); // t = 2  -> a += 2
    timer.lap('b'); // t = 7  -> b += 5
    timer.lap('c'); // t = 10 -> c += 3
    expect(timer.mean('a')).toBeCloseTo(2, 9);
    expect(timer.mean('b')).toBeCloseTo(5, 9);
    expect(timer.mean('c')).toBeCloseTo(3, 9);
  });

  it('averages a stage over the frames in the window', () => {
    const timer = new StageTimer(fakeClock([4]));
    for (let i = 0; i < 3; i++) {
      timer.beginFrame();
      timer.lap('a');
    }
    expect(timer.frameCount).toBe(3);
    expect(timer.mean('a')).toBeCloseTo(4, 9); // 4 ms in each of 3 frames
  });

  it('sums the stages into the measured CPU cost of a frame', () => {
    const timer = new StageTimer(fakeClock([2, 5]));
    timer.beginFrame();
    timer.lap('a');
    timer.lap('b');
    expect(timer.meanTotal()).toBeCloseTo(7, 9);
  });

  it('reports zero for an unrecorded stage rather than NaN', () => {
    const timer = new StageTimer(fakeClock([1]));
    timer.beginFrame();
    timer.lap('a');
    expect(timer.mean('nothing-ran-here')).toBe(0);
  });

  it('reports zero before any frame, so the first HUD paint is not NaN', () => {
    const timer = new StageTimer(fakeClock([1]));
    expect(timer.mean('a')).toBe(0);
    expect(timer.meanTotal()).toBe(0);
  });

  it('starts a fresh window on reset', () => {
    const timer = new StageTimer(fakeClock([9]));
    timer.beginFrame();
    timer.lap('a');
    timer.reset();
    expect(timer.frameCount).toBe(0);
    expect(timer.mean('a')).toBe(0);
  });
});
