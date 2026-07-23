/**
 * Renders accumulated voxels as an InstancedMesh of small colored cubes.
 *
 * Incremental + append-only for performance (Phase 4): each update only touches cells the grid
 * marked dirty, appends the ones that newly reached the confidence threshold, and re-uploads
 * just the appended (contiguous) slice of the instance buffers. Existing instances keep their
 * first-confident color — the grid keeps the true running average for export.
 */

import { InstancedMesh, BoxGeometry, MeshBasicMaterial, Object3D, Color } from 'three';
import type { VoxelGrid, VoxelView } from '../voxel/grid';

export class VoxelRenderer {
  readonly mesh: InstancedMesh;
  readonly capacity: number;
  private readonly dummy = new Object3D();
  private readonly color = new Color();
  private readonly keyToInstance = new Map<number, number>();
  private readonly scratch: VoxelView = { cx: 0, cy: 0, cz: 0, r: 0, g: 0, b: 0, count: 0 };
  private count = 0;

  constructor(capacity: number, voxelSize: number) {
    this.capacity = capacity;
    // Cubes noticeably smaller than the cell so the real world shows through the gaps.
    const geometry = new BoxGeometry(voxelSize * 0.55, voxelSize * 0.55, voxelSize * 0.55);
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
   * Append voxels that have newly reached `minObservations`. Only dirty cells are examined and
   * only the appended buffer range is re-uploaded. Returns the total drawn count.
   */
  applyUpdates(grid: VoxelGrid, minObservations: number): number {
    const start = this.count;
    grid.drainDirty((key) => {
      if (this.count >= this.capacity) return;
      if (this.keyToInstance.has(key)) return;
      if (!grid.readVoxel(key, this.scratch) || this.scratch.count < minObservations) return;
      const slot = this.count++;
      this.keyToInstance.set(key, slot);
      this.dummy.position.set(this.scratch.cx, this.scratch.cy, this.scratch.cz);
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

  /** Drop all instances (used on Clear). */
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
