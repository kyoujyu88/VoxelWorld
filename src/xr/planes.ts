/**
 * Snapping depth measurements onto ARCore's detected planes.
 *
 * A wall is the one thing in a room we can know better than any single depth reading: the runtime
 * has fitted thousands of measurements down to four numbers, so its estimate of *where the wall is*
 * carries far less noise than the ±1 cm wobble on an individual sample. Projecting a sample onto
 * that plane before fusing removes the perpendicular error outright, which is what turns a visibly
 * lumpy wall into a flat one.
 *
 * It also makes the sample cheaper to fuse. `fuseDepthSample` walks a band of cells either side of
 * the hit because it does not know exactly where the surface is and has to let the zero crossing
 * converge. On a plane we already know, so one cell can be written directly.
 *
 * ## Why snapping, and not replacing planar regions with the plane
 *
 * The tempting version — treat a detected plane as "this whole area is wall" and stop storing
 * voxels there — is wrong for this app. `XRPlane.polygon` is a **convex** hull, so a wall
 * containing a doorway comes back as a solid rectangle, and rasterizing it would brick up the
 * doorway. Snapping only ever moves measurements that actually exist, so openings stay open and
 * furniture standing in front of a wall stays furniture.
 *
 * ## Caveats the spec is explicit about
 *
 * Planes are refined over time: both the pose and the polygon move, and planes get subsumed into
 * one another. Attributes are only valid inside the `requestAnimationFrame` callback, and a plane
 * that has lost tracking throws on property access — so everything here re-reads per frame and is
 * defensive about it. The tolerance is deliberately tight: if the runtime's plane is itself a
 * couple of centimetres off, that error is the ceiling on how far a snap can move a point.
 */

import { Matrix4, Vector3 } from 'three';

/** Max vertices kept per plane. ARCore hulls are far smaller; this only bounds the buffer. */
const MAX_VERTS = 64;

/**
 * Is (x, z) inside this convex polygon? Vertices are a flat [x0,z0, x1,z1, …] loop in plane space.
 *
 * For a convex loop, an interior point sits on the same side of every directed edge, so the cross
 * products all share a sign. Accepting either sign means the winding order does not have to be
 * known, and a zero (exactly on an edge) counts as inside rather than flipping the decision.
 */
export function pointInConvexPolygon(
  x: number,
  z: number,
  verts: ArrayLike<number>,
  count: number,
): boolean {
  if (count < 3) return false;
  let sign = 0;
  for (let i = 0; i < count; i++) {
    const ax = verts[i * 2];
    const az = verts[i * 2 + 1];
    const j = i + 1 === count ? 0 : i + 1;
    const bx = verts[j * 2];
    const bz = verts[j * 2 + 1];
    const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
    if (cross > 0) {
      if (sign < 0) return false;
      sign = 1;
    } else if (cross < 0) {
      if (sign > 0) return false;
      sign = -1;
    }
  }
  return true;
}

export interface Bounds2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Axis-aligned bounds of a plane-space polygon, used to reject points before the exact test. */
export function polygonBounds(verts: ArrayLike<number>, count: number, out: Bounds2D): void {
  if (count === 0) {
    out.minX = out.maxX = out.minZ = out.maxZ = 0;
    return;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = verts[i * 2];
    const z = verts[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  out.minX = minX;
  out.maxX = maxX;
  out.minZ = minZ;
  out.maxZ = maxZ;
}

/** A world-space point, filled in by `snap`. */
export interface SnapResult {
  x: number;
  y: number;
  z: number;
}

interface CachedPlane {
  worldToPlane: Matrix4;
  planeToWorld: Matrix4;
  verts: Float64Array;
  vertCount: number;
  bounds: Bounds2D;
}

interface PlaneLike {
  planeSpace: XRSpace;
  polygon?: ArrayLike<{ x: number; z: number }>;
}

function makeCached(): CachedPlane {
  return {
    worldToPlane: new Matrix4(),
    planeToWorld: new Matrix4(),
    verts: new Float64Array(MAX_VERTS * 2),
    vertCount: 0,
    bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
  };
}

const _p = new Vector3();

/**
 * Per-frame cache of the runtime's planes, and the point-snapping query over them.
 *
 * `update` is called once a frame and `snap` thousands of times, so the transform and bounds for
 * each plane are prepared up front and the query allocates nothing.
 */
export class PlaneSet {
  /** Whether the runtime exposed planes at all this frame. */
  available = false;
  /** Metres a point may sit off a plane and still be treated as belonging to it. */
  tolerance: number;
  private readonly pool: CachedPlane[] = [];
  private count = 0;

  constructor(tolerance = 0.03) {
    this.tolerance = tolerance;
  }

  get planeCount(): number {
    return this.count;
  }

  /**
   * Re-read the tracked planes for this frame. Everything is re-read rather than cached across
   * frames because the runtime refines planes in place and drops ones it has subsumed.
   */
  update(frame: XRFrame, refSpace: XRReferenceSpace): void {
    this.count = 0;
    let planes: Iterable<PlaneLike> | undefined;
    try {
      planes = (frame as unknown as { detectedPlanes?: Iterable<PlaneLike> }).detectedPlanes;
    } catch {
      planes = undefined;
    }
    if (!planes || typeof (planes as { forEach?: unknown }).forEach !== 'function') {
      this.available = false;
      return;
    }
    this.available = true;

    for (const plane of planes) {
      try {
        const pose = frame.getPose(plane.planeSpace, refSpace);
        if (!pose) continue;
        const polygon = plane.polygon;
        if (!polygon || polygon.length < 3) continue;

        const slot = this.pool[this.count] ?? (this.pool[this.count] = makeCached());
        slot.planeToWorld.fromArray(pose.transform.matrix);
        slot.worldToPlane.fromArray(pose.transform.inverse.matrix);

        const n = Math.min(polygon.length, MAX_VERTS);
        for (let i = 0; i < n; i++) {
          slot.verts[i * 2] = polygon[i].x;
          slot.verts[i * 2 + 1] = polygon[i].z;
        }
        slot.vertCount = n;
        polygonBounds(slot.verts, n, slot.bounds);
        this.count++;
      } catch {
        // A plane whose tracking was lost throws on property access; skip it and keep the rest.
      }
    }
  }

  /**
   * Project a world point onto the plane it belongs to, if any. Returns false when the point is
   * not on a known plane, in which case the caller fuses it normally.
   *
   * The cheap perpendicular test runs first and rejects nearly everything; only points already at
   * the right depth pay for the bounds and polygon tests.
   */
  snap(x: number, y: number, z: number, out: SnapResult): boolean {
    const tol = this.tolerance;
    for (let i = 0; i < this.count; i++) {
      const pl = this.pool[i];
      _p.set(x, y, z).applyMatrix4(pl.worldToPlane);
      // In plane space the normal is Y, so the perpendicular distance is just |y|.
      if (_p.y > tol || _p.y < -tol) continue;
      const b = pl.bounds;
      if (_p.x < b.minX || _p.x > b.maxX || _p.z < b.minZ || _p.z > b.maxZ) continue;
      if (!pointInConvexPolygon(_p.x, _p.z, pl.verts, pl.vertCount)) continue;
      _p.y = 0; // the snap itself
      _p.applyMatrix4(pl.planeToWorld);
      out.x = _p.x;
      out.y = _p.y;
      out.z = _p.z;
      return true;
    }
    return false;
  }
}
