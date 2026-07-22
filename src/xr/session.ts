/**
 * AR session construction and lightweight per-frame probing.
 *
 * The WebXR depth-sensing / camera-access surface is not uniformly present across
 * `@types/webxr` versions, so this module keeps its own minimal structural types and
 * accesses the runtime objects defensively. Phase 3 (voxel accumulation) introduces
 * the precise depth types where the values are actually consumed.
 */

export type DepthUsage = 'cpu-optimized' | 'gpu-optimized';
export type DepthDataFormat = 'luminance-alpha' | 'float32';

export interface SessionFeatureConfig {
  /** DOM element used as the dom-overlay root (bottom-half UI, live panel, ...). */
  overlayRoot?: Element;
}

interface DepthStateInitLike {
  usagePreference: readonly DepthUsage[];
  dataFormatPreference: readonly DepthDataFormat[];
}

/**
 * Build the XRSessionInit for our immersive-ar session. Pure and testable.
 *
 * - depth-sensing is REQUIRED (the whole app depends on it).
 * - camera-access is OPTIONAL: needed for per-voxel color, but the session should still
 *   start (geometry only) if the user denies it.
 * - We prefer cpu-optimized + luminance-alpha (only luminance-alpha is guaranteed), with
 *   gpu-optimized / float32 listed as fallbacks in priority order.
 */
export function buildSessionInit(config: SessionFeatureConfig = {}): XRSessionInit {
  const depthSensing: DepthStateInitLike = {
    usagePreference: ['cpu-optimized', 'gpu-optimized'],
    dataFormatPreference: ['luminance-alpha', 'float32'],
  };

  // Record<> + cast avoids depending on these optional fields being present in the
  // installed @types/webxr, and sidesteps excess-property checks on the literal.
  const init: Record<string, unknown> = {
    requiredFeatures: ['depth-sensing'],
    optionalFeatures: ['camera-access', 'dom-overlay', 'local-floor'],
    depthSensing,
  };
  if (config.overlayRoot) {
    init.domOverlay = { root: config.overlayRoot };
  }
  return init as XRSessionInit;
}

export async function requestArSession(config: SessionFeatureConfig = {}): Promise<XRSession> {
  if (!navigator.xr) {
    throw new Error('navigator.xr is unavailable');
  }
  return navigator.xr.requestSession('immersive-ar', buildSessionInit(config));
}

export interface SessionInfo {
  depthUsage?: string;
  depthDataFormat?: string;
  enabledFeatures: string[];
}

/** Read the negotiated depth configuration and enabled features off the session. */
export function readSessionInfo(session: XRSession): SessionInfo {
  const s = session as unknown as {
    depthUsage?: string;
    depthDataFormat?: string;
    enabledFeatures?: ArrayLike<string>;
  };
  return {
    depthUsage: s.depthUsage,
    depthDataFormat: s.depthDataFormat,
    enabledFeatures: s.enabledFeatures ? Array.from(s.enabledFeatures) : [],
  };
}

export interface DepthProbe {
  depthAvailable: boolean;
  width: number | null;
  height: number | null;
  rawValueToMeters: number | null;
}

interface DepthInfoLike {
  width: number;
  height: number;
  rawValueToMeters: number;
}

/**
 * Try to read the CPU depth buffer metadata for a view. Returns depthAvailable=false when
 * depth isn't ready yet (device not moving), when the session negotiated the GPU path
 * (getDepthInformation on XRFrame is CPU-only), or when the call throws.
 */
export function readDepthProbe(frame: XRFrame, view: XRView): DepthProbe {
  const getDepthInformation = (
    frame as unknown as {
      getDepthInformation?: (view: XRView) => DepthInfoLike | undefined;
    }
  ).getDepthInformation;

  if (typeof getDepthInformation !== 'function') {
    return { depthAvailable: false, width: null, height: null, rawValueToMeters: null };
  }

  let depthInfo: DepthInfoLike | undefined;
  try {
    depthInfo = getDepthInformation.call(frame, view);
  } catch {
    depthInfo = undefined;
  }

  if (!depthInfo) {
    return { depthAvailable: false, width: null, height: null, rawValueToMeters: null };
  }
  return {
    depthAvailable: true,
    width: depthInfo.width,
    height: depthInfo.height,
    rawValueToMeters: depthInfo.rawValueToMeters,
  };
}

export interface CameraProbe {
  available: boolean;
  width: number | null;
  height: number | null;
}

/** Report whether camera-access produced an XRCamera on this view (color source in Phase 3). */
export function readCameraProbe(view: XRView): CameraProbe {
  const camera = (view as unknown as { camera?: { width?: number; height?: number } }).camera;
  if (camera) {
    return { available: true, width: camera.width ?? null, height: camera.height ?? null };
  }
  return { available: false, width: null, height: null };
}
