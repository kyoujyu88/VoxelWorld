/**
 * Free-space carving: remove voxels that float in front of the real surface.
 *
 * Naive depth accumulation leaves spurious voxels hanging in empty space (noisy far depth,
 * transient objects, reprojection error). Once you get closer, your depth rays pass *through* that
 * space to the real surface behind — proving it's empty. This module reverses the reprojection in
 * `reproject.ts`: it projects a voxel's world center back into the current depth image and reports
 * whether the measured surface is meaningfully *behind* the voxel (so the voxel sits in free space
 * and should be carved away).
 *
 * The reverse path mirrors the forward one (device-validated, R6): world -> eye (inverse view) ->
 * clip (projection) -> NDC -> normalized view -> normalized depth-buffer (normDepthFromNormView) ->
 * texel. Heavy objects are reused so a full carve sweep allocates nothing per voxel.
 */

import { Matrix4, Vector4 } from 'three';
import type { CpuDepthFrame } from './depth';

/** The occupancy rule: a valid measurement meaningfully farther than the voxel means free space. */
export function isFreeSpace(voxelDepth: number, measuredDepth: number, margin: number): boolean {
  return measuredDepth > 0 && measuredDepth > voxelDepth + margin;
}

export interface CarveOptions {
  /** NDC-y convention (must match the reprojection flipY). */
  flipY: boolean;
  /** Metres the surface must lie beyond the voxel before it's judged free (noise guard). */
  margin: number;
  /** Voxels nearer than this (metres) are ignored — too close to trust / behind the near plane. */
  minDepth: number;
}

/**
 * Holds the per-frame matrices + depth image and answers `testFree(x,y,z)` for any world point.
 * Call `update()` once per frame with the current view/depth, then query many voxels.
 */
export class CarveContext {
  private readonly invView = new Matrix4();
  private readonly proj = new Matrix4();
  private readonly ndbFromView = new Matrix4();
  private readonly eye = new Vector4();
  private readonly ndb = new Vector4();
  private width = 0;
  private height = 0;
  private flipY = true;
  private margin = 0.08;
  private minDepth = 0.2;
  private depth: CpuDepthFrame | null = null;
  ready = false;

  update(
    projectionMatrix: ArrayLike<number>,
    viewTransformMatrix: ArrayLike<number>,
    depth: CpuDepthFrame,
    options: CarveOptions,
  ): void {
    const nd = depth.normDepthFromNormViewMatrix;
    if (!nd) {
      this.ready = false;
      return;
    }
    this.invView.fromArray(viewTransformMatrix).invert(); // world -> eye
    this.proj.fromArray(projectionMatrix); // eye -> clip
    this.ndbFromView.fromArray(nd); // normView -> normalized depth buffer
    this.width = depth.width;
    this.height = depth.height;
    this.flipY = options.flipY;
    this.margin = options.margin;
    this.minDepth = options.minDepth;
    this.depth = depth;
    this.ready = true;
  }

  /** True if the voxel sits in free space in front of the measured surface (should be carved). */
  testFree(wx: number, wy: number, wz: number): boolean {
    const depth = this.depth;
    if (!this.ready || !depth) return false;

    const eye = this.eye.set(wx, wy, wz, 1).applyMatrix4(this.invView); // eye space (w stays 1)
    const voxelDepth = -eye.z; // perpendicular distance (camera looks down -Z)
    if (voxelDepth <= this.minDepth) return false;

    eye.applyMatrix4(this.proj); // now clip space
    if (eye.w <= 0) return false;
    const iw = 1 / eye.w;
    const ndcX = eye.x * iw;
    const ndcY = eye.y * iw;
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) return false; // off-screen

    const nvx = (ndcX + 1) * 0.5;
    const nvy = this.flipY ? (1 - ndcY) * 0.5 : (ndcY + 1) * 0.5;

    const ndb = this.ndb.set(nvx, nvy, 0, 1).applyMatrix4(this.ndbFromView);
    const qw = ndb.w !== 0 ? 1 / ndb.w : 1;
    const col = Math.round(ndb.x * qw * this.width - 0.5);
    const row = Math.round(ndb.y * qw * this.height - 0.5);

    const measured = depth.metersAt(col, row);
    return isFreeSpace(voxelDepth, measured, this.margin);
  }
}
