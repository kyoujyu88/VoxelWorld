import { describe, it, expect } from 'vitest';
import { PerspectiveCamera } from 'three';
import {
  reprojectDepthFrame,
  slantTangent,
  isDepthEdge,
  qualityFromSlant,
  type ReprojectStats,
} from '../src/xr/reproject';
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

describe('slantTangent', () => {
  // 1 texel of stride spans 1 cm sideways at d = 1 m with lateral = 0.01.
  const LAT = 0.01;

  it('is zero for a head-on surface (equal neighbour depths)', () => {
    expect(slantTangent(1, 1, 1, LAT, LAT, 1, 0)).toBeCloseTo(0, 9);
  });

  it('is 1 when the depth step equals the sideways run (45 degrees)', () => {
    // run = 1 m * 0.01 * 1 = 1 cm, so a 1 cm depth step is a 45-degree slant.
    expect(slantTangent(1, 1.01, 0, LAT, LAT, 1, 0)).toBeCloseTo(1, 6);
  });

  it('scales with stride: the same step over a longer run is a gentler slant', () => {
    const one = slantTangent(1, 1.01, 0, LAT, LAT, 1, 0);
    const three = slantTangent(1, 1.01, 0, LAT, LAT, 3, 0);
    expect(three).toBeCloseTo(one / 3, 6);
  });

  it('combines the two axes in quadrature', () => {
    const both = slantTangent(1, 1.01, 1.01, LAT, LAT, 1, 0);
    expect(both).toBeCloseTo(Math.SQRT2, 6);
  });

  it('treats a 0 (unknown) neighbour as no information, not as an edge', () => {
    expect(slantTangent(1, 0, 0, LAT, LAT, 1, 0)).toBe(0);
    // Only the known axis contributes.
    expect(slantTangent(1, 1.01, 0, LAT, LAT, 1, 0)).toBeCloseTo(1, 6);
  });

  it('ignores depth steps within the noise deadband', () => {
    // 3 mm of jitter on a head-on surface must not read as slant.
    expect(slantTangent(1, 1.003, 0, LAT, LAT, 1, 0.005)).toBe(0);
    // Beyond the deadband only the excess counts.
    expect(slantTangent(1, 1.01, 0, LAT, LAT, 1, 0.005)).toBeCloseTo(0.5, 6);
  });

  it('returns 0 for degenerate depth', () => {
    expect(slantTangent(0, 1, 1, LAT, LAT, 1, 0)).toBe(0);
  });
});

describe('isDepthEdge / qualityFromSlant', () => {
  it('flags only slants past the threshold', () => {
    expect(isDepthEdge(3, 8)).toBe(false);
    expect(isDepthEdge(20, 8)).toBe(true);
  });

  it('is cos(angle): 1 head-on and decreasing with slant', () => {
    expect(qualityFromSlant(0)).toBeCloseTo(1, 9);
    expect(qualityFromSlant(1)).toBeCloseTo(Math.SQRT1_2, 6); // 45 degrees
    expect(qualityFromSlant(2)).toBeLessThan(qualityFromSlant(1));
  });

  it('never falls below the floor, so a steep real surface is slow not discarded', () => {
    expect(qualityFromSlant(1000, 0.1)).toBeCloseTo(0.1, 9);
  });
});

describe('reprojectDepthFrame depth-quality filtering', () => {
  it('drops the texels that straddle a depth discontinuity, keeping the flat parts', () => {
    // A frame split down the middle: near wall at 1 m, far wall at 3 m. Only the column on the
    // near side of the split sees the 2 m jump; everything else is flat. Resolution matters here
    // — the test is meaningless on a 3x3 buffer where one texel already spans ~20 degrees.
    const W = 16;
    const H = 16;
    const raw: number[] = [];
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) raw.push(c < W / 2 ? 1000 : 3000);
    }
    const stats: ReprojectStats = { emitted: 0, rejectedEdge: 0 };
    reprojectDepthFrame(
      makeDepth(W, H, raw),
      projection(),
      IDENTITY,
      { minMeters: 0.1, maxMeters: 10, stride: 1, flipY: true },
      () => {},
      stats,
    );
    // Exactly the last near column (one per row) straddles the step.
    expect(stats.rejectedEdge).toBe(H);
    expect(stats.emitted).toBe(W * H - H);
  });

  it('keeps every sample and reports full quality on a flat head-on wall', () => {
    const W = 4;
    const H = 4;
    const raw = new Array(W * H).fill(2000); // uniform 2 m
    const qualities: number[] = [];
    const stats: ReprojectStats = { emitted: 0, rejectedEdge: 0 };
    reprojectDepthFrame(
      makeDepth(W, H, raw),
      projection(),
      IDENTITY,
      { minMeters: 0.1, maxMeters: 10, stride: 1, flipY: true },
      (_x, _y, _z, _u, _v, _d, q) => qualities.push(q),
      stats,
    );
    expect(stats.rejectedEdge).toBe(0);
    expect(qualities).toHaveLength(W * H);
    for (const q of qualities) expect(q).toBeCloseTo(1, 6);
  });

  it('down-weights a slanted surface without rejecting it', () => {
    // Depth ramps gently across the frame: a real surface seen at an angle.
    const W = 4;
    const H = 4;
    const raw: number[] = [];
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) raw.push(2000 + c * 40); // +4 cm per texel
    }
    const qualities: number[] = [];
    const stats: ReprojectStats = { emitted: 0, rejectedEdge: 0 };
    reprojectDepthFrame(
      makeDepth(W, H, raw),
      projection(),
      IDENTITY,
      { minMeters: 0.1, maxMeters: 10, stride: 1, flipY: true },
      (_x, _y, _z, _u, _v, _d, q) => qualities.push(q),
      stats,
    );
    expect(stats.rejectedEdge).toBe(0);
    const slanted = qualities.filter((q) => q < 1);
    expect(slanted.length).toBeGreaterThan(0);
    for (const q of slanted) expect(q).toBeGreaterThan(0.1);
  });
});
