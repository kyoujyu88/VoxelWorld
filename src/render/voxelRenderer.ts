/**
 * Renders accumulated voxels as an InstancedMesh of small colored cubes.
 *
 * This is the display path (Phase 3 keeps it simple: full rebuild from the grid, throttled by
 * the caller). Phase 4 hardens it for the 100k-voxel / 30fps target. Export uses a separate
 * greedy-meshed path, so InstancedMesh instance colors never need to round-trip to glTF.
 */

import { InstancedMesh, BoxGeometry, MeshBasicMaterial, Object3D, Color } from 'three';
import type { VoxelGrid } from '../voxel/grid';

export class VoxelRenderer {
  readonly mesh: InstancedMesh;
  readonly capacity: number;
  private readonly dummy = new Object3D();
  private readonly color = new Color();

  constructor(capacity: number, voxelSize: number) {
    this.capacity = capacity;
    const geometry = new BoxGeometry(voxelSize * 0.9, voxelSize * 0.9, voxelSize * 0.9);
    const material = new MeshBasicMaterial();
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    // Allocate the per-instance color buffer up front, then start empty.
    this.mesh.setColorAt(0, this.color.setRGB(1, 1, 1));
    this.mesh.count = 0;
  }

  /** Rebuild instances from voxels observed at least `minObservations` times. Returns count drawn. */
  rebuild(grid: VoxelGrid, minObservations: number): number {
    let i = 0;
    grid.forEach(minObservations, (v) => {
      if (i >= this.capacity) return;
      this.dummy.position.set(v.cx, v.cy, v.cz);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, this.color.setRGB(v.r / 255, v.g / 255, v.b / 255));
      i++;
    });
    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return i;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.dispose();
  }
}
