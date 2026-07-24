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
 * Free-space carving (Phase 6.2) makes the base path removal-capable: `carve` projects drawn
 * voxels back into the depth image and swap-removes the ones floating in front of the real
 * surface. `instanceToKey` is the slot→key map that removal needs.
 *
 * Incremental instances keep their first-confident color; the grid keeps the true running average,
 * which the downsampled rebuild (and export) use.
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
  private readonly scratch: VoxelView = { cx: 0, cy: 0, cz: 0, r: 0, g: 0, b: 0, count: 0 };
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
   * Append base-size voxels that have newly reached `minObservations` (incremental, factor 1).
   * Only dirty cells are examined and only the appended buffer range is re-uploaded.
   */
  applyUpdates(grid: VoxelGrid, minObservations: number): number {
    const start = this.count;
    const s = this.voxelSize * BASE_FILL;
    grid.drainDirty((key) => {
      if (this.count >= this.capacity) return;
      if (this.keyToInstance.has(key)) return;
      if (!grid.readVoxel(key, this.scratch) || this.scratch.count < minObservations) return;
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
   * Free-space carve pass (base path only). Examines up to `budget` drawn instances starting from
   * a rolling cursor, projects each voxel center into the current depth image via `ctx`, and for
   * any that sit in free space records a miss in the grid and swap-removes the instance if its
   * occupancy dropped below `minObservations`. Amortized so no single frame stalls. Returns the
   * number carved.
   */
  carve(grid: VoxelGrid, ctx: CarveContext, minObservations: number, budget: number): number {
    if (this.count === 0 || !ctx.ready) return 0;
    const half = this.voxelSize * 0.5;
    let examined = 0;
    let carved = 0;
    let i = this.carveCursor;
    while (examined < budget && this.count > 0) {
      if (i >= this.count) i = 0;
      const key = this.instanceToKey[i];
      const { xi, yi, zi } = unpackKey(key);
      examined++;
      if (
        ctx.testFree(
          xi * this.voxelSize + half,
          yi * this.voxelSize + half,
          zi * this.voxelSize + half,
        )
      ) {
        const stillDrawn = grid.recordMiss(key, minObservations);
        if (!stillDrawn) {
          this.swapRemove(i);
          carved++;
          continue; // slot i now holds the moved instance (or i == count); re-examine it
        }
      }
      i++;
    }
    this.carveCursor = i;
    return carved;
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
  rebuildDownsampled(grid: VoxelGrid, factor: number, minObservations: number): number {
    this.keyToInstance.clear();
    this.count = 0;
    this.carveCursor = 0;
    const s = factor * this.voxelSize * COARSE_FILL;
    grid.forEachDownsampled(factor, minObservations, (cx, cy, cz, r, g, b) => {
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
