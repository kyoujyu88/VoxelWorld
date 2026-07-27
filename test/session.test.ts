import { describe, it, expect } from 'vitest';
import { buildSessionInit, readPlaneProbe } from '../src/xr/session';

describe('buildSessionInit', () => {
  it('requires depth-sensing', () => {
    const init = buildSessionInit();
    expect(init.requiredFeatures).toContain('depth-sensing');
  });

  it('requests camera-access and dom-overlay as optional features', () => {
    const init = buildSessionInit();
    expect(init.optionalFeatures).toEqual(expect.arrayContaining(['camera-access', 'dom-overlay']));
  });

  it('prefers cpu-optimized + luminance-alpha in priority order', () => {
    const init = buildSessionInit() as unknown as {
      depthSensing: { usagePreference: string[]; dataFormatPreference: string[] };
    };
    expect(init.depthSensing.usagePreference[0]).toBe('cpu-optimized');
    expect(init.depthSensing.usagePreference).toContain('gpu-optimized');
    expect(init.depthSensing.dataFormatPreference[0]).toBe('luminance-alpha');
    expect(init.depthSensing.dataFormatPreference).toContain('float32');
  });

  it('omits domOverlay when no root is provided', () => {
    const init = buildSessionInit() as unknown as { domOverlay?: unknown };
    expect(init.domOverlay).toBeUndefined();
  });

  it('includes domOverlay when a root is provided', () => {
    const fakeRoot = {} as Element;
    const init = buildSessionInit({ overlayRoot: fakeRoot }) as unknown as {
      domOverlay?: { root: Element };
    };
    expect(init.domOverlay?.root).toBe(fakeRoot);
  });
});

describe('plane detection', () => {
  it('asks for plane-detection as optional, so an unsupporting device still starts', () => {
    const init = buildSessionInit();
    expect(init.optionalFeatures).toContain('plane-detection');
    expect(init.requiredFeatures).not.toContain('plane-detection');
  });

  it('reports unavailable when the runtime exposes no detectedPlanes', () => {
    const probe = readPlaneProbe({} as XRFrame);
    expect(probe).toEqual({ available: false, count: 0, horizontal: 0, vertical: 0 });
  });

  it('reports unavailable when reading detectedPlanes throws', () => {
    // Chrome throws outright when the feature was not granted, rather than returning undefined.
    const frame = {
      get detectedPlanes(): unknown {
        throw new DOMException('feature not enabled');
      },
    } as unknown as XRFrame;
    expect(readPlaneProbe(frame).available).toBe(false);
  });

  it('counts tracked planes and splits them by orientation', () => {
    const frame = {
      detectedPlanes: new Set([
        { orientation: 'horizontal' },
        { orientation: 'horizontal' },
        { orientation: 'vertical' },
        { orientation: undefined }, // orientation is optional when the runtime cannot classify
      ]),
    } as unknown as XRFrame;
    expect(readPlaneProbe(frame)).toEqual({
      available: true,
      count: 4,
      horizontal: 2,
      vertical: 1,
    });
  });

  it('reports available with zero planes before the runtime has fitted any', () => {
    const frame = { detectedPlanes: new Set() } as unknown as XRFrame;
    expect(readPlaneProbe(frame)).toEqual({
      available: true,
      count: 0,
      horizontal: 0,
      vertical: 0,
    });
  });

  it('keeps the planes it counted when one throws mid-iteration', () => {
    // A plane that lost tracking throws on property access.
    const bad = {
      get orientation(): string {
        throw new DOMException('plane no longer tracked');
      },
    };
    const frame = {
      detectedPlanes: new Set([{ orientation: 'horizontal' }, bad]),
    } as unknown as XRFrame;
    const probe = readPlaneProbe(frame);
    expect(probe.available).toBe(true);
    expect(probe.horizontal).toBe(1);
  });
});
