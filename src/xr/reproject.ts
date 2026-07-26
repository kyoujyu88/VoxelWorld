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
  /**
   * Slant (tan of the surface angle away from head-on) above which a sample is treated as a depth
   * discontinuity rather than a steep surface, and dropped. Default 8 (~83°): a genuinely grazing
   * wall reads ~3-8, while a texel straddling a silhouette jumps by the object's standoff — tens
   * of centimetres — which lands far above.
   */
  edgeSlant?: number;
  /** Floor on the grazing weight, so a steep-but-real surface is slow, not discarded. Default 0.1. */
  minQuality?: number;
  /** Depth-noise deadband: `noiseAbs + noiseRel * depth` metres. Defaults 0.003 m and 0.01 (1%). */
  noiseAbs?: number;
  noiseRel?: number;
}

/** Optional per-call counters. Pass the same object every frame to avoid allocating. */
export interface ReprojectStats {
  emitted: number;
  rejectedEdge: number;
}

/**
 * Surface slant at a texel, as tan(angle away from head-on), from the depth gradient across its
 * neighbours.
 *
 * For a locally flat surface, two rays `stride` texels apart are `d * lateral * stride` apart
 * sideways at depth `d`, so the depth step over that run is the surface's slope. The two axes are
 * combined in quadrature — that is the gradient magnitude, i.e. the steepest slope at the texel,
 * regardless of which way the surface is tilted.
 *
 * A neighbour depth of 0 means "no measurement" (it is also the out-of-bounds sentinel), so it
 * contributes nothing: a missing neighbour must never read as an edge, or every hole would erode
 * its own rim. `noise` is a deadband subtracted from each depth step so sensor jitter on a
 * head-on surface doesn't register as slant — without it the close, head-on measurements this
 * whole filter exists to favour would be the ones penalised.
 */
export function slantTangent(
  d: number,
  dRight: number,
  dDown: number,
  lateralX: number,
  lateralY: number,
  stride: number,
  noise: number,
): number {
  if (!(d > 0)) return 0;
  let sx = 0;
  let sy = 0;
  const runX = d * lateralX * stride;
  if (dRight > 0 && runX > 0) {
    sx = Math.max(0, Math.abs(dRight - d) - noise) / runX;
  }
  const runY = d * lateralY * stride;
  if (dDown > 0 && runY > 0) {
    sy = Math.max(0, Math.abs(dDown - d) - noise) / runY;
  }
  return Math.sqrt(sx * sx + sy * sy);
}

/**
 * True when the slant is too steep to be a real surface, so the sample straddles a depth
 * discontinuity. These "flying pixels" at object contours are the classic RGB-D artifact: the
 * texel averages foreground and background, and reprojects into thin air — the tail smeared
 * behind an object.
 */
export function isDepthEdge(slant: number, threshold: number): boolean {
  return slant > threshold;
}

/**
 * Confidence multiplier for a measurement at the given slant, `cos(angle)`. A grazing ray pins the
 * surface poorly along its own direction and its footprint is stretched by 1/cos, so it carries
 * proportionally less information — voxblox's anti-grazing weighting. 1 head-on, 0.71 at 45°,
 * 0.31 at 72°. The floor keeps a legitimately steep surface (a floor seen at a shallow angle)
 * merely slow to build rather than effectively discarded.
 */
export function qualityFromSlant(slant: number, minQuality = 0.1): number {
  const q = 1 / Math.sqrt(1 + slant * slant);
  return q > minQuality ? q : minQuality;
}

/**
 * Called for each reprojected point: world x/y/z, the source texel's normalized view coordinates
 * (u, v), the measured depth in meters, and a 0..1 quality factor. Because the camera image is
 * aligned to the XRView, (u, v) double as the camera-image UV for per-voxel color sampling.
 * `depth` is how far away the measurement was taken — near measurements are far more accurate.
 * `quality` falls off as the surface turns away from the camera (see `qualityFromSlant`); callers
 * fold both into the fusion weight.
 */
export type PointSink = (
  x: number,
  y: number,
  z: number,
  u: number,
  v: number,
  depth: number,
  quality: number,
) => void;

const _ndbToView = new Matrix4();
const _invProj = new Matrix4();
const _viewToWorld = new Matrix4();
const _view = new Vector4();
const _eye = new Vector4();
const _world = new Vector3();
const _ray = new Vector3();
const _rayA = new Vector3();

/**
 * Ray direction, per unit of perpendicular depth, for a texel center — i.e. the eye-space point at
 * depth 1 along that texel's ray. Differencing two of these gives how far apart neighbouring rays
 * spread per metre of depth, which is what turns a depth step into a surface slant without having
 * to assume a field of view.
 */
function texelRayPerDepth(col: number, row: number, W: number, H: number, flipY: boolean): Vector3 {
  _view.set((col + 0.5) / W, (row + 0.5) / H, 0, 1).applyMatrix4(_ndbToView);
  const vw = _view.w !== 0 ? 1 / _view.w : 1;
  const ndcX = _view.x * vw * 2 - 1;
  const nvy = _view.y * vw;
  const ndcY = flipY ? 1 - nvy * 2 : nvy * 2 - 1;
  _eye.set(ndcX, ndcY, -1, 1).applyMatrix4(_invProj);
  const ew = _eye.w !== 0 ? 1 / _eye.w : 1;
  const z = _eye.z * ew;
  const inv = z !== 0 ? 1 / Math.abs(z) : 0;
  return _ray.set(_eye.x * ew * inv, _eye.y * ew * inv, 0);
}

export function reprojectDepthFrame(
  depth: CpuDepthFrame,
  projectionMatrix: ArrayLike<number>,
  viewTransformMatrix: ArrayLike<number>,
  options: ReprojectOptions,
  sink: PointSink,
  stats?: ReprojectStats,
): number {
  const nd = depth.normDepthFromNormViewMatrix;
  if (!nd) return 0;

  const stride = Math.max(1, Math.floor(options.stride ?? 1));
  const flipY = options.flipY ?? true;
  const edgeSlant = options.edgeSlant ?? 8;
  const minQuality = options.minQuality ?? 0.1;
  const noiseAbs = options.noiseAbs ?? 0.003;
  const noiseRel = options.noiseRel ?? 0.01;
  const { width: W, height: H, data, rawValueToMeters } = depth;

  _ndbToView.fromArray(nd).invert(); // normDepthBuffer -> normView
  _invProj.fromArray(projectionMatrix).invert(); // clip -> eye
  _viewToWorld.fromArray(viewTransformMatrix); // eye -> world

  // How far apart neighbouring texel rays spread, per metre of depth. Measured once per frame at
  // the image center through the same unprojection the loop uses, so it needs no FOV assumption.
  // Both are full 2D lengths on purpose: the depth buffer is not axis-aligned with the view on
  // this device (160x90 landscape buffer, portrait view — normDepthBufferFromNormView carries a
  // rotation), so stepping a column can move along view Y. Taking a single component would read
  // as zero spread there and silently disable the filter.
  const midC = Math.floor(W / 2);
  const midR = Math.floor(H / 2);
  _rayA.copy(texelRayPerDepth(midC, midR, W, H, flipY));
  const lateralX = texelRayPerDepth(midC + 1, midR, W, H, flipY).distanceTo(_rayA);
  const lateralY = texelRayPerDepth(midC, midR + 1, W, H, flipY).distanceTo(_rayA);

  let emitted = 0;
  let rejectedEdge = 0;
  for (let row = 0; row < H; row += stride) {
    for (let col = 0; col < W; col += stride) {
      const raw = data[col + row * W];
      if (raw <= 0) continue;
      const d = raw * rawValueToMeters;
      if (d < options.minMeters || d > options.maxMeters) continue;

      // Surface slant from the forward neighbours. The column bound must be checked explicitly:
      // reading past the row would wrap to the next row's first texel and fabricate an edge on
      // every right-hand column. Neighbours are read straight out of `data` rather than through
      // metersAt, which the tests stub out.
      const dRight = col + stride < W ? data[col + stride + row * W] * rawValueToMeters : 0;
      const dDown = row + stride < H ? data[col + (row + stride) * W] * rawValueToMeters : 0;
      const slant = slantTangent(
        d,
        dRight,
        dDown,
        lateralX,
        lateralY,
        stride,
        noiseAbs + noiseRel * d,
      );
      if (isDepthEdge(slant, edgeSlant)) {
        rejectedEdge++;
        continue; // flying pixel at an object contour — reprojects into empty space
      }
      const quality = qualityFromSlant(slant, minQuality);

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
      sink(_world.x, _world.y, _world.z, nvx, nvy, d, quality);
      emitted++;
    }
  }
  if (stats) {
    stats.emitted = emitted;
    stats.rejectedEdge = rejectedEdge;
  }
  return emitted;
}
