import { describe, it, expect } from 'vitest';
import { evaluateXRSupport } from '../src/xr/capabilities';

describe('evaluateXRSupport', () => {
  it('errors when navigator.xr is absent', () => {
    const s = evaluateXRSupport({
      hasNavigatorXR: false,
      isSecureContext: true,
      immersiveArSupported: null,
    });
    expect(s.ready).toBe(false);
    expect(s.level).toBe('error');
    expect(s.title).toContain('WebXR');
  });

  it('errors when not a secure context', () => {
    const s = evaluateXRSupport({
      hasNavigatorXR: true,
      isSecureContext: false,
      immersiveArSupported: true,
    });
    expect(s.ready).toBe(false);
    expect(s.reasons.join(' ')).toMatch(/localhost|HTTPS/);
  });

  it('errors when the support query failed (null)', () => {
    const s = evaluateXRSupport({
      hasNavigatorXR: true,
      isSecureContext: true,
      immersiveArSupported: null,
    });
    expect(s.ready).toBe(false);
    expect(s.title).toContain('照会');
  });

  it('errors when immersive-ar is unsupported', () => {
    const s = evaluateXRSupport({
      hasNavigatorXR: true,
      isSecureContext: true,
      immersiveArSupported: false,
    });
    expect(s.ready).toBe(false);
    expect(s.reasons.join(' ')).toMatch(/ARCore/);
  });

  it('is ready when xr + secure + immersive-ar supported', () => {
    const s = evaluateXRSupport({
      hasNavigatorXR: true,
      isSecureContext: true,
      immersiveArSupported: true,
    });
    expect(s.ready).toBe(true);
    expect(s.level).toBe('ok');
  });

  it('prioritizes the secure-context error over the AR query', () => {
    const s = evaluateXRSupport({
      hasNavigatorXR: true,
      isSecureContext: false,
      immersiveArSupported: false,
    });
    expect(s.title).toContain('セキュア');
  });
});
