import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Matrix4 } from 'three';
import { CarveContext, isFreeSpace } from '../src/xr/carve';
import type { CpuDepthFrame } from '../src/xr/depth';

/** A 2×2 depth frame whose center texel (col 1, row 1) reads `measuredAtCenter` meters. */
function depthFrame(measuredAtCenter: number): CpuDepthFrame {
  const width = 2;
  const height = 2;
  const data = new Float32Array([0, 0, 0, measuredAtCenter]); // index 3 = (col 1, row 1)
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return {
    width,
    height,
    data,
    rawValueToMeters: 1,
    normDepthFromNormViewMatrix: identity,
    metersAt(c: number, r: number): number {
      if (c < 0 || r < 0 || c >= width || r >= height) return 0;
      const raw = data[c + r * width];
      return raw > 0 ? raw : 0;
    },
  };
}

describe('isFreeSpace', () => {
  it('is free only when a valid measurement lies beyond the voxel by more than the margin', () => {
    expect(isFreeSpace(2, 3, 0.08)).toBe(true);
    expect(isFreeSpace(2, 2.05, 0.08)).toBe(false); // within margin (on the surface)
    expect(isFreeSpace(2, 1, 0.08)).toBe(false); // surface in front (occluded)
    expect(isFreeSpace(2, 0, 0.08)).toBe(false); // no measurement
  });
});

describe('CarveContext', () => {
  const cam = new PerspectiveCamera(60, 1, 0.1, 100);
  cam.updateProjectionMatrix();
  const proj = cam.projectionMatrix.toArray();
  const identityView = new Matrix4().identity().toArray(); // eye space == world space

  const opts = { flipY: true, margin: 0.08, minDepth: 0.2 };

  it('carves a voxel floating in front of a farther surface', () => {
    const ctx = new CarveContext();
    ctx.update(proj, identityView, depthFrame(3), opts);
    // Voxel straight ahead at 2 m; surface measured at 3 m -> free space, carve.
    expect(ctx.testFree(0, 0, -2)).toBe(true);
  });

  it('keeps a voxel sitting on the measured surface', () => {
    const ctx = new CarveContext();
    ctx.update(proj, identityView, depthFrame(2), opts);
    expect(ctx.testFree(0, 0, -2)).toBe(false);
  });

  it('keeps a voxel behind the measured surface (occluded)', () => {
    const ctx = new CarveContext();
    ctx.update(proj, identityView, depthFrame(1), opts);
    expect(ctx.testFree(0, 0, -2)).toBe(false);
  });

  it('keeps a voxel behind the camera', () => {
    const ctx = new CarveContext();
    ctx.update(proj, identityView, depthFrame(3), opts);
    expect(ctx.testFree(0, 0, 2)).toBe(false); // +Z is behind (camera looks down -Z)
  });
});
