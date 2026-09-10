// The RENDERER SEAM of the particle runtime: everything in `./runtime` that depends on HOW a
// binding's pixels are produced, behind one interface. The runtime keeps the simulation, the
// bindings, the canvases, the loop and the frozen/dormant/image-swap machinery — all of which are
// renderer-agnostic — and hands a packed `InstanceBuffer` plus the draw's inputs to a backend.
//
// The WebGL backend below is `drawBinding`'s GL half MOVED, not rewritten: the same call order, the
// same bottom-left source-rect math, the same profiling buckets. A WebGPU peer lands against this
// same interface later, and it renders STRAIGHT into each node's canvas — no shared canvas, no
// blit — which is what the two unusual shapes here exist for:
//
//   - `ParticleSurface.ctx2d` is NULL on such a backend. The runtime's two 2D-CANVAS-ONLY features
//     — the static-frame cache and the surface image swap, both of which re-read a canvas through a
//     2D context — key off exactly that, rather than off a renderer name.
//   - the draw options carry texture HANDLES (`ParticleTextureHandle`), not `WebGLTexture`s, so a
//     GPU texture entry (which has no `WebGLTexture` to offer) can satisfy them unchanged.
//
// `beginFrame`/`endFrame` bracket one tick's worth of draws. They are no-ops on WebGL, whose
// submits are independent; a WebGPU backend records the tick into ONE command encoder and submits
// it once at `endFrame` (the measured reason it is fast — see docs/perf-harness.md S7).

import {
  clearWebglSurface,
  disposeParticleInstanceBuffer,
  drawParticles,
  getParticleProgram,
} from "@godot-scene-web/canvas-effects/webgl";
import type { InstanceBuffer } from "@godot-scene-web/effects/particles";
import {
  bakeGradient,
  GRADIENT_INTERPOLATE_CONSTANT,
  type GradientBakeSpec,
} from "../webgl/bake-texture";
import {
  ensureSharedDrawSize,
  getBakedTexture,
  getImageTexture,
  performanceNow,
  type SharedGl,
  type TextureEntry,
} from "../webgl/shared-gl";
import type { ParticleProfile } from "./runtime";
import type { ParticleSpecConfig } from "./spec";

/** What one binding draws INTO. The canvas is the runtime's (it owns its DOM life); the context is
 *  the backend's, because a canvas can only ever hold ONE context type — which is why the choice is
 *  made once, at create, and why a backend swap means a new canvas element. */
export interface ParticleSurface {
  canvas: HTMLCanvasElement;
  /** The 2D blit target on the WebGL backend (the shared GL canvas is copied onto it), and NULL on a
   *  backend that renders into `canvas` directly. Everything that needs to READ this surface's
   *  pixels back — the static-frame cache, the surface image swap — is gated on it being non-null. */
  ctx2d: CanvasRenderingContext2D | null;
}

/** The structural subset of a texture entry the runtime and the draw carry around: enough to size a
 *  sprite (`width`/`height`), to know whether the real pixels have arrived (`loaded`, the frozen
 *  frame's cache gate) and to be told when they do (`listeners`, see `onTextureLoaded`). Deliberately
 *  NOT `TextureEntry`: the GPU resource itself is the backend's business, and a non-WebGL entry
 *  carries no `WebGLTexture`. */
export interface ParticleTextureHandle {
  width: number;
  height: number;
  loaded: boolean;
  listeners: Set<() => void>;
}

/** One binding's draw inputs: the packed instances are the buffer, everything else is here. Mirrors
 *  `DrawParticlesOptions` (the fragment feature set) with the viewport quartet replaced by the node
 *  canvas's own backing-store size — how that maps onto a viewport, a clamped target rect and a blit
 *  is a backend's private business (see the WebGL implementation). */
export interface ParticleDrawOptions {
  /** The node canvas's BACKING-STORE size (px): the coordinate domain the packed instance positions
   *  are already expressed in, and the rect a blitting backend copies into. */
  width: number;
  height: number;
  texture: ParticleTextureHandle | null;
  textured: boolean;
  /** Baked per-texel color LUT (see `ParticleSpecConfig.colorLut`), or null. */
  lutTexture: ParticleTextureHandle | null;
  /** Quad-shaped coverage mask (see `ParticleSpecConfig.maskUrl`), or null. */
  maskTexture: ParticleTextureHandle | null;
  hframes: number;
  vframes: number;
  blendMode: number;
  /** `ParticleSpecConfig.alphaFromRed`: coverage from the source RED channel, pre-LUT. */
  alphaFromRed?: boolean;
  /** `ParticleSpecConfig.alphaErode`: constant-erosion smoothstep applied to coverage. */
  erode?: { threshold: number; softness: number } | null;
  /** `ParticleSpecConfig.uvPolar`: sample the sheet through Godot's polar_coordinates remap. */
  uvPolar?: boolean;
}

/** The three texture handles one system draws with, resolved from its spec by the backend that will
 *  sample them (see `ParticleRenderBackend.resolveTextures`). The runtime holds them for reasons that
 *  have nothing to do with sampling — the sprite's decoded size drives the canvas pad, `loaded` gates
 *  the frozen-frame cache, `listeners` is how a late decode kicks a redraw — which is why they come
 *  back as handles rather than staying private to the backend. */
export interface ParticleTextureSet {
  texture: ParticleTextureHandle | null;
  lut: ParticleTextureHandle | null;
  mask: ParticleTextureHandle | null;
}

export interface ParticleRenderBackend {
  readonly kind: "webgl" | "webgpu";
  /** Give `canvas` its rendering context (and whatever per-surface GPU state the backend needs).
   *  NULL means this canvas cannot be rendered to at all, and the binding is refused — today's
   *  `getContext("2d")` returning null. */
  createSurface(
    canvas: HTMLCanvasElement,
    config: ParticleSpecConfig,
  ): ParticleSurface | null;
  /** Resolve `config`'s sprite / colour-LUT / mask into handles this backend can sample.
   *
   *  A texture belongs to the API that will bind it — a `WebGLTexture` is meaningless to a WebGPU
   *  pass and vice versa — so the CACHE is the backend's, not the runtime's. Both implementations key
   *  their cache with the SAME strings for the same inputs (`clamp:`/`repeat:` + url, and
   *  `particle-lut:${JSON}` from `particleLutBake`), which is what lets a page that falls back from
   *  WebGPU to WebGL mid-run re-derive the same entry for the same texture. */
  resolveTextures(config: ParticleSpecConfig): ParticleTextureSet;
  /** Release every GPU resource this binding owned, the instance buffer included. The canvas element
   *  itself belongs to the runtime, which removes it. */
  disposeSurface(surface: ParticleSurface, buffer: InstanceBuffer): void;
  /** Longest-edge ceiling this backend can back a canvas with, folded into the sizing law, or
   *  UNDEFINED for no limit of its own — which is what WebGL reports (the shared drawing buffer
   *  discovers its ceiling at draw time instead, see `ensureSharedDrawSize`). */
  maxBackingDim(): number | undefined;
  /** Called once around each tick's draws (see the module doc). */
  beginFrame(): void;
  endFrame(): void;
  /** Blank `surface` over `w`x`h` — the live tick's no-live-instances frame and the expired-burst
   *  retire. A REAL frame, cheap but not free, so it books to `blitMs` on a backend where it is
   *  2D-canvas fill. */
  clear(
    surface: ParticleSurface,
    w: number,
    h: number,
    prof: ParticleProfile | null,
  ): void;
  /** Draw `buffer`'s instances onto `surface`. `prof` is the caller's cost attribution or null (the
   *  frozen path draws once, off the per-frame buckets — see `ParticleProfile`), and every bracket
   *  must sit behind that one null check so an unprofiled draw takes no clock reading at all. */
  draw(
    surface: ParticleSurface,
    buffer: InstanceBuffer,
    opts: ParticleDrawOptions,
    prof: ParticleProfile | null,
  ): void;
  /** Frames this backend has SUBMITTED to the GPU, or absent where the question is meaningless (a
   *  WebGL backend submits per draw, through a context it does not own). Read as a stat, never by a
   *  render decision — it is how a probe checks that a tick really cost ONE submit and not N. */
  submits?(): number;
  /** Re-render `surface`'s current frame into an offscreen target and read it back as tightly-packed
   *  RGBA (premultiplied, top-down) at the surface's backing size — see
   *  `ParticleRuntime.captureNodePixels`, which is the only caller.
   *
   *  ABSENT on the WebGL backend, deliberately: its canvas already holds readable 2D pixels, so a
   *  consumer that wants them uses `getImageData`. It exists at all because a WebGPU canvas has no
   *  such path (`drawImage`/`toDataURL` from one are blank headless and pathological on Android —
   *  see `../webgpu/readback`), so the pixels must be produced a second time into a texture that can
   *  be copied. */
  captureSurface?(
    surface: ParticleSurface,
    buffer: InstanceBuffer,
    opts: ParticleDrawOptions,
  ): Promise<Uint8Array | null>;
}

/** Godot's `GradientTexture1D` default width — the resolution the game's own LUT samplers are baked
 *  at, so the browser samples the same quantization. */
const LUT_WIDTH = 256;

/**
 * The colour-LUT bake for a system — its cache KEY, the gradient to bake, and whether it must be
 * sampled with NEAREST — or null when the spec carries no `colorLut`.
 *
 * Pure, and shared by both backends ON PURPOSE: the key is a cross-cache invariant (`particle-lut:`
 * + the serialized spec), so the WebGL and WebGPU caches hand out the same LUT for the same stops
 * and a fallback mid-run does not re-bake a subtly different ramp.
 */
export function particleLutBake(
  cfg: ParticleSpecConfig,
): { key: string; spec: GradientBakeSpec; nearest: boolean } | null {
  const stops = cfg.colorLut;
  if (!stops || stops.length === 0) return null;
  const mode = cfg.colorLutInterpolation ?? 0;
  const spec: GradientBakeSpec = {
    kind: "gradient",
    width: LUT_WIDTH,
    stops,
    interpolationMode: mode,
  };
  return {
    key: `particle-lut:${JSON.stringify(spec)}`,
    spec,
    // CONSTANT stops are hard steps; LINEAR filtering would smear each boundary back.
    nearest: mode === GRADIENT_INTERPOLATE_CONSTANT,
  };
}

/** The baked colour-LUT texture for a system on the WEBGL backend, or null when the spec carries no
 *  `colorLut`. Cached (by value, in shared-gl's texture cache) so the many nodes that share one VFX
 *  material — every hit-streak burst in a combat — share ONE 256x1 GL texture. Re-exported from
 *  `./runtime`, where it used to live. */
export function lutTextureFor(
  gl: WebGL2RenderingContext,
  cfg: ParticleSpecConfig,
): TextureEntry | null {
  const bake = particleLutBake(cfg);
  if (!bake) return null;
  return getBakedTexture(gl, bake.key, () => bakeGradient(bake.spec), {
    repeat: false,
    nearest: bake.nearest,
  });
}

// Under this backend a texture handle IS a shared-gl `TextureEntry` — the runtime resolves them from
// the shared cache — and the interface types them structurally only so a GPU entry can satisfy it
// later. Narrow back here, at the one place that needs the resource itself.
function glTextureOf(
  handle: ParticleTextureHandle | null,
): WebGLTexture | null {
  return (handle as TextureEntry | null)?.texture ?? null;
}

/**
 * The WebGL particle backend: one shared offscreen WebGL2 context for every system on the page
 * (`../webgl/shared-gl`), rendered into a viewport sub-rect of its grow-only canvas and blitted onto
 * each node's own 2D canvas — the pipeline this runtime has always had.
 *
 * NULL when the instanced particle program does not compile or link, which is the runtime's
 * long-standing "no particles at all" gate: the caller returns a no-op handle and every opted-in node
 * stays on its static `<span>` preview.
 */
export function createWebglParticleBackend(
  shared: SharedGl,
): ParticleRenderBackend | null {
  const { gl } = shared;
  const program = getParticleProgram(gl);
  if (!program) return null;
  return {
    kind: "webgl",
    createSurface(canvas: HTMLCanvasElement): ParticleSurface | null {
      // A PLAIN 2D context, with no options: this canvas is the blit target for the shared GL
      // canvas, and `drawImage` between canvases needs nothing declared here (the alpha contract
      // lives on the SOURCE — `../webgl/shared-gl.ts` declares `premultipliedAlpha: true`, and
      // every 2D canvas is premultiplied by definition, so the copy is a straight copy).
      //
      // The additive path resolves in-canvas to `(light, coverage)`, which is a source-over-
      // complete frame: source-over then contributes `light + dst*(1 - coverage)`. That is the
      // closest source-over gets to Godot's `light + dst`, not an equal — the node ALSO carries
      // `mix-blend-mode: plus-lighter` when its material says BLEND_MODE_ADD (`../material.ts`),
      // which is what supplies the missing `dst` term at the page level. The in-canvas resolve is
      // what makes overlapping particles inside ONE system stack correctly; the CSS blend is what
      // makes the system stack correctly on the page.
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return null;
      return { canvas, ctx2d };
    },
    // The shared image-texture cache: the many nodes of one VFX family share each entry, and a
    // still-loading one is the 1x1 TRANSPARENT placeholder — so a masked system draws nothing rather
    // than flashing an unmasked square, which is what the game shows too.
    resolveTextures(config: ParticleSpecConfig) {
      return {
        texture: config.textureUrl
          ? getImageTexture(gl, config.textureUrl, { repeat: false })
          : null,
        lut: lutTextureFor(gl, config),
        mask: config.maskUrl
          ? getImageTexture(gl, config.maskUrl, { repeat: false })
          : null,
      };
    },
    disposeSurface(_surface: ParticleSurface, buffer: InstanceBuffer): void {
      disposeParticleInstanceBuffer(gl, buffer);
    },
    // The shared drawing buffer is grow-only and VERIFIES what it really got, so this backend needs
    // no size law of its own (see `ensureSharedDrawSize`): a canvas larger than the buffer can hold
    // is drawn at a reduced target rect and scaled back up by the blit, never clamped up front.
    maxBackingDim(): number | undefined {
      return undefined;
    },
    // No-ops: each system's draw is submitted on its own, exactly as before this seam existed.
    beginFrame(): void {},
    endFrame(): void {},
    clear(
      surface: ParticleSurface,
      w: number,
      h: number,
      prof: ParticleProfile | null,
    ): void {
      // The CLEAR is 2D-canvas fill, the same cost class as the blit that usually follows it, so it
      // is booked to `blitMs` — on the clear-only path too, which is a real (if cheap) frame.
      const clearStart = prof ? performanceNow() : 0;
      surface.ctx2d?.clearRect(0, 0, w, h);
      if (prof) prof.blitMs += performanceNow() - clearStart;
    },
    draw(
      surface: ParticleSurface,
      buffer: InstanceBuffer,
      opts: ParticleDrawOptions,
      prof: ParticleProfile | null,
    ): void {
      const ctx2d = surface.ctx2d;
      const w = opts.width;
      const h = opts.height;
      const clearStart = prof ? performanceNow() : 0;
      ctx2d?.clearRect(0, 0, w, h);
      if (prof) prof.blitMs += performanceNow() - clearStart;

      // Grow-only: never shrink the shared GL canvas. Re-assigning canvas.width/height reallocates the drawing
      // buffer (very expensive) — and with MANY differently-sized particle systems (screen-filling background
      // emitters can be 1500–2048px) each setting the shared canvas to its own size every frame, that realloc
      // thrash dominated the frame. Keep the shared canvas at the max ever needed and render into a viewport
      // sub-rect. The grow is VERIFIED against the actual drawing buffer (see `ensureSharedDrawSize`):
      // drawing/blitting at the attribute size when the buffer came back smaller reads out-of-bounds — the
      // shader runtime's black-band bug, same shared canvas. vw×vh ≤ w×h is what can really be drawn; the blit
      // scales it back up to the node canvas.
      const { vw, vh, bufH } = ensureSharedDrawSize(shared, w, h);
      clearWebglSurface(gl, vw, vh);

      // GL SUBMIT bucket — issue cost only (the GPU runs async; see `ParticleProfile.glMs`). The
      // options object is inside the bracket because building it IS part of submitting the draw.
      const glStart = prof ? performanceNow() : 0;
      drawParticles(shared, program, buffer, {
        texture: glTextureOf(opts.texture),
        textured: opts.textured,
        lutTexture: glTextureOf(opts.lutTexture),
        maskTexture: glTextureOf(opts.maskTexture),
        hframes: opts.hframes,
        vframes: opts.vframes,
        blendMode: opts.blendMode,
        // The px coordinate DOMAIN stays the node's full backing (the vertex NDC mapping divides by
        // it); the clamped `target` is where the pixels land — together they scale the draw down.
        viewportW: w,
        viewportH: h,
        targetW: vw,
        targetH: vh,
        alphaFromRed: opts.alphaFromRed,
        erode: opts.erode,
        uvPolar: opts.uvPolar,
      });
      if (prof) prof.glMs += performanceNow() - glStart;
      // The viewport rendered into the framebuffer's bottom-left (GL origin) = the BOTTOM `vh` rows of the
      // (possibly taller, grow-only) shared canvas image; copy that sub-region rather than the whole canvas. The
      // dest covers the node's FULL w×h backing: a buffer-capped draw scales up (reduced resolution, never a
      // clipped band).
      //
      // A PURE COPY, in bytes: the shared canvas declares `premultipliedAlpha: true` and a 2D
      // canvas is premultiplied, so `drawImage` converts nothing. It did once — the source was
      // declared STRAIGHT while the MIX fragment wrote premultiplied content, and this line was
      // where the browser dutifully multiplied by alpha a second time, landing MIX particles at
      // `(c·a², a)`. That is why the alpha contract is stated on the context, not here.
      const blitStart = prof ? performanceNow() : 0;
      ctx2d?.drawImage(shared.canvas, 0, bufH - vh, vw, vh, 0, 0, w, h);
      if (prof) prof.blitMs += performanceNow() - blitStart;
    },
  };
}
