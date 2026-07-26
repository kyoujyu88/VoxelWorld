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
 *    so a well-scanned surface is barely moved by a later distant glimpse.
 *
 * Distances are truncated to ±`truncation` around the surface, so a cell only ever holds a local
 * statement about the nearest surface. Display / export downsampling (integer multiples of the
 * base size) stays a separate concern layered on top.
 *
 * ## Storage
 *
 * Cells live in an **open-addressed hash table over typed arrays**, keyed by integer cell
 * coordinates and probed linearly. The obvious `Map<number, {…}>` was measured to be the app's
 * bottleneck at room scale: packed keys reach 2.25e15, far past V8's small-integer range, so every
 * key became a boxed heap number — 9.07 ms per 16k lookups over 1.4M entries, against 4.88 ms for
 * small-integer keys, and the per-frame fusion and carve passes do tens of thousands of them.
 * Hashing three integer coordinates instead sidesteps the boxing entirely, and holding each field
 * in its own contiguous array keeps a probe to a handful of cache lines.
 *
 * A slot's fields are **interleaved** into that one array rather than split one array per field.
 * That was measured too: splitting them apart made lookups faster but fusion slower, because
 * fusion reads and writes eight fields of a single cell and each one sat on its own cache line.
 * Interleaved, a slot is 48 contiguous bytes and behaves well under both access patterns.
 *
 * A leading `state` field marks each slot empty / occupied / tombstoned (deletion has to leave a
 * marker, or a probe could stop short of an entry that hashed earlier in the run). The table is
 * rehashed before occupancy plus tombstones reaches 70%, which also guarantees every probe meets
 * an empty slot and terminates.
 *
 * Measured against the `Map` it replaces, on a synthetic 1.07M-cell room: lookups 8.21 → 1.96 ms
 * per 16k (4.2x), steady-state fusion unchanged at ~5.3 ms/frame, heap 409 → 169 MB (2.4x).
 *
 * Packed keys (`packKey` / `unpackKey`) remain the public handle for a cell, so callers that hold
 * onto cells — the renderer's instance maps, the dirty sets — are unaffected by rehashing, which
 * moves slots around.
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

/** True if these cell coords can be represented as a packed key. */
function inKeyRange(xi: number, yi: number, zi: number): boolean {
  return (
    xi >= -OFFSET && xi < OFFSET && yi >= -OFFSET && yi < OFFSET && zi >= -OFFSET && zi < OFFSET
  );
}

const DIR_SECTORS = 8;
const TWO_PI = Math.PI * 2;

/**
 * Bit for the horizontal sector a view ray arrived from — half of "how well do we know this cell".
 * A surface seen from several directions has been checked against itself, which a single lucky
 * angle never is. Returns 0 (no information) for a purely vertical ray, which ORs in harmlessly.
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

/** Slot states. Deletion must tombstone, not clear, or a probe run can be cut in half. */
const EMPTY = 0;
const OCCUPIED = 1;
const TOMBSTONE = 2;

/**
 * One slot's fields, interleaved into a single Float32Array at this stride.
 *
 * Interleaved rather than one array per field, which was measured: splitting the fields apart made
 * lookups 2.8x faster but fusion 1.8x *slower*, because fusion reads and writes eight fields of one
 * cell and each lived on its own cache line. Interleaved, a slot is 48 contiguous bytes and spans
 * at most two lines whichever way it is used. The cell coordinates ride along as floats — they are
 * whole numbers well inside Float32's exact-integer range (±16,777,216) — so the whole table is one
 * allocation with no boxing anywhere.
 */
const STRIDE = 12;
const F_STATE = 0;
const F_XI = 1;
const F_YI = 2;
const F_ZI = 3;
const F_SDF = 4;
const F_W = 5;
const F_R = 6;
const F_G = 7;
const F_B = 8;
const F_CW = 9;
const F_BEST = 10;
const F_DIR = 11;

/** Initial slot count (power of two). Grows by doubling as the scan fills in. */
const INITIAL_CAPACITY = 1 << 15;
/** Rehash once occupied + tombstoned slots reach this share; also keeps probes terminating. */
const MAX_LOAD = 0.7;

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

  // --- open-addressed table; one Float32Array, STRIDE floats per slot ---
  private capacity = 0;
  private mask = 0;
  private count = 0;
  private tombstones = 0;
  private data!: Float32Array;
  /** Set by findOrInsert: whether the returned slot was created by that call. */
  private inserted = false;

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
    this.allocate(INITIAL_CAPACITY);
  }

  /** Total stored cells (surface *and* the free/occluded band around it). */
  get size(): number {
    return this.count;
  }

  private allocate(capacity: number): void {
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.data = new Float32Array(capacity * STRIDE); // zero-filled, i.e. every slot EMPTY
  }

  /**
   * Spatial hash of the three cell coordinates. `Math.imul` keeps every step a 32-bit integer
   * operation — the whole point of hashing coordinates rather than the packed key is to stay
   * inside small-integer arithmetic, so a plain `*` (which would produce a double past 2^31)
   * would give the boxing back.
   */
  private hash(xi: number, yi: number, zi: number): number {
    let h = (Math.imul(xi, 73856093) ^ Math.imul(yi, 19349663) ^ Math.imul(zi, 83492791)) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    return h >>> 0;
  }

  /** Base index into `data` of the slot holding this cell, or -1 if absent. */
  private findSlot(xi: number, yi: number, zi: number): number {
    const d = this.data;
    let i = this.hash(xi, yi, zi) & this.mask;
    for (;;) {
      const p = i * STRIDE;
      const st = d[p + F_STATE];
      if (st === EMPTY) return -1;
      if (st === OCCUPIED && d[p + F_XI] === xi && d[p + F_YI] === yi && d[p + F_ZI] === zi) {
        return p;
      }
      i = (i + 1) & this.mask;
    }
  }

  /**
   * Slot for this cell, creating it if absent. Returns -1 when the cap is reached. Sets
   * `this.inserted` so the caller can tell a fresh cell from an existing one without a second
   * probe (and without allocating a result object on a path that runs thousands of times a frame).
   */
  private findOrInsert(xi: number, yi: number, zi: number): number {
    if ((this.count + this.tombstones + 1) / this.capacity > MAX_LOAD) this.rehash();
    const d = this.data;
    let i = this.hash(xi, yi, zi) & this.mask;
    let firstTomb = -1;
    for (;;) {
      const p = i * STRIDE;
      const st = d[p + F_STATE];
      if (st === EMPTY) {
        if (this.count >= this.maxVoxels) {
          this.inserted = false;
          return -1;
        }
        let slot = p;
        if (firstTomb >= 0) {
          slot = firstTomb; // reuse a tombstone rather than lengthening the probe run
          this.tombstones--;
        }
        d[slot + F_STATE] = OCCUPIED;
        d[slot + F_XI] = xi;
        d[slot + F_YI] = yi;
        d[slot + F_ZI] = zi;
        this.count++;
        this.inserted = true;
        return slot;
      }
      if (st === TOMBSTONE) {
        if (firstTomb < 0) firstTomb = p;
      } else if (d[p + F_XI] === xi && d[p + F_YI] === yi && d[p + F_ZI] === zi) {
        this.inserted = false;
        return p;
      }
      i = (i + 1) & this.mask;
    }
  }

  /**
   * Rebuild the table: double it when the live cells genuinely need the room, otherwise reuse the
   * same size and simply drop the tombstones a delete-heavy carve pass left behind.
   */
  private rehash(): void {
    const oldCap = this.capacity;
    const old = this.data;

    // Doubling halves the load, so growing at 0.525 keeps it in [0.26, 0.525] — short probe runs
    // without paying for a table twice the size it needs.
    const grow = (this.count + 1) / oldCap > MAX_LOAD * 0.75;
    this.allocate(grow ? oldCap * 2 : oldCap);
    this.tombstones = 0;
    this.count = 0;

    const d = this.data;
    for (let s = 0; s < oldCap; s++) {
      const q = s * STRIDE;
      if (old[q + F_STATE] !== OCCUPIED) continue;
      // The fresh table has no tombstones, so the first empty slot in the run is the destination.
      const xi = old[q + F_XI];
      const yi = old[q + F_YI];
      const zi = old[q + F_ZI];
      let i = this.hash(xi, yi, zi) & this.mask;
      while (d[i * STRIDE + F_STATE] === OCCUPIED) i = (i + 1) & this.mask;
      const p = i * STRIDE;
      for (let f = 0; f < STRIDE; f++) d[p + f] = old[q + f];
      this.count++;
    }
  }

  private deleteSlot(slot: number): void {
    this.data[slot + F_STATE] = TOMBSTONE;
    this.count--;
    this.tombstones++;
  }

  /** True if this cell currently sits on the surface (zero crossing) and is well enough observed. */
  private isSurfaceSlot(slot: number, minWeight: number): boolean {
    const sdf = this.data[slot + F_SDF];
    return (
      this.data[slot + F_W] >= minWeight && sdf <= this.surfaceBand && sdf >= -this.surfaceBand
    );
  }

  /**
   * True once a cell has been observed well enough to be trusted and locked in.
   *
   * Enough weight, *and* either a close look or looks from several directions. The two are an OR,
   * not an AND, on purpose: a flat wall can only ever be seen from one side, so requiring direction
   * diversity would mean walls never confirm. Conversely an object you have circled is well pinned
   * even if you never got close to it.
   */
  private isConfirmedSlot(slot: number): boolean {
    return (
      this.data[slot + F_W] >= this.confirmWeight &&
      (this.data[slot + F_BEST] <= this.confirmDist ||
        popcount8(this.data[slot + F_DIR]) >= this.confirmDirs)
    );
  }

  /**
   * Whether an observation from `obsDepth` metres away is too poor to be allowed to touch this
   * cell. A confirmed cell only yields to a look of comparable quality — no farther than
   * `lockRatio` times its own best. That is what stops a distant glimpse from degrading, or the
   * carve pass from erasing, something you already walked up to and scanned properly; getting
   * close again always restores the ability to correct it.
   */
  private isLocked(slot: number, obsDepth: number): boolean {
    return obsDepth > this.data[slot + F_BEST] * this.lockRatio && this.isConfirmedSlot(slot);
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
    // Cells outside the packed-key range could be stored but never referred to again.
    if (!inKeyRange(xi, yi, zi)) return;

    const t = this.truncation;
    const clamped = sdf > t ? t : sdf < -t ? -t : sdf;

    const slot = this.findOrInsert(xi, yi, zi);
    if (slot < 0) {
      this.droppedAtCap++;
      return;
    }

    const d = this.data;
    if (this.inserted) {
      // Colour starts empty and is only ever set through the colorWeight path below, so a
      // geometry-only sample (one taken away from the surface) never tints a cell.
      d[slot + F_SDF] = clamped;
      d[slot + F_W] = Math.min(weight, this.maxWeight);
      d[slot + F_R] = 0;
      d[slot + F_G] = 0;
      d[slot + F_B] = 0;
      d[slot + F_CW] = 0;
      d[slot + F_BEST] = obsDepth;
      d[slot + F_DIR] = dirBit;
      this.growBounds(xi, yi, zi);
    } else {
      if (this.isLocked(slot, obsDepth)) return; // too distant a look to touch a confirmed cell
      // Weighted running average of the distance, with the weight capped (KinectFusion).
      const w = d[slot + F_W];
      const wNew = w + weight;
      d[slot + F_SDF] = (d[slot + F_SDF] * w + clamped * weight) / wNew;
      d[slot + F_W] = wNew > this.maxWeight ? this.maxWeight : wNew;
      if (obsDepth < d[slot + F_BEST]) d[slot + F_BEST] = obsDepth;
      d[slot + F_DIR] = d[slot + F_DIR] | dirBit;
    }

    if (colorWeight > 0) {
      const cw = d[slot + F_CW];
      const cwNew = cw + colorWeight;
      d[slot + F_R] = (d[slot + F_R] * cw + r * colorWeight) / cwNew;
      d[slot + F_G] = (d[slot + F_G] * cw + g * colorWeight) / cwNew;
      d[slot + F_B] = (d[slot + F_B] * cw + b * colorWeight) / cwNew;
      d[slot + F_CW] = cwNew > this.maxWeight ? this.maxWeight : cwNew;
    }

    // Only a cell on the zero crossing can be drawn or painted, and both consumers discard the
    // rest the moment they read them. The band a measurement writes is wider than the surface
    // band, so filtering here drops most of the traffic — and with it most of the work the
    // incremental draw and the overhead preview do walking their dirty sets.
    const finalSdf = d[slot + F_SDF];
    if (finalSdf <= this.surfaceBand && finalSdf >= -this.surfaceBand) {
      const key = (xi + OFFSET) * BASE * BASE + (yi + OFFSET) * BASE + (zi + OFFSET);
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
    const z = key % BASE;
    const afterZ = (key - z) / BASE;
    const y = afterZ % BASE;
    const x = (afterZ - y) / BASE;
    const slot = this.findSlot(x - OFFSET, y - OFFSET, z - OFFSET);
    if (slot < 0) return false;
    if (this.isLocked(slot, obsDepth)) return this.isSurfaceSlot(slot, minWeight); // as it stands
    const d = this.data;
    const w = d[slot + F_W];
    const wNew = w + weight;
    const sdf = (d[slot + F_SDF] * w + this.truncation * weight) / wNew;
    d[slot + F_SDF] = sdf;
    d[slot + F_W] = wNew > this.maxWeight ? this.maxWeight : wNew;
    this.dirtyPreview.add(key);
    if (sdf >= this.truncation * 0.99) {
      this.deleteSlot(slot); // fully empty: nothing left to remember
      return false;
    }
    return this.isSurfaceSlot(slot, minWeight);
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
    this.allocate(INITIAL_CAPACITY);
    this.count = 0;
    this.tombstones = 0;
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
    for (let s = 0; s < this.capacity; s++) {
      const p = s * STRIDE;
      if (this.data[p + F_STATE] !== OCCUPIED) continue;
      this.dirty.add(this.keyAtSlot(p));
    }
  }

  private keyAtSlot(slot: number): number {
    return (
      (this.data[slot + F_XI] + OFFSET) * BASE * BASE +
      (this.data[slot + F_YI] + OFFSET) * BASE +
      (this.data[slot + F_ZI] + OFFSET)
    );
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
    const z = key % BASE;
    const afterZ = (key - z) / BASE;
    const y = afterZ % BASE;
    const x = (afterZ - y) / BASE;
    const xi = x - OFFSET;
    const yi = y - OFFSET;
    const zi = z - OFFSET;
    const slot = this.findSlot(xi, yi, zi);
    if (slot < 0) return false;
    const half = this.voxelSize * 0.5;
    out.cx = xi * this.voxelSize + half;
    out.cy = yi * this.voxelSize + half;
    out.cz = zi * this.voxelSize + half;
    const d = this.data;
    out.r = d[slot + F_R];
    out.g = d[slot + F_G];
    out.b = d[slot + F_B];
    out.weight = d[slot + F_W];
    out.sdf = d[slot + F_SDF];
    out.confirmed = this.isConfirmedSlot(slot);
    return true;
  }

  /** Number of cells currently on the surface at the given weight threshold. */
  countSurface(minWeight: number): number {
    let n = 0;
    for (let s = 0; s < this.capacity; s++) {
      const p = s * STRIDE;
      if (this.data[p + F_STATE] !== OCCUPIED) continue;
      if (this.isSurfaceSlot(p, minWeight)) n++;
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
    const d = this.data;
    for (let i = 0; i < this.capacity; i++) {
      const p = i * STRIDE;
      if (d[p + F_STATE] !== OCCUPIED) continue;
      if (!this.isSurfaceSlot(p, minWeight)) continue;
      cb(
        d[p + F_XI] * s + half,
        d[p + F_YI] * s + half,
        d[p + F_ZI] * s + half,
        d[p + F_R],
        d[p + F_G],
        d[p + F_B],
        this.isConfirmedSlot(p),
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
    const d = this.data;
    for (let i = 0; i < this.capacity; i++) {
      const p = i * STRIDE;
      if (d[p + F_STATE] !== OCCUPIED) continue;
      if (!this.isSurfaceSlot(p, minWeight)) continue;
      // Math.floor divides correctly for the negative cell indices too.
      const cxi = Math.floor(d[p + F_XI] / f);
      const cyi = Math.floor(d[p + F_YI] / f);
      const czi = Math.floor(d[p + F_ZI] / f);
      const ckey = packKey(cxi, cyi, czi);
      if (ckey === null) continue;
      let c = coarse.get(ckey);
      if (c === undefined) {
        c = { w: 0, r: 0, g: 0, b: 0, confirmed: false };
        coarse.set(ckey, c);
      }
      // Weight each constituent by how well established it is.
      const rw = d[p + F_W];
      const wNew = c.w + rw;
      c.r = (c.r * c.w + d[p + F_R] * rw) / wNew;
      c.g = (c.g * c.w + d[p + F_G] * rw) / wNew;
      c.b = (c.b * c.w + d[p + F_B] * rw) / wNew;
      c.w = wNew;
      // A coarse cell counts as confirmed once any constituent is: at this size the block is a
      // summary, and a block containing scanned surface should not read as "not scanned yet".
      if (!c.confirmed && this.isConfirmedSlot(p)) c.confirmed = true;
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
