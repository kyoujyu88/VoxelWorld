import './style.css';
import * as THREE from 'three';
import { probeXRSupport } from './xr/capabilities';
import {
  requestArSession,
  readSessionInfo,
  readDepthProbe,
  readCameraProbe,
  type SessionInfo,
} from './xr/session';
import { renderCapabilityStatus, renderKVTable, type KV } from './ui/probePanel';
import { el, clear } from './ui/dom';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app container not found');

function fmtInt(n: number | null): string {
  return n === null ? '—' : String(Math.round(n));
}

async function main(app: HTMLDivElement): Promise<void> {
  const header = el('header', { className: 'app-header' }, [
    el('h1', { textContent: 'VoxelWorld — WebXR ボクセルスキャナ' }),
    el('p', {
      className: 'subtitle',
      textContent: 'Phase 1: 環境確認 — immersive-ar と depth-sensing の対応を判定します。',
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
          '開始後、端末をゆっくり動かすと深度が生成されます（静止状態では深度は出ません）。',
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

  // dom-overlay root: a live info panel drawn over the camera feed.
  const overlay = el('div', { className: 'xr-overlay' });
  const liveTable = el('div', { className: 'live' });
  const endBtn = el('button', { className: 'ghost', textContent: 'AR を終了' });
  overlay.append(el('h2', { textContent: '深度センシング 実測値' }), liveTable, endBtn);
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
  let lastUpdate = 0;

  renderer.setAnimationLoop((time: number, frame?: XRFrame) => {
    renderer.render(scene, camera);
    if (!frame) return;
    if (time - lastUpdate < 250) return; // throttle UI to ~4 Hz
    lastUpdate = time;
    updateLivePanel(liveTable, renderer, frame, info);
  });
}

function updateLivePanel(
  liveTable: HTMLElement,
  renderer: THREE.WebGLRenderer,
  frame: XRFrame,
  info: SessionInfo,
): void {
  const rows: KV[] = [
    { label: 'depthUsage', value: info.depthUsage ?? '(未報告)' },
    { label: 'depthDataFormat', value: info.depthDataFormat ?? '(未報告)' },
    { label: 'enabledFeatures', value: info.enabledFeatures.join(', ') || '(なし)' },
  ];

  const refSpace = renderer.xr.getReferenceSpace();
  const pose = refSpace ? frame.getViewerPose(refSpace) : null;

  if (pose && pose.views.length > 0) {
    const view = pose.views[0];
    const depth = readDepthProbe(frame, view);
    const cam = readCameraProbe(view);
    rows.push(
      {
        label: '深度取得',
        value: depth.depthAvailable ? '成功' : '取得できず（端末を動かしてください）',
      },
      {
        label: '深度バッファ',
        value: depth.depthAvailable ? `${fmtInt(depth.width)} x ${fmtInt(depth.height)}` : '—',
      },
      {
        label: 'rawValueToMeters',
        value: depth.rawValueToMeters === null ? '—' : depth.rawValueToMeters.toExponential(4),
      },
      {
        label: 'camera-access',
        value: cam.available
          ? `有効 (${fmtInt(cam.width)} x ${fmtInt(cam.height)})`
          : '無効/未許可',
      },
    );
  } else {
    rows.push({ label: 'viewerPose', value: '未取得（トラッキング初期化中）' });
  }

  clear(liveTable);
  liveTable.append(renderKVTable(rows));
}

function showError(slot: HTMLElement, err: unknown): void {
  const e = err as { name?: string; message?: string };
  const name = e?.name ?? 'Error';
  const message = e?.message ?? String(err);
  const hints: Record<string, string> = {
    NotSupportedError:
      'depth-sensing が未対応の可能性。ARCore の導入と Chrome の更新を確認してください。',
    SecurityError: 'セキュアコンテキストが必要です。localhost / HTTPS で開いてください。',
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
