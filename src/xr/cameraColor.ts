/**
 * Reads the WebXR raw camera image (camera-access) into a small CPU buffer so per-voxel
 * colors can be sampled and averaged.
 *
 * `XRWebGLBinding.getCameraImage(view.camera)` returns a frame-valid, GPU-only WebGLTexture
 * aligned to the XRView (confirmed: 855x1920 on Pixel 9a). There is no CPU pixel access, so we
 * attach it to a framebuffer, blit-downscale into a small RGBA texture, and `readPixels` that
 * (WebGL2). Everything is guarded: any failure sets `failed` and the caller falls back to a
 * placeholder color — the AR view must never break because of this path.
 *
 * Orientation of the readback vs. the normalized view coords is device-dependent, so `flipX`
 * / `flipY` are adjustable and validated on-device.
 */

interface XRWebGLBindingLike {
  getCameraImage(camera: unknown): WebGLTexture | null;
}
interface XRCameraLike {
  width: number;
  height: number;
}

export interface CameraColorConfig {
  targetWidth: number;
  targetHeight: number;
  flipX?: boolean;
  flipY?: boolean;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export class CameraColorReader {
  readonly width: number;
  readonly height: number;
  flipX: boolean;
  flipY: boolean;

  /** True once a hard failure occurred; the caller should stop relying on camera color. */
  failed = false;
  /** True when the most recent update() produced a fresh readback. */
  available = false;
  /** Downsampled RGBA buffer (bottom-up rows, as returned by readPixels). */
  readonly buffer: Uint8Array;

  private readonly gl: WebGL2RenderingContext;
  private readonly binding: XRWebGLBindingLike | null = null;
  private readonly srcFbo: WebGLFramebuffer | null;
  private readonly dstFbo: WebGLFramebuffer | null;
  private readonly dstTex: WebGLTexture | null;
  private hasData = false;

  /** True once at least one readback has succeeded and no hard failure has occurred. */
  get ready(): boolean {
    return this.hasData && !this.failed;
  }

  constructor(session: XRSession, gl: WebGL2RenderingContext, config: CameraColorConfig) {
    this.gl = gl;
    this.width = config.targetWidth;
    this.height = config.targetHeight;
    this.flipX = config.flipX ?? false;
    this.flipY = config.flipY ?? true;
    this.buffer = new Uint8Array(this.width * this.height * 4);

    let srcFbo: WebGLFramebuffer | null = null;
    let dstFbo: WebGLFramebuffer | null = null;
    let dstTex: WebGLTexture | null = null;
    try {
      if (typeof gl.blitFramebuffer !== 'function' || typeof XRWebGLBinding === 'undefined') {
        throw new Error('WebGL2 / XRWebGLBinding unavailable');
      }
      this.binding = new XRWebGLBinding(session, gl) as unknown as XRWebGLBindingLike;
      srcFbo = gl.createFramebuffer();
      dstFbo = gl.createFramebuffer();
      dstTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, dstTex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        this.width,
        this.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } catch {
      this.failed = true;
    }
    this.srcFbo = srcFbo;
    this.dstFbo = dstFbo;
    this.dstTex = dstTex;
  }

  /** Grab + downscale the camera image for `view`. Returns true if a fresh buffer is ready. */
  update(view: XRView): boolean {
    this.available = false;
    if (this.failed || !this.binding || !this.srcFbo || !this.dstFbo) return false;

    const camera = (view as unknown as { camera?: XRCameraLike }).camera;
    if (!camera) return false;

    const gl = this.gl;
    let tex: WebGLTexture | null = null;
    try {
      tex = this.binding.getCameraImage(camera);
    } catch {
      this.failed = true;
      return false;
    }
    if (!tex) return false;

    try {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.srcFbo);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.failed = true;
        return false;
      }
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.dstFbo);
      gl.blitFramebuffer(
        0,
        0,
        camera.width,
        camera.height,
        0,
        0,
        this.width,
        this.height,
        gl.COLOR_BUFFER_BIT,
        gl.LINEAR,
      );
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.dstFbo);
      gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, this.buffer);
      this.available = true;
      this.hasData = true;
    } catch {
      this.failed = true;
      this.available = false;
    } finally {
      // Detach and unbind so nothing dangles into three's next render.
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.srcFbo);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    return this.available;
  }

  /** Sample the last readback at normalized view coords (u, v). Writes into `out`, returns success. */
  sample(u: number, v: number, out: RGB): boolean {
    if (!this.hasData) return false;
    let su = this.flipX ? 1 - u : u;
    let sv = this.flipY ? 1 - v : v;
    su = su < 0 ? 0 : su > 1 ? 1 : su;
    sv = sv < 0 ? 0 : sv > 1 ? 1 : sv;
    const x = Math.min(this.width - 1, (su * this.width) | 0);
    const y = Math.min(this.height - 1, (sv * this.height) | 0);
    const i = (y * this.width + x) * 4;
    out.r = this.buffer[i];
    out.g = this.buffer[i + 1];
    out.b = this.buffer[i + 2];
    return true;
  }

  dispose(): void {
    const gl = this.gl;
    if (this.srcFbo) gl.deleteFramebuffer(this.srcFbo);
    if (this.dstFbo) gl.deleteFramebuffer(this.dstFbo);
    if (this.dstTex) gl.deleteTexture(this.dstTex);
  }
}
