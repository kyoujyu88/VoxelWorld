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
  count: number; // net occupancy: +1 per hit, -1 per carve; drawn once it reaches minObservations
  wSum: number; // sum of observation weights; color is weighted (nearer views count more)
  rSum: number; // sum of color × weight
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
  /** Second dirty set, drained independently by the overhead preview (a separate consumer). */
  private readonly dirtyPreview = new Set<number>();
  /** Integer-cell AABB over stored cells (drives the preview fit; reusable for export bbox). */
  private hasCells = false;
  private minXi = 0;
  private maxXi = 0;
  private minYi = 0;
  private maxYi = 0;
  private minZi = 0;
  private maxZi = 0;
  /** Incremented whenever a cell is skipped because the cap was reached (for reporting). */
  droppedAtCap = 0;

  constructor(options: VoxelGridOptions = {}) {
    this.voxelSize = options.voxelSize ?? 0.02;
    this.maxVoxels = options.maxVoxels ?? 500_000;
  }

  get size(): number {
    return this.cells.size;
  }

  /**
   * Quantize and accumulate a colored world point. Colors are 0..255. `weight` (default 1) lets
   * the caller value nearer, more accurate observations more heavily — the stored color is the
   * weight-weighted mean, so revisiting a cell from close up pulls its color toward the accurate
   * one. The occupancy count is the raw hit count and ignores the weight.
   */
  addPoint(x: number, y: number, z: number, r: number, g: number, b: number, weight = 1): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const w = weight > 0 ? weight : 1;
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
      rec = { count: 0, wSum: 0, rSum: 0, gSum: 0, bSum: 0 };
      this.cells.set(key, rec);
    }
    rec.count++;
    rec.wSum += w;
    rec.rSum += r * w;
    rec.gSum += g * w;
    rec.bSum += b * w;
    if (!this.hasCells) {
      this.hasCells = true;
      this.minXi = this.maxXi = xi;
      this.minYi = this.maxYi = yi;
      this.minZi = this.maxZi = zi;
    } else {
      if (xi < this.minXi) this.minXi = xi;
      else if (xi > this.maxXi) this.maxXi = xi;
      if (yi < this.minYi) this.minYi = yi;
      else if (yi > this.maxYi) this.maxYi = yi;
      if (zi < this.minZi) this.minZi = zi;
      else if (zi > this.maxZi) this.maxZi = zi;
    }
    this.dirty.add(key);
    this.dirtyPreview.add(key);
  }

  clear(): void {
    this.cells.clear();
    this.dirty.clear();
    this.dirtyPreview.clear();
    this.hasCells = false;
    this.droppedAtCap = 0;
  }

  /** Visit every key changed since the last call, then clear the dirty set (no allocation). */
  drainDirty(cb: (key: number) => void): void {
    for (const key of this.dirty) cb(key);
    this.dirty.clear();
  }

  /** Discard the renderer's pending dirty keys without visiting them (used in coarse mode). */
  clearDirty(): void {
    this.dirty.clear();
  }

  /**
   * Record that a carve ray passed through this cell (free-space evidence): drop its occupancy by
   * `strength`, deleting the cell entirely once occupancy reaches zero. Returns whether the cell is
   * still occupied enough to draw (`count >= minObservations`) so the renderer can drop its
   * instance when it isn't. Colour sums are left untouched — a re-hit cell keeps its mean.
   */
  recordMiss(key: number, minObservations: number, strength = 1): boolean {
    const rec = this.cells.get(key);
    if (rec === undefined) return false;
    rec.count -= strength;
    if (rec.count <= 0) {
      this.cells.delete(key);
      return false;
    }
    return rec.count >= minObservations;
  }

  /** Like drainDirty, but for the preview's independent dirty set (a second consumer). */
  drainDirtyPreview(cb: (key: number) => void): void {
    for (const key of this.dirtyPreview) cb(key);
    this.dirtyPreview.clear();
  }

  /**
   * Mark every stored cell dirty for the renderer, so the next incremental applyUpdates re-adds
   * them all. Used to re-seed the base-size (2cm) display after switching the size slider back to
   * 1× (the coarse rebuild had cleared the incremental instance map).
   */
  markAllDirty(): void {
    for (const key of this.cells.keys()) this.dirty.add(key);
  }

  /** World-space AABB (meters, at cell centers) over stored cells, or null if empty. */
  getBounds(): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  } | null {
    if (!this.hasCells) return null;
    const s = this.voxelSize;
    const half = s * 0.5;
    return {
      minX: this.minXi * s + half,
      maxX: this.maxXi * s + half,
      minY: this.minYi * s + half,
      maxY: this.maxYi * s + half,
      minZ: this.minZi * s + half,
      maxZ: this.maxZi * s + half,
    };
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
    out.r = rec.rSum / rec.wSum;
    out.g = rec.gSum / rec.wSum;
    out.b = rec.bSum / rec.wSum;
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
        r: rec.rSum / rec.wSum,
        g: rec.gSum / rec.wSum,
        b: rec.bSum / rec.wSum,
        count: rec.count,
      });
    }
  }

  /**
   * Allocation-free iteration over confident cells, passing world-center + mean color as
   * primitives. Used by the overhead preview, which sweeps every voxel ~10x/second and must
   * not allocate a view object (or an unpackKey object) per cell.
   */
  forEachConfidentPoint(
    minObservations: number,
    cb: (cx: number, cy: number, cz: number, r: number, g: number, b: number) => void,
  ): void {
    const s = this.voxelSize;
    const half = s * 0.5;
    for (const [key, rec] of this.cells) {
      if (rec.count < minObservations) continue;
      // Inline unpackKey to avoid allocating a { xi, yi, zi } object per cell.
      const z = key % BASE;
      const afterZ = (key - z) / BASE;
      const y = afterZ % BASE;
      const x = (afterZ - y) / BASE;
      const inv = 1 / rec.wSum;
      cb(
        (x - OFFSET) * s + half,
        (y - OFFSET) * s + half,
        (z - OFFSET) * s + half,
        rec.rSum * inv,
        rec.gSum * inv,
        rec.bSum * inv,
      );
    }
  }

  /**
   * Aggregate confident 2cm cells into coarser display cells (integer `factor`, so the coarse
   * size is factor×voxelSize) and yield each occupied coarse cell's world-center + mean color.
   * `factor = 1` reproduces the confident cells exactly. This is how the display/export gets
   * re-tessellated at a larger voxel size without re-scanning (Phase 6). Color is the true mean
   * over all observations in the coarse cell (raw sums are combined, then divided). Allocates a
   * temp aggregation map per call, so call it on a slider change / throttle, not every frame.
   */
  forEachDownsampled(
    factor: number,
    minObservations: number,
    cb: (cx: number, cy: number, cz: number, r: number, g: number, b: number) => void,
  ): void {
    const f = Math.max(1, Math.floor(factor));
    if (f === 1) {
      this.forEachConfidentPoint(minObservations, cb);
      return;
    }
    const coarse = new Map<number, VoxelRecord>();
    for (const [key, rec] of this.cells) {
      if (rec.count < minObservations) continue;
      const z = key % BASE;
      const afterZ = (key - z) / BASE;
      const y = afterZ % BASE;
      const x = (afterZ - y) / BASE;
      // Math.floor divides correctly for the negative cell indices too.
      const cxi = Math.floor((x - OFFSET) / f);
      const cyi = Math.floor((y - OFFSET) / f);
      const czi = Math.floor((z - OFFSET) / f);
      const ckey = packKey(cxi, cyi, czi);
      if (ckey === null) continue;
      let c = coarse.get(ckey);
      if (c === undefined) {
        c = { count: 0, wSum: 0, rSum: 0, gSum: 0, bSum: 0 };
        coarse.set(ckey, c);
      }
      c.count += rec.count;
      c.wSum += rec.wSum;
      c.rSum += rec.rSum;
      c.gSum += rec.gSum;
      c.bSum += rec.bSum;
    }
    const coarseSize = f * this.voxelSize;
    const half = coarseSize * 0.5;
    for (const [ckey, c] of coarse) {
      const { xi, yi, zi } = unpackKey(ckey);
      const inv = 1 / c.wSum;
      cb(
        xi * coarseSize + half,
        yi * coarseSize + half,
        zi * coarseSize + half,
        c.rSum * inv,
        c.gSum * inv,
        c.bSum * inv,
      );
    }
  }
}
