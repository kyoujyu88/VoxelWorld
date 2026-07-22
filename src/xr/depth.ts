/**
 * CPU depth-frame reader.
 *
 * On the negotiated `cpu-optimized` path, `XRFrame.getDepthInformation(view)` returns an
 * `XRCPUDepthInformation` whose `data` is a raw ArrayBuffer. For `luminance-alpha` it is a
 * Uint16 buffer; for `float32` it is a Float32 buffer. Depth in meters is always
 * `rawValue * rawValueToMeters`, so this reader is format-agnostic.
 *
 * Confirmed on Pixel 9a (2026-07-22): cpu-optimized, luminance-alpha, 160x90,
 * rawValueToMeters = 1e-3 (raw values are millimeters).
 *
 * `normDepthFromNormViewMatrix` (from `normDepthBufferFromNormView`) is captured here for
 * Phase 3's world-space reprojection; Phase 2 only needs the depth magnitudes.
 */

export type DepthSampleArray = Uint16Array | Float32Array;

export interface CpuDepthFrame {
  width: number;
  height: number;
  /** Raw depth samples (row-major). Multiply by rawValueToMeters for meters. */
  data: DepthSampleArray;
  rawValueToMeters: number;
  /** Column-major 4x4 mapping normalized view coords -> normalized depth-buffer coords, or null. */
  normDepthFromNormViewMatrix: Float32Array | null;
  /** Depth in meters at integer texel (c, r). Returns 0 for out-of-range or missing samples. */
  metersAt(c: number, r: number): number;
}

interface RawCpuDepthInformation {
  width: number;
  height: number;
  data: ArrayBuffer;
  rawValueToMeters: number;
  normDepthBufferFromNormView?: { matrix?: ArrayLike<number> };
}

/**
 * Read the CPU depth buffer for a view, or null when depth isn't available this frame
 * (device not moving, GPU path negotiated, or the call throws).
 */
export function readCpuDepthFrame(frame: XRFrame, view: XRView): CpuDepthFrame | null {
  const getDepthInformation = (
    frame as unknown as {
      getDepthInformation?: (view: XRView) => RawCpuDepthInformation | undefined;
    }
  ).getDepthInformation;

  if (typeof getDepthInformation !== 'function') return null;

  let info: RawCpuDepthInformation | undefined;
  try {
    info = getDepthInformation.call(frame, view);
  } catch {
    return null;
  }
  if (!info) return null;

  const { width, height, data, rawValueToMeters } = info;
  const sampleCount = width * height;
  if (sampleCount <= 0) return null;

  const bytesPerSample = data.byteLength / sampleCount;
  const samples: DepthSampleArray =
    bytesPerSample === 4 ? new Float32Array(data) : new Uint16Array(data);

  const rawMatrix = info.normDepthBufferFromNormView?.matrix ?? null;
  const normDepthFromNormViewMatrix = rawMatrix ? new Float32Array(rawMatrix) : null;

  return {
    width,
    height,
    data: samples,
    rawValueToMeters,
    normDepthFromNormViewMatrix,
    metersAt(c: number, r: number): number {
      if (c < 0 || r < 0 || c >= width || r >= height) return 0;
      const raw = samples[c + r * width];
      return raw > 0 ? raw * rawValueToMeters : 0;
    },
  };
}
