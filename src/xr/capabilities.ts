/**
 * WebXR capability detection.
 *
 * `evaluateXRSupport` is a pure function (no globals, no side effects) so it can be
 * unit-tested exhaustively. `probeXRSupport` gathers the real runtime inputs and
 * delegates to it.
 */

export type CapabilityLevel = 'ok' | 'error';

export interface XRSupportInput {
  hasNavigatorXR: boolean;
  isSecureContext: boolean;
  /** Result of navigator.xr.isSessionSupported('immersive-ar'); null if it threw or xr is absent. */
  immersiveArSupported: boolean | null;
}

export interface CapabilityStatus {
  level: CapabilityLevel;
  /** True when we can attempt to start an immersive-ar + depth-sensing session. */
  ready: boolean;
  title: string;
  reasons: string[];
}

const ADB_HINT =
  'adb reverse tcp:5173 tcp:5173 で Pixel の localhost に転送すると secure context 扱いになり、証明書なしで動きます。';

/**
 * Decide whether the environment can start our AR session, and why not when it can't.
 * Order matters: the most fundamental blocker is reported first.
 */
export function evaluateXRSupport(input: XRSupportInput): CapabilityStatus {
  if (!input.hasNavigatorXR) {
    return {
      level: 'error',
      ready: false,
      title: 'WebXR 非対応',
      reasons: [
        'navigator.xr がありません。この端末/ブラウザは WebXR に対応していません。',
        'iOS / Safari は WebXR 未実装のため対象外です。Android Chrome で開いてください。',
      ],
    };
  }

  if (!input.isSecureContext) {
    return {
      level: 'error',
      ready: false,
      title: 'セキュアコンテキストが必要',
      reasons: ['WebXR は HTTPS または localhost でのみ動作します。', ADB_HINT],
    };
  }

  if (input.immersiveArSupported === null) {
    return {
      level: 'error',
      ready: false,
      title: 'AR 対応の照会に失敗',
      reasons: [
        'navigator.xr.isSessionSupported("immersive-ar") が例外を投げました。',
        'ブラウザのフラグや WebXR の無効化設定を確認してください。',
      ],
    };
  }

  if (!input.immersiveArSupported) {
    return {
      level: 'error',
      ready: false,
      title: 'immersive-ar 非対応',
      reasons: [
        'この端末は immersive-ar セッションに対応していません。',
        'ARCore（Google Play 開発者サービス for AR）が未導入か、非対応端末の可能性があります。',
      ],
    };
  }

  return {
    level: 'ok',
    ready: true,
    title: 'AR 準備完了',
    reasons: [
      'immersive-ar が利用可能です。',
      '深度センシング / カメラアクセスの可否はセッション開始時に確定します（下のボタンから開始）。',
    ],
  };
}

/** Gather runtime inputs from globals and evaluate them. Not unit-tested (touches globals). */
export async function probeXRSupport(): Promise<CapabilityStatus> {
  const hasNavigatorXR = typeof navigator !== 'undefined' && 'xr' in navigator && !!navigator.xr;
  const secure = typeof isSecureContext !== 'undefined' ? isSecureContext : false;

  let immersiveArSupported: boolean | null = null;
  if (hasNavigatorXR) {
    try {
      immersiveArSupported = await navigator.xr!.isSessionSupported('immersive-ar');
    } catch {
      immersiveArSupported = null;
    }
  }

  return evaluateXRSupport({ hasNavigatorXR, isSecureContext: secure, immersiveArSupported });
}
