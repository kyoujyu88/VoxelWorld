import { describe, it, expect } from 'vitest';
import { Matrix4 } from 'three';
import {
  PlaneSet,
  pointInConvexPolygon,
  polygonBounds,
  type Bounds2D,
  type SnapResult,
} from '../src/xr/planes';

/** A 2x2 m square centred on the plane origin, as a flat [x,z] loop. */
const SQUARE = [-1, -1, 1, -1, 1, 1, -1, 1];

/**
 * A fake XRFrame exposing one plane whose pose is `matrix` (plane -> world).
 * `polygon` is given as {x, z} pairs, matching what the runtime hands back (y is always 0).
 */
function frameWithPlane(
  matrix: number[],
  polygon: Array<{ x: number; z: number }>,
): { frame: XRFrame; refSpace: XRReferenceSpace } {
  const m = new Matrix4().fromArray(matrix);
  const inv = new Matrix4().copy(m).invert();
  const plane = {
    planeSpace: {} as XRSpace,
    polygon,
  };
  const frame = {
    detectedPlanes: new Set([plane]),
    getPose: () => ({
      transform: {
        matrix: new Float32Array(m.toArray()),
        inverse: { matrix: new Float32Array(inv.toArray()) },
      },
    }),
  } as unknown as XRFrame;
  return { frame, refSpace: {} as XRReferenceSpace };
}

const squarePolygon = (): Array<{ x: number; z: number }> => [
  { x: -1, z: -1 },
  { x: 1, z: -1 },
  { x: 1, z: 1 },
  { x: -1, z: 1 },
];

describe('pointInConvexPolygon', () => {
  it('accepts a point well inside', () => {
    expect(pointInConvexPolygon(0, 0, SQUARE, 4)).toBe(true);
  });

  it('rejects points outside each edge', () => {
    expect(pointInConvexPolygon(2, 0, SQUARE, 4)).toBe(false);
    expect(pointInConvexPolygon(-2, 0, SQUARE, 4)).toBe(false);
    expect(pointInConvexPolygon(0, 2, SQUARE, 4)).toBe(false);
    expect(pointInConvexPolygon(0, -2, SQUARE, 4)).toBe(false);
  });

  it('counts a point exactly on an edge as inside', () => {
    expect(pointInConvexPolygon(1, 0, SQUARE, 4)).toBe(true);
    expect(pointInConvexPolygon(-1, -1, SQUARE, 4)).toBe(true); // a corner
  });

  it('does not depend on winding order', () => {
    const reversed = [-1, 1, 1, 1, 1, -1, -1, -1];
    expect(pointInConvexPolygon(0, 0, reversed, 4)).toBe(true);
    expect(pointInConvexPolygon(5, 5, reversed, 4)).toBe(false);
  });

  it('rejects a degenerate polygon rather than accepting everything', () => {
    expect(pointInConvexPolygon(0, 0, [0, 0, 1, 1], 2)).toBe(false);
    expect(pointInConvexPolygon(0, 0, SQUARE, 0)).toBe(false);
  });

  it('handles a triangle', () => {
    const tri = [0, 0, 2, 0, 0, 2];
    expect(pointInConvexPolygon(0.5, 0.5, tri, 3)).toBe(true);
    expect(pointInConvexPolygon(1.5, 1.5, tri, 3)).toBe(false);
  });
});

describe('polygonBounds', () => {
  it('spans the extreme vertices', () => {
    const out: Bounds2D = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    polygonBounds([-3, -1, 2, -1, 2, 5, -3, 5], 4, out);
    expect(out).toEqual({ minX: -3, maxX: 2, minZ: -1, maxZ: 5 });
  });

  it('returns a zero box for an empty polygon rather than infinities', () => {
    const out: Bounds2D = { minX: 9, maxX: 9, minZ: 9, maxZ: 9 };
    polygonBounds([], 0, out);
    expect(out).toEqual({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 });
  });
});

describe('PlaneSet', () => {
  const out: SnapResult = { x: 0, y: 0, z: 0 };
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  it('reports unavailable and snaps nothing without plane support', () => {
    const set = new PlaneSet(0.03);
    set.update({} as XRFrame, {} as XRReferenceSpace);
    expect(set.available).toBe(false);
    expect(set.planeCount).toBe(0);
    expect(set.snap(0, 0, 0, out)).toBe(false);
  });

  it('survives a runtime that throws on detectedPlanes', () => {
    const set = new PlaneSet(0.03);
    const frame = {
      get detectedPlanes(): unknown {
        throw new DOMException('feature not enabled');
      },
    } as unknown as XRFrame;
    set.update(frame, {} as XRReferenceSpace);
    expect(set.available).toBe(false);
  });

  it('flattens a point onto the plane, killing only the perpendicular error', () => {
    // Plane is the world XZ plane through the origin; its normal is Y.
    const set = new PlaneSet(0.03);
    const { frame, refSpace } = frameWithPlane(IDENTITY, squarePolygon());
    set.update(frame, refSpace);
    expect(set.planeCount).toBe(1);

    expect(set.snap(0.4, 0.02, -0.3, out)).toBe(true);
    expect(out.y).toBeCloseTo(0, 9); // the 2 cm of depth noise is gone
    expect(out.x).toBeCloseTo(0.4, 9); // ...and nothing else moved
    expect(out.z).toBeCloseTo(-0.3, 9);
  });

  it('leaves a point beyond the tolerance alone', () => {
    const set = new PlaneSet(0.03);
    const { frame, refSpace } = frameWithPlane(IDENTITY, squarePolygon());
    set.update(frame, refSpace);
    expect(set.snap(0, 0.5, 0, out)).toBe(false); // 50 cm off the plane: a real object
  });

  it('leaves a point outside the polygon alone, so openings stay open', () => {
    const set = new PlaneSet(0.03);
    const { frame, refSpace } = frameWithPlane(IDENTITY, squarePolygon());
    set.update(frame, refSpace);
    // At plane height, but past the edge of the detected extent.
    expect(set.snap(5, 0.01, 0, out)).toBe(false);
  });

  it('snaps in world space for a plane that is rotated and offset', () => {
    // A vertical wall: rotate the plane's Y (its normal) onto world +X, then push it to x = 2.
    const m = new Matrix4().makeRotationZ(Math.PI / 2).setPosition(2, 0, 0);
    const set = new PlaneSet(0.05);
    const { frame, refSpace } = frameWithPlane(m.toArray(), squarePolygon());
    set.update(frame, refSpace);

    // A measurement 3 cm short of the wall should land exactly on x = 2, keeping y and z.
    expect(set.snap(1.97, 0.25, -0.5, out)).toBe(true);
    expect(out.x).toBeCloseTo(2, 6);
    expect(out.y).toBeCloseTo(0.25, 6);
    expect(out.z).toBeCloseTo(-0.5, 6);
  });

  it('respects the tolerance it was configured with', () => {
    const tight = new PlaneSet(0.01);
    const loose = new PlaneSet(0.1);
    const { frame, refSpace } = frameWithPlane(IDENTITY, squarePolygon());
    tight.update(frame, refSpace);
    loose.update(frame, refSpace);
    expect(tight.snap(0, 0.05, 0, out)).toBe(false);
    expect(loose.snap(0, 0.05, 0, out)).toBe(true);
  });

  it('skips a plane whose polygon is too small to bound anything', () => {
    const set = new PlaneSet(0.03);
    const { frame, refSpace } = frameWithPlane(IDENTITY, [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
    ]);
    set.update(frame, refSpace);
    expect(set.planeCount).toBe(0);
    expect(set.snap(0, 0, 0, out)).toBe(false);
  });

  it('drops planes from the previous frame when they stop being tracked', () => {
    const set = new PlaneSet(0.03);
    const { frame, refSpace } = frameWithPlane(IDENTITY, squarePolygon());
    set.update(frame, refSpace);
    expect(set.planeCount).toBe(1);
    // Next frame the runtime has subsumed it and reports nothing.
    set.update({ detectedPlanes: new Set() } as unknown as XRFrame, refSpace);
    expect(set.planeCount).toBe(0);
    expect(set.snap(0, 0, 0, out)).toBe(false);
  });

  it('keeps the other planes when one throws on access', () => {
    const good = { planeSpace: {} as XRSpace, polygon: squarePolygon() };
    const bad = {
      planeSpace: {} as XRSpace,
      get polygon(): unknown {
        throw new DOMException('plane no longer tracked');
      },
    };
    const m = new Matrix4();
    const frame = {
      detectedPlanes: new Set([bad, good]),
      getPose: () => ({
        transform: {
          matrix: new Float32Array(m.toArray()),
          inverse: { matrix: new Float32Array(m.toArray()) },
        },
      }),
    } as unknown as XRFrame;
    const set = new PlaneSet(0.03);
    set.update(frame, {} as XRReferenceSpace);
    expect(set.planeCount).toBe(1);
    expect(set.snap(0, 0.01, 0, out)).toBe(true);
  });

  it('skips a plane the runtime cannot currently pose', () => {
    const frame = {
      detectedPlanes: new Set([{ planeSpace: {} as XRSpace, polygon: squarePolygon() }]),
      getPose: () => null,
    } as unknown as XRFrame;
    const set = new PlaneSet(0.03);
    set.update(frame, {} as XRReferenceSpace);
    expect(set.available).toBe(true); // the feature works, this plane just has no pose
    expect(set.planeCount).toBe(0);
  });
});
