import './style.css';
import * as THREE from 'three';
import { probeXRSupport } from './xr/capabilities';
import { requestArSession, readSessionInfo, type SessionInfo } from './xr/session';
import { readCpuDepthFrame, type CpuDepthFrame } from './xr/depth';
import { reprojectDepthFrame } from './xr/reproject';
import { computeDepthStats } from './render/depthHeatmap';
import { CameraColorReader, type RGB } from './xr/cameraColor';
import { VoxelGrid } from './voxel/grid';
import { VoxelRenderer } from './render/voxelRenderer';
import { OverheadPreview } from './render/overheadPreview';
import { renderCapabilityStatus, renderKVTable, type KV } from './ui/probePanel';
import { el, clear } from './ui/dom';

declare const __BUILD_ID__: string;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app container not found');

const VOXEL_SIZE = 0.02; // internal fine grid (2 cm)
const MIN_M = 0.3; // accumulate depths in [MIN_M, MAX_M]; ARCore is most accurate 0.5–5 m
const MAX_M = 3.0; // far depth is noisiest; capping the range curbs drift and spurious voxels
const STRIDE = 2; // subsample the depth buffer (every 2nd texel)
const MIN_OBS = 3; // render/keep a voxel once seen at least this many times (rejects transient noise)
const STATS_MS = 250; // HUD stats / thumbnail / FPS update cadence
const PREVIEW_MS = 150; // overhead preview redraw cadence (~7 Hz; incremental)
const CAMERA_MS = 100; // camera-image readback cadence (~10 Hz; readback is a GPU stall)
const DOWNSAMPLE_MS = 400; // coarse-mode (factor > 1) mesh re-tessellation cadence while scanning
const MAX_FACTOR = 8; // display voxel size up to 8× base = 16 cm
const CAMERA_W = 96; // downsampled camera readback size (portrait, ~855:1920)
const CAMERA_H = 214;
const RENDER_CAP = 150_000;
const GRID_CAP = 600_000;

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
}

async function main(app: HTMLDivElement): Promise<void> {
  const header = el('header', { className: 'app-header' }, [
    el('h1', { textContent: 'VoxelWorld — WebXR ボクセルスキャナ' }),
    el('p', {
      className: 'subtitle',
      textContent:
        'Phase 6: ボクセルサイズ可変 — 上で AR スキャン、下に俯瞰プレビュー。表示サイズスライダーで再スキャンなしにボクセルの粗さを変えられます。',
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

  const grid = new VoxelGrid({ voxelSize: VOXEL_SIZE, maxVoxels: GRID_CAP });
  const voxels = new VoxelRenderer(RENDER_CAP, VOXEL_SIZE);
  scene.add(voxels.mesh);

  const state: ScanState = {
    accumulating: true,
    colorMode: 'camera',
    camFlipX: false,
    camFlipY: true,
    displayFactor: 1,
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
  const pauseBtn = el('button', { className: 'ctl', textContent: '⏸ 一時停止' });
  const clearBtn = el('button', { className: 'ctl', textContent: '🗑 クリア' });
  const colorBtn = el('button', { className: 'ctl', textContent: '🎨 色: カメラ' });
  const flipBtn = el('button', { className: 'ctl', textContent: '🔃 色向き' });
  const endBtn = el('button', { className: 'ghost', textContent: 'AR を終了' });
  hud.append(
    el('div', {
      className: 'hud-title',
      textContent: 'Phase 6: ボクセルサイズ可変（表示スライダー）',
    }),
    el('div', { className: 'overhead-wrap' }, [overheadCanvas, thumbCanvas]),
    statsSlot,
    sizeRow,
    el('div', { className: 'controls' }, [pauseBtn, clearBtn, colorBtn, flipBtn, endBtn]),
    el('div', { className: 'build-stamp', textContent: `build: ${__BUILD_ID__}` }),
  );
  overlay.append(hud);
  document.body.append(overlay);

  const overhead = new OverheadPreview(overheadCanvas);

  pauseBtn.addEventListener('click', () => {
    state.accumulating = !state.accumulating;
    pauseBtn.textContent = state.accumulating ? '⏸ 一時停止' : '▶ 再開';
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
      voxels.rebuildDownsampled(grid, f, MIN_OBS);
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
  let lastRebuild = 0;
  let latestDepth: CpuDepthFrame | null = null;
  let frameCount = 0;
  let fpsWindowStart = 0;
  let fps = 0;

  const accumulate = (x: number, y: number, z: number, u: number, v: number): void => {
    if (
      state.colorMode === 'camera' &&
      cameraReader !== null &&
      !cameraReader.failed &&
      cameraReader.sample(u, v, camRGB)
    ) {
      grid.addPoint(x, y, z, camRGB.r, camRGB.g, camRGB.b);
      return;
    }
    const t = Math.min(1, Math.max(0, (y - HEIGHT_LO) / (HEIGHT_HI - HEIGHT_LO)));
    heightColor.setHSL((1 - t) * 0.7, 0.85, 0.55);
    grid.addPoint(x, y, z, heightColor.r * 255, heightColor.g * 255, heightColor.b * 255);
  };

  renderer.setAnimationLoop((time: number, frame?: XRFrame) => {
    renderer.render(scene, camera);
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
      reprojectDepthFrame(
        latestDepth,
        view.projectionMatrix,
        view.transform.matrix,
        { minMeters: MIN_M, maxMeters: MAX_M, stride: STRIDE, flipY: true },
        accumulate,
      );
    }

    // 3D voxel display. Base size (2cm) is incremental every frame; coarser display sizes
    // re-tessellate on a throttle while scanning (and immediately on a slider change).
    if (state.displayFactor === 1) {
      voxels.applyUpdates(grid, MIN_OBS);
    } else if (state.accumulating && time - lastRebuild >= DOWNSAMPLE_MS) {
      lastRebuild = time;
      voxels.rebuildDownsampled(grid, state.displayFactor, MIN_OBS);
    }

    // Overhead preview (bottom half, always base 2cm): incremental top-down redraw so the map
    // visibly grows while the AR view scans on top.
    if (time - lastPreview >= PREVIEW_MS) {
      lastPreview = time;
      overhead.update(grid, MIN_OBS);
    }

    if (time - lastStats >= STATS_MS) {
      const dt = time - fpsWindowStart;
      fps = dt > 0 ? (frameCount * 1000) / dt : 0;
      frameCount = 0;
      fpsWindowStart = time;
      lastStats = time;
      updateStats(statsSlot, info, state, grid, voxels.drawn, latestDepth, cameraReader, fps);
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
  rendered: number,
  depth: CpuDepthFrame | null,
  reader: CameraColorReader | null,
  fps: number,
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
    { label: 'ボクセル(2cm)', value: `${grid.size.toLocaleString()} セル` },
    {
      label: '表示サイズ',
      value: `${state.displayFactor * 2}cm${state.displayFactor > 1 ? ` (×${state.displayFactor})` : ''}`,
    },
    { label: '描画中', value: `${rendered.toLocaleString()} / ${RENDER_CAP.toLocaleString()}` },
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
