/**
 * Renders accumulated voxels as an InstancedMesh of colored cubes.
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
 * `instanceToKey` is the slot→key map that removal needs.
 *
 * Instances keep the color they were appended with; the grid keeps the weighted mean, which the
 * downsampled rebuild (and export) use.
 */

import { InstancedMesh, BoxGeometry, MeshBasicMaterial, Object3D, Color, Matrix4 } from 'three';
import { unpackKey, type VoxelGrid, type VoxelView } from '../voxel/grid';
import type { CarveContext } from '../xr/carve';

const BASE_FILL = 0.9; // near-solid 2cm cubes — a grid of Minecraft-like blocks
const COARSE_FILL = 0.95; // coarser cubes read as solid blocks

export class VoxelRenderer {
  readonly mesh: InstancedMesh;
  readonly capacity: number;
  private readonly voxelSize: number;
  private readonly dummy = new Object3D();
  private readonly color = new Color();
  private readonly keyToInstance = new Map<number, number>();
  private readonly instanceToKey: number[] = [];
  private readonly scratch: VoxelView = {
    cx: 0,
    cy: 0,
    cz: 0,
    r: 0,
    g: 0,
    b: 0,
    weight: 0,
    sdf: 0,
  };
  private readonly swapMat = new Matrix4();
  private readonly swapColor = new Color();
  private count = 0;
  private carveCursor = 0;

  constructor(capacity: number, voxelSize: number) {
    this.capacity = capacity;
    this.voxelSize = voxelSize;
    const geometry = new BoxGeometry(1, 1, 1); // unit cube; per-instance scale sets the real size
    const material = new MeshBasicMaterial();
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, this.color.setRGB(1, 1, 1)); // allocate the instanceColor buffer
    this.mesh.count = 0;
  }

  get drawn(): number {
    return this.count;
  }

  /**
   * Append base-size cells that have newly become surface (incremental, factor 1).
   * Only dirty cells are examined and only the appended buffer range is re-uploaded.
   */
  applyUpdates(grid: VoxelGrid, minWeight: number): number {
    const start = this.count;
    const s = this.voxelSize * BASE_FILL;
    grid.drainDirty((key) => {
      if (this.count >= this.capacity) return;
      if (this.keyToInstance.has(key)) return;
      if (!grid.readVoxel(key, this.scratch)) return;
      if (this.scratch.weight < minWeight) return;
      if (Math.abs(this.scratch.sdf) > grid.surfaceBand) return; // not on the zero crossing
      const slot = this.count++;
      this.keyToInstance.set(key, slot);
      this.instanceToKey[slot] = key;
      this.dummy.position.set(this.scratch.cx, this.scratch.cy, this.scratch.cz);
      this.dummy.scale.set(s, s, s);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(slot, this.dummy.matrix);
      this.mesh.setColorAt(
        slot,
        this.color.setRGB(this.scratch.r / 255, this.scratch.g / 255, this.scratch.b / 255),
      );
    });

    const added = this.count - start;
    if (added > 0) {
      this.mesh.instanceMatrix.addUpdateRange(start * 16, added * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) {
        this.mesh.instanceColor.addUpdateRange(start * 3, added * 3);
        this.mesh.instanceColor.needsUpdate = true;
      }
      this.mesh.count = this.count;
    }
    return this.count;
  }

  /**
   * Validate + carve pass over the drawn instances (base path only). Walks up to `budget`
   * instances from a rolling cursor and, for each:
   *   1. drops it if the cell is no longer a surface cell — fusion moves the zero crossing, so an
   *      instance drawn earlier can stop belonging on the surface;
   *   2. otherwise, if the current depth image shows free space where it sits, fuses that
   *      free-space evidence in (which pushes its distance out of the surface band and, once the
   *      cell is fully empty, deletes it).
   *
   * Long-range floaters are cleared this way; the near-surface band is handled by fusion itself.
   * Amortized so no single frame stalls. Returns the number of instances removed.
   */
  carve(
    grid: VoxelGrid,
    ctx: CarveContext,
    minWeight: number,
    budget: number,
    freeWeight = 1,
  ): number {
    if (this.count === 0) return 0;
    const half = this.voxelSize * 0.5;
    let examined = 0;
    let removed = 0;
    let i = this.carveCursor;
    while (examined < budget && this.count > 0) {
      if (i >= this.count) i = 0;
      const key = this.instanceToKey[i];
      examined++;

      // 1. Still a surface cell?
      if (!grid.readVoxel(key, this.scratch)) {
        this.swapRemove(i);
        removed++;
        continue;
      }
      if (this.scratch.weight < minWeight || Math.abs(this.scratch.sdf) > grid.surfaceBand) {
        this.swapRemove(i);
        removed++;
        continue;
      }

      // 2. Does the current view see through it?
      if (ctx.ready) {
        const { xi, yi, zi } = unpackKey(key);
        if (
          ctx.testFree(
            xi * this.voxelSize + half,
            yi * this.voxelSize + half,
            zi * this.voxelSize + half,
          )
        ) {
          if (!grid.integrateFree(key, freeWeight, minWeight)) {
            this.swapRemove(i);
            removed++;
            continue; // slot i now holds the moved instance (or i == count); re-examine it
          }
        }
      }
      i++;
    }
    this.carveCursor = i;
    return removed;
  }

  /** Remove instance `slot` by moving the last instance into it (order-independent). */
  private swapRemove(slot: number): void {
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

  /**
   * Full re-tessellation at a coarser display size (factor×base): rebuild every instance from the
   * grid aggregated into factor-sized cells. Used on a size-slider change and on a pause toggle.
   * The incremental keyToInstance map is not maintained here (factor > 1 disables the incremental
   * and carve paths). Returns the drawn coarse-voxel count.
   */
  rebuildDownsampled(grid: VoxelGrid, factor: number, minWeight: number): number {
    this.keyToInstance.clear();
    this.count = 0;
    this.carveCursor = 0;
    const s = factor * this.voxelSize * COARSE_FILL;
    grid.forEachDownsampled(factor, minWeight, (cx, cy, cz, r, g, b) => {
      if (this.count >= this.capacity) return;
      const slot = this.count++;
      this.dummy.position.set(cx, cy, cz);
      this.dummy.scale.set(s, s, s);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(slot, this.dummy.matrix);
      this.mesh.setColorAt(slot, this.color.setRGB(r / 255, g / 255, b / 255));
    });
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
    return this.count;
  }

  /** Drop all instances (used on Clear and before re-seeding the incremental path). */
  reset(): void {
    this.keyToInstance.clear();
    this.count = 0;
    this.carveCursor = 0;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.dispose();
  }
}
