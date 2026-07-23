/**
 * Renders accumulated voxels as an InstancedMesh of colored cubes.
 *
 * The geometry is a unit cube; the real size comes from each instance's scale, so one mesh serves
 * two paths:
 *  - applyUpdates (Phase 4): incremental, append-only at the base 2cm size. Only cells the grid
 *    marked dirty are appended, and only the appended buffer slice is re-uploaded.
 *  - rebuildDownsampled (Phase 6): a full re-tessellation at a coarser display size (factor×base),
 *    aggregating confident cells on the fly via grid.forEachDownsampled. Used when the size slider
 *    changes (and on a throttle while scanning coarse).
 *
 * Incremental instances keep their first-confident color; the grid keeps the true running average,
 * which the downsampled rebuild (and export) use.
 */

import { InstancedMesh, BoxGeometry, MeshBasicMaterial, Object3D, Color } from 'three';
import type { VoxelGrid, VoxelView } from '../voxel/grid';

const BASE_FILL = 0.55; // 2cm cubes shrunk so the AR view shows through the gaps
const COARSE_FILL = 0.9; // coarser cubes read as solid blocks

export class VoxelRenderer {
  readonly mesh: InstancedMesh;
  readonly capacity: number;
  private readonly voxelSize: number;
  private readonly dummy = new Object3D();
  private readonly color = new Color();
  private readonly keyToInstance = new Map<number, number>();
  private readonly scratch: VoxelView = { cx: 0, cy: 0, cz: 0, r: 0, g: 0, b: 0, count: 0 };
  private count = 0;

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
   * Full re-tessellation at a coarser display size (factor×base): rebuild every instance from the
   * grid aggregated into factor-sized cells. Used on a size-slider change and on a throttle while
   * scanning coarse. The incremental keyToInstance map is not maintained here (factor > 1 disables
   * the incremental path). Returns the drawn coarse-voxel count.
   */
  rebuildDownsampled(grid: VoxelGrid, factor: number, minObservations: number): number {
    this.keyToInstance.clear();
    this.count = 0;
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
    // Re-upload the whole used range (clear any pending incremental ranges first).
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
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.dispose();
  }
}
