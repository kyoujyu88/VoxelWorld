/**
 * Overhead (top-down, bird's-eye) preview of the accumulated voxels, drawn to its own 2D canvas
 * for the bottom half of the screen (Phase 5). Looking straight down the world -Y axis, each
 * canvas pixel keeps the color of the *topmost* voxel (largest world Y) whose XZ column maps to
 * it — so the map reads like a floor plan that fills in as you scan.
 *
 * The projection math (`computeFit` / `worldToPixel`) is pure and unit-tested; the class only
 * adds the canvas plumbing. The whole thing is a passive view of the grid — it never mutates it,
 * and if the 2D context is unavailable it degrades to a no-op rather than breaking the AR view.
 */

import type { VoxelGrid } from '../voxel/grid';

/** World-space XZ extent of the occupied cells (meters). */
export interface OverheadBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Precomputed world→pixel transform: uniform scale (px/m) about the data/canvas centers. */
export interface FitTransform {
  scale: number;
  cxWorld: number;
  czWorld: number;
  cxPix: number;
  cyPix: number;
}

/**
 * Fit an XZ bounding box into a `w`×`h` canvas (minus `pad` on every side), preserving aspect
 * ratio and centering the data's midpoint on the canvas center. `minSpan` guards against a
 * zero-size box (a single column) blowing the scale up to Infinity, and — because we scale about
 * the midpoint — keeps a lone voxel centered rather than pinned to a corner.
 */
export function computeFit(
  b: OverheadBounds,
  w: number,
  h: number,
  pad: number,
  minSpan = 0.1,
): FitTransform {
  const spanX = Math.max(b.maxX - b.minX, minSpan);
  const spanZ = Math.max(b.maxZ - b.minZ, minSpan);
  const availW = Math.max(1, w - 2 * pad);
  const availH = Math.max(1, h - 2 * pad);
  const scale = Math.min(availW / spanX, availH / spanZ);
  return {
    scale,
    cxWorld: (b.minX + b.maxX) / 2,
    czWorld: (b.minZ + b.maxZ) / 2,
    cxPix: w / 2,
    cyPix: h / 2,
  };
}

/**
 * Map a world point to an integer canvas pixel. +X goes right; -Z (the direction the user
 * initially faced in local-floor space) reads as "up" on the map, so +Z goes down.
 */
export function worldToPixel(f: FitTransform, x: number, z: number): { px: number; py: number } {
  return {
    px: Math.round(f.cxPix + (x - f.cxWorld) * f.scale),
    py: Math.round(f.cyPix + (z - f.czWorld) * f.scale),
  };
}

/** Choose a "nice" scale-bar length (meters) that fits within `maxPx` at the given px/m scale. */
export function niceBarMeters(scale: number, maxPx: number): number {
  const candidates = [0.25, 0.5, 1, 2, 5, 10];
  let best = candidates[0];
  for (const m of candidates) {
    if (m * scale <= maxPx) best = m;
  }
  return best;
}

const PREVIEW_W = 360;
const PREVIEW_H = 240;
const PAD = 12;
const BG: [number, number, number] = [18, 20, 26];

export class OverheadPreview {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly img: ImageData | null;
  private readonly topY: Float32Array;
  readonly width = PREVIEW_W;
  readonly height = PREVIEW_H;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = PREVIEW_W;
    canvas.height = PREVIEW_H;
    this.ctx = canvas.getContext('2d');
    this.img = this.ctx ? this.ctx.createImageData(PREVIEW_W, PREVIEW_H) : null;
    this.topY = new Float32Array(PREVIEW_W * PREVIEW_H);
  }

  /**
   * Redraw the whole map from the grid's confident cells. Returns the number of confident cells.
   * Cheap enough to call at ~10 fps: two allocation-free sweeps of the grid (bounds, then paint).
   */
  render(grid: VoxelGrid, minObservations: number): number {
    const ctx = this.ctx;
    const img = this.img;
    if (!ctx || !img) return 0;

    const data = img.data;
    const px = PREVIEW_W;
    const py = PREVIEW_H;

    // Reset background + per-pixel height buffer.
    for (let i = 0; i < px * py; i++) {
      const d = i * 4;
      data[d] = BG[0];
      data[d + 1] = BG[1];
      data[d + 2] = BG[2];
      data[d + 3] = 255;
      this.topY[i] = -Infinity;
    }

    // Pass 1: XZ bounds over confident cells.
    let has = false;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let count = 0;
    grid.forEachConfidentPoint(minObservations, (cx, _cy, cz) => {
      has = true;
      count++;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cz < minZ) minZ = cz;
      if (cz > maxZ) maxZ = cz;
    });

    if (!has) {
      ctx.putImageData(img, 0, 0);
      return 0;
    }

    const fit = computeFit({ minX, maxX, minZ, maxZ }, px, py, PAD);

    // Pass 2: paint the topmost voxel color per pixel (bird's-eye occlusion).
    grid.forEachConfidentPoint(minObservations, (cx, cy, cz, r, g, b) => {
      const p = worldToPixel(fit, cx, cz);
      if (p.px < 0 || p.px >= px || p.py < 0 || p.py >= py) return;
      const idx = p.py * px + p.px;
      if (cy <= this.topY[idx]) return; // a higher voxel already owns this pixel
      this.topY[idx] = cy;
      const d = idx * 4;
      data[d] = r; // Uint8ClampedArray rounds + clamps the float means
      data[d + 1] = g;
      data[d + 2] = b;
      data[d + 3] = 255;
    });

    ctx.putImageData(img, 0, 0);
    this.drawScaleBar(ctx, fit);
    this.drawOrigin(ctx, fit);
    return count;
  }

  clearCanvas(): void {
    const ctx = this.ctx;
    const img = this.img;
    if (!ctx || !img) return;
    const data = img.data;
    for (let i = 0; i < PREVIEW_W * PREVIEW_H; i++) {
      const d = i * 4;
      data[d] = BG[0];
      data[d + 1] = BG[1];
      data[d + 2] = BG[2];
      data[d + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  private drawScaleBar(ctx: CanvasRenderingContext2D, fit: FitTransform): void {
    const meters = niceBarMeters(fit.scale, PREVIEW_W * 0.3);
    const barPx = meters * fit.scale;
    const x0 = 12;
    const y0 = PREVIEW_H - 14;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + barPx, y0);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillText(meters >= 1 ? `${meters} m` : `${meters * 100} cm`, x0, y0 - 3);
  }

  private drawOrigin(ctx: CanvasRenderingContext2D, fit: FitTransform): void {
    const o = worldToPixel(fit, 0, 0);
    if (o.px < 0 || o.px >= PREVIEW_W || o.py < 0 || o.py >= PREVIEW_H) return;
    ctx.strokeStyle = 'rgba(120,200,255,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(o.px - 5, o.py);
    ctx.lineTo(o.px + 5, o.py);
    ctx.moveTo(o.px, o.py - 5);
    ctx.lineTo(o.px, o.py + 5);
    ctx.stroke();
  }
}
