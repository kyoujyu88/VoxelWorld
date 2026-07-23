import { describe, it, expect } from 'vitest';
import { VoxelGrid, packKey, unpackKey, type VoxelView } from '../src/voxel/grid';

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

describe('VoxelGrid', () => {
  it('quantizes points into one 2cm cell and averages color', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.addPoint(0.001, 0.001, 0.001, 300, 0, 0);
    g.addPoint(0.01, 0.019, 0.005, 0, 300, 0);
    g.addPoint(0.019, 0.0, 0.019, 0, 0, 300);
    expect(g.size).toBe(1);

    const views: VoxelView[] = [];
    g.forEach(1, (v) => views.push(v));
    expect(views).toHaveLength(1);
    expect(views[0].count).toBe(3);
    expect(views[0].r).toBeCloseTo(100, 6);
    expect(views[0].g).toBeCloseTo(100, 6);
    expect(views[0].b).toBeCloseTo(100, 6);
    expect(views[0].cx).toBeCloseTo(0.01, 6); // cell (0,0,0) center
    expect(views[0].cy).toBeCloseTo(0.01, 6);
    expect(views[0].cz).toBeCloseTo(0.01, 6);
  });

  it('separates points that fall in different cells', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.addPoint(0.0, 0, 0, 1, 1, 1);
    g.addPoint(0.05, 0, 0, 1, 1, 1); // x cell 2
    expect(g.size).toBe(2);
  });

  it('filters by minObservations', () => {
    const g = new VoxelGrid();
    g.addPoint(0, 0, 0, 10, 10, 10); // count 1
    g.addPoint(1, 1, 1, 20, 20, 20);
    g.addPoint(1, 1, 1, 20, 20, 20); // count 2
    expect(g.countConfident(2)).toBe(1);
    const seen: VoxelView[] = [];
    g.forEach(2, (v) => seen.push(v));
    expect(seen).toHaveLength(1);
  });

  it('respects maxVoxels but still accumulates into existing cells', () => {
    const g = new VoxelGrid({ voxelSize: 0.02, maxVoxels: 2 });
    g.addPoint(0, 0, 0, 1, 1, 1);
    g.addPoint(1, 0, 0, 1, 1, 1);
    g.addPoint(2, 0, 0, 1, 1, 1); // 3rd distinct cell -> dropped
    expect(g.size).toBe(2);
    expect(g.droppedAtCap).toBe(1);
    g.addPoint(0.001, 0, 0, 1, 1, 1); // existing cell (0,0,0)
    expect(g.size).toBe(2);
  });

  it('ignores non-finite points', () => {
    const g = new VoxelGrid();
    g.addPoint(NaN, 0, 0, 1, 1, 1);
    g.addPoint(0, Infinity, 0, 1, 1, 1);
    expect(g.size).toBe(0);
  });

  it('clears all cells', () => {
    const g = new VoxelGrid();
    g.addPoint(0, 0, 0, 1, 1, 1);
    g.clear();
    expect(g.size).toBe(0);
  });
});

describe('VoxelGrid dirty tracking + readVoxel', () => {
  const emptyView = (): VoxelView => ({ cx: 0, cy: 0, cz: 0, r: 0, g: 0, b: 0, count: 0 });

  it('drainDirty yields each touched cell once, then clears', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.addPoint(0, 0, 0, 1, 1, 1);
    g.addPoint(0.001, 0, 0, 1, 1, 1); // same cell
    g.addPoint(0.05, 0, 0, 1, 1, 1); // different cell
    const first: number[] = [];
    g.drainDirty((k) => first.push(k));
    expect(first).toHaveLength(2);
    const second: number[] = [];
    g.drainDirty((k) => second.push(k));
    expect(second).toHaveLength(0);
  });

  it('readVoxel fills world-center + mean color + count', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.addPoint(0.001, 0.001, 0.001, 300, 0, 0);
    g.addPoint(0.01, 0.01, 0.01, 0, 0, 0); // same cell (0,0,0)
    let key = -1;
    g.drainDirty((k) => {
      key = k;
    });
    const out = emptyView();
    expect(g.readVoxel(key, out)).toBe(true);
    expect(out.count).toBe(2);
    expect(out.r).toBeCloseTo(150, 6);
    expect(out.cx).toBeCloseTo(0.01, 6);
  });

  it('readVoxel returns false for an absent key', () => {
    const g = new VoxelGrid();
    expect(g.readVoxel(123456, emptyView())).toBe(false);
  });

  it('clear() empties the dirty set', () => {
    const g = new VoxelGrid();
    g.addPoint(0, 0, 0, 1, 1, 1);
    g.clear();
    const keys: number[] = [];
    g.drainDirty((k) => keys.push(k));
    expect(keys).toHaveLength(0);
  });
});

describe('VoxelGrid.forEachConfidentPoint', () => {
  it('yields only confident cells with world-center + mean color as primitives', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    // Cell (0,0,0): two observations -> confident at minObs 2, mean color (150,0,0).
    g.addPoint(0.001, 0.001, 0.001, 300, 0, 0);
    g.addPoint(0.01, 0.01, 0.01, 0, 0, 0);
    // Cell (2,0,0): one observation -> below threshold.
    g.addPoint(0.05, 0, 0, 9, 9, 9);

    const seen: Array<[number, number, number, number, number, number]> = [];
    g.forEachConfidentPoint(2, (cx, cy, cz, r, gg, b) => seen.push([cx, cy, cz, r, gg, b]));

    expect(seen).toHaveLength(1);
    const [cx, cy, cz, r, gg, b] = seen[0];
    expect(cx).toBeCloseTo(0.01, 6); // cell (0,0,0) center
    expect(cy).toBeCloseTo(0.01, 6);
    expect(cz).toBeCloseTo(0.01, 6);
    expect(r).toBeCloseTo(150, 6);
    expect(gg).toBeCloseTo(0, 6);
    expect(b).toBeCloseTo(0, 6);
  });

  it('yields nothing for an empty grid', () => {
    const g = new VoxelGrid();
    let n = 0;
    g.forEachConfidentPoint(1, () => n++);
    expect(n).toBe(0);
  });
});

describe('VoxelGrid bounds + preview dirty set', () => {
  it('getBounds is null when empty and resets on clear()', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    expect(g.getBounds()).toBeNull();
    g.addPoint(0, 0, 0, 1, 1, 1);
    expect(g.getBounds()).not.toBeNull();
    g.clear();
    expect(g.getBounds()).toBeNull();
  });

  it('getBounds spans the world-center AABB of stored cells', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.addPoint(0.001, 0.001, 0.001, 1, 1, 1); // cell (0,0,0) -> center 0.01
    g.addPoint(0.05, 0.09, 0.05, 1, 1, 1); // cell (2,4,2) -> center (0.05,0.09,0.05)
    const b = g.getBounds();
    expect(b).not.toBeNull();
    expect((b as NonNullable<typeof b>).minX).toBeCloseTo(0.01, 6);
    expect((b as NonNullable<typeof b>).maxX).toBeCloseTo(0.05, 6);
    expect((b as NonNullable<typeof b>).minY).toBeCloseTo(0.01, 6);
    expect((b as NonNullable<typeof b>).maxY).toBeCloseTo(0.09, 6);
    expect((b as NonNullable<typeof b>).minZ).toBeCloseTo(0.01, 6);
    expect((b as NonNullable<typeof b>).maxZ).toBeCloseTo(0.05, 6);
  });

  it('drainDirtyPreview is independent of drainDirty and clears after draining', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.addPoint(0, 0, 0, 1, 1, 1);
    g.addPoint(0.05, 0, 0, 1, 1, 1);
    // Draining the renderer's dirty set must not empty the preview's set.
    g.drainDirty(() => {});
    const previewKeys: number[] = [];
    g.drainDirtyPreview((k) => previewKeys.push(k));
    expect(previewKeys).toHaveLength(2);
    // Second drain is empty.
    const again: number[] = [];
    g.drainDirtyPreview((k) => again.push(k));
    expect(again).toHaveLength(0);
  });
});

describe('VoxelGrid.forEachDownsampled', () => {
  it('factor 1 reproduces the confident cells', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.addPoint(0, 0, 0, 10, 20, 30);
    g.addPoint(0, 0, 0, 10, 20, 30);
    g.addPoint(0.05, 0, 0, 40, 50, 60);
    g.addPoint(0.05, 0, 0, 40, 50, 60);
    const confident: number[] = [];
    g.forEachConfidentPoint(2, (cx) => confident.push(cx));
    const down: number[] = [];
    g.forEachDownsampled(1, 2, (cx) => down.push(cx));
    expect(down.length).toBe(confident.length);
    expect(down.length).toBe(2);
  });

  it('factor 2 merges a 2×2×2 block and means the color over all observations', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    // Internal cell (0,0,0): two obs of red (200,0,0).
    g.addPoint(0.001, 0.001, 0.001, 200, 0, 0);
    g.addPoint(0.001, 0.001, 0.001, 200, 0, 0);
    // Internal cell (1,0,0): two obs of black — same coarse cell at factor 2.
    g.addPoint(0.03, 0.001, 0.001, 0, 0, 0);
    g.addPoint(0.03, 0.001, 0.001, 0, 0, 0);

    const out: Array<[number, number, number, number, number, number]> = [];
    g.forEachDownsampled(2, 2, (cx, cy, cz, r, gg, b) => out.push([cx, cy, cz, r, gg, b]));
    expect(out).toHaveLength(1);
    const [cx, cy, cz, r, gg, b] = out[0];
    // Coarse cell (0,0,0), size 0.04 -> center 0.02.
    expect(cx).toBeCloseTo(0.02, 6);
    expect(cy).toBeCloseTo(0.02, 6);
    expect(cz).toBeCloseTo(0.02, 6);
    // rSum = 200*2 + 0*2 = 400 over count 4 -> 100.
    expect(r).toBeCloseTo(100, 6);
    expect(gg).toBeCloseTo(0, 6);
    expect(b).toBeCloseTo(0, 6);
  });

  it('factor 2 keeps cells in different coarse blocks separate', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.addPoint(0.001, 0, 0, 1, 1, 1);
    g.addPoint(0.001, 0, 0, 1, 1, 1); // internal (0,0,0) -> coarse (0,0,0)
    g.addPoint(0.05, 0, 0, 1, 1, 1);
    g.addPoint(0.05, 0, 0, 1, 1, 1); // internal (2,0,0) -> coarse (1,0,0)
    let n = 0;
    g.forEachDownsampled(2, 2, () => n++);
    expect(n).toBe(2);
  });
});

describe('VoxelGrid proximity-weighted color', () => {
  it('blends color by observation weight but counts raw hits', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    // Same cell: a red observation at weight 1, then a black one at weight 3 (nearer view).
    g.addPoint(0.001, 0.001, 0.001, 255, 0, 0, 1);
    g.addPoint(0.001, 0.001, 0.001, 0, 0, 0, 3);
    let key = -1;
    g.drainDirty((k) => {
      key = k;
    });
    const out: VoxelView = { cx: 0, cy: 0, cz: 0, r: 0, g: 0, b: 0, count: 0 };
    expect(g.readVoxel(key, out)).toBe(true);
    // Weighted mean: (255*1 + 0*3) / (1+3) = 63.75. Occupancy count is raw hits (2), not weighted.
    expect(out.r).toBeCloseTo(63.75, 6);
    expect(out.count).toBe(2);
  });

  it('default weight 1 reproduces the plain mean', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.addPoint(0.001, 0.001, 0.001, 300, 0, 0);
    g.addPoint(0.001, 0.001, 0.001, 0, 0, 0);
    let key = -1;
    g.drainDirty((k) => {
      key = k;
    });
    const out: VoxelView = { cx: 0, cy: 0, cz: 0, r: 0, g: 0, b: 0, count: 0 };
    g.readVoxel(key, out);
    expect(out.r).toBeCloseTo(150, 6);
  });
});

describe('VoxelGrid.recordMiss (free-space carving)', () => {
  const keyOf = (g: VoxelGrid): number => {
    let key = -1;
    g.drainDirty((k) => {
      key = k;
    });
    return key;
  };

  it('lowers occupancy and reports when it falls below the threshold', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    for (let i = 0; i < 5; i++) g.addPoint(0, 0, 0, 1, 1, 1); // count 5
    const key = keyOf(g);
    expect(g.recordMiss(key, 3)).toBe(true); // 5 -> 4
    expect(g.recordMiss(key, 3)).toBe(true); // 4 -> 3
    expect(g.recordMiss(key, 3)).toBe(false); // 3 -> 2, below minObs
    expect(g.size).toBe(1); // cell still present
  });

  it('deletes the cell once occupancy reaches zero', () => {
    const g = new VoxelGrid({ voxelSize: 0.02 });
    g.addPoint(0, 0, 0, 1, 1, 1);
    g.addPoint(0, 0, 0, 1, 1, 1); // count 2
    const key = keyOf(g);
    expect(g.recordMiss(key, 3)).toBe(false); // 2 -> 1
    expect(g.recordMiss(key, 3)).toBe(false); // 1 -> 0 -> deleted
    expect(g.size).toBe(0);
    expect(g.recordMiss(key, 3)).toBe(false); // already gone, no throw
  });
});
