import { describe, it, expect } from 'vitest';
import { depthToRGBA, computeDepthStats } from '../src/render/depthHeatmap';

const RVTM = 0.001; // Pixel 9a: raw values are millimeters

describe('depthToRGBA', () => {
  const opts = { minMeters: 0.3, maxMeters: 5.0, nearBright: true };

  it('produces width*height*4 bytes', () => {
    const out = depthToRGBA([0, 0, 0, 0], 2, 2, RVTM, opts);
    expect(out.length).toBe(2 * 2 * 4);
  });

  it('marks invalid (raw<=0) samples fully transparent', () => {
    const out = depthToRGBA([0], 1, 1, RVTM, opts);
    expect(out[3]).toBe(0);
  });

  it('maps the near plane to white and the far plane to black (nearBright)', () => {
    const near = depthToRGBA([300], 1, 1, RVTM, opts); // 0.3 m
    const far = depthToRGBA([5000], 1, 1, RVTM, opts); // 5.0 m
    expect(near[0]).toBe(255);
    expect(near[3]).toBe(255);
    expect(far[0]).toBe(0);
  });

  it('maps the midpoint to mid-gray', () => {
    const mid = depthToRGBA([2650], 1, 1, RVTM, opts); // 2.65 m => t=0.5
    expect(mid[0]).toBeGreaterThanOrEqual(126);
    expect(mid[0]).toBeLessThanOrEqual(129);
  });

  it('clamps depths beyond the range', () => {
    const tooNear = depthToRGBA([100], 1, 1, RVTM, opts); // 0.1 m < min
    const tooFar = depthToRGBA([10000], 1, 1, RVTM, opts); // 10 m > max
    expect(tooNear[0]).toBe(255);
    expect(tooFar[0]).toBe(0);
  });

  it('inverts brightness when nearBright is false', () => {
    const near = depthToRGBA([300], 1, 1, RVTM, {
      minMeters: 0.3,
      maxMeters: 5.0,
      nearBright: false,
    });
    expect(near[0]).toBe(0);
  });
});

describe('computeDepthStats', () => {
  it('returns nulls when no samples are valid', () => {
    const s = computeDepthStats([0, 0, 0, 0], 2, 2, RVTM);
    expect(s.validCount).toBe(0);
    expect(s.totalCount).toBe(4);
    expect(s.minMeters).toBeNull();
    expect(s.medianMeters).toBeNull();
  });

  it('computes coverage, min, max, and median over valid samples', () => {
    const s = computeDepthStats([0, 1000, 2000, 3000], 2, 2, RVTM);
    expect(s.totalCount).toBe(4);
    expect(s.validCount).toBe(3);
    expect(s.minMeters).toBeCloseTo(1.0, 6);
    expect(s.maxMeters).toBeCloseTo(3.0, 6);
    expect(s.medianMeters).toBeCloseTo(2.0, 6);
  });
});
