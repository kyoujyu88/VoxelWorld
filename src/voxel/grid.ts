/**
 * Sparse TSDF (truncated signed distance) voxel grid.
 *
 * The internal representation is a fixed fine grid (default 2 cm). Rather than counting how often
 * a cell was hit, each cell stores the *weighted average signed distance to the nearest surface* —
 * the representation KinectFusion introduced and Open3D / voxblox still use. This is what makes an
 * accurate scanner accurate:
 *
 *  - **Sub-voxel accuracy.** The surface is the zero crossing of the distance field, so averaging
 *    many noisy measurements converges on the true surface position instead of scattering them
 *    into a thick shell of separate occupied cells.
 *  - **Noise cancels instead of accumulating.** Measurements that fall slightly in front and
 *    slightly behind average out, rather than each carving out its own cell.
 *  - **Free space is intrinsic.** A cell in front of the measured surface gets a positive
 *    distance; keep observing through it and its average is pushed out of the surface band, so
 *    floating voxels dissolve without a separate erase pass.
 *  - **Distance-aware by construction.** Observation weight falls off as 1/z² (voxblox's
 *    recommendation — depth error grows steeply with range) and the accumulated weight is capped,
 *    so a well-scanned surface is barely moved by a later distant glimpse. This replaces the ad-hoc
 *    "quality lock" with the standard mechanism.
 *
 * Distances are truncated to ±`truncation` around the surface, so a cell only ever holds a local
 * statement about the nearest surface. Display / export downsampling (integer multiples of the
 * base size) stays a separate concern layered on top.
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
  /** Weighted-average signed distance to the surface (m). >0 in front (free), <0 behind. */
  sdf: number;
  /** Accumulated observation weight, capped at maxWeight. */
  w: number;
  r: number; // running mean color 0..255
  g: number;
  b: number;
  /** Accumulated color weight, capped at maxWeight. */
  cw: number;
  /**
   * The closest this cell has ever been observed from (m); Infinity until seen. Weight alone can't
   * distinguish "stared at from across the room for 10 seconds" from "walked right up to" — but
   * depth error grows steeply with range, so it is proximity, not repetition, that makes a cell
   * trustworthy.
   */
  bestDepth: number;
  /** Bitmask of the horizontal sectors this cell has been observed from (see `azimuthBit`). */
  dirMask: number;
}

const DIR_SECTORS = 8;
const TWO_PI = Math.PI * 2;

/**
 * Bit for the horizontal sector a view ray arrived from — the second half of "how well do we know
 * this cell". A surface seen from several directions has been checked against itself, which a
 * single lucky angle never is. Returns 0 (no information) for a purely vertical ray, which ORs in
 * harmlessly.
 *
 * `dx`/`dz` are the horizontal components of camera→cell; only the azimuth matters, so the vector
 * needs no normalizing.
 */
export function azimuthBit(dx: number, dz: number): number {
  if (dx === 0 && dz === 0) return 0;
  const a = Math.atan2(dz, dx) + Math.PI; // [0, 2π]
  return 1 << (Math.floor((a / TWO_PI) * DIR_SECTORS) & (DIR_SECTORS - 1));
}

/** Number of set bits in the low byte — how many distinct directions a cell has been seen from. */
export function popcount8(mask: number): number {
  let m = mask & 0xff;
  m = m - ((m >> 1) & 0x55);
  m = (m & 0x33) + ((m >> 2) & 0x33);
  return (m + (m >> 4)) & 0x0f;
}

export interface VoxelGridOptions {
  /** Base cell size in meters (default 0.02). */
  voxelSize?: number;
  /** Hard cap on the number of distinct stored cells (memory guard). */
  maxVoxels?: number;
  /**
   * Distance (m) at which the signed distance is truncated, i.e. the half-width of the band
   * around a surface that a single measurement updates. Default 3x the voxel size — the usual
   * choice; too small and the average has no room to converge, too large and thin structures
   * interfere with each other.
   */
  truncation?: number;
  /**
   * Ceiling on accumulated weight (default 20). Caps how certain a cell can get, so later
   * observations still nudge it (the map can heal) while a well-scanned surface is barely moved
   * by a single low-weight one. This is what stops distant glimpses from degrading a close scan.
   */
  maxWeight?: number;
  /**
   * How close to the zero crossing a cell must be to count as surface (default 0.75x voxel size).
   * Larger renders a thicker shell; smaller can leave pinholes on steep surfaces.
   */
  surfaceBand?: number;
  /** Accumulated weight a cell needs before it can be confirmed (default 8). */
  confirmWeight?: number;
  /** Distance (m) a single look confirms from (default 1.0). Tunable at runtime. */
  confirmDist?: number;
  /** Distinct horizontal sectors that confirm a cell seen only from farther away (default 3). */
  confirmDirs?: number;
  /** How much farther than a cell's best look an observation may be and still change it (default 2). */
  lockRatio?: number;
}

export interface VoxelView {
  /** World-space cell center (meters). */
  cx: number;
  cy: number;
  cz: number;
  r: number; // mean color 0..255
  g: number;
  b: number;
  /** Accumulated observation weight — how well established this cell is. */
  weight: number;
  /** Weighted-average signed distance to the surface (m). */
  sdf: number;
  /** Whether this cell has been observed well enough to be locked in (see `isConfirmed`). */
  confirmed: boolean;
}

export class VoxelGrid {
  readonly voxelSize: number;
  readonly maxVoxels: number;
  readonly truncation: number;
  readonly maxWeight: number;
  readonly surfaceBand: number;
  readonly confirmWeight: number;
  readonly confirmDirs: number;
  readonly lockRatio: number;
  /** Mutable so the on-device slider can re-classify an existing scan without re-scanning it. */
  confirmDist: number;
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
    this.truncation = options.truncation ?? this.voxelSize * 3;
    this.maxWeight = options.maxWeight ?? 20;
    this.surfaceBand = options.surfaceBand ?? this.voxelSize * 0.75;
    this.confirmWeight = options.confirmWeight ?? 8;
    this.confirmDist = options.confirmDist ?? 1.0;
    this.confirmDirs = options.confirmDirs ?? 3;
    this.lockRatio = options.lockRatio ?? 2;
  }

  /** Total stored cells (surface *and* the free/occluded band around it). */
  get size(): number {
    return this.cells.size;
  }

  /** True if this cell currently sits on the surface (zero crossing) and is well enough observed. */
  isSurface(rec: VoxelRecord, minWeight: number): boolean {
    return rec.w >= minWeight && rec.sdf <= this.surfaceBand && rec.sdf >= -this.surfaceBand;
  }

  /**
   * True once a cell has been observed well enough to be trusted and locked in.
   *
   * Enough weight, *and* either a close look or looks from several directions. The two are an OR,
   * not an AND, on purpose: a flat wall can only ever be seen from one side, so requiring direction
   * diversity would mean walls never confirm. Conversely an object you have circled is well pinned
   * even if you never got close to it.
   */
  isConfirmed(rec: VoxelRecord): boolean {
    return (
      rec.w >= this.confirmWeight &&
      (rec.bestDepth <= this.confirmDist || popcount8(rec.dirMask) >= this.confirmDirs)
    );
  }

  /**
   * Whether an observation from `obsDepth` metres away is too poor to be allowed to touch this
   * cell. A confirmed cell only yields to a look of comparable quality — no farther than
   * `lockRatio` times its own best. That is what stops a distant glimpse from degrading, or the
   * carve pass from erasing, something you already walked up to and scanned properly; getting
   * close again always restores the ability to correct it.
   */
  private isLocked(rec: VoxelRecord, obsDepth: number): boolean {
    return obsDepth > rec.bestDepth * this.lockRatio && this.isConfirmed(rec);
  }

  /**
   * Fuse one measurement into the cell containing (x, y, z).
   *
   * `sdf` is the signed distance from this point to the measured surface along the view ray
   * (positive in front of it / toward the camera, negative behind); it is truncated internally.
   * `weight` is the measurement's confidence — callers should use ~1/z². Color is optional: pass
   * `colorWeight > 0` only near the surface, where a color sample actually belongs to it.
   *
   * `obsDepth` is how far away the measurement was taken and `dirBit` which direction it came from
   * (see `azimuthBit`); together they build the cell's confidence. Both fold in idempotently — min
   * and OR — so the several calls one measurement makes along its truncation band cannot inflate
   * either. They default to "no information", which leaves the pure-fusion behaviour unchanged.
   */
  integrate(
    x: number,
    y: number,
    z: number,
    sdf: number,
    weight: number,
    r = 0,
    g = 0,
    b = 0,
    colorWeight = 0,
    obsDepth = Infinity,
    dirBit = 0,
  ): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if (!Number.isFinite(sdf) || !(weight > 0)) return;
    const xi = Math.floor(x / this.voxelSize);
    const yi = Math.floor(y / this.voxelSize);
    const zi = Math.floor(z / this.voxelSize);
    const key = packKey(xi, yi, zi);
    if (key === null) return;

    const t = this.truncation;
    const clamped = sdf > t ? t : sdf < -t ? -t : sdf;

    let rec = this.cells.get(key);
    if (rec === undefined) {
      if (this.cells.size >= this.maxVoxels) {
        this.droppedAtCap++;
        return;
      }
      // Colour starts empty and is only ever set through the colorWeight path below, so a
      // geometry-only sample (one taken away from the surface) never tints a cell.
      rec = {
        sdf: clamped,
        w: Math.min(weight, this.maxWeight),
        r: 0,
        g: 0,
        b: 0,
        cw: 0,
        bestDepth: obsDepth,
        dirMask: dirBit,
      };
      this.cells.set(key, rec);
      this.growBounds(xi, yi, zi);
    } else {
      if (this.isLocked(rec, obsDepth)) return; // too distant a look to touch a confirmed cell
      // Weighted running average of the distance, with the weight capped (KinectFusion).
      const wNew = rec.w + weight;
      rec.sdf = (rec.sdf * rec.w + clamped * weight) / wNew;
      rec.w = wNew > this.maxWeight ? this.maxWeight : wNew;
      if (obsDepth < rec.bestDepth) rec.bestDepth = obsDepth;
      rec.dirMask |= dirBit;
    }

    if (colorWeight > 0) {
      const cwNew = rec.cw + colorWeight;
      rec.r = (rec.r * rec.cw + r * colorWeight) / cwNew;
      rec.g = (rec.g * rec.cw + g * colorWeight) / cwNew;
      rec.b = (rec.b * rec.cw + b * colorWeight) / cwNew;
      rec.cw = cwNew > this.maxWeight ? this.maxWeight : cwNew;
    }

    // Only a cell on the zero crossing can be drawn or painted, and both consumers discard the
    // rest the moment they read them. The band a measurement writes is wider than the surface
    // band, so filtering here drops most of the traffic — and with it most of the work the
    // incremental draw and the overhead preview do walking their dirty sets.
    if (rec.sdf <= this.surfaceBand && rec.sdf >= -this.surfaceBand) {
      this.dirty.add(key);
      this.dirtyPreview.add(key);
    }
  }

  /**
   * Fuse "this cell is empty" evidence into an existing cell (a ray passed through it). Pushes the
   * average distance toward +truncation; once it leaves the surface band the cell stops being
   * drawn, and a cell that is both empty and unobserved is dropped entirely to free memory.
   * Returns whether the cell still counts as surface, so a renderer can drop its instance.
   *
   * `obsDepth` is how far the carving view is from the cell. Erasure is where a distant view does
   * the most damage — it deletes outright rather than nudging an average — so a confirmed cell is
   * protected from it by the same rule that protects it from fusion.
   */
  integrateFree(key: number, weight: number, minWeight: number, obsDepth = Infinity): boolean {
    const rec = this.cells.get(key);
    if (rec === undefined) return false;
    if (this.isLocked(rec, obsDepth)) return this.isSurface(rec, minWeight); // keep it as it stands
    const wNew = rec.w + weight;
    rec.sdf = (rec.sdf * rec.w + this.truncation * weight) / wNew;
    rec.w = wNew > this.maxWeight ? this.maxWeight : wNew;
    this.dirtyPreview.add(key);
    if (rec.sdf >= this.truncation * 0.99) {
      this.cells.delete(key); // fully empty: nothing left to remember
      return false;
    }
    return this.isSurface(rec, minWeight);
  }

  private growBounds(xi: number, yi: number, zi: number): void {
    if (!this.hasCells) {
      this.hasCells = true;
      this.minXi = this.maxXi = xi;
      this.minYi = this.maxYi = yi;
      this.minZi = this.maxZi = zi;
      return;
    }
    if (xi < this.minXi) this.minXi = xi;
    else if (xi > this.maxXi) this.maxXi = xi;
    if (yi < this.minYi) this.minYi = yi;
    else if (yi > this.maxYi) this.maxYi = yi;
    if (zi < this.minZi) this.minZi = zi;
    else if (zi > this.maxZi) this.maxZi = zi;
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

  /** Like drainDirty, but for the preview's independent dirty set (a second consumer). */
  drainDirtyPreview(cb: (key: number) => void): void {
    for (const key of this.dirtyPreview) cb(key);
    this.dirtyPreview.clear();
  }

  /**
   * Mark every stored cell dirty for the renderer, so the next incremental update re-examines them
   * all. Used after a display-setting change that alters which cells qualify as surface.
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

  /** Fill `out` with a cell's world-center, mean color, weight and distance. False if absent. */
  readVoxel(key: number, out: VoxelView): boolean {
    const rec = this.cells.get(key);
    if (rec === undefined) return false;
    // Inline unpackKey rather than call it: this runs tens of thousands of times per frame (the
    // carve walk alone is 16k), and returning a { xi, yi, zi } object each time made it one of the
    // biggest sources of garbage in the loop.
    const z = key % BASE;
    const afterZ = (key - z) / BASE;
    const y = afterZ % BASE;
    const x = (afterZ - y) / BASE;
    const half = this.voxelSize * 0.5;
    out.cx = (x - OFFSET) * this.voxelSize + half;
    out.cy = (y - OFFSET) * this.voxelSize + half;
    out.cz = (z - OFFSET) * this.voxelSize + half;
    out.r = rec.r;
    out.g = rec.g;
    out.b = rec.b;
    out.weight = rec.w;
    out.sdf = rec.sdf;
    out.confirmed = this.isConfirmed(rec);
    return true;
  }

  /** Number of cells currently on the surface at the given weight threshold. */
  countSurface(minWeight: number): number {
    let n = 0;
    for (const rec of this.cells.values()) {
      if (this.isSurface(rec, minWeight)) n++;
    }
    return n;
  }

  /**
   * Allocation-free iteration over surface cells, passing world-center + mean color as primitives.
   * Used by the overhead preview, which sweeps the grid and must not allocate per cell.
   */
  forEachSurfacePoint(
    minWeight: number,
    cb: (
      cx: number,
      cy: number,
      cz: number,
      r: number,
      g: number,
      b: number,
      confirmed: boolean,
    ) => void,
  ): void {
    const s = this.voxelSize;
    const half = s * 0.5;
    for (const [key, rec] of this.cells) {
      if (!this.isSurface(rec, minWeight)) continue;
      // Inline unpackKey to avoid allocating a { xi, yi, zi } object per cell.
      const z = key % BASE;
      const afterZ = (key - z) / BASE;
      const y = afterZ % BASE;
      const x = (afterZ - y) / BASE;
      cb(
        (x - OFFSET) * s + half,
        (y - OFFSET) * s + half,
        (z - OFFSET) * s + half,
        rec.r,
        rec.g,
        rec.b,
        this.isConfirmed(rec),
      );
    }
  }

  /**
   * Aggregate surface cells into coarser display cells (integer `factor`, so the coarse size is
   * factor×voxelSize) and yield each occupied coarse cell's world-center + weight-mean color.
   * `factor = 1` reproduces the surface cells exactly. This is how the display/export gets
   * re-tessellated at a larger voxel size without re-scanning. Allocates a temp map per call, so
   * call it on a slider change / throttle, not every frame.
   */
  forEachDownsampled(
    factor: number,
    minWeight: number,
    cb: (
      cx: number,
      cy: number,
      cz: number,
      r: number,
      g: number,
      b: number,
      confirmed: boolean,
    ) => void,
  ): void {
    const f = Math.max(1, Math.floor(factor));
    if (f === 1) {
      this.forEachSurfacePoint(minWeight, cb);
      return;
    }
    const coarse = new Map<
      number,
      { w: number; r: number; g: number; b: number; confirmed: boolean }
    >();
    for (const [key, rec] of this.cells) {
      if (!this.isSurface(rec, minWeight)) continue;
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
        c = { w: 0, r: 0, g: 0, b: 0, confirmed: false };
        coarse.set(ckey, c);
      }
      // Weight each constituent by how well established it is.
      const wNew = c.w + rec.w;
      c.r = (c.r * c.w + rec.r * rec.w) / wNew;
      c.g = (c.g * c.w + rec.g * rec.w) / wNew;
      c.b = (c.b * c.w + rec.b * rec.w) / wNew;
      c.w = wNew;
      // A coarse cell counts as confirmed once any constituent is: at this size the block is a
      // summary, and a block containing scanned surface should not read as "not scanned yet".
      if (!c.confirmed && this.isConfirmed(rec)) c.confirmed = true;
    }
    const coarseSize = f * this.voxelSize;
    const half = coarseSize * 0.5;
    for (const [ckey, c] of coarse) {
      const { xi, yi, zi } = unpackKey(ckey);
      cb(
        xi * coarseSize + half,
        yi * coarseSize + half,
        zi * coarseSize + half,
        c.r,
        c.g,
        c.b,
        c.confirmed,
      );
    }
  }
}
