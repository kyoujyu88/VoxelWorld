/**
 * Grayscale depth visualization for Phase 2.
 *
 * `depthToRGBA` and `computeDepthStats` are pure and unit-tested. `DepthHeatmapView` is the
 * thin browser wrapper that pushes the RGBA bytes into a canvas via ImageData.
 */

import type { CpuDepthFrame, DepthSampleArray } from '../xr/depth';

export interface HeatmapOptions {
  /** Depth mapped to full white/black across [minMeters, maxMeters]; outside is clamped. */
  minMeters: number;
  maxMeters: number;
  /** true → nearer is brighter (default); false → nearer is darker. */
  nearBright?: boolean;
}

/**
 * Map raw depth samples to an RGBA byte array (length width*height*4).
 * Invalid samples (raw <= 0, i.e. no depth) become fully transparent so gaps are visible.
 */
export function depthToRGBA(
  raw: ArrayLike<number>,
  width: number,
  height: number,
  rawValueToMeters: number,
  opts: HeatmapOptions,
): Uint8ClampedArray {
  const nearBright = opts.nearBright ?? true;
  const range = Math.max(1e-6, opts.maxMeters - opts.minMeters);
  const count = width * height;
  const out = new Uint8ClampedArray(count * 4);

  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const rawVal = raw[i] || 0;
    if (rawVal <= 0) {
      out[o + 3] = 0; // transparent (rgb already 0)
      continue;
    }
    const meters = rawVal * rawValueToMeters;
    let t = (meters - opts.minMeters) / range;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const gray = Math.round(255 * (nearBright ? 1 - t : t));
    out[o] = gray;
    out[o + 1] = gray;
    out[o + 2] = gray;
    out[o + 3] = 255;
  }
  return out;
}

export interface DepthStats {
  totalCount: number;
  validCount: number;
  minMeters: number | null;
  maxMeters: number | null;
  medianMeters: number | null;
}

/** Summarize valid depth samples (min/median/max in meters and coverage). Pure. */
export function computeDepthStats(
  raw: ArrayLike<number>,
  width: number,
  height: number,
  rawValueToMeters: number,
): DepthStats {
  const total = width * height;
  const valid: number[] = [];
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < total; i++) {
    const rawVal = raw[i] || 0;
    if (rawVal <= 0) continue;
    const meters = rawVal * rawValueToMeters;
    valid.push(meters);
    if (meters < min) min = meters;
    if (meters > max) max = meters;
  }

  if (valid.length === 0) {
    return {
      totalCount: total,
      validCount: 0,
      minMeters: null,
      maxMeters: null,
      medianMeters: null,
    };
  }
  valid.sort((a, b) => a - b);
  const median = valid[Math.floor(valid.length / 2)];
  return {
    totalCount: total,
    validCount: valid.length,
    minMeters: min,
    maxMeters: max,
    medianMeters: median,
  };
}

/** Owns a canvas sized to the depth buffer; call update() each frame to redraw. */
export class DepthHeatmapView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private image: ImageData | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'depth-canvas';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
  }

  update(depth: CpuDepthFrame, opts: HeatmapOptions): void {
    const { width, height } = depth;
    if (this.canvas.width !== width || this.canvas.height !== height || !this.image) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.image = this.ctx.createImageData(width, height);
    }
    const rgba = depthToRGBA(
      depth.data as DepthSampleArray,
      width,
      height,
      depth.rawValueToMeters,
      opts,
    );
    this.image.data.set(rgba);
    this.ctx.putImageData(this.image, 0, 0);
  }
}
