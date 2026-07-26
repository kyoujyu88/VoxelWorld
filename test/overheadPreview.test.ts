import { describe, it, expect } from 'vitest';
import {
  computeFit,
  worldToPixel,
  niceBarMeters,
  blendToBackground,
} from '../src/render/overheadPreview';

describe('computeFit', () => {
  it('fills a square box into a square canvas and centers it', () => {
    const f = computeFit({ minX: 0, maxX: 2, minZ: 0, maxZ: 2 }, 100, 100, 10);
    expect(f.scale).toBeCloseTo(40, 6); // (100-20)/2
    expect(f.cxWorld).toBeCloseTo(1, 6);
    expect(f.czWorld).toBeCloseTo(1, 6);
    expect(f.cxPix).toBe(50);
    expect(f.cyPix).toBe(50);
  });

  it('limits scale by the wide axis and centers the narrow one', () => {
    const f = computeFit({ minX: 0, maxX: 4, minZ: 0, maxZ: 1 }, 100, 100, 10);
    expect(f.scale).toBeCloseTo(20, 6); // min(80/4, 80/1) = 20
  });

  it('uses minSpan instead of dividing by zero for a single column', () => {
    const f = computeFit({ minX: 1, maxX: 1, minZ: 1, maxZ: 1 }, 100, 100, 10, 0.1);
    expect(Number.isFinite(f.scale)).toBe(true);
    expect(f.scale).toBeCloseTo(800, 6); // 80 / 0.1
  });
});

describe('worldToPixel', () => {
  const fit = computeFit({ minX: 0, maxX: 2, minZ: 0, maxZ: 2 }, 100, 100, 10);

  it('puts the data midpoint at the canvas center', () => {
    expect(worldToPixel(fit, 1, 1)).toEqual({ px: 50, py: 50 });
  });

  it('maps +X right and +Z down (so -Z reads as up)', () => {
    expect(worldToPixel(fit, 0, 0)).toEqual({ px: 10, py: 10 }); // minX left, minZ top
    expect(worldToPixel(fit, 2, 2)).toEqual({ px: 90, py: 90 }); // maxX right, maxZ bottom
    expect(worldToPixel(fit, 2, 0)).toEqual({ px: 90, py: 10 }); // top-right
  });

  it('keeps a lone voxel centered', () => {
    const f = computeFit({ minX: 1, maxX: 1, minZ: 1, maxZ: 1 }, 100, 100, 10, 0.1);
    expect(worldToPixel(f, 1, 1)).toEqual({ px: 50, py: 50 });
  });
});

describe('niceBarMeters', () => {
  it('picks the largest candidate that fits', () => {
    expect(niceBarMeters(40, 30)).toBe(0.5); // 0.5*40=20<=30, 1*40=40>30
    expect(niceBarMeters(20, 30)).toBe(1); // 1*20=20<=30, 2*20=40>30
  });

  it('falls back to the smallest candidate when nothing fits', () => {
    expect(niceBarMeters(1000, 30)).toBe(0.25);
  });
});

describe('blendToBackground', () => {
  it('returns the color untouched at full alpha', () => {
    expect(blendToBackground(200, 18, 1)).toBeCloseTo(200, 9);
  });

  it('returns the background at zero alpha', () => {
    expect(blendToBackground(200, 18, 0)).toBeCloseTo(18, 9);
  });

  it('lands between the two, nearer the background when faint', () => {
    const v = blendToBackground(200, 18, 0.35);
    expect(v).toBeGreaterThan(18);
    expect(v).toBeLessThan(200);
    expect(v).toBeCloseTo(200 * 0.35 + 18 * 0.65, 9);
  });

  it('keeps a dark voxel darker than the background from washing out', () => {
    // Blending is symmetric: it moves toward the background from either side.
    expect(blendToBackground(0, 18, 0.35)).toBeCloseTo(18 * 0.65, 9);
  });
});
