/**
 * Fuses one depth measurement into the TSDF grid.
 *
 * A measurement doesn't just mark the surface cell occupied — it makes a statement about a whole
 * band of space along its view ray: cells in front of the hit are that much *empty*, cells behind
 * it are that much *inside*. Walking that band and averaging the signed distances is what lets the
 * surface settle onto its true position instead of scattering into a shell of separate cells
 * (KinectFusion / Open3D / voxblox all integrate this way).
 *
 * The band is ±`truncation` around the hit, expressed in perpendicular depth: a sample at
 * perpendicular depth `depth + s` has signed distance `-s` (positive in front, negative behind).
 * Because the reprojected point already sits at perpendicular depth `depth`, offsetting along the
 * unit ray by `s * (rayLength / depth)` moves exactly `s` in perpendicular depth.
 */

import { azimuthBit, type VoxelGrid } from './grid';

export interface FuseOptions {
  /** How far in front of the hit (toward the camera) to mark free (m). Default: grid truncation. */
  truncation?: number;
  /**
   * How far behind the hit to mark as inside (m). Default: half the front extent — the negative
   * side only has to be deep enough to define the crossing, and every cell it writes is a cell to
   * store, so keeping it short leaves more of the budget for actual surface.
   */
  backTruncation?: number;
  /** Sample spacing along the ray (m). Defaults to one voxel. */
  step?: number;
  /** Only samples within this distance of the hit take the color (m). Defaults to one voxel. */
  colorBand?: number;
}

/**
 * Integrate one reprojected depth sample.
 *
 * `cx/cy/cz` is the camera position, `px/py/pz` the measured surface point, and `depth` the
 * perpendicular depth that produced it. `weight` is the measurement confidence — callers use
 * ~1/depth² since depth error grows steeply with range. Returns the number of cells touched.
 */
export function fuseDepthSample(
  grid: VoxelGrid,
  cx: number,
  cy: number,
  cz: number,
  px: number,
  py: number,
  pz: number,
  depth: number,
  weight: number,
  r: number,
  g: number,
  b: number,
  options: FuseOptions = {},
): number {
  if (!(depth > 0) || !(weight > 0)) return 0;

  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  const rayLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(rayLength > 0)) return 0;

  const trunc = options.truncation ?? grid.truncation;
  const backTrunc = options.backTruncation ?? trunc * 0.5;
  const step = options.step ?? grid.voxelSize;
  const colorBand = options.colorBand ?? grid.voxelSize;
  if (!(step > 0)) return 0;

  // Unit ray scaled so a step of 1 in perpendicular depth moves 1 unit of `depth` along the ray.
  const k = rayLength / depth / rayLength; // = 1 / depth, applied to the (unnormalized) ray
  const ux = dx * k;
  const uy = dy * k;
  const uz = dz * k;

  // How well this measurement knows the band it is about to write: taken from `depth` metres, from
  // this horizontal direction. Computed once and passed to every cell in the band — the grid folds
  // both in idempotently, so the repetition costs nothing and can't overstate the coverage.
  const dirBit = azimuthBit(dx, dz);

  let touched = 0;
  for (let s = -trunc; s <= backTrunc + 1e-9; s += step) {
    const sx = px + ux * s;
    const sy = py + uy * s;
    const sz = pz + uz * s;
    const colorWeight = s >= -colorBand && s <= colorBand ? weight : 0;
    grid.integrate(sx, sy, sz, -s, weight, r, g, b, colorWeight, depth, dirBit);
    touched++;
  }
  return touched;
}
