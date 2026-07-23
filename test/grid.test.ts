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
