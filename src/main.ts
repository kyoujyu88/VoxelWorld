import './style.css';
import * as THREE from 'three';
import { probeXRSupport } from './xr/capabilities';
import { requestArSession, readSessionInfo, type SessionInfo } from './xr/session';
import { readCpuDepthFrame, type CpuDepthFrame } from './xr/depth';
import { reprojectDepthFrame, type ReprojectStats } from './xr/reproject';
import { computeDepthStats } from './render/depthHeatmap';
import { CameraColorReader, type RGB } from './xr/cameraColor';
import { VoxelGrid } from './voxel/grid';
import { fuseDepthSample } from './voxel/fuse';
import { VoxelRenderer } from './render/voxelRenderer';
import { OverheadPreview } from './render/overheadPreview';
import { CarveContext } from './xr/carve';
import { renderCapabilityStatus, renderKVTable, type KV } from './ui/probePanel';
import { StageTimer } from './ui/stageTimer';
import { el, clear } from './ui/dom';

declare const __BUILD_ID__: string;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app container not found');

const VOXEL_SIZE = 0.02; // internal fine grid (2 cm)
const MIN_M = 0.3; // accumulate depths in [MIN_M, MAX_M]; ARCore is most accurate 0.5–5 m
const MAX_M = 3.0; // far depth is noisiest; capping the range curbs drift and spurious voxels
const STRIDE = 3; // subsample the depth buffer; each sample now fuses a whole band, not one cell
// TSDF fusion parameters. Weight is ~1/depth² (voxblox: depth error grows steeply with range)
// and the per-cell total is capped, so a well-scanned surface is barely moved by a distant look.
const MAX_WEIGHT = 20; // per-cell weight ceiling — keeps the map able to heal
const MIN_W_DEFAULT = 3; // accumulated weight a cell needs before it is drawn
const MIN_W_MAX = 12; // slider max
const FREE_WEIGHT = 2; // weight of one "I see through here" observation from the carve pass
const TRUNCATION = 0.04; // ±4cm band around a hit that each measurement updates (2 voxels)
const EDGE_SLANT = 8; // slant (~83°) above which a sample straddles a depth edge and is dropped
const STATS_MS = 250; // HUD stats / thumbnail / FPS update cadence
const PREVIEW_MS = 150; // overhead preview redraw cadence (~7 Hz; incremental)
const CAMERA_MS = 100; // camera-image readback cadence (~10 Hz; readback is a GPU stall)
const MAX_FACTOR = 8; // display voxel size up to 8× base = 16 cm
const CARVE_BUDGET = 16000; // voxels tested for free-space carving per frame (amortized full sweep)
const CARVE_MARGIN = 0.08; // surface must be ≥8cm beyond a voxel before it's carved (noise guard)
const CARVE_MIN_DEPTH = 0.2; // ignore voxels nearer than this to the camera when carving
const CAMERA_W = 96; // downsampled camera readback size (portrait, ~855:1920)
const CAMERA_H = 214;
// Instance budget, split by confidence tier. Confirmed cells are what a finished scan is made of,
// so they get the larger share; provisional ones are transient by nature.
const CONFIRMED_CAP = 180_000;
const PROVISIONAL_CAP = 120_000;
const RENDER_CAP = CONFIRMED_CAP + PROVISIONAL_CAP;
const GRID_CAP = 2_000_000; // max internal 2cm cells — larger fields fit before hitting the cap
// Confidence: weight needed before a cell can lock in, and how far a single look can confirm from.
const CONFIRM_WEIGHT = 8;
const CONFIRM_DIST_DEFAULT = 1.0;
const CONFIRM_DIST_MIN = 0.4;
const CONFIRM_DIST_MAX = 2.0;

// Height-based fallback color window (local-space Y), floor..ceiling.
const HEIGHT_LO = -1.3;
const HEIGHT_HI = 1.7;

type ColorMode = 'camera' | 'height';

interface ScanState {
  accumulating: boolean;
  colorMode: ColorMode;
  camFlipX: boolean;
  camFlipY: boolean;
  displayFactor: number; // display/export voxel size = displayFactor × base (2cm); 1 = live 2cm
  minWeight: number; // accumulated weight a cell needs to be drawn/kept
}

async function main(app: HTMLDivElement): Promise<void> {
  const header = el('header', { className: 'app-header' }, [
    el('h1', { textContent: 'VoxelWorld — WebXR ボクセルスキャナ' }),
    el('p', {
      className: 'subtitle',
      textContent:
        'Phase 8b: 信頼度でボクセルを確定 — よく観測できたボクセルは不透明になって固定され、離れても消えません。半透明のままのボクセルは「まだ精度が足りない＝近づいて」の合図です。',
    }),
  ]);

  const statusSlot = el('div', { className: 'slot' });
  const actionSlot = el('div', { className: 'slot' });
  const errorSlot = el('div', { className: 'slot' });
  const buildFooter = el('p', { className: 'build-stamp', textContent: `build: ${__BUILD_ID__}` });
  app.append(header, statusSlot, actionSlot, errorSlot, buildFooter);

  const status = await probeXRSupport();
  statusSlot.append(renderCapabilityStatus(status));

  const startBtn = el('button', {
    className: 'primary',
    textContent: 'AR + 深度センシングを開始',
    disabled: !status.ready,
  });
  actionSlot.append(startBtn);

  if (status.ready) {
    actionSlot.append(
      el('p', {
        className: 'hint',
        textContent:
          '開始後、端末をゆっくり動かすと見た面にボクセルが積もります。色はカメラ映像から取得します（失敗時は高さ色）。',
      }),
    );
  }

  startBtn.addEventListener('click', () => {
    startBtn.disabled = true;
    clear(errorSlot);
    void startAR(errorSlot).finally(() => {
      startBtn.disabled = false;
    });
  });
}

async function startAR(errorSlot: HTMLElement): Promise<void> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.domElement.classList.add('xr-canvas');
  document.body.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();

  const grid = new VoxelGrid({
    voxelSize: VOXEL_SIZE,
    maxVoxels: GRID_CAP,
    truncation: TRUNCATION,
    maxWeight: MAX_WEIGHT,
    confirmWeight: CONFIRM_WEIGHT,
    confirmDist: CONFIRM_DIST_DEFAULT,
  });
  const voxels = new VoxelRenderer(CONFIRMED_CAP, PROVISIONAL_CAP, VOXEL_SIZE);
  scene.add(voxels.root);

  const state: ScanState = {
    accumulating: true,
    colorMode: 'camera',
    camFlipX: false,
    camFlipY: true,
    displayFactor: 1,
    minWeight: MIN_W_DEFAULT,
  };
  const heightColor = new THREE.Color();
  const camRGB: RGB = { r: 0, g: 0, b: 0 };

  const overlay = el('div', { className: 'xr-overlay' });
  const hud = el('div', { className: 'hud' });
  const overheadCanvas = el('canvas', { className: 'overhead' });
  const thumbCanvas = el('canvas', { className: 'cam-thumb', width: CAMERA_W, height: CAMERA_H });
  const statsSlot = el('div', { className: 'stats' });
  const sizeSlider = el('input', {
    type: 'range',
    min: '1',
    max: String(MAX_FACTOR),
    step: '1',
    value: '1',
    className: 'size-slider',
  });
  const sizeLabel = el('span', { className: 'size-label', textContent: '2cm' });
  const sizeRow = el('div', { className: 'size-row' }, [
    el('span', { className: 'size-cap', textContent: '表示サイズ' }),
    sizeSlider,
    sizeLabel,
  ]);
  const stabSlider = el('input', {
    type: 'range',
    min: '1',
    max: String(MIN_W_MAX),
    step: '1',
    value: String(MIN_W_DEFAULT),
    className: 'size-slider',
  });
  const stabLabel = el('span', {
    className: 'size-label',
    textContent: `${MIN_W_DEFAULT} / ${MAX_WEIGHT}`,
  });
  const stabRow = el('div', { className: 'size-row' }, [
    el('span', { className: 'size-cap', textContent: 'ノイズ除去' }),
    stabSlider,
    stabLabel,
  ]);
  const confirmSlider = el('input', {
    type: 'range',
    min: String(CONFIRM_DIST_MIN),
    max: String(CONFIRM_DIST_MAX),
    step: '0.1',
    value: String(CONFIRM_DIST_DEFAULT),
    className: 'size-slider',
  });
  const confirmLabel = el('span', {
    className: 'size-label',
    textContent: `${CONFIRM_DIST_DEFAULT.toFixed(1)}m`,
  });
  const confirmRow = el('div', { className: 'size-row' }, [
    el('span', { className: 'size-cap', textContent: '確定距離' }),
    confirmSlider,
    confirmLabel,
  ]);
  const pauseBtn = el('button', { className: 'ctl', textContent: '⏸ 一時停止' });
  const clearBtn = el('button', { className: 'ctl', textContent: '🗑 クリア' });
  const colorBtn = el('button', { className: 'ctl', textContent: '🎨 色: カメラ' });
  const flipBtn = el('button', { className: 'ctl', textContent: '🔃 色向き' });
  const endBtn = el('button', { className: 'ghost', textContent: 'AR を終了' });
  hud.append(
    el('div', {
      className: 'hud-title',
      textContent: 'Phase 8b: 信頼度で確定・ロック（半透明＝要接近）',
    }),
    el('div', { className: 'overhead-wrap' }, [overheadCanvas, thumbCanvas]),
    statsSlot,
    sizeRow,
    stabRow,
    confirmRow,
    el('div', { className: 'controls' }, [pauseBtn, clearBtn, colorBtn, flipBtn, endBtn]),
    el('div', { className: 'build-stamp', textContent: `build: ${__BUILD_ID__}` }),
  );
  overlay.append(hud);
  document.body.append(overlay);

  const overhead = new OverheadPreview(overheadCanvas);
  const carveCtx = new CarveContext();
  const reprojectStats: ReprojectStats = { emitted: 0, rejectedEdge: 0 };
  const timer = new StageTimer();

  pauseBtn.addEventListener('click', () => {
    state.accumulating = !state.accumulating;
    pauseBtn.textContent = state.accumulating ? '⏸ 一時停止' : '▶ 再開';
    // Coarse view doesn't refresh while scanning; toggling pause re-tessellates it with the
    // latest data so you can inspect what you've captured.
    if (state.displayFactor > 1)
      voxels.rebuildDownsampled(grid, state.displayFactor, state.minWeight);
  });
  clearBtn.addEventListener('click', () => {
    grid.clear();
    voxels.reset();
    overhead.reset();
  });
  colorBtn.addEventListener('click', () => {
    state.colorMode = state.colorMode === 'camera' ? 'height' : 'camera';
    colorBtn.textContent = state.colorMode === 'camera' ? '🎨 色: カメラ' : '🎨 色: 高さ';
  });
  // Cycle the 4 camera-UV orientations so the correct one can be found on-device.
  flipBtn.addEventListener('click', () => {
    if (!state.camFlipX && state.camFlipY) {
      state.camFlipX = true;
    } else if (state.camFlipX && state.camFlipY) {
      state.camFlipY = false;
    } else if (state.camFlipX && !state.camFlipY) {
      state.camFlipX = false;
    } else {
      state.camFlipY = true;
    }
  });

  // Display voxel size = factor × 2cm. Dragging shows the target size; releasing re-tessellates
  // the 3D display from the existing grid — no re-scan (Phase 6 completion condition).
  const readFactor = (): number =>
    Math.min(MAX_FACTOR, Math.max(1, parseInt(sizeSlider.value, 10) || 1));
  sizeSlider.addEventListener('input', () => {
    sizeLabel.textContent = `${readFactor() * 2}cm`;
  });
  sizeSlider.addEventListener('change', () => {
    const f = readFactor();
    state.displayFactor = f;
    sizeLabel.textContent = `${f * 2}cm`;
    if (f === 1) {
      voxels.reset();
      grid.markAllDirty(); // the next applyUpdates() re-seeds every cell at base 2cm
    } else {
      voxels.rebuildDownsampled(grid, f, state.minWeight);
    }
  });

  // Noise-removal threshold: the accumulated weight (out of MAX_WEIGHT) a cell needs to stay
  // drawn — i.e. how well established it must be. Dragging updates the label; releasing
  // re-tessellates the already-scanned cells at the new threshold — no re-scan.
  stabSlider.addEventListener('input', () => {
    stabLabel.textContent = `${stabSlider.value} / ${MAX_WEIGHT}`;
  });
  stabSlider.addEventListener('change', () => {
    const n = Math.min(MIN_W_MAX, Math.max(1, parseInt(stabSlider.value, 10) || MIN_W_DEFAULT));
    state.minWeight = n;
    stabLabel.textContent = `${n} / ${MAX_WEIGHT}`;
    if (state.displayFactor === 1) {
      voxels.reset();
      grid.markAllDirty();
    } else {
      voxels.rebuildDownsampled(grid, state.displayFactor, n);
    }
  });

  // Confirmation distance: how close a single look has to be taken from to lock a cell in. Lower
  // demands a closer approach before anything turns solid; raise it and more of the scan confirms
  // (and locks) on the strength of a more distant look. Releasing re-classifies what is already
  // scanned — no re-scan, same as the other two sliders.
  const readConfirmDist = (): number => {
    const v = parseFloat(confirmSlider.value);
    if (!Number.isFinite(v)) return CONFIRM_DIST_DEFAULT;
    return Math.min(CONFIRM_DIST_MAX, Math.max(CONFIRM_DIST_MIN, v));
  };
  confirmSlider.addEventListener('input', () => {
    confirmLabel.textContent = `${readConfirmDist().toFixed(1)}m`;
  });
  confirmSlider.addEventListener('change', () => {
    const d = readConfirmDist();
    grid.confirmDist = d;
    confirmLabel.textContent = `${d.toFixed(1)}m`;
    if (state.displayFactor === 1) {
      voxels.reset();
      grid.markAllDirty(); // re-seeds every cell into whichever tier it now belongs to
    } else {
      voxels.rebuildDownsampled(grid, state.displayFactor, state.minWeight);
    }
  });

  let cameraReader: CameraColorReader | null = null;

  const cleanup = (): void => {
    renderer.setAnimationLoop(null);
    cameraReader?.dispose();
    renderer.domElement.remove();
    overlay.remove();
    voxels.dispose();
    renderer.dispose();
  };

  let session: XRSession;
  try {
    session = await requestArSession({ overlayRoot: overlay });
  } catch (err) {
    cleanup();
    showError(errorSlot, err);
    return;
  }

  endBtn.addEventListener('click', () => void session.end());
  session.addEventListener('end', cleanup);

  renderer.xr.setReferenceSpaceType('local');
  try {
    await renderer.xr.setSession(session);
  } catch (err) {
    showError(errorSlot, err);
    void session.end();
    return;
  }

  const gl = renderer.getContext();
  if (gl instanceof WebGL2RenderingContext) {
    cameraReader = new CameraColorReader(session, gl, {
      targetWidth: CAMERA_W,
      targetHeight: CAMERA_H,
      flipX: state.camFlipX,
      flipY: state.camFlipY,
    });
  }

  const info: SessionInfo = readSessionInfo(session);
  let lastStats = 0;
  let lastPreview = 0;
  let lastCamera = 0;
  let latestDepth: CpuDepthFrame | null = null;
  let frameCount = 0;
  let fpsWindowStart = 0;
  let fps = 0;

  // Camera world position for the current frame — the fusion band is walked along the view ray.
  let camX = 0;
  let camY = 0;
  let camZ = 0;

  // Fuse one measurement: not a single occupied cell, but the band of signed distances along its
  // ray. Weight is ~1/depth² because depth error grows steeply with range (voxblox), so near looks
  // dominate the average and a later distant glimpse barely moves a well-scanned surface.
  const accumulate = (
    x: number,
    y: number,
    z: number,
    u: number,
    v: number,
    depth: number,
    quality: number,
  ): void => {
    const d = depth > 0.3 ? depth : 0.3; // clamp at the minimum useful range
    // Confidence falls off with distance (depth error grows steeply) and with surface slant
    // (a grazing ray pins the surface poorly along itself).
    const w = quality / (d * d);
    let r: number;
    let g: number;
    let b: number;
    if (
      state.colorMode === 'camera' &&
      cameraReader !== null &&
      !cameraReader.failed &&
      cameraReader.sample(u, v, camRGB)
    ) {
      r = camRGB.r;
      g = camRGB.g;
      b = camRGB.b;
    } else {
      const t = Math.min(1, Math.max(0, (y - HEIGHT_LO) / (HEIGHT_HI - HEIGHT_LO)));
      heightColor.setHSL((1 - t) * 0.7, 0.85, 0.55);
      r = heightColor.r * 255;
      g = heightColor.g * 255;
      b = heightColor.b * 255;
    }
    fuseDepthSample(grid, camX, camY, camZ, x, y, z, depth, w, r, g, b);
  };

  renderer.setAnimationLoop((time: number, frame?: XRFrame) => {
    timer.beginFrame();
    renderer.render(scene, camera);
    timer.lap('gl');
    // Seed the FPS window on the first frame (WebXR `time` is page-load-relative, not 0),
    // so the first reading isn't frameCount/absoluteTime garbage.
    if (fpsWindowStart === 0) {
      fpsWindowStart = time;
      lastStats = time;
    }
    frameCount++;
    if (!frame) return;

    const refSpace = renderer.xr.getReferenceSpace();
    const pose = refSpace ? frame.getViewerPose(refSpace) : null;
    if (!pose || pose.views.length === 0) return;

    const view = pose.views[0];
    latestDepth = readCpuDepthFrame(frame, view);

    // Throttled camera readback (raw GL), then resync three's tracked state.
    if (
      cameraReader !== null &&
      !cameraReader.failed &&
      state.colorMode === 'camera' &&
      time - lastCamera >= CAMERA_MS
    ) {
      lastCamera = time;
      cameraReader.flipX = state.camFlipX;
      cameraReader.flipY = state.camFlipY;
      cameraReader.update(view);
      renderer.resetState();
    }

    if (latestDepth && state.accumulating) {
      const camPos = view.transform.position; // ray origin for the fusion band
      camX = camPos.x;
      camY = camPos.y;
      camZ = camPos.z;
      reprojectDepthFrame(
        latestDepth,
        view.projectionMatrix,
        view.transform.matrix,
        {
          minMeters: MIN_M,
          maxMeters: MAX_M,
          stride: STRIDE,
          flipY: true,
          edgeSlant: EDGE_SLANT,
        },
        accumulate,
        reprojectStats,
      );
    }
    timer.lap('fuse');

    // 3D voxel display. Base size (2cm) is incremental every frame (cheap regardless of grid
    // size). Coarser sizes re-tessellate only on a slider change / pause (see handlers), since a
    // full aggregation sweep of a large grid is too heavy to run every frame — so here we just
    // discard the renderer's dirty keys to keep that set bounded.
    if (state.displayFactor === 1) {
      voxels.applyUpdates(grid, state.minWeight);
      timer.lap('draw');
      // Free-space carving: remove voxels floating in front of the measured surface, so getting
      // closer clears noise. Amortized (a slice of instances per frame). Base size only.
      if (latestDepth && state.accumulating) {
        carveCtx.update(view.projectionMatrix, view.transform.matrix, latestDepth, {
          flipY: true,
          margin: CARVE_MARGIN,
          minDepth: CARVE_MIN_DEPTH,
        });
        voxels.carve(grid, carveCtx, state.minWeight, CARVE_BUDGET, FREE_WEIGHT);
      }
      timer.lap('carve');
    } else {
      grid.clearDirty();
      timer.lap('draw');
    }

    // Overhead preview (bottom half, always base 2cm): incremental top-down redraw so the map
    // visibly grows while the AR view scans on top.
    if (time - lastPreview >= PREVIEW_MS) {
      lastPreview = time;
      overhead.update(grid, state.minWeight);
    }
    timer.lap('prev');

    if (time - lastStats >= STATS_MS) {
      const dt = time - fpsWindowStart;
      fps = dt > 0 ? (frameCount * 1000) / dt : 0;
      frameCount = 0;
      fpsWindowStart = time;
      lastStats = time;
      updateStats(
        statsSlot,
        info,
        state,
        grid,
        voxels,
        latestDepth,
        cameraReader,
        fps,
        reprojectStats,
        timer,
      );
      timer.reset();
      drawThumbnail(thumbCanvas, cameraReader);
    }
  });
}

function drawThumbnail(canvas: HTMLCanvasElement, reader: CameraColorReader | null): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!reader || !reader.ready) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const { width: w, height: h, buffer } = reader;
  const img = ctx.createImageData(w, h);
  // readPixels is bottom-up; flip vertically so the thumbnail reads like the camera.
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w;
    const dstRow = y * w;
    for (let x = 0; x < w; x++) {
      const s = (srcRow + x) * 4;
      const d = (dstRow + x) * 4;
      img.data[d] = buffer[s];
      img.data[d + 1] = buffer[s + 1];
      img.data[d + 2] = buffer[s + 2];
      img.data[d + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function updateStats(
  slot: HTMLElement,
  info: SessionInfo,
  state: ScanState,
  grid: VoxelGrid,
  voxels: VoxelRenderer,
  depth: CpuDepthFrame | null,
  reader: CameraColorReader | null,
  fps: number,
  reprojectStats: ReprojectStats,
  timer: StageTimer,
): void {
  const colorStatus =
    state.colorMode === 'height'
      ? '高さ'
      : reader === null
        ? 'カメラ(不可)'
        : reader.failed
          ? 'カメラ(失敗→高さ)'
          : reader.ready
            ? 'カメラ'
            : 'カメラ(待機)';

  const rows: KV[] = [
    { label: 'FPS', value: fps > 0 ? fps.toFixed(0) : '—' },
    { label: '状態', value: state.accumulating ? '● 蓄積中' : '❚❚ 一時停止' },
    { label: 'TSDF セル', value: `${grid.size.toLocaleString()}` },
    {
      label: '表示サイズ',
      value: `${state.displayFactor * 2}cm${state.displayFactor > 1 ? ` (×${state.displayFactor})` : ''}`,
    },
    { label: 'ノイズ除去', value: `${state.minWeight} / ${MAX_WEIGHT}` },
    {
      label: 'エッジ除去',
      value: `${reprojectStats.rejectedEdge.toLocaleString()} / ${(
        reprojectStats.emitted + reprojectStats.rejectedEdge
      ).toLocaleString()}`,
    },
    { label: '描画中', value: `${voxels.drawn.toLocaleString()} / ${RENDER_CAP.toLocaleString()}` },
    {
      label: '確定 / 暫定',
      value: `${voxels.drawnConfirmed.toLocaleString()} / ${voxels.drawnProvisional.toLocaleString()}`,
    },
    { label: '確定距離', value: `${grid.confirmDist.toFixed(1)}m` },
    // CPU cost per frame by stage. If these sum to far less than the frame period implied by FPS,
    // the bottleneck is the GPU (fill rate / instance count), not any of this code.
    {
      label: 'CPU ms',
      value:
        `計${timer.meanTotal().toFixed(1)}` +
        ` (描画${timer.mean('gl').toFixed(1)}` +
        ` 融合${timer.mean('fuse').toFixed(1)}` +
        ` 追記${timer.mean('draw').toFixed(1)}` +
        ` 除去${timer.mean('carve').toFixed(1)}` +
        ` 俯瞰${timer.mean('prev').toFixed(1)})`,
    },
    { label: '色', value: colorStatus },
    {
      label: '色向き',
      value: `X:${state.camFlipX ? '反転' : '正'} Y:${state.camFlipY ? '反転' : '正'}`,
    },
    { label: 'depthUsage', value: info.depthUsage ?? '—' },
  ];

  if (depth) {
    const s = computeDepthStats(depth.data, depth.width, depth.height, depth.rawValueToMeters);
    const coverage = s.totalCount > 0 ? (100 * s.validCount) / s.totalCount : 0;
    rows.push(
      { label: '深度有効率', value: `${coverage.toFixed(0)}%` },
      {
        label: '距離 中央',
        value: s.medianMeters === null ? '—' : `${s.medianMeters.toFixed(2)}m`,
      },
    );
  }
  // Chrome-only and coarse, but this is a Chrome-on-Android target and the grid stores one object
  // per cell — at room scale that is the single biggest thing on the heap, so it is worth seeing.
  const heap = (performance as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })
    .memory;
  if (heap) {
    rows.push({
      label: 'JS ヒープ',
      value: `${(heap.usedJSHeapSize / 1048576).toFixed(0)} / ${(heap.jsHeapSizeLimit / 1048576).toFixed(0)} MB`,
    });
  }
  if (grid.droppedAtCap > 0) {
    rows.push({ label: '⚠ グリッド上限', value: `${grid.droppedAtCap.toLocaleString()} 破棄` });
  }

  clear(slot);
  slot.append(renderKVTable(rows));
}

function showError(slot: HTMLElement, err: unknown): void {
  const e = err as { name?: string; message?: string };
  const name = e?.name ?? 'Error';
  const message = e?.message ?? String(err);
  const hints: Record<string, string> = {
    NotSupportedError:
      'depth-sensing が未対応の可能性。ARCore の導入と Chrome の更新を確認してください。',
    SecurityError: 'セキュアコンテキストが必要です。HTTPS / localhost で開いてください。',
    NotAllowedError: '権限が拒否されました。カメラ / AR の許可を確認してください。',
    InvalidStateError: 'セッション状態が不正です。ページを再読み込みしてください。',
  };

  const card = el('section', { className: 'card error' }, [
    el('h2', { textContent: `AR を開始できませんでした: ${name}` }),
    el('p', { textContent: message }),
  ]);
  const hint = hints[name];
  if (hint) card.append(el('p', { className: 'hint', textContent: hint }));
  slot.append(card);
}

void main(app);
