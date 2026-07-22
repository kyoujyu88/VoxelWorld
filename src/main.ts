import './style.css';
import * as THREE from 'three';
import { probeXRSupport } from './xr/capabilities';
import { requestArSession, readSessionInfo, type SessionInfo } from './xr/session';
import { readCpuDepthFrame } from './xr/depth';
import { DepthHeatmapView, computeDepthStats, type DepthStats } from './render/depthHeatmap';
import { renderCapabilityStatus, renderKVTable, type KV } from './ui/probePanel';
import { el, clear } from './ui/dom';
import type { CpuDepthFrame } from './xr/depth';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app container not found');

// Grayscale range. ARCore depth is most accurate 0.5–5 m; we start slightly nearer.
const NEAR_M = 0.3;
const FAR_M = 5.0;
const HEATMAP_INTERVAL_MS = 66; // ~15 Hz redraw
const STATS_INTERVAL_MS = 250; // ~4 Hz text update

async function main(app: HTMLDivElement): Promise<void> {
  const header = el('header', { className: 'app-header' }, [
    el('h1', { textContent: 'VoxelWorld — WebXR ボクセルスキャナ' }),
    el('p', {
      className: 'subtitle',
      textContent: 'Phase 2: 深度の可視化 — 深度を白黒ヒートマップで表示します。',
    }),
  ]);

  const statusSlot = el('div', { className: 'slot' });
  const actionSlot = el('div', { className: 'slot' });
  const errorSlot = el('div', { className: 'slot' });
  app.append(header, statusSlot, actionSlot, errorSlot);

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
          '開始後、端末をゆっくり動かすと深度が生成されます。近い物ほど明るく表示されます（欠損は透明）。',
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

  // dom-overlay root. The UA controls the root element's box, so all visible styling lives
  // on the inner .hud child (own background, bottom-anchored, safe-area padding).
  const overlay = el('div', { className: 'xr-overlay' });
  const hud = el('div', { className: 'hud' });
  const heatmap = new DepthHeatmapView();
  const statsSlot = el('div', { className: 'stats' });
  const endBtn = el('button', { className: 'ghost', textContent: 'AR を終了' });

  hud.append(
    el('div', {
      className: 'hud-title',
      textContent: 'Phase 2: 深度ヒートマップ（近い=明るい / 欠損=透明）',
    }),
    heatmap.canvas,
    renderLegend(),
    statsSlot,
    endBtn,
  );
  overlay.append(hud);
  document.body.append(overlay);

  const cleanup = (): void => {
    renderer.setAnimationLoop(null);
    renderer.domElement.remove();
    overlay.remove();
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

  const info: SessionInfo = readSessionInfo(session);
  let lastHeatmap = 0;
  let lastStats = 0;

  renderer.setAnimationLoop((time: number, frame?: XRFrame) => {
    renderer.render(scene, camera);
    if (!frame) return;

    const refSpace = renderer.xr.getReferenceSpace();
    const pose = refSpace ? frame.getViewerPose(refSpace) : null;
    if (!pose || pose.views.length === 0) return;

    const depth = readCpuDepthFrame(frame, pose.views[0]);

    if (depth && time - lastHeatmap >= HEATMAP_INTERVAL_MS) {
      lastHeatmap = time;
      heatmap.update(depth, { minMeters: NEAR_M, maxMeters: FAR_M, nearBright: true });
    }

    if (time - lastStats >= STATS_INTERVAL_MS) {
      lastStats = time;
      updateStats(statsSlot, info, depth);
    }
  });
}

function renderLegend(): HTMLElement {
  return el('div', { className: 'legend' }, [
    el('span', { textContent: `近い (${NEAR_M.toFixed(1)}m)` }),
    el('span', { className: 'ramp' }),
    el('span', { textContent: `遠い (${FAR_M.toFixed(1)}m)` }),
  ]);
}

function updateStats(slot: HTMLElement, info: SessionInfo, depth: CpuDepthFrame | null): void {
  const rows: KV[] = [
    {
      label: 'depthUsage / format',
      value: `${info.depthUsage ?? '—'} / ${info.depthDataFormat ?? '—'}`,
    },
  ];

  if (!depth) {
    rows.push({ label: '深度', value: '取得できず（端末を動かしてください）' });
  } else {
    const stats: DepthStats = computeDepthStats(
      depth.data,
      depth.width,
      depth.height,
      depth.rawValueToMeters,
    );
    const coverage = stats.totalCount > 0 ? (100 * stats.validCount) / stats.totalCount : 0;
    rows.push(
      { label: '深度バッファ', value: `${depth.width} x ${depth.height}` },
      {
        label: '有効率',
        value: `${coverage.toFixed(0)}% (${stats.validCount}/${stats.totalCount})`,
      },
      {
        label: '距離 min/中央/max',
        value: `${meters(stats.minMeters)} / ${meters(stats.medianMeters)} / ${meters(stats.maxMeters)}`,
      },
    );
  }

  clear(slot);
  slot.append(renderKVTable(rows));
}

function meters(n: number | null): string {
  return n === null ? '—' : `${n.toFixed(2)}m`;
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
