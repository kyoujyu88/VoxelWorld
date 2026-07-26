import { describe, it, expect } from 'vitest';
import { VoxelGrid, packKey, type VoxelView } from '../src/voxel/grid';
import { fuseDepthSample } from '../src/voxel/fuse';

const view = (): VoxelView => ({
  cx: 0,
  cy: 0,
  cz: 0,
  r: 0,
  g: 0,
  b: 0,
  weight: 0,
  sdf: 0,
  confirmed: false,
});

/** Read the cell containing a world point. */
function cellAt(g: VoxelGrid, x: number, y: number, z: number): VoxelView | null {
  const key = packKey(
    Math.floor(x / g.voxelSize),
    Math.floor(y / g.voxelSize),
    Math.floor(z / g.voxelSize),
  );
  if (key === null) return null;
  const out = view();
  return g.readVoxel(key, out) ? out : null;
}

// Camera at the origin looking down -Z; the surface is measured 1 m away.
const CAM = { x: 0, y: 0, z: 0 };
const HIT = { x: 0, y: 0, z: -1 };

describe('fuseDepthSample', () => {
  it('writes a band of cells along the ray, not a single one', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, truncation: 0.04 });
    const touched = fuseDepthSample(g, CAM.x, CAM.y, CAM.z, HIT.x, HIT.y, HIT.z, 1, 1, 0, 0, 0);
    expect(touched).toBeGreaterThan(1);
    expect(g.size).toBeGreaterThan(1);
  });

  it('puts the zero crossing at the measured surface', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, truncation: 0.04 });
    fuseDepthSample(g, CAM.x, CAM.y, CAM.z, HIT.x, HIT.y, HIT.z, 1, 1, 0, 0, 0);
    const at = cellAt(g, HIT.x, HIT.y, HIT.z);
    expect(at).not.toBeNull();
    // Within half a voxel of the surface — this is what makes the shell one cell thick.
    expect(Math.abs((at as VoxelView).sdf)).toBeLessThan(g.voxelSize * 0.5);
  });

  it('marks the space between camera and surface as free (positive distance)', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, truncation: 0.04 });
    fuseDepthSample(g, CAM.x, CAM.y, CAM.z, HIT.x, HIT.y, HIT.z, 1, 1, 0, 0, 0);
    const inFront = cellAt(g, 0, 0, -0.965); // 3.5cm toward the camera
    expect(inFront).not.toBeNull();
    expect((inFront as VoxelView).sdf).toBeGreaterThan(0);
  });

  it('marks space behind the surface as inside (negative distance)', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, truncation: 0.04 });
    fuseDepthSample(g, CAM.x, CAM.y, CAM.z, HIT.x, HIT.y, HIT.z, 1, 1, 0, 0, 0);
    const behind = cellAt(g, 0, 0, -1.015); // just past the surface, inside the back band
    expect(behind).not.toBeNull();
    expect((behind as VoxelView).sdf).toBeLessThan(0);
  });

  it('averages two straddling measurements onto the true surface (sub-voxel)', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, truncation: 0.06 });
    // The same wall measured 1cm short and 1cm long — noise either side of the truth at z = -1.
    fuseDepthSample(g, CAM.x, CAM.y, CAM.z, 0, 0, -0.99, 0.99, 1, 0, 0, 0);
    fuseDepthSample(g, CAM.x, CAM.y, CAM.z, 0, 0, -1.01, 1.01, 1, 0, 0, 0);

    const at = cellAt(g, 0, 0, -1) as VoxelView;
    expect(at).not.toBeNull();
    // The recovered surface is where the distance field crosses zero, which need not sit on a cell
    // center — that is the whole point: depth = (cell depth) + sdf resolves it below voxel size.
    const impliedSurfaceDepth = -at.cz + at.sdf;
    expect(impliedSurfaceDepth).toBeCloseTo(1.0, 3);
  });

  it('lets a high-weight near measurement outvote a low-weight far one', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, truncation: 0.06, maxWeight: 100 });
    // A far, low-confidence reading that is 3cm too short...
    fuseDepthSample(g, CAM.x, CAM.y, CAM.z, 0, 0, -0.97, 0.97, 1, 0, 0, 0);
    // ...then a close, confident one at the true surface.
    fuseDepthSample(g, CAM.x, CAM.y, CAM.z, 0, 0, -1.0, 1.0, 16, 0, 0, 0);
    const at = cellAt(g, 0, 0, -1);
    expect(at).not.toBeNull();
    expect(Math.abs((at as VoxelView).sdf)).toBeLessThan(g.voxelSize * 0.5);
  });

  it('colors only the cells near the surface, not the whole band', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, truncation: 0.06 });
    fuseDepthSample(g, CAM.x, CAM.y, CAM.z, HIT.x, HIT.y, HIT.z, 1, 1, 250, 250, 250);

    // Inspect every cell the sample touched.
    const keys: number[] = [];
    g.drainDirty((k) => keys.push(k));
    const out = view();
    let colored = 0;
    for (const key of keys) {
      g.readVoxel(key, out);
      if (out.r > 0) colored++;
    }
    expect(colored).toBeGreaterThan(0);
    expect(colored).toBeLessThan(keys.length); // the free/inside band stays uncolored
    expect((cellAt(g, 0, 0, -1) as VoxelView).r).toBeGreaterThan(100); // the surface is colored
  });

  it('ignores degenerate input', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    expect(fuseDepthSample(g, 0, 0, 0, 0, 0, -1, 0, 1, 0, 0, 0)).toBe(0); // depth 0
    expect(fuseDepthSample(g, 0, 0, 0, 0, 0, -1, 1, 0, 0, 0, 0)).toBe(0); // weight 0
    expect(fuseDepthSample(g, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0)).toBe(0); // zero-length ray
    expect(g.size).toBe(0);
  });
});

describe('fuseDepthSample confidence', () => {
  /** Confirmation reachable only by distance, so `confirmed` reads out bestDepth directly. */
  const distanceOnly = (confirmDist: number): VoxelGrid =>
    new VoxelGrid({
      voxelSize: 0.02,
      truncation: 0.04,
      confirmWeight: 0.001,
      confirmDist,
      confirmDirs: 99,
    });

  it('records the measurement distance itself, not a multiple of it', () => {
    // The band writes ~4 cells per measurement. If those calls accumulated instead of taking a
    // min, the stored distance would be some multiple of 1 m and both bounds below would fail.
    const near = distanceOnly(1.05);
    fuseDepthSample(near, CAM.x, CAM.y, CAM.z, HIT.x, HIT.y, HIT.z, 1, 1, 0, 0, 0);
    expect(cellAt(near, HIT.x, HIT.y, HIT.z)?.confirmed).toBe(true); // 1.0 m <= 1.05

    const far = distanceOnly(0.95);
    fuseDepthSample(far, CAM.x, CAM.y, CAM.z, HIT.x, HIT.y, HIT.z, 1, 1, 0, 0, 0);
    expect(cellAt(far, HIT.x, HIT.y, HIT.z)?.confirmed).toBe(false); // 1.0 m > 0.95
  });

  /** Confirmation reachable only by direction diversity, so `confirmed` reads out dirMask. */
  const directionsOnly = (confirmDirs: number): VoxelGrid =>
    new VoxelGrid({
      voxelSize: 0.02,
      truncation: 0.04,
      confirmWeight: 0.001,
      confirmDist: 0.0001,
      confirmDirs,
    });

  it('counts one measurement as one direction, whatever its band touched', () => {
    const g = directionsOnly(2);
    fuseDepthSample(g, CAM.x, CAM.y, CAM.z, HIT.x, HIT.y, HIT.z, 1, 1, 0, 0, 0);
    expect(cellAt(g, HIT.x, HIT.y, HIT.z)?.confirmed).toBe(false);
  });

  it('confirms once the same cell is measured from a second direction', () => {
    const g = directionsOnly(2);
    fuseDepthSample(g, CAM.x, CAM.y, CAM.z, HIT.x, HIT.y, HIT.z, 1, 1, 0, 0, 0);
    // Same surface point, camera moved 90 degrees around it (still 1 m away).
    fuseDepthSample(g, 1, 0, -1, HIT.x, HIT.y, HIT.z, 1, 1, 0, 0, 0);
    expect(cellAt(g, HIT.x, HIT.y, HIT.z)?.confirmed).toBe(true);
  });
});
