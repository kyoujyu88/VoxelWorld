import { describe, it, expect } from 'vitest';
import { buildSessionInit } from '../src/xr/session';

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
