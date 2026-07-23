/**
 * Sparse voxel grid.
 *
 * The internal representation is a fixed fine grid (default 2 cm). World points are
 * floor-quantized to integer cell coordinates and stored in a hash map keyed by a packed
 * integer. Each cell accumulates an observation count and running color sums so the mean
 * color and confidence can be recovered on read.
 *
 * Display / export downsampling (integer multiples of the base size) is a separate concern
 * built on top of this grid in later phases — accumulation itself stays at the fine size so
 * past data never becomes invalid.
 */

// Packing: each axis is offset into [0, BASE) and combined into one integer.
// BASE = 2^17 gives a ±65536-cell range (±1310 m at 2 cm). BASE^3 ≈ 2.25e15 < 2^53, so the
// key stays an exact JS number.
const BITS = 17;
const BASE = 1 << BITS; // 131072
const OFFSET = BASE >> 1; // 65536

/** Pack integer cell coords into a single exact-integer key, or null if out of range. */
export function packKey(xi: number, yi: number, zi: number): number | null {
  const x = xi + OFFSET;
  const y = yi + OFFSET;
  const z = zi + OFFSET;
  if (x < 0 || x >= BASE || y < 0 || y >= BASE || z < 0 || z >= BASE) return null;
  return (x * BASE + y) * BASE + z;
}

export function unpackKey(key: number): { xi: number; yi: number; zi: number } {
  const z = key % BASE;
  const afterZ = (key - z) / BASE;
  const y = afterZ % BASE;
  const x = (afterZ - y) / BASE;
  return { xi: x - OFFSET, yi: y - OFFSET, zi: z - OFFSET };
}

export interface VoxelRecord {
  count: number;
  rSum: number;
  gSum: number;
  bSum: number;
}

export interface VoxelGridOptions {
  /** Base cell size in meters (default 0.02). */
  voxelSize?: number;
  /** Hard cap on the number of distinct occupied cells (memory guard). */
  maxVoxels?: number;
}

export interface VoxelView {
  /** World-space cell center (meters). */
  cx: number;
  cy: number;
  cz: number;
  r: number; // mean color 0..255
  g: number;
  b: number;
  count: number;
}

export class VoxelGrid {
  readonly voxelSize: number;
  readonly maxVoxels: number;
  private readonly cells = new Map<number, VoxelRecord>();
  /** Keys touched since the last drainDirty() — lets the renderer update incrementally. */
  private readonly dirty = new Set<number>();
  /** Incremented whenever a cell is skipped because the cap was reached (for reporting). */
  droppedAtCap = 0;

  constructor(options: VoxelGridOptions = {}) {
    this.voxelSize = options.voxelSize ?? 0.02;
    this.maxVoxels = options.maxVoxels ?? 500_000;
  }

  get size(): number {
    return this.cells.size;
  }

  /** Quantize and accumulate a colored world point. Colors are 0..255. */
  addPoint(x: number, y: number, z: number, r: number, g: number, b: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const xi = Math.floor(x / this.voxelSize);
    const yi = Math.floor(y / this.voxelSize);
    const zi = Math.floor(z / this.voxelSize);
    const key = packKey(xi, yi, zi);
    if (key === null) return;

    let rec = this.cells.get(key);
    if (rec === undefined) {
      if (this.cells.size >= this.maxVoxels) {
        this.droppedAtCap++;
        return;
      }
      rec = { count: 0, rSum: 0, gSum: 0, bSum: 0 };
      this.cells.set(key, rec);
    }
    rec.count++;
    rec.rSum += r;
    rec.gSum += g;
    rec.bSum += b;
    this.dirty.add(key);
  }

  clear(): void {
    this.cells.clear();
    this.dirty.clear();
    this.droppedAtCap = 0;
  }

  /** Visit every key changed since the last call, then clear the dirty set (no allocation). */
  drainDirty(cb: (key: number) => void): void {
    for (const key of this.dirty) cb(key);
    this.dirty.clear();
  }

  /** Fill `out` with a cell's world-center + mean color + count. Returns false if absent. */
  readVoxel(key: number, out: VoxelView): boolean {
    const rec = this.cells.get(key);
    if (rec === undefined) return false;
    const { xi, yi, zi } = unpackKey(key);
    const half = this.voxelSize * 0.5;
    out.cx = xi * this.voxelSize + half;
    out.cy = yi * this.voxelSize + half;
    out.cz = zi * this.voxelSize + half;
    out.r = rec.rSum / rec.count;
    out.g = rec.gSum / rec.count;
    out.b = rec.bSum / rec.count;
    out.count = rec.count;
    return true;
  }

  /** Number of cells observed at least `minObservations` times. */
  countConfident(minObservations: number): number {
    let n = 0;
    for (const rec of this.cells.values()) {
      if (rec.count >= minObservations) n++;
    }
    return n;
  }

  /** Iterate confident cells, yielding world-center + mean color. */
  forEach(minObservations: number, cb: (v: VoxelView) => void): void {
    const half = this.voxelSize * 0.5;
    for (const [key, rec] of this.cells) {
      if (rec.count < minObservations) continue;
      const { xi, yi, zi } = unpackKey(key);
      cb({
        cx: xi * this.voxelSize + half,
        cy: yi * this.voxelSize + half,
        cz: zi * this.voxelSize + half,
        r: rec.rSum / rec.count,
        g: rec.gSum / rec.count,
        b: rec.bSum / rec.count,
        count: rec.count,
      });
    }
  }
}
