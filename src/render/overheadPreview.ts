/**
 * Overhead (top-down, bird's-eye) preview of the accumulated voxels, drawn to its own 2D canvas
 * for the bottom half of the screen (Phase 5). Looking straight down the world -Y axis, each
 * canvas pixel keeps the color of the *topmost* voxel (largest world Y) whose XZ column maps to
 * it — so the map reads like a floor plan that fills in as you scan.
 *
 * It updates *incrementally* (Phase 5.1): each tick folds in only the cells the grid marked dirty
 * for the preview since the last call, painting them into a persistent image + height buffer. A
 * full sweep of the grid happens only on a rebuild — the first time data appears, or when growth
 * pushes a voxel outside the current fit (rare, thanks to fit margin). So the preview costs
 * O(new voxels) per tick, not O(grid), and no longer drags the AR frame rate down.
 *
 * The projection math (`computeFit` / `worldToPixel`) is pure and unit-tested; the class only
 * adds the canvas plumbing. The whole thing is a passive view of the grid — it never mutates it,
 * and if the 2D context is unavailable it degrades to a no-op rather than breaking the AR view.
 */

import type { VoxelGrid, VoxelView } from '../voxel/grid';

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
// Fit margin so ordinary growth stays inside the current fit and doesn't trigger a rebuild.
const FIT_MARGIN_FRAC = 0.08;
const FIT_MARGIN_MIN_M = 0.25;

export class OverheadPreview {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly img: ImageData | null;
  private readonly data: Uint8ClampedArray | null;
  private readonly topY: Float32Array;
  readonly width = PREVIEW_W;
  readonly height = PREVIEW_H;
  private fit: FitTransform | null = null;
  private readonly pending: number[] = [];
  private readonly scratch: VoxelView = { cx: 0, cy: 0, cz: 0, r: 0, g: 0, b: 0, count: 0 };

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = PREVIEW_W;
    canvas.height = PREVIEW_H;
    this.ctx = canvas.getContext('2d');
    this.img = this.ctx ? this.ctx.createImageData(PREVIEW_W, PREVIEW_H) : null;
    this.data = this.img ? this.img.data : null;
    this.topY = new Float32Array(PREVIEW_W * PREVIEW_H);
  }

  /**
   * Fold the grid's newly-confident voxels into the map. Common case: paint only the drained
   * dirty cells (O(new)). Rebuild (full sweep) only on first data or when growth escapes the fit.
   */
  update(grid: VoxelGrid, minObservations: number): void {
    if (!this.ctx || !this.img) return;
    if (grid.size === 0) {
      if (this.fit !== null) this.reset();
      return;
    }

    // Drain the preview's own dirty keys (independent of the renderer's dirty set).
    this.pending.length = 0;
    grid.drainDirtyPreview((k) => this.pending.push(k));

    if (this.fit === null) {
      this.rebuild(grid, minObservations);
      return;
    }

    // If any newly-confident voxel now falls outside the current fit, refit + full rebuild.
    for (const key of this.pending) {
      if (!grid.readVoxel(key, this.scratch) || this.scratch.count < minObservations) continue;
      const p = worldToPixel(this.fit, this.scratch.cx, this.scratch.cz);
      if (p.px < 0 || p.px >= this.width || p.py < 0 || p.py >= this.height) {
        this.rebuild(grid, minObservations);
        return;
      }
    }

    // Otherwise paint just the new voxels into the persistent buffer.
    for (const key of this.pending) {
      if (!grid.readVoxel(key, this.scratch) || this.scratch.count < minObservations) continue;
      const s = this.scratch;
      this.paint(s.cx, s.cy, s.cz, s.r, s.g, s.b);
    }
    this.blit();
  }

  /** Full redraw: refit to the (padded) grid bounds and repaint every confident cell. */
  private rebuild(grid: VoxelGrid, minObservations: number): void {
    const b = grid.getBounds();
    if (!b) {
      this.reset();
      return;
    }
    const mx = Math.max((b.maxX - b.minX) * FIT_MARGIN_FRAC, FIT_MARGIN_MIN_M);
    const mz = Math.max((b.maxZ - b.minZ) * FIT_MARGIN_FRAC, FIT_MARGIN_MIN_M);
    this.fit = computeFit(
      { minX: b.minX - mx, maxX: b.maxX + mx, minZ: b.minZ - mz, maxZ: b.maxZ + mz },
      this.width,
      this.height,
      PAD,
    );
    this.clearBuffers();
    grid.forEachConfidentPoint(minObservations, (cx, cy, cz, r, g, bl) =>
      this.paint(cx, cy, cz, r, g, bl),
    );
    this.blit();
  }

  /** Paint one voxel into the persistent buffer with a top-down z-test (topmost color wins). */
  private paint(cx: number, cy: number, cz: number, r: number, g: number, b: number): void {
    const f = this.fit;
    const data = this.data;
    if (!f || !data) return;
    const px = Math.round(f.cxPix + (cx - f.cxWorld) * f.scale);
    const py = Math.round(f.cyPix + (cz - f.czWorld) * f.scale);
    if (px < 0 || px >= this.width || py < 0 || py >= this.height) return;
    const idx = py * this.width + px;
    if (cy <= this.topY[idx]) return; // a higher voxel already owns this pixel
    this.topY[idx] = cy;
    const d = idx * 4;
    data[d] = r; // Uint8ClampedArray rounds + clamps the float means
    data[d + 1] = g;
    data[d + 2] = b;
    data[d + 3] = 255;
  }

  private clearBuffers(): void {
    const data = this.data;
    if (!data) return;
    for (let i = 0; i < this.width * this.height; i++) {
      const d = i * 4;
      data[d] = BG[0];
      data[d + 1] = BG[1];
      data[d + 2] = BG[2];
      data[d + 3] = 255;
      this.topY[i] = -Infinity;
    }
  }

  private blit(): void {
    if (!this.ctx || !this.img) return;
    this.ctx.putImageData(this.img, 0, 0);
    if (this.fit) {
      this.drawScaleBar(this.ctx, this.fit);
      this.drawOrigin(this.ctx, this.fit);
    }
  }

  /** Reset the map to empty (used on Clear and when the grid is emptied). */
  reset(): void {
    this.fit = null;
    this.clearBuffers();
    if (this.ctx && this.img) this.ctx.putImageData(this.img, 0, 0);
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
