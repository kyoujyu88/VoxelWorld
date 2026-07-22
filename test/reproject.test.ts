import { describe, it, expect } from 'vitest';
import { PerspectiveCamera } from 'three';
import { reprojectDepthFrame } from '../src/xr/reproject';
import type { CpuDepthFrame } from '../src/xr/depth';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function makeDepth(width: number, height: number, raw: number[], rvtm = 0.001): CpuDepthFrame {
  return {
    width,
    height,
    data: raw as unknown as Uint16Array,
    rawValueToMeters: rvtm,
    normDepthFromNormViewMatrix: IDENTITY,
    metersAt: () => 0,
  };
}

function projection(): Float32Array {
  const cam = new PerspectiveCamera(60, 1, 0.1, 100);
  cam.updateProjectionMatrix();
  return new Float32Array(cam.projectionMatrix.toArray());
}

describe('reprojectDepthFrame', () => {
  it('maps the center texel to (0, 0, -d) with identity view', () => {
    const W = 3;
    const H = 3;
    const raw = new Array(W * H).fill(0);
    raw[1 + 1 * W] = 2000; // center, 2.0 m
    const pts: Array<[number, number, number]> = [];
    const n = reprojectDepthFrame(
      makeDepth(W, H, raw),
      projection(),
      IDENTITY,
      { minMeters: 0.1, maxMeters: 10, stride: 1, flipY: true },
      (x, y, z) => pts.push([x, y, z]),
    );
    expect(n).toBe(1);
    expect(pts[0][0]).toBeCloseTo(0, 5);
    expect(pts[0][1]).toBeCloseTo(0, 5);
    expect(pts[0][2]).toBeCloseTo(-2, 5);
  });

  it('places a right-column texel at +x, keeping perpendicular depth', () => {
    const W = 3;
    const H = 3;
    const raw = new Array(W * H).fill(0);
    raw[2 + 1 * W] = 2000; // right column, middle row
    const pts: Array<[number, number, number]> = [];
    reprojectDepthFrame(
      makeDepth(W, H, raw),
      projection(),
      IDENTITY,
      { minMeters: 0.1, maxMeters: 10, flipY: true },
      (x, y, z) => pts.push([x, y, z]),
    );
    expect(pts).toHaveLength(1);
    expect(pts[0][0]).toBeGreaterThan(0);
    expect(pts[0][2]).toBeCloseTo(-2, 5); // eye-space Z stays the perpendicular depth
  });

  it('flipY inverts the reconstructed Y sign for a top-row texel', () => {
    const W = 3;
    const H = 3;
    const raw = new Array(W * H).fill(0);
    raw[1 + 0 * W] = 2000; // top row, middle column
    const up: Array<[number, number, number]> = [];
    const down: Array<[number, number, number]> = [];
    reprojectDepthFrame(
      makeDepth(W, H, raw),
      projection(),
      IDENTITY,
      { minMeters: 0.1, maxMeters: 10, flipY: true },
      (x, y, z) => up.push([x, y, z]),
    );
    reprojectDepthFrame(
      makeDepth(W, H, raw),
      projection(),
      IDENTITY,
      { minMeters: 0.1, maxMeters: 10, flipY: false },
      (x, y, z) => down.push([x, y, z]),
    );
    expect(up[0][1]).not.toBeCloseTo(0, 3);
    expect(Math.sign(up[0][1])).toBe(-Math.sign(down[0][1]));
  });

  it('skips missing (0) and out-of-range samples', () => {
    const W = 2;
    const H = 2;
    const raw = [0, 50, 20000, 3000]; // missing, 0.05 m, 20 m, 3 m
    const pts: Array<[number, number, number]> = [];
    const n = reprojectDepthFrame(
      makeDepth(W, H, raw),
      projection(),
      IDENTITY,
      { minMeters: 0.3, maxMeters: 5, stride: 1, flipY: true },
      (x, y, z) => pts.push([x, y, z]),
    );
    expect(n).toBe(1);
  });
});
