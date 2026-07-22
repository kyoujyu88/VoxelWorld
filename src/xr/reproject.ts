/**
 * Reproject CPU depth texels to world-space points.
 *
 * Depth is the perpendicular eye-space distance (docs/RESEARCH.md Q7), so for each texel we:
 *   1. map its normalized depth-buffer coord to a normalized view coord via
 *      inverse(normDepthBufferFromNormView);
 *   2. turn that into an NDC xy and unproject a near-plane clip point with inverse(projection)
 *      to get the eye-space ray direction;
 *   3. scale the ray so its eye-space Z magnitude equals the measured depth;
 *   4. transform the eye-space point to world with view.transform (eye -> world).
 *
 * `flipY` selects the NDC y convention; it is validated on-device (R6). All heavy objects are
 * reused across calls to avoid per-sample allocation.
 */

import { Matrix4, Vector4, Vector3 } from 'three';
import type { CpuDepthFrame } from './depth';

export interface ReprojectOptions {
  minMeters: number;
  maxMeters: number;
  /** Subsample stride in texels (1 = every texel). */
  stride?: number;
  /** Flip normalized-view Y when forming NDC. Device convention; validated on-device (R6). */
  flipY?: boolean;
}

/** Called for each reprojected point: world x/y/z plus the source texel column/row. */
export type PointSink = (x: number, y: number, z: number, col: number, row: number) => void;

const _ndbToView = new Matrix4();
const _invProj = new Matrix4();
const _viewToWorld = new Matrix4();
const _view = new Vector4();
const _eye = new Vector4();
const _world = new Vector3();

export function reprojectDepthFrame(
  depth: CpuDepthFrame,
  projectionMatrix: ArrayLike<number>,
  viewTransformMatrix: ArrayLike<number>,
  options: ReprojectOptions,
  sink: PointSink,
): number {
  const nd = depth.normDepthFromNormViewMatrix;
  if (!nd) return 0;

  const stride = Math.max(1, Math.floor(options.stride ?? 1));
  const flipY = options.flipY ?? true;
  const { width: W, height: H, data, rawValueToMeters } = depth;

  _ndbToView.fromArray(nd).invert(); // normDepthBuffer -> normView
  _invProj.fromArray(projectionMatrix).invert(); // clip -> eye
  _viewToWorld.fromArray(viewTransformMatrix); // eye -> world

  let emitted = 0;
  for (let row = 0; row < H; row += stride) {
    for (let col = 0; col < W; col += stride) {
      const raw = data[col + row * W];
      if (raw <= 0) continue;
      const d = raw * rawValueToMeters;
      if (d < options.minMeters || d > options.maxMeters) continue;

      // texel-center normalized depth-buffer coord -> normalized view coord
      _view.set((col + 0.5) / W, (row + 0.5) / H, 0, 1).applyMatrix4(_ndbToView);
      const vw = _view.w !== 0 ? 1 / _view.w : 1;
      const nvx = _view.x * vw;
      const nvy = _view.y * vw;

      // normalized view coord -> NDC xy
      const ndcX = nvx * 2 - 1;
      const ndcY = flipY ? 1 - nvy * 2 : nvy * 2 - 1;

      // unproject a near-plane point to get the eye-space ray direction
      _eye.set(ndcX, ndcY, -1, 1).applyMatrix4(_invProj);
      const ew = _eye.w !== 0 ? 1 / _eye.w : 1;
      const dirZ = _eye.z * ew;
      if (dirZ === 0) continue;

      // scale so eye-space Z == -d (camera looks down -Z), then eye -> world
      const t = -d / dirZ;
      _world.set(_eye.x * ew * t, _eye.y * ew * t, dirZ * t).applyMatrix4(_viewToWorld);
      sink(_world.x, _world.y, _world.z, col, row);
      emitted++;
    }
  }
  return emitted;
}
