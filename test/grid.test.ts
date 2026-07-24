import { describe, it, expect } from 'vitest';
import { VoxelGrid, packKey, unpackKey, type VoxelView } from '../src/voxel/grid';

const view = (): VoxelView => ({ cx: 0, cy: 0, cz: 0, r: 0, g: 0, b: 0, weight: 0, sdf: 0 });

/** Drain the renderer dirty set and return the single key that was touched. */
const soleKey = (g: VoxelGrid): number => {
  const keys: number[] = [];
  g.drainDirty((k) => keys.push(k));
  return keys[0];
};

describe('packKey / unpackKey', () => {
  it('round-trips positive, negative, and zero coordinates', () => {
    const cases: Array<[number, number, number]> = [
      [0, 0, 0],
      [1, -2, 3],
      [-100, 200, -300],
      [65535, -65536, 12345],
    ];
    for (const [x, y, z] of cases) {
      const key = packKey(x, y, z);
      expect(key).not.toBeNull();
      expect(unpackKey(key as number)).toEqual({ xi: x, yi: y, zi: z });
    }
  });

  it('returns null out of range', () => {
    expect(packKey(70000, 0, 0)).toBeNull();
    expect(packKey(0, -70000, 0)).toBeNull();
  });

  it('gives distinct keys to distinct coordinates', () => {
    expect(packKey(1, 2, 3)).not.toBe(packKey(3, 2, 1));
  });
});

describe('VoxelGrid.integrate', () => {
  it('quantizes to a cell and records the signed distance and weight', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.integrate(0.001, 0.001, 0.001, 0, 1, 10, 20, 30, 1);
    expect(g.size).toBe(1);

    const out = view();
    expect(g.readVoxel(soleKey(g), out)).toBe(true);
    expect(out.cx).toBeCloseTo(0.01, 6); // cell (0,0,0) center
    expect(out.cy).toBeCloseTo(0.01, 6);
    expect(out.cz).toBeCloseTo(0.01, 6);
    expect(out.sdf).toBeCloseTo(0, 6);
    expect(out.weight).toBeCloseTo(1, 6);
    expect(out.r).toBeCloseTo(10, 6);
  });

  it('truncates the signed distance to ±truncation', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, truncation: 0.05 });
    g.integrate(0, 0, 0, 10, 1); // absurdly far in front
    const out = view();
    g.readVoxel(soleKey(g), out);
    expect(out.sdf).toBeCloseTo(0.05, 6);
  });

  it('converges the surface between measurements that straddle it (sub-voxel averaging)', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, truncation: 0.06 });
    // Same cell measured as 1cm in front and 1cm behind the surface: the truth is halfway.
    g.integrate(0, 0, 0, 0.01, 1);
    g.integrate(0, 0, 0, -0.01, 1);
    const out = view();
    g.readVoxel(soleKey(g), out);
    expect(out.sdf).toBeCloseTo(0, 6);
    expect(out.weight).toBeCloseTo(2, 6);
  });

  it('weights measurements, so a confident one dominates a weak one', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, truncation: 0.06 });
    g.integrate(0, 0, 0, 0.04, 1); // weak, far-off reading
    g.integrate(0, 0, 0, 0.0, 9); // confident close reading
    const out = view();
    g.readVoxel(soleKey(g), out);
    expect(out.sdf).toBeCloseTo(0.004, 6); // (0.04*1 + 0*9) / 10
  });

  it('caps accumulated weight so the map can still heal', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, maxWeight: 5 });
    for (let i = 0; i < 100; i++) g.integrate(0, 0, 0, 0, 1);
    const out = view();
    g.readVoxel(soleKey(g), out);
    expect(out.weight).toBe(5);
  });

  it('ignores non-finite input and non-positive weight', () => {
    const g = new VoxelGrid();
    g.integrate(NaN, 0, 0, 0, 1);
    g.integrate(0, Infinity, 0, 0, 1);
    g.integrate(0, 0, 0, NaN, 1);
    g.integrate(0, 0, 0, 0, 0);
    expect(g.size).toBe(0);
  });
});

describe('VoxelGrid surface extraction', () => {
  it('counts only cells near the zero crossing that are well enough observed', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, truncation: 0.06, surfaceBand: 0.015 });
    g.integrate(0, 0, 0, 0, 5); // on the surface, well observed
    g.integrate(0.1, 0, 0, 0.05, 5); // clearly in free space
    g.integrate(0.2, 0, 0, 0, 1); // on the surface but barely observed
    expect(g.size).toBe(3);
    expect(g.countSurface(3)).toBe(1);
    let n = 0;
    g.forEachSurfacePoint(3, () => n++);
    expect(n).toBe(1);
  });

  it('drops a cell out of the surface as free-space evidence accumulates', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, truncation: 0.06, surfaceBand: 0.015 });
    g.integrate(0, 0, 0, 0, 4);
    const key = soleKey(g);
    expect(g.countSurface(3)).toBe(1);

    // Seeing through the cell repeatedly pushes its distance toward +truncation.
    expect(g.integrateFree(key, 4, 3)).toBe(false); // (0*4 + 0.06*4)/8 = 0.03 > band
    expect(g.countSurface(3)).toBe(0);
    expect(g.size).toBe(1); // still remembered as "empty here"
  });

  it('deletes a cell entirely once it is fully empty', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, truncation: 0.06 });
    g.integrate(0, 0, 0, 0, 1);
    const key = soleKey(g);
    for (let i = 0; i < 50; i++) g.integrateFree(key, 5, 3);
    expect(g.size).toBe(0);
  });
});

describe('VoxelGrid color fusion', () => {
  it('keeps a weighted running mean and caps the color weight', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, maxWeight: 100 });
    g.integrate(0, 0, 0, 0, 1, 255, 0, 0, 1);
    g.integrate(0, 0, 0, 0, 3, 0, 0, 0, 3); // 3x more confident, black
    const out = view();
    g.readVoxel(soleKey(g), out);
    expect(out.r).toBeCloseTo(63.75, 6); // (255*1 + 0*3) / 4
  });

  it('leaves color untouched when colorWeight is 0 (samples away from the surface)', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.integrate(0, 0, 0, 0, 1, 200, 200, 200, 1);
    g.integrate(0, 0, 0, 0.03, 1, 0, 0, 0, 0); // geometry only
    const out = view();
    g.readVoxel(soleKey(g), out);
    expect(out.r).toBeCloseTo(200, 6);
  });
});

describe('VoxelGrid dirty tracking', () => {
  it('drainDirty yields each touched cell once, then clears', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.integrate(0, 0, 0, 0, 1);
    g.integrate(0.001, 0, 0, 0, 1); // same cell
    g.integrate(0.05, 0, 0, 0, 1); // different cell
    const first: number[] = [];
    g.drainDirty((k) => first.push(k));
    expect(first).toHaveLength(2);
    const second: number[] = [];
    g.drainDirty((k) => second.push(k));
    expect(second).toHaveLength(0);
  });

  it('drainDirtyPreview is independent of drainDirty', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.integrate(0, 0, 0, 0, 1);
    g.integrate(0.05, 0, 0, 0, 1);
    g.drainDirty(() => {});
    const previewKeys: number[] = [];
    g.drainDirtyPreview((k) => previewKeys.push(k));
    expect(previewKeys).toHaveLength(2);
  });

  it('markAllDirty re-offers every stored cell', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.integrate(0, 0, 0, 0, 1);
    g.integrate(0.05, 0, 0, 0, 1);
    g.drainDirty(() => {});
    g.markAllDirty();
    const keys: number[] = [];
    g.drainDirty((k) => keys.push(k));
    expect(keys).toHaveLength(2);
  });

  it('clear() empties cells and both dirty sets', () => {
    const g = new VoxelGrid();
    g.integrate(0, 0, 0, 0, 1);
    g.clear();
    expect(g.size).toBe(0);
    const keys: number[] = [];
    g.drainDirty((k) => keys.push(k));
    g.drainDirtyPreview((k) => keys.push(k));
    expect(keys).toHaveLength(0);
  });
});

describe('VoxelGrid capacity + bounds', () => {
  it('respects maxVoxels but still fuses into existing cells', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, maxVoxels: 2 });
    g.integrate(0, 0, 0, 0, 1);
    g.integrate(1, 0, 0, 0, 1);
    g.integrate(2, 0, 0, 0, 1); // 3rd distinct cell -> dropped
    expect(g.size).toBe(2);
    expect(g.droppedAtCap).toBe(1);
    g.integrate(0.001, 0, 0, 0, 1); // existing cell still updates
    expect(g.size).toBe(2);
  });

  it('getBounds is null when empty and spans the stored cell centers', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    expect(g.getBounds()).toBeNull();
    g.integrate(0.001, 0.001, 0.001, 0, 1); // cell (0,0,0) -> center 0.01
    g.integrate(0.05, 0.09, 0.05, 0, 1); // cell (2,4,2) -> center (0.05,0.09,0.05)
    const b = g.getBounds();
    expect(b).not.toBeNull();
    const bb = b as NonNullable<typeof b>;
    expect(bb.minX).toBeCloseTo(0.01, 6);
    expect(bb.maxX).toBeCloseTo(0.05, 6);
    expect(bb.maxY).toBeCloseTo(0.09, 6);
    g.clear();
    expect(g.getBounds()).toBeNull();
  });
});

describe('VoxelGrid.forEachDownsampled', () => {
  it('factor 1 reproduces the surface cells', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.integrate(0, 0, 0, 0, 5, 10, 20, 30, 5);
    g.integrate(0.05, 0, 0, 0, 5, 10, 20, 30, 5);
    const down: number[] = [];
    g.forEachDownsampled(1, 3, (cx) => down.push(cx));
    expect(down).toHaveLength(2);
  });

  it('factor 2 merges a 2x2x2 block and weight-means the color', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    // Internal cells (0,0,0) and (1,0,0) share coarse cell (0,0,0) at factor 2.
    g.integrate(0.001, 0.001, 0.001, 0, 3, 200, 0, 0, 3);
    g.integrate(0.03, 0.001, 0.001, 0, 1, 0, 0, 0, 1);

    const out: Array<[number, number, number, number]> = [];
    g.forEachDownsampled(2, 1, (cx, cy, cz, r) => out.push([cx, cy, cz, r]));
    expect(out).toHaveLength(1);
    const [cx, cy, cz, r] = out[0];
    expect(cx).toBeCloseTo(0.02, 6); // coarse cell (0,0,0), size 0.04 -> center 0.02
    expect(cy).toBeCloseTo(0.02, 6);
    expect(cz).toBeCloseTo(0.02, 6);
    expect(r).toBeCloseTo(150, 6); // (200*3 + 0*1) / 4
  });

  it('factor 2 keeps cells in different coarse blocks separate', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.integrate(0.001, 0, 0, 0, 3); // internal (0,0,0) -> coarse (0,0,0)
    g.integrate(0.05, 0, 0, 0, 3); // internal (2,0,0) -> coarse (1,0,0)
    let n = 0;
    g.forEachDownsampled(2, 1, () => n++);
    expect(n).toBe(2);
  });

  it('excludes cells that are not on the surface', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, truncation: 0.06, surfaceBand: 0.015 });
    g.integrate(0, 0, 0, 0, 3); // surface
    g.integrate(0.03, 0, 0, 0.05, 3); // free space, same coarse cell at factor 4
    let n = 0;
    g.forEachDownsampled(4, 1, () => n++);
    expect(n).toBe(1);
  });
});
