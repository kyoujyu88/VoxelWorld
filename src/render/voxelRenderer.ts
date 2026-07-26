/**
 * Renders accumulated voxels as instanced colored cubes, split across two confidence tiers.
 *
 * The geometry is a unit cube; the real size comes from each instance's scale, so one mesh serves
 * two paths:
 *  - applyUpdates (Phase 4): incremental, append-only at the base 2cm size. Only cells the grid
 *    marked dirty are appended, and only the appended buffer slice is re-uploaded.
 *  - rebuildDownsampled (Phase 6): a full re-tessellation at a coarser display size (factor×base),
 *    aggregating confident cells on the fly via grid.forEachDownsampled.
 *
 * A cell is drawn when it sits on the TSDF's zero crossing (|sdf| within the grid's surface band)
 * and is well enough observed. Because fusion moves that crossing, drawn instances have to be
 * re-validated as well as appended: `carve` walks them and swap-removes any that stopped being
 * surface, plus fuses free-space evidence where the current view sees through one.
 *
 * Phase 8b splits that into two `VoxelLayer`s (confirmed / provisional) drawn from one Group.
 * three.js has no per-instance opacity — `instanceColor` is RGB-only — so two meshes with
 * different materials is how a cell's confidence becomes visible: solid blocks are scanned, ghosts
 * are "come closer". A cell is appended into whichever tier it belongs to, and the carve walk is
 * also where a cell that has since been confirmed migrates from one mesh to the other, since
 * `applyUpdates` never revisits an instance it has already drawn.
 *
 * Instances keep the color they were appended with; the grid keeps the weighted mean, which the
 * downsampled rebuild (and export) use.
 */

import {
  InstancedMesh,
  BoxGeometry,
  MeshBasicMaterial,
  Object3D,
  Color,
  Matrix4,
  Group,
  type BufferGeometry,
} from 'three';
import { unpackKey, type VoxelGrid, type VoxelView } from '../voxel/grid';
import { carveWeightScale, type CarveContext } from '../xr/carve';

const BASE_FILL = 0.9; // near-solid 2cm cubes — a grid of Minecraft-like blocks
const COARSE_FILL = 0.95; // coarser cubes read as solid blocks
/** Provisional cells are see-through so the surface behind them stays readable. */
const PROVISIONAL_OPACITY = 0.35;

/**
 * One InstancedMesh plus the bookkeeping that keeps its slots addressable by cell key.
 *
 * Extracted so the confirmed and provisional tiers can share it unchanged — in particular the
 * swap-remove, which keeps `keyToInstance` and `instanceToKey` consistent as instances move.
 */
class VoxelLayer {
  readonly mesh: InstancedMesh;
  readonly capacity: number;
  /** Rolling cursor for the amortized carve/validate walk over this layer's instances. */
  cursor = 0;
  private readonly keyToInstance = new Map<number, number>();
  private readonly instanceToKey: number[] = [];
  private readonly dummy = new Object3D();
  private readonly color = new Color();
  private readonly swapMat = new Matrix4();
  private readonly swapColor = new Color();
  private count = 0;
  /** First slot appended since the last flush, or -1 when nothing is pending. */
  private appendStart = -1;

  constructor(geometry: BufferGeometry, material: MeshBasicMaterial, capacity: number) {
    this.capacity = capacity;
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, this.color.setRGB(1, 1, 1)); // allocate the instanceColor buffer
    this.mesh.count = 0;
  }

  get drawn(): number {
    return this.count;
  }

  get hasRoom(): boolean {
    return this.count < this.capacity;
  }

  has(key: number): boolean {
    return this.keyToInstance.has(key);
  }

  keyAt(slot: number): number {
    return this.instanceToKey[slot];
  }

  /** Append one cube. Returns false when the layer is full. Call `flush()` once when done. */
  append(
    key: number,
    cx: number,
    cy: number,
    cz: number,
    size: number,
    r: number,
    g: number,
    b: number,
  ): boolean {
    if (this.count >= this.capacity) return false;
    const slot = this.count++;
    if (this.appendStart < 0) this.appendStart = slot;
    this.keyToInstance.set(key, slot);
    this.instanceToKey[slot] = key;
    this.dummy.position.set(cx, cy, cz);
    this.dummy.scale.set(size, size, size);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(slot, this.dummy.matrix);
    this.mesh.setColorAt(slot, this.color.setRGB(r / 255, g / 255, b / 255));
    return true;
  }

  /** Upload just the range appended since the last flush. */
  flush(): void {
    if (this.appendStart < 0) return;
    const added = this.count - this.appendStart;
    if (added > 0) {
      this.mesh.instanceMatrix.addUpdateRange(this.appendStart * 16, added * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) {
        this.mesh.instanceColor.addUpdateRange(this.appendStart * 3, added * 3);
        this.mesh.instanceColor.needsUpdate = true;
      }
      this.mesh.count = this.count;
    }
    this.appendStart = -1;
  }

  /** Remove instance `slot` by moving the last instance into it (order-independent). */
  removeAt(slot: number): void {
    this.keyToInstance.delete(this.instanceToKey[slot]);
    const last = this.count - 1;
    if (slot !== last) {
      this.mesh.getMatrixAt(last, this.swapMat);
      this.mesh.setMatrixAt(slot, this.swapMat);
      this.mesh.instanceMatrix.addUpdateRange(slot * 16, 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) {
        this.mesh.getColorAt(last, this.swapColor);
        this.mesh.setColorAt(slot, this.swapColor);
        this.mesh.instanceColor.addUpdateRange(slot * 3, 3);
        this.mesh.instanceColor.needsUpdate = true;
      }
      const movedKey = this.instanceToKey[last];
      this.instanceToKey[slot] = movedKey;
      this.keyToInstance.set(movedKey, slot);
    }
    this.count--;
    this.mesh.count = this.count;
  }

  /** Re-upload the whole buffer (used after a full re-tessellation). */
  uploadAll(): void {
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges();
    im.addUpdateRange(0, this.count * 16);
    im.needsUpdate = true;
    const ic = this.mesh.instanceColor;
    if (ic) {
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, this.count * 3);
      ic.needsUpdate = true;
    }
    this.mesh.count = this.count;
    this.appendStart = -1;
  }

  reset(): void {
    this.keyToInstance.clear();
    this.count = 0;
    this.cursor = 0;
    this.appendStart = -1;
    this.mesh.count = 0;
  }

  dispose(): void {
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.dispose();
  }
}

export class VoxelRenderer {
  /** Both tiers under one node, so callers add a single object to the scene. */
  readonly root = new Group();
  readonly capacity: number;
  private readonly geometry: BoxGeometry;
  private readonly confirmed: VoxelLayer;
  private readonly provisional: VoxelLayer;
  private readonly voxelSize: number;
  private readonly scratch: VoxelView = {
    cx: 0,
    cy: 0,
    cz: 0,
    r: 0,
    g: 0,
    b: 0,
    weight: 0,
    sdf: 0,
    confirmed: false,
  };

  constructor(confirmedCapacity: number, provisionalCapacity: number, voxelSize: number) {
    this.capacity = confirmedCapacity + provisionalCapacity;
    this.voxelSize = voxelSize;
    this.geometry = new BoxGeometry(1, 1, 1); // unit cube; per-instance scale sets the real size
    this.confirmed = new VoxelLayer(this.geometry, new MeshBasicMaterial(), confirmedCapacity);
    // depthWrite off so translucent blocks don't occlude each other into hard holes; three draws
    // transparent materials after opaque ones, so confirmed geometry still occludes these.
    this.provisional = new VoxelLayer(
      this.geometry,
      new MeshBasicMaterial({
        transparent: true,
        opacity: PROVISIONAL_OPACITY,
        depthWrite: false,
      }),
      provisionalCapacity,
    );
    this.root.add(this.confirmed.mesh, this.provisional.mesh);
  }

  get drawn(): number {
    return this.confirmed.drawn + this.provisional.drawn;
  }

  get drawnConfirmed(): number {
    return this.confirmed.drawn;
  }

  get drawnProvisional(): number {
    return this.provisional.drawn;
  }

  /**
   * Append base-size cells that have newly become surface (incremental, factor 1).
   * Only dirty cells are examined and only the appended buffer range is re-uploaded.
   */
  applyUpdates(grid: VoxelGrid, minWeight: number): number {
    const s = this.voxelSize * BASE_FILL;
    grid.drainDirty((key) => {
      // Drawn in either tier already: migration between them is the carve walk's job.
      if (this.confirmed.has(key) || this.provisional.has(key)) return;
      if (!grid.readVoxel(key, this.scratch)) return;
      if (this.scratch.weight < minWeight) return;
      if (Math.abs(this.scratch.sdf) > grid.surfaceBand) return; // not on the zero crossing
      const layer = this.scratch.confirmed ? this.confirmed : this.provisional;
      const v = this.scratch;
      layer.append(key, v.cx, v.cy, v.cz, s, v.r, v.g, v.b);
    });
    this.confirmed.flush();
    this.provisional.flush();
    return this.drawn;
  }

  /**
   * Validate + carve pass over the drawn instances (base path only). Walks up to `budget`
   * instances from a rolling cursor and, for each:
   *   1. drops it if the cell is no longer a surface cell — fusion moves the zero crossing, so an
   *      instance drawn earlier can stop belonging on the surface;
   *   2. moves it to the other tier if its confidence has changed — this is where a provisional
   *      cell you have walked up to turns solid;
   *   3. otherwise, if the current depth image shows free space where it sits, fuses that
   *      free-space evidence in (which pushes its distance out of the surface band and, once the
   *      cell is fully empty, deletes it).
   *
   * Long-range floaters are cleared this way; the near-surface band is handled by fusion itself.
   * Amortized so no single frame stalls, with the budget split across the tiers by size. Returns
   * the number of instances removed.
   */
  carve(
    grid: VoxelGrid,
    ctx: CarveContext,
    minWeight: number,
    budget: number,
    freeWeight = 1,
  ): number {
    const total = this.drawn;
    if (total === 0) return 0;
    const share = (n: number): number => Math.ceil((budget * n) / total);
    return (
      this.carveLayer(
        this.confirmed,
        true,
        grid,
        ctx,
        minWeight,
        share(this.confirmed.drawn),
        freeWeight,
      ) +
      this.carveLayer(
        this.provisional,
        false,
        grid,
        ctx,
        minWeight,
        share(this.provisional.drawn),
        freeWeight,
      )
    );
  }

  private carveLayer(
    layer: VoxelLayer,
    tierIsConfirmed: boolean,
    grid: VoxelGrid,
    ctx: CarveContext,
    minWeight: number,
    budget: number,
    freeWeight: number,
  ): number {
    if (layer.drawn === 0) return 0;
    const other = tierIsConfirmed ? this.provisional : this.confirmed;
    const size = this.voxelSize * BASE_FILL;
    const half = this.voxelSize * 0.5;
    let examined = 0;
    let removed = 0;
    let i = layer.cursor;
    while (examined < budget && layer.drawn > 0) {
      if (i >= layer.drawn) i = 0;
      const key = layer.keyAt(i);
      examined++;

      // 1. Still a surface cell?
      if (!grid.readVoxel(key, this.scratch)) {
        layer.removeAt(i);
        removed++;
        continue;
      }
      const v = this.scratch;
      if (v.weight < minWeight || Math.abs(v.sdf) > grid.surfaceBand) {
        layer.removeAt(i);
        removed++;
        continue;
      }

      // 2. Has its confidence tier changed? If the other layer is full, leave it drawn where it
      // is — showing it in the wrong tier beats dropping it.
      if (v.confirmed !== tierIsConfirmed && other.hasRoom) {
        layer.removeAt(i);
        other.append(key, v.cx, v.cy, v.cz, size, v.r, v.g, v.b);
        other.flush();
        continue; // slot i now holds the moved instance (or i == drawn); re-examine it
      }

      // 3. Does the current view see through it?
      if (ctx.ready) {
        const { xi, yi, zi } = unpackKey(key);
        if (
          ctx.testFree(
            xi * this.voxelSize + half,
            yi * this.voxelSize + half,
            zi * this.voxelSize + half,
          )
        ) {
          // Erase with the same distance falloff fusion uses, and let the grid refuse the edit
          // outright when the cell is confirmed and this view is a far worse look than the one
          // that confirmed it.
          const obs = ctx.lastVoxelDepth;
          if (!grid.integrateFree(key, freeWeight * carveWeightScale(obs), minWeight, obs)) {
            layer.removeAt(i);
            removed++;
            continue; // slot i now holds the moved instance (or i == drawn); re-examine it
          }
        }
      }
      i++;
    }
    layer.cursor = i;
    return removed;
  }

  /**
   * Full re-tessellation at a coarser display size (factor×base): rebuild every instance from the
   * grid aggregated into factor-sized cells. Used on a size-slider change and on a pause toggle.
   * The incremental key maps are not maintained here (factor > 1 disables the incremental and
   * carve paths). Returns the drawn coarse-voxel count.
   */
  rebuildDownsampled(grid: VoxelGrid, factor: number, minWeight: number): number {
    this.confirmed.reset();
    this.provisional.reset();
    const s = factor * this.voxelSize * COARSE_FILL;
    let synthetic = 0;
    grid.forEachDownsampled(factor, minWeight, (cx, cy, cz, r, g, b, confirmed) => {
      // Coarse cells have no key of their own; the maps are unused on this path, so a running
      // counter is enough to keep the entries distinct.
      const layer = confirmed ? this.confirmed : this.provisional;
      layer.append(synthetic++, cx, cy, cz, s, r, g, b);
    });
    this.confirmed.uploadAll();
    this.provisional.uploadAll();
    return this.drawn;
  }

  /** Drop all instances (used on Clear and before re-seeding the incremental path). */
  reset(): void {
    this.confirmed.reset();
    this.provisional.reset();
  }

  dispose(): void {
    this.geometry.dispose();
    this.confirmed.dispose();
    this.provisional.dispose();
  }
}
