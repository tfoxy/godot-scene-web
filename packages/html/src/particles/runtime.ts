import {
  type ParticleInstancePackInput,
  packParticleInstances,
} from "@godot-scene-web/effects/particles";
// Live 2D particle runtime — the sibling of `../webgl/runtime.ts`. Walks the opted-in `[data-godot-particle-runtime]` nodes a
// renderer mounted, builds a per-node overlay canvas in the self-layer, runs the
// deterministic CPU simulation, and draws instanced quads via the SHARED WebGL2
// context (blitting to each node's 2D canvas). A single loop steps + redraws all
// systems and STOPS when every system is idle (so finished one-shot bursts cost ~0); under an FPS
// cap it PARKS on a timer to the next cap boundary instead of arming a rAF per display frame (see
// `../effects-loop-pacing`, and `effectsLoopPacing: "raf"` to restore the per-frame spin).
// Returns a disposer; a no-op when WebGL2 is unavailable (the static `<span>` preview
// then stays as the fallback).
//
// Sizing: a binding's canvas is placed and sized from its self-layer's content box, and it is that
// MEASUREMENT, not the drawing, that dominated this runtime's main-thread cost — a `clientWidth`
// right after the writes the same pass just made is a forced style+layout flush. Two options bound
// it. `particleRectCache` caches each binding's box so only a CREATE reads (one contiguous batched
// run per reconcile, never a per-binding read/write interleave), and `particleObserverSizing` removes
// even that: a new binding's canvas stays OUT of the DOM until the shared ResizeObserver hands over
// the first box it measured during the browser's own layout step. With both on (the default) the
// create path forces no layout at all and `stats().boxReads` settles at 0. See `../types`.
//
// Frozen one-shots: static/frozen mode warms a system to a representative frame and parks it, which is right
// for an emitter that runs forever and wrong for a BURST. A one-shot binding whose own active window
// (`lifetime * (2 - explosiveness)`, the same law the sim ends a live burst by) has elapsed since this client
// first saw it emitting stops being drawn — see `retireExpiredBurst`, kill switch
// `staticParticleOneShotExpiry: false`.
//
// Occlusion: a binding under a `data-godot-effects-suspended` ancestor is SUSPENDED — the loop
// skips its simulate + draw (state FROZEN, never reset) and it doesn't count as live, so a covered
// subtree (a full-screen dialog over the scene) parks the loop instead of burning CPU on ambient
// emitters nobody can see. See `../effects-suspend` for the full contract.
//
// Dormancy PARK: a suspended binding stops SIMULATING, but its `<canvas>` is an unconditionally
// promoted compositor layer, so it kept costing a layer, a render surface and its GPU backing store
// for as long as the node stayed mounted — measured as +340 net layers and a monotonic GPU-process
// climb (148 → 276 MB) across a combat trace. So a suspended binding is also PARKED (see
// `../shader-dormant`, whose contract this is the particle sibling of): its canvas is hidden, every
// `sizeCanvas` it is owed is deferred to the wake, and a binding parked longer than
// `DORMANT_DISPOSE_SECONDS` is disposed for real by ONE per-runtime sweep. Kill switch:
// `particleDormant: false` (see `../types`).
//
// Image swap: a binding whose canvas has been observed to stand still is shown as an `<img>` of its
// own frame instead (the canvas stays, hidden), which drops its compositor layer, its render
// surface and its per-frame GPU fill. The MECHANISM is `../surface-image-swap` (generic, no
// particles in it); the POLICY comes from the `staticParticleImages` option, which is OFF by
// default and whose `true` means the QUIET-WINDOW gate — "nothing has painted this canvas for a
// while" is the only evidence a system that is still SIMULATING can ever offer. Every path that
// writes pixels into a binding's canvas reports a paint (`notePaint`), the CACHE-HIT BLIT included.
// A paint that lands on the pristine path also carries the frame's KEY, which is what collapses N
// twins onto one encode and lets a re-blit re-state the frame it is already showing instead of
// thawing it — see `notePaint` for the whole contract and for the cases that must stay keyless.
//
// Freeze at mount: a binding the host names through `canFreezeSurface` may skip the simulation
// entirely (`staticParticleFreezeAtMount`) — warmed once, drawn once, never stepped — and, when this
// document has already encoded its frame, mount as an `<img>` with NO canvas context and NO backing
// store at all. See `claimFrozenMount` for the zero-canvas path, `liveifyBinding` for how such a
// surface takes its canvas back, and `donateStill` for how a departing binding banks the frame its
// successors will claim.

import {
  createParticleState,
  InstanceBuffer,
  oneShotBurstSeconds,
  type ParticleSystemState,
  particlesAreLive,
  preprocessParticles,
  simulateParticles,
  staticOneShotExpired,
  warmStaticParticles,
} from "@godot-scene-web/effects/particles";
import {
  reportUnsupportedRender,
  type UnsupportedRenderReporter,
} from "../diagnostics";
import {
  createEffectsLoopPacer,
  type EffectsLoopPacing,
} from "../effects-loop-pacing";
import { isEffectsSuspended } from "../effects-suspend";
import { ownSelfLayer } from "../render-structure";
import type { GodotHtmlRuntimeOptions } from "../runtime-options";
import { DORMANT_DISPOSE_SECONDS } from "../shader-dormant";
import {
  applySurfaceVisibility,
  claimStaticStill,
  createStaticImageSwapCounters,
  createStaticSurfaceSwapper,
  disposeStaticImage,
  hasStaticStill,
  liveStaticImageUrlCount,
  noteStaticFrame,
  noteStaticSurfaceWake,
  revertStaticImage,
  type StaticImageState,
  type StaticImageSwapCounters,
  type StaticSurfaceCapture,
  type StaticSurfaceOption,
  type StaticSurfacePolicy,
  type StaticSurfaceSwapper,
  staticStillPoolStats,
} from "../surface-image-swap";
import type { GodotEffectRenderInfo } from "../types";
import {
  backingStoreSize,
  effectivePixelRatio,
  getShared,
  MAX_PINNED_BACKING_DIM,
  normalizeStaticPixelRatio,
  nowSeconds,
  onTextureLoaded,
  parseSurfacePixelRatio,
  performanceNow,
  SURFACE_PIXEL_RATIO_ATTR,
} from "../webgl/shared-gl";
import {
  acquireWebgpuDevice,
  latchWebgpuFallbackReason,
  onWebgpuDeviceLost,
  peekWebgpuDevice,
  type WebgpuFallbackReason,
  type WebgpuShared,
  webgpuFallbackReason,
} from "../webgpu/device";
import { canvasFromPremultipliedRgba } from "../webgpu/still-capture";
import {
  frameSize,
  type ParticleExtents,
  type ParticleLocalRect,
  parseLocalVisibleRect,
  particleCanvasExtents,
  symmetricCanvasExtents,
  visibleAllowance,
} from "./extents";
import {
  createWebglParticleBackend,
  type ParticleDrawOptions,
  type ParticleRenderBackend,
  type ParticleSurface,
  type ParticleTextureHandle,
} from "./render-backend";
import {
  createWebgpuParticleBackend,
  peekWebgpuParticleBackend,
} from "./render-webgpu";
import { type ParticleSpecConfig, parseParticleSpecConfig } from "./spec";
import {
  getStaticParticleFrame,
  particleStaticFrameKey,
  particleStaticFrameKeyBase,
  storeStaticParticleFrame,
} from "./static-frame-cache";

/** The host attribute naming the part of a particle node's OWN local px space that can actually be
 *  seen (`"x,y,width,height"`), so the canvas is grown to contain the spray's travel but no further
 *  than the visible stage. Optional: absent ⇒ the margin is capped at `PAD_CAP` per side instead
 *  (see `./extents`). Re-read on every reconcile for a KEPT binding, so a node that moves re-sizes
 *  its canvas — it does NOT re-create the binding, which would restart the simulation. */
const VISIBLE_RECT_ATTR = "data-godot-particle-visible-rect";

// The baked color-LUT texture for a system on the WebGL backend. It MOVED to `./render-backend`
// (which is where the GL texture cache is consulted from now that texture resolution is a backend
// question — the WebGPU peer bakes the same gradient under the same key), and is re-exported here
// because that is where its consumers have always imported it from.
export { lutTextureFor } from "./render-backend";

// How many BAKE DONORS one runtime may hold at once (see `donateStill`). Small on purpose: a donor
// pins a canvas backing store and a GPU buffer for a readback nobody is waiting on, and the
// population this serves collapses onto a handful of distinct keys — a fleet of 70 nodes measured at
// 2 — so a deep queue would only be holding duplicates of frames already in flight.
const MAX_STILL_DONORS = 4;

// The pure sizing law — how big the overlay canvas has to be, per side — lives in `./extents`.
// Re-exported from here because that is where its consumers have always imported it from (as
// `lutTextureFor` above is), and because the directional law that replaced the symmetric pad still
// has to be able to compute the old number: it is the FLOOR the new one can never go below.
export {
  emissionExtentPad,
  emissionExtents,
  type ParticleExtents,
  type ParticleLocalRect,
  particleCanvasExtents,
  spriteExtentPad,
  travelExtents,
  visibleAllowance,
} from "./extents";

interface ParticleBinding {
  /** The outer `[data-godot-particle-runtime]` node element (the reconcile key; carries the host's
   *  node-level styles, e.g. an additive material's `mix-blend-mode` — see `parkBindingBlend`). */
  node: HTMLElement;
  selfLayer: HTMLElement;
  /** The overlay canvas element. Owned by the runtime (it sizes, places, mounts, hides and removes
   *  it) and ALSO reachable through `surface` — the DOM half of it is renderer-agnostic, the
   *  context on it is not. */
  canvas: HTMLCanvasElement;
  /** What the backend draws into (see `./render-backend`), or NULL while no backend has claimed the
   *  canvas yet. A surface-less binding is skipped by the draw paths exactly like an unmounted one:
   *  it has no context, so it can neither draw nor be frozen. */
  surface: ParticleSurface | null;
  /** ASYNC ENCODE SOURCE for the frozen-surface image swap, set ONLY on a binding whose canvas
   *  cannot be read back (a WebGPU one — see `attachSurfaceSwap`). Produces a fresh 2D canvas of
   *  this binding's current frame through the backend's capture hook; the swap module owns and
   *  releases it. Absent on a 2D-backed binding, whose canvas the swap reads directly. See
   *  `../surface-image-swap`'s `StaticImageSwapBinding.captureCanvas`. */
  captureCanvas?: () => Promise<StaticSurfaceCapture>;
  config: ParticleSpecConfig;
  state: ParticleSystemState;
  /** The sprite sheet, resolved by the BACKEND that will sample it (`resolveTextures`), or null —
   *  for a system with no `textureUrl`, and for any binding whose backend has not been decided yet
   *  (see `surface`). The runtime reads only the renderer-agnostic quartet off it: `width`/`height`
   *  for the canvas pad, `loaded` for the frozen-frame cache gate, `listeners` for the redraw hook. */
  texture: ParticleTextureHandle | null;
  /** Baked `colorLut` ramp (shared + cached by spec key on the backend's cache), or null. */
  lut: ParticleTextureHandle | null;
  /** `maskUrl` coverage mask (shared image-texture cache), or null. A transparent 1x1 until it decodes. */
  mask: ParticleTextureHandle | null;
  buffer: InstanceBuffer;
  packing?: ReturnType<typeof bindingPackInput>;
  /** Static preview spans we hid; restored on dispose. */
  hiddenPreview: HTMLElement[];
  /** Whether `canvas` is IN THE DOM. False between `createBinding` and the binding's first
   *  successful `sizeCanvas`, which is the moment it acquires a real box (see `mountBinding`).
   *
   *  A canvas is mounted by its FIRST SIZING, never by its create, because an unsized canvas is a
   *  300x150 default box at the self-layer origin — a wrong picture, an unconditional compositor
   *  layer and a raster, for a surface that cannot draw anything yet. Deferring the insert is what
   *  lets `particleObserverSizing` take that first box from the shared ResizeObserver's initial
   *  delivery instead of from a create-time `clientWidth` (see `readBoxInto`). The preview spans are
   *  hidden at CREATE either way: hiding them is a pure write, and leaving them visible for the extra
   *  frame would both flash a static preview under the arriving canvas and keep a parked (occluded)
   *  binding's spans painting — the very cost the park exists to drop.
   *
   *  A binding that never mounts never draws (the loop skips it) and never freezes (it can have no
   *  paint), so nothing downstream has to special-case it. */
  mounted: boolean;
  textureDisposers: Array<() => void>;
  /** Per-side canvas margin (css px) so a system's sprites and its TRAVEL aren't clipped to the
   *  (usually zero-size) box — see `./extents`. `left`/`top` are also the draw's origin offset
   *  (`packBinding`), which is why the two are read individually all over this file rather than as
   *  one symmetric `pad`. With `particleTravelExtents` off all four are the same number, and every
   *  geometry this runtime computes is byte-identical to the pre-directional one. */
  pad: ParticleExtents;
  /** The part of this node's own local px space that can be SEEN, as the host last said
   *  (`VISIBLE_RECT_ATTR`), or null when it said nothing. Caps the margin above, so a burst that
   *  travels off-screen allocates only the on-screen part of its flight. */
  visibleRect: ParticleLocalRect | null;
  /** …and the raw attribute string it was parsed from, so a reconcile can tell "unchanged" from
   *  "moved" with one string compare and no parse. Null while the option is off (nothing is read). */
  visibleRectAttr: string | null;
  /** Per-binding backing-density MULTIPLIER (see `SURFACE_PIXEL_RATIO_ATTR` in `../webgl/shared-gl`):
   *  how much bigger this surface is on screen than its own CSS box, as the host states it. Folded
   *  into the density term by `measureCanvasGeometry`, so it applies to the live ratio, the frozen
   *  pin and a freeze-at-mount claim's frame key alike. Always a finite positive number — an absent
   *  or malformed attribute resolves to exactly `1`, the un-stamped, byte-identical case. */
  pixelRatioScale: number;
  /** …and the raw attribute string, compared per reconcile the way `visibleRectAttr` is: one string
   *  compare for a node that did not move, no parse. */
  pixelRatioAttr: string | null;
  /** Last-measured self-layer content-box size in CSS px, and whether it has been measured at all.
   *  Seeded by the ONE create-time layout read (`reconcile`'s measure pass) and kept current by the
   *  shared ResizeObserver's `contentRect`, so every later `syncCanvasSize` — a fleet re-size
   *  (`setRenderScale`, a pin change, a frozen-mode flip) or a texture-load re-pad, none of which
   *  move the element box — reuses it instead of forcing another clientWidth/clientHeight layout
   *  flush. The shader runtime's `NodeBinding.boxW`/`boxH` (`../webgl/runtime`), with one
   *  difference: "have we measured?" lives in its OWN flag rather than in `boxW > 0`, because a
   *  particle self-layer legitimately measures 0 (a never-laid-out or hidden subtree) and reading
   *  that as "unmeasured" would leave exactly those bindings re-reading forever. Written but never
   *  consulted while `particleRectCache` is false. */
  boxW: number;
  boxH: number;
  boxMeasured: boolean;
  /** The backing-store ratio this binding's canvas was LAST sized at — the live
   *  `devicePixelRatio × renderScale`, the frozen-mode pin (`staticParticlePixelRatio`), or, when the
   *  pinned size hit `MAX_PINNED_BACKING_DIM`, the reduced ratio that was actually allocated. The
   *  draw scales its geometry by exactly this, so sprites can never be sized for a canvas the
   *  binding did not get. Written by `syncCanvasSize`. */
  drawRatio: number;
  /** The raw `data-godot-particle-specs` string — the reconcile key for change detection. */
  signature: string;
  /** The binding-lifetime-constant half of the static-frame cache key, PRECOMPUTED here instead of
   *  re-derived on every static tick (the shader runtime's `paramsKey` memo, same trick). Every term
   *  in it is fixed for as long as the binding exists: a change to the spec attribute — the only
   *  input that can move — RE-CREATES the binding (see `reconcile`), so this is recomputed exactly
   *  when the attribute string changes and never otherwise. See `./static-frame-cache`. */
  staticKeyBase: string;
  /** Static/frozen mode: whether this binding has already been warmed + drawn since the last freeze. A fresh
   *  binding (or one re-created by a spec/epoch change) starts false, so the static loop re-warms + re-freezes it. */
  frozen: boolean;
  /** Whether this binding's simulation state is still the DETERMINISTIC function of its
   *  (config, count) that `createBinding` left behind — i.e. the live loop has never stepped it. Only
   *  a pristine binding may be keyed into the static-frame cache: `warmStaticParticles` is pure, but
   *  it is pure OF THE STATE IT IS GIVEN, and a system frozen mid-flight (live runtime, then
   *  `setStaticParticles(true)`) warms from whatever phase it was in — which two nodes sharing a spec
   *  do NOT share. Cleared for good the first time `simulateParticles` steps it. */
  pristine: boolean;
  /** A static tick served this binding's frozen frame from the cache and therefore SKIPPED its own
   *  `warmStaticParticles`. The skipped warm is owed: without it, leaving frozen mode would resume
   *  the simulation from the un-warmed post-create state instead of the mid-flight state it would
   *  have had, i.e. a visible pop. `setStaticParticles(false)` pays it back before resuming. */
  pendingWarm: boolean;
  /** Occlusion suspend (see `../effects-suspend`): the node sits under a
   *  `data-godot-effects-suspended` ancestor → the loop skips simulate + draw for it and it does
   *  NOT keep the loop alive. The sim state is FROZEN, not reset, so a resume continues where it
   *  left off. Recomputed on every `reconcile()`, never polled per frame. */
  suspended: boolean;
  /** A repaint of this canvas is OWED, so its pixels are NOT the frame anything may freeze: the
   *  backing store was re-allocated (which CLEARS it), the binding is suspended and its resume
   *  redraw has not run, or it has never been drawn at all. Read only by the surface image swap —
   *  which refuses to freeze a dirty surface and reverts a swapped one — and cleared by `notePaint`.
   *  The shader runtime's `NodeBinding.dirty`, and the same way it expresses occlusion to the swap.
   *  Inert while the swap is off (nothing else in this runtime reads it). */
  dirty: boolean;
  /** PARKED (the shader runtime's `data-godot-shader-dormant` state, see `../shader-dormant`):
   *  `suspended` AND the park is enabled (`particleDormant`, the default). A parked binding keeps
   *  its object identity and its simulation state, but its canvas is HIDDEN — which is what drops
   *  the compositor layer, the render surface and the backing store an occluded canvas would
   *  otherwise hold for as long as the node stays mounted — and every `sizeCanvas` it is owed is
   *  deferred (`canvasSyncDeferred`). Recomputed on every `reconcile()`, from the same
   *  attribute-only read that recomputes `suspended`; never polled per frame.
   *
   *  DISPLAY OWNERSHIP (the delicate part). This runtime NEVER writes `canvas.style.display`
   *  itself: the park is published by setting this flag and calling the swap module's
   *  `applySurfaceVisibility`, which stays the single writer and composes the two states — parked
   *  hides BOTH surfaces (canvas and any stand-in `<img>`), swapped-and-awake hides the canvas
   *  only, and neither restores the `display` the HOST left rather than a blanket `""`. That is
   *  exactly how `../webgl/runtime`'s `syncDormant` arbitrates, and it is why a park can never
   *  strand an `<img>` over a hidden canvas, nor leave a canvas hidden after the wake. The one
   *  direct write is at CREATE (`createBinding`), before any swap state exists — the swapper's
   *  `attach` adopts that hide, as it does for a shader binding born dormant. */
  dormant: boolean;
  /** A `sizeCanvas` that was skipped while parked; run ONCE on wake (`../webgl/runtime`'s
   *  `canvasSyncDeferred`). What is deferred, with WS-1's box cache in place, is mostly the WRITE
   *  side — four inline style writes plus, whenever the density really moved, a `canvas.width`
   *  assignment that RE-ALLOCATES (and clears) the backing store of a canvas nobody can see, and
   *  with the image swap on a revert of its stand-in. However many of those pile up while parked (a
   *  fleet `setRenderScale`, a pin change, a frozen-mode flip, an observer delivery), the wake pays
   *  for one. It defers a READ too in the two cases where the box is not cached: a binding BORN
   *  parked (never measured — the shader runtime's original motivation) and `particleRectCache:
   *  false`. */
  canvasSyncDeferred: boolean;
  /** Ordinal of the moment this binding parked, from the runtime's monotonic counter (0 while
   *  awake). The park-expiry sweep compares ordinals rather than a wall clock, so it needs no
   *  per-binding timer and no clock reading (`../webgl/runtime`'s `dormantSeq`). */
  dormantSeq: number;
  /** Frozen-surface image-swap state (see `../surface-image-swap`), or null when the runtime's
   *  `staticParticleImages` option is off — the default — in which case every swap call site is a
   *  no-op and the binding takes exactly the path it took before the swap existed. */
  staticImage: StaticImageState | null;
  /** FROZEN-MODE one-shot expiry (`options.staticParticleOneShotExpiry`, see `retireExpiredBurst`): the
   *  clock reading at which THIS CLIENT first saw this binding as an emitting one-shot, or null when it is
   *  not one (a continuous emitter, or a one-shot the host says is not emitting).
   *
   *  Set at CREATE and never moved, which is exactly right: a binding is re-created whenever its spec
   *  attribute changes, and a re-triggered burst IS a spec change (the host bumps an epoch — see
   *  `createParticleRuntime`), so every burst gets its own clock. The client cannot know when the GAME
   *  started the burst; one full active window from first sight is what the burst itself would do. */
  emitSeenAt: number | null;
  /** The expired-burst blank has been painted (see `retireExpiredBurst`), so the frozen loop leaves this
   *  binding alone. Never unset: a burst that ended does not restart — a re-trigger is a new binding. */
  burstCleared: boolean;
  /** Parked-blend neutralization (`options.parkStaticParticleBlend`): the node's inline
   *  `mix-blend-mode` saved when this binding was parked in static mode (restored verbatim on
   *  unpark/dispose), or null while not neutralized. The FIRST-saved value wins across re-asserts,
   *  so a host style writer re-imposing the blend mid-park is healed without forgetting the
   *  restore value. */
  parkedBlend: string | null;
  /** FREEZE AT MOUNT (`staticParticleFreezeAtMount`): the host's `canFreezeSurface` predicate has
   *  been asked about this binding. Asked ONCE, at its first sizing (`claimFrozenMount`), and never
   *  again — the answer is a property of the node, and re-asking it per sizing would let a host
   *  change a binding's kind underneath a swap that is already standing on it. Always false while
   *  the option is off, in which case nothing below it can ever be true either. */
  freezeDecided: boolean;
  /** …and the answer: this binding is warmed once, drawn once and NEVER simulated. The live loop
   *  skips it before it clears `pristine` and it does not keep the loop alive, so a fleet of them
   *  costs nothing per frame in a runtime that is otherwise live. Permanent for the binding's life:
   *  a re-triggered system arrives as a spec change, i.e. a new binding, which decides again. */
  freezeAtMount: boolean;
  /** …and the strong form: this binding's canvas is in the DOM carrying its CSS box and NOTHING
   *  else — no context, no backing store, never painted — because the frame it would have drawn was
   *  already encoded in this document and an `<img>` of it stands in (`claimStaticStill`). It owes a
   *  warm (`pendingWarm`) and a draw, both paid by `liveifyBinding` the moment the swap can no
   *  longer vouch for the stand-in. Implies `freezeAtMount` and `surface === null`. */
  stillMounted: boolean;
}

// --- parked-blend neutralization (see `parkStaticParticleBlend` in types.ts) --------------------
//
// WHY: every element with a non-normal `mix-blend-mode` is a STANDING compositor blend render
// surface — one offscreen render pass per composited frame — even when nothing under it ever
// changes. In `staticParticles` mode the canvas is drawn once and parked, yet an additive VFX
// node's `plus-lighter` (stamped by `material.ts`, or by a host's own style pipeline) kept that
// per-frame pass alive; on a GPU-bound phone the parked particle fleet owned MOST of the scene's
// blend surfaces. The canvas doesn't need the node blend for correctness: additive systems resolve
// to source-over-complete pixels inside the canvas (render-webgl.ts resolve pass). So while parked,
// force the node's inline blend to `normal`; restore the saved value the moment the binding leaves
// the parked world (live resume, dispose). Idempotent + re-assertable: a re-park after a host
// rewrite overwrites back to `normal` but keeps the ORIGINAL saved value.
function parkBindingBlend(binding: ParticleBinding): void {
  const style = binding.node.style;
  const current = style.mixBlendMode;
  if (binding.parkedBlend === null) {
    if (current === "" || current === "normal") return; // nothing to neutralize
    binding.parkedBlend = current;
  } else if (current === "normal") {
    return; // already parked and untouched
  }
  style.mixBlendMode = "normal";
}

function unparkBindingBlend(binding: ParticleBinding): void {
  if (binding.parkedBlend === null) return;
  binding.node.style.mixBlendMode = binding.parkedBlend;
  binding.parkedBlend = null;
}

/** OPT-IN per-frame cost attribution for ONE particle runtime (`effectsProfiling`, see `../types`),
 *  read from `stats().profile`. NULL when the option is off — see `ParticleRuntimeStats.profile`.
 *
 *  WHY IT EXISTS. A live tick's wall clock alone says nothing about what to DO: "9 ms/frame" is the
 *  same number whether the CPU integrator is chewing through 2000 particles × 4 sub-steps, the
 *  instance buffer is being rebuilt per frame, or the GL→2D blit is fill-bound at
 *  devicePixelRatio 3. Those have opposite fixes (`particleFps`/`amount`/`staticParticles` vs
 *  `renderScale`), so the tick is split into the four buckets below and each carries its own WORK
 *  counter — a millisecond total is only interpretable next to the work that produced it.
 *
 *  Counters are monotonic and never reset (the `ParticleRuntimeStats` contract): a benchmark
 *  snapshots the object, runs its window, and diffs. Times are `performance.now()` deltas in ms,
 *  summed — wall clock on the main thread, so an interrupted frame charges its interruption to
 *  whichever bucket was open. */
export interface ParticleProfile {
  /** LIVE ticks that simulated + drew at least one binding. The frozen (`staticParticles`) path
   *  books NONE: it draws once and parks the loop, so a frozen runtime reports `ticks: 0` and every
   *  other field 0 — which is the right report for a mode whose whole point is that it has no
   *  per-frame cost. A deferred tick (the FPS cap re-arming without work) books none either. */
  ticks: number;
  /** Bindings simulated + drawn, summed across those ticks. `bindings / ticks` is the live system
   *  count the frame really paid for — suspended, parked and unmounted bindings are skipped by the
   *  loop and never counted. */
  bindings: number;
  /** Fixed sub-steps `simulateParticles` executed. THE sim work unit, and deliberately not the tick
   *  count: the sim runs at `fixed_fps` (30 by default) regardless of display rate, so a 60Hz device
   *  runs ~0.5 steps per tick per binding and a stalled frame runs several. `simMs / simSteps` is
   *  therefore the only stable cost-per-unit, and a `simSteps` far from `bindings` is the proof that
   *  the sim rate is decoupled from the display rate. */
  simSteps: number;
  /** Instances pushed into the GL instance buffer ≈ live particles actually drawn (a dead or
   *  fully-transparent particle is skipped by the build loop). The denominator for both `buildMs`
   *  and `glMs`, and the number to compare against `particleMaxInstances`. */
  instances: number;
  /** CPU simulation: `simulateParticles` (integrate + emit + curve sampling). The bucket the
   *  mid-range-phone suspicion points at. */
  simMs: number;
  /** Instance-buffer BUILD: the per-particle push loop in `drawBinding` that turns simulation state
   *  into the interleaved float array. Separate from `simMs` because it is a different fix — it
   *  scales with LIVE particles, not with sub-steps. */
  buildMs: number;
  /** GL SUBMIT: `drawParticles` — uniform writes, the buffer upload and the instanced draw call.
   *  SUBMIT ONLY: the GPU executes asynchronously, so this is main-thread issue cost, never GPU
   *  time. A GPU-bound frame shows up as back-pressure in `blitMs` (the readback-shaped
   *  `drawImage`), not here. */
  glMs: number;
  /** GL→2D BLIT: the binding canvas's `clearRect` plus the `drawImage` that copies the shared GL
   *  canvas onto it. Pure fill cost, so it scales with BACKING-STORE AREA (`renderScale`,
   *  `devicePixelRatio`, the sprite `pad`) and not with particle count — which is exactly the
   *  distinction a "particles are slow" report cannot make without this split. */
  blitMs: number;
}

/** A zeroed `ParticleProfile`. Allocated ONCE per runtime, at create, and only when
 *  `effectsProfiling` is on; the live paths then mutate it in place, so profiling adds no per-frame
 *  allocation to measure. */
function createParticleProfile(): ParticleProfile {
  return {
    ticks: 0,
    bindings: 0,
    simSteps: 0,
    instances: 0,
    simMs: 0,
    buildMs: 0,
    glMs: 0,
    blitMs: 0,
  };
}

/** Live, monotonically-increasing counters for ONE particle runtime (see `ParticleRuntime.stats`).
 *  Same contract as the shader runtime's `WebglShaderRuntimeStats`: plain `++` writes, never reset,
 *  the SAME object returned on every `stats()` call (snapshot to diff). */
export interface ParticleRuntimeStats extends StaticImageSwapCounters {
  /** Actual instanced GL draws of a particle-system frame (`drawBinding` reaching `drawParticles`). */
  draws: number;
  /** Frozen-mode static-frame cache hits: the warm AND the instanced draw were both skipped and a
   *  cached canvas blitted instead (see `./static-frame-cache`). The shader runtime's `cacheHits`
   *  sibling. A fleet of N identical frozen systems should settle at 1 `draws` + (N-1) `cacheHits`. */
  cacheHits: number;
  /** `syncCanvasSize` calls that sized a binding at the PINNED static ratio
   *  (`staticParticlePixelRatio`) instead of `devicePixelRatio × renderScale` — the shader runtime's
   *  `pinnedCanvasSyncs` sibling, and the same purpose: a device probe reads it to confirm the pin
   *  is really in force (0 = option unset, or frozen mode never entered). */
  pinnedCanvasSyncs: number;
  /** Self-layer box reads: `selfLayer.clientWidth`/`clientHeight`, i.e. the layout this runtime
   *  forces. Booked by the create-time measure pass and by any `syncCanvasSize` that had neither a
   *  ResizeObserver `contentRect` nor a cached box. With the cache on (`particleRectCache`, the
   *  default) it settles at exactly one per binding CREATED and zero for everything after — fleet
   *  re-sizes, texture-load re-pads and observer deliveries are all reflow-free — so a device probe
   *  can confirm that live. It counts READS, not flushes: the create-time reads are batched into one
   *  contiguous run, so N new bindings book N reads and cost ONE forced layout flush.
   *
   *  With `particleObserverSizing` also on (the default) even that per-create read is gone and this
   *  settles at **0**: a new binding's first box arrives from the shared ResizeObserver, off the main
   *  path. Any read left standing is therefore a real signal — a wake whose observation never landed,
   *  or the mount backstop firing on an engine that does not deliver 0x0 initial observations. */
  boxReads: number;
  /** COUNTER. Bindings PARKED (canvas hidden) because their subtree went suspended — a create that
   *  was born parked included. Monotonic: a binding that parks, wakes and parks again counts twice.
   *  0 means the park never engaged (nothing suspended, or `particleDormant: false`). */
  dormantParks: number;
  /** COUNTER. Parked bindings woken again (the resume half, so a probe can tell "parked and stayed
   *  parked" from "flapped"). */
  dormantWakes: number;
  /** COUNTER. Bindings the expiry sweep DISPOSED for real after ~`DORMANT_DISPOSE_SECONDS` parked
   *  (canvas removed from the DOM, GL buffer released) rather than holding them forever. */
  dormantDisposes: number;
  /** GAUGE — bindings parked RIGHT NOW, sampled on each `stats()` read (the `staticImagesLive`
   *  contract exactly, and re-derived from the binding set rather than trusted incrementally). This
   *  is the "is the park actually engaged?" measurement a device probe reads — `28/33` — which the
   *  monotonic counters above cannot answer. */
  dormantLive: number;
  /** Per-frame cost attribution (see `ParticleProfile`), or NULL when `effectsProfiling` is off —
   *  which is the default, and the no-op handle always. NULL rather than a zeroed object ON PURPOSE:
   *  a bench that read `simMs: 0` out of an un-instrumented runtime would report "the simulation is
   *  free" when the truth is "nobody measured". The same object every `stats()` call, mutated in
   *  place by the live tick. */
  profile: ParticleProfile | null;
  /** GAUGE — which renderer this runtime's bindings are drawing through RIGHT NOW, re-derived on
   *  each `stats()` read (a runtime can change backend mid-life, in one direction: a WebGPU device
   *  that is lost is rebuilt on WebGL).
   *
   *  `"pending"` is a real state, not a transient to be waited out politely: with
   *  `effectsRenderer: "auto"`/`"webgpu"` on a browser that HAS `navigator.gpu`, the device arrives
   *  from a promise, and until it does the bindings exist, are sized and are mounted but have no
   *  surface and draw nothing. `"none"` is the no-op handle (no WebGL2, or particles disabled). */
  renderer: "pending" | "webgpu" | "webgl" | "none";
  /** COUNTER. Times this runtime adopted WebGL after being asked for `"auto"`/`"webgpu"` — the
   *  SYNCHRONOUS "this browser has no navigator.gpu" decline included, which is the common case and
   *  the reason a plain WebGL page reports 1 here rather than 0. Stays 0 for `effectsRenderer:
   *  "webgl"` (nothing was ever asked for) and for a runtime that adopted WebGPU and kept it. */
  webgpuFallbacks: number;
  /** The FIRST reason this runtime declined WebGPU (later ones cannot un-explain it), or null while
   *  it never has. THE diagnostic for a silent fallback: `renderer: "webgl"` under
   *  `effectsRenderer: "webgpu"` says something went wrong, and only this says what. */
  webgpuFallbackReason: WebgpuFallbackReason | null;
  /** COUNTER — `queue.submit` calls this runtime's WebGPU backend has made, sampled on read. ONE per
   *  tick that drew anything, whatever the binding count: that batching is the measured win (S7), so
   *  a probe that finds it climbing with N systems has found the win being given back. 0 on WebGL,
   *  where the question is meaningless. */
  webgpuSubmits: number;
  /** GAUGE — `device.lost` resolutions seen by the page-wide device (see `../webgpu/device`). A lost
   *  device stops producing frames, so a non-zero value here next to `renderer: "webgl"` is the
   *  device-loss rebuild having happened. */
  webgpuDeviceLosses: number;
  /** GAUGE — `uncapturederror` events on the page-wide device. Non-zero means a frame was silently
   *  WRONG: WebGPU reports most command-level mistakes this way and nothing else says so. */
  webgpuErrors: number;
  /** GAUGE — BAKE DONORS this runtime is holding right now (see `donateStill`): bindings whose node
   *  is gone but whose surface is kept alive, out of the DOM, only long enough to encode the frame
   *  their successors will claim. Sampled on each `stats()` read. A number pinned at the bound means
   *  bakes are not draining — check `staticStillDonorBakes` against `staticStillDonorsDropped`. */
  staticStillDonors: number;
  /** COUNTER. Donor bakes that PUBLISHED, i.e. banked a frame nothing had encoded yet. Each one is a
   *  key the next binding to reach it can claim for free. */
  staticStillDonorBakes: number;
  /** COUNTER. Donors released WITHOUT publishing — evicted by the donor bound, or dropped at runtime
   *  teardown. A donor is speculative work by construction, so these are not failures; a run where
   *  they dominate `staticStillDonorBakes` means the bound is too small for the scene's churn, or
   *  that retention (`encode.stillCacheBytes`) is off and every bake is refused. */
  staticStillDonorsDropped: number;
}

/** A zeroed `ParticleRuntimeStats` (the swap counters included — see `../surface-image-swap`,
 *  whose `staticImageSwaps`/`…Reverts`/`…Encodes` a device probe reads to confirm the mechanism,
 *  `staticImagesLive` to see how much of the set is engaged, and `staticImageUrlsLive` to confirm
 *  it does not leak). */
function createParticleRuntimeStats(): ParticleRuntimeStats {
  return {
    draws: 0,
    cacheHits: 0,
    pinnedCanvasSyncs: 0,
    boxReads: 0,
    dormantParks: 0,
    dormantWakes: 0,
    dormantDisposes: 0,
    dormantLive: 0,
    // OFF unless `createEngine` swaps in a real profile: the never-measured state, and the only one
    // a no-op handle can ever report.
    profile: null,
    // "none" is the no-op handle's permanent answer; a real runtime overwrites this on its first
    // `stats()` read (and the gate has usually settled it before anyone can look).
    renderer: "none",
    webgpuFallbacks: 0,
    webgpuFallbackReason: null,
    webgpuSubmits: 0,
    webgpuDeviceLosses: 0,
    webgpuErrors: 0,
    staticStillDonors: 0,
    staticStillDonorBakes: 0,
    staticStillDonorsDropped: 0,
    ...createStaticImageSwapCounters(),
  };
}

// The per-runtime render plumbing (the renderer seam, one offscreen WebGL2 context for the texture
// cache, the instance cap). Null when WebGL2/particles are unavailable.
interface ParticleEngine {
  /** WHERE the pixels come from (see `./render-backend`). Every draw, clear, surface create/dispose,
   *  texture resolution and the sizing law's own ceiling go through it; nothing else in this runtime
   *  knows the renderer.
   *
   *  NULL means PENDING: the runtime asked for WebGPU and the device has not arrived yet (see the
   *  async gate in `createParticleRuntime`). Bindings are still created, sized and mounted in that
   *  state — they simply have no surface and no textures, and every draw path skips them exactly as
   *  it skips an unmounted one. It is never null again once a backend has been adopted. */
  backend: ParticleRenderBackend | null;
  /** The WebGL backend, built at create and kept for the runtime's whole life whatever `backend`
   *  currently is. It is the FALLBACK, and a fallback that had to be constructed at the moment it
   *  was needed would be a second way to fail — on the device-loss path, which is already the worst
   *  moment to discover that the shared GL context cannot be had either. */
  glBackend: ParticleRenderBackend;
  maxInstances: number;
  /** Backing-store pixel ratio for LIVE bindings (devicePixelRatio × clamped renderScale) — the
   *  low-end resolution knob. */
  pixelRatio: number;
  /** OPT-IN pinned backing ratio for FROZEN bindings (see `staticParticlePixelRatio`), or undefined
   *  = not pinned (every binding keeps sizing at `pixelRatio`, exactly as before the option existed). */
  staticPixelRatio: number | undefined;
  /** Whether the runtime is in frozen (`staticParticles`) mode right now — the OTHER half of the pin
   *  condition, and the loop's `isStatic`. Lives on the engine because the sizing + draw paths are
   *  free functions that already carry it. */
  staticMode: boolean;
  /** Whether a binding's measured box may be REUSED (`particleRectCache`, default true). False is
   *  the kill switch: `syncCanvasSize` re-reads `clientWidth`/`clientHeight` on every call and
   *  `reconcile` runs no measure pass, i.e. exactly the create-then-size interleave this runtime had
   *  before the cache existed. Read once at create — a code-path selector, not a live knob. */
  rectCache: boolean;
  /** Whether a NEW binding takes its first box from the shared ResizeObserver's INITIAL delivery
   *  instead of a create-time layout read (`particleObserverSizing`, default true). On: `reconcile`
   *  measures nothing for a create, the canvas stays out of the DOM until that delivery lands, and
   *  `boxReads` settles at 0 — the create path forces no layout at all. Off is the kill switch: the
   *  measure pass reads every new binding exactly as it did before, i.e. WS-1's one-read-per-create
   *  floor. Requires BOTH `rectCache` (the mechanism that lets a `contentRect` stand in for a read)
   *  and a real `ResizeObserver`, so a jsdom/SSR environment always takes the read path. Read once at
   *  create — a code-path selector, not a live knob. */
  observerSizing: boolean;
  /** Whether a SUSPENDED binding is also PARKED (`particleDormant`, default true): canvas hidden,
   *  `sizeCanvas` deferred, disposed after `DORMANT_DISPOSE_SECONDS`. False is the kill switch —
   *  `dormant` then stays false for every binding, nothing ever writes a canvas's `display`, and
   *  suspension means exactly what it meant before the park existed. Read once at create — a
   *  code-path selector, not a live knob. */
  parkDormant: boolean;
  /** Whether the canvas margin is sized DIRECTIONALLY from where the particles actually travel
   *  (`particleTravelExtents`, default true — see `./extents`), capped by the host's per-node visible
   *  rect. False is the kill switch: the margin is the symmetric `spriteExtentPad +
   *  emissionExtentPad` this had before, `VISIBLE_RECT_ATTR` is never read, and every canvas geometry
   *  is byte-identical to the pre-directional one. Read once at create — a code-path selector, not a
   *  live knob. */
  travelExtents: boolean;
  /** Whether a FROZEN one-shot stops being drawn once its own burst window has elapsed
   *  (`staticParticleOneShotExpiry`, default true — see `retireExpiredBurst`). False is the kill switch:
   *  `emitSeenAt` stays null for every binding, nothing is ever retired, and a frozen one-shot's warmed frame
   *  is parked forever exactly as it was before this existed. Read once at create — a code-path selector, not a
   *  live knob. */
  oneShotExpiry: boolean;
  /** Whether a binding the host names may be FROZEN AT MOUNT (`staticParticleFreezeAtMount`, default
   *  false): warmed once, drawn once, never simulated — and, where its frame is already encoded,
   *  mounted as an `<img>` over a canvas that never gets a context (see `claimFrozenMount`). False is
   *  not a kill switch but the absence of the mechanism: `freezeDecided` stays false for every
   *  binding, `createBinding` claims its surface exactly as it always did, and no code path below
   *  this can be reached. Read once at create — a code-path selector, not a live knob. */
  freezeAtMount: boolean;
  /** The host's `canFreezeSurface` veto, lifted OFF the swap policy (`staticParticleImages`) so the
   *  freeze-at-mount decision consults the same predicate the swap's own gate does. ONE predicate,
   *  two mechanisms: a host that named which of its surfaces may be frozen must not have to name
   *  them twice, and a binding that mounted frozen must not then be refused a stand-in by the gate.
   *  Null = no predicate, which the swap reads as "no veto" and so does this — with
   *  `freezeAtMount` on and no predicate, EVERY binding is frozen at mount. */
  canFreezeSurface:
    | ((node: HTMLElement, canvas: HTMLCanvasElement) => boolean)
    | null;
  /** Instrumentation counters (purely observational — no render decision reads them). */
  stats: ParticleRuntimeStats;
  /** Per-frame cost attribution (see `ParticleProfile`), or NULL when `effectsProfiling` is off.
   *  Held HERE, next to the hot paths that write it, so a bracket costs one field read and one null
   *  check — the whole reason an off runtime can carry the instrumentation for free. The same object
   *  `stats.profile` exposes; it is mutated in place and never replaced. Read once at create — a
   *  code-path selector, not a live knob. */
  profile: ParticleProfile | null;
  /** Optional per-binding render notification (see `GodotHtmlRuntimeOptions.onBindingRendered`):
   *  fired from `notePaint`, i.e. from every path that WRITES this binding's canvas — the instanced
   *  draw, the frozen cache-hit blit, and the clears that end a burst — and never from the paths that
   *  write nothing (no surface, zero-size, a parked or claimed binding). Absent ⇒ byte-identical
   *  behavior. */
  onBindingRendered?: (
    node: HTMLElement,
    canvas: HTMLCanvasElement,
    info: GodotEffectRenderInfo,
  ) => void;
}

/**
 * What a particle binding reports as `GodotEffectRenderInfo`. Three of the four
 * fields are CONSTANT for every particle system there is; only `staticKey`
 * varies, so this builds one small object per paint around those constants.
 *
 * `blend: "mix"` is a statement about the CANVAS, not about the system. A Godot
 * additive particle material really is additive, and the renderer resolves that
 * INSIDE this binding's own canvas (see `./render-webgl`'s accumulator pass); what
 * comes out is a finished premultiplied image that composites over whatever is
 * behind it source-over, exactly like a mix-mode one. A consumer that read the
 * material's mode off the spec and composited the canvas additively would apply
 * the mode twice.
 *
 * The screen flags are false because a particle system has no fragment stage of
 * its own to read SCREEN_TEXTURE/SCREEN_UV with.
 *
 * A FRESH OBJECT PER FIRING, not one shared mutable record: a consumer is entitled
 * to KEEP the info it was handed (couch-coop's fx registry stores it on the
 * surface), and a shared one would silently re-point every stored reference at the
 * last binding to paint. It is a four-field literal behind a callback that only
 * fires when a canvas was actually written, which is the same trade the shader
 * runtime's `renderInfoOf` already makes.
 */
function particleRenderInfo(staticKey: string | null): GodotEffectRenderInfo {
  return {
    usesScreenTexture: false,
    usesScreenUv: false,
    blend: "mix",
    staticKey,
  };
}

function createEngine(options: GodotHtmlRuntimeOptions): ParticleEngine | null {
  const sharedGl = getShared();
  if (!sharedGl || !options.enableParticles) return null;
  // No renderable backend (the instanced program did not compile/link) ⇒ no runtime at all: the
  // caller returns the no-op handle and every opted-in node stays on its static preview.
  //
  // A WORKING WEBGL BACKEND IS REQUIRED EVEN FOR A WEBGPU RUNTIME. It is what every failure path
  // adopts — no adapter, a rejected pipeline, a device lost mid-run — so a runtime that could not
  // build one has no fallback to fall back TO, and "WebGPU or nothing" is not a trade this package
  // makes. The cost is one shared GL context + one program compile on a page that may never use
  // them; the alternative is discovering at device-loss time that there is nowhere to go.
  const glBackend = createWebglParticleBackend(sharedGl);
  if (!glBackend) return null;
  // ONE profile object for the runtime's whole life, or null forever (see `ParticleProfile`). The
  // stats object publishes the SAME reference, so `stats().profile` needs no per-read plumbing and a
  // bench may hold onto it across ticks.
  const profile =
    options.effectsProfiling === true ? createParticleProfile() : null;
  const stats = createParticleRuntimeStats();
  stats.profile = profile;
  return {
    // Left PENDING here on purpose: which backend this runtime adopts is the async gate's decision
    // (see `createParticleRuntime`), and for the common case — no `navigator.gpu` — it is made
    // synchronously, before anything can observe the null.
    backend: null,
    glBackend,
    maxInstances: Math.max(1, options.particleMaxInstances ?? 2048),
    pixelRatio: effectivePixelRatio(options.renderScale),
    staticPixelRatio: normalizeStaticPixelRatio(
      options.staticParticlePixelRatio,
    ),
    staticMode: options.staticParticles ?? false,
    rectCache: options.particleRectCache !== false,
    // Both halves are prerequisites, not preferences: without the box cache there is nowhere for a
    // delivered `contentRect` to live, and without a ResizeObserver no first box ever arrives.
    observerSizing:
      options.particleObserverSizing !== false &&
      options.particleRectCache !== false &&
      typeof ResizeObserver !== "undefined",
    parkDormant: options.particleDormant !== false,
    travelExtents: options.particleTravelExtents !== false,
    oneShotExpiry: options.staticParticleOneShotExpiry !== false,
    freezeAtMount: options.staticParticleFreezeAtMount === true,
    canFreezeSurface: hostFreezeVeto(options.staticParticleImages),
    stats,
    profile,
    onBindingRendered: options.onBindingRendered,
  };
}

// The host's `canFreezeSurface` predicate, read straight off the swap policy object (see
// `ParticleEngine.canFreezeSurface`). `true`/`false`/absent carry no predicate — the swap reads that
// as "no veto", and so does the freeze-at-mount decision.
function hostFreezeVeto(
  option: StaticSurfaceOption | undefined,
): ((node: HTMLElement, canvas: HTMLCanvasElement) => boolean) | null {
  if (typeof option !== "object" || option === null) return null;
  return typeof option.canFreezeSurface === "function"
    ? option.canFreezeSurface
    : null;
}

// Is there a WebGPU API on this page AT ALL? The gate's synchronous short-circuit (see `openGate`):
// no `navigator.gpu` means no promise is created, no microtask is scheduled and no binding is ever
// surface-less — which is what keeps jsdom and every non-WebGPU browser on the byte-identical path
// under the default `effectsRenderer: "auto"`. Deliberately NOT `acquireWebgpuDevice`, which would
// answer the same question one turn of the event loop later.
function hasWebgpuApi(): boolean {
  return Boolean(
    (globalThis.navigator as (Navigator & { gpu?: unknown }) | undefined)?.gpu,
  );
}

// The pinned backing ratio in force right now, or undefined when the canvases follow the live
// `devicePixelRatio × renderScale`. Pinned means BOTH: the consumer set `staticParticlePixelRatio`
// AND the runtime is in frozen mode — a live binding is simulating against the current fit and must
// keep tracking it.
function pinnedRatio(engine: ParticleEngine): number | undefined {
  return engine.staticMode ? engine.staticPixelRatio : undefined;
}

// The longest-edge ceiling in force for one sizing: the PINNED static clamp
// (`MAX_PINNED_BACKING_DIM`, pinned path only), whatever the backend can back a canvas with
// (`maxBackingDim`), or the SMALLER of the two when both apply. Undefined = unbounded, which is what
// the live path and the WebGL backend both are.
function backingDimLimit(
  pinLimit: number | undefined,
  backendLimit: number | undefined,
): number | undefined {
  if (pinLimit === undefined) return backendLimit;
  if (backendLimit === undefined) return pinLimit;
  return Math.min(pinLimit, backendLimit);
}

// THE layout read: measure one binding's self-layer content box into its cache, and book it.
// Every `clientWidth`/`clientHeight` this runtime performs goes through here, so `boxReads` is the
// whole truth about the forced layouts it causes.
//
// The read itself is cheap; what costs is the STYLE+LAYOUT FLUSH the browser must run first,
// because this runtime always reads right after writing (it inserted a canvas, hid the preview
// spans, set the canvas box). So the callers' job is not to avoid reading — each binding has its own
// self-layer, so N bindings genuinely need N reads — but to keep the reads CONTIGUOUS (one flush for
// the run; see `reconcile`'s measure pass) and to not read again once the box is known.
function readBoxInto(
  binding: ParticleBinding,
  stats: ParticleRuntimeStats | undefined,
): void {
  if (stats) stats.boxReads++;
  binding.boxW = binding.selfLayer.clientWidth;
  binding.boxH = binding.selfLayer.clientHeight;
  binding.boxMeasured = true;
}

// Put a binding's canvas in the DOM, once, at its first sizing (see `ParticleBinding.mounted`).
// Returns TRUE only for the insert that really happened, so the sizer can report "this surface has
// never been painted" to whoever must kick the loop.
//
// PURE WRITE. The canvas is `position: absolute` in an `overflow: visible` self-layer whose own
// width/height are explicit inline px (see `../model`), so inserting it cannot change the box the
// ResizeObserver is watching — which is what makes it safe to do from inside an observer callback
// without provoking a second delivery (or a "loop completed with undelivered notifications").
function mountBinding(binding: ParticleBinding): boolean {
  if (binding.mounted) return false;
  binding.mounted = true;
  binding.selfLayer.insertBefore(binding.canvas, binding.selfLayer.firstChild);
  return true;
}

// Give a binding the rendering context it draws through, if it does not have one yet. Returns
// whether it now has a surface.
//
// The ONE place a surface is acquired after `createBinding`, because under
// `staticParticleFreezeAtMount` a binding's surface is DEFERRED — a claimed still never needs one at
// all (see `claimFrozenMount`), so asking the backend for one at create would allocate a context, a
// backing store and a GPU buffer per node for the exact population this option exists to make free.
//
// A REFUSAL (`createSurface` returning null — on WebGL, `getContext("2d")` failing) leaves the
// binding surface-less rather than deleting it, which is a real narrowing of the create-time
// behaviour and is confined to the opt-in path: a surface-less binding is skipped by every draw path
// exactly like a still-pending one, so it renders nothing and costs nothing, but its static preview
// spans stay hidden until the node goes away. The create-time refusal still deletes, because there
// the runtime has the binding map in hand and can rebuild the node.
function ensureSurface(
  engine: ParticleEngine,
  binding: ParticleBinding,
): boolean {
  if (binding.surface) return true;
  const backend = engine.backend;
  // PENDING (the WebGPU device has not arrived): `adoptBackend` hands surfaces out.
  if (!backend) return false;
  binding.surface = backend.createSurface(binding.canvas, binding.config);
  return binding.surface !== null;
}

// Does this binding deliberately own NO surface right now? Two states, both freeze-at-mount's:
// undecided (its first sizing has not run, so whether it needs one is still an open question) and
// standing on a claimed still (it will never draw unless it is asked to go live). `adoptBackend`
// consults this so an arriving backend does not hand out the surfaces this option exists to skip.
function surfaceDeferred(
  engine: ParticleEngine,
  binding: ParticleBinding,
): boolean {
  return (
    engine.freezeAtMount && (!binding.freezeDecided || binding.stillMounted)
  );
}

// FREEZE AT MOUNT, decided ONCE at a binding's first sizing (`staticParticleFreezeAtMount`).
// Returns TRUE only when this binding is now standing on a claimed still — mounted as an `<img>`
// over a canvas with no context and no backing store — in which case the caller must not size it.
//
// THE POINT OF THE WHOLE ROUND. For a fleet whose Nth copy renders a frame this document has
// already encoded, everything the ordinary path does — allocate a context, allocate a backing store,
// warm a simulation, draw it, wait out a quiet window, read the canvas back, encode it — is redundant
// work for pixels that are already in hand. So: resolve the geometry (no writes), name the frame
// with it, write the canvas's CSS BOX ONLY, mount, and ask the swap module for that key.
//   HIT ⇒ nothing else happens for this node, ever, unless something asks it to go live. The canvas
//     is contextless and blank, which is why `dirty` is cleared (an owed repaint is what the swap's
//     watchdog reverts on) and why `pendingWarm` is set: the warm this binding did not run is OWED,
//     and `liveifyBinding` pays it before it draws so a live-ify cannot pop.
//   MISS ⇒ today's path verbatim from here: acquire the surface, and the caller sizes, warms and
//     draws as it always did. The frame it produces is what the swap then encodes under this same
//     key, which is what makes the NEXT copy a hit.
// A miss is the honest report even for the first-ever appearance of a key (nothing was there to
// claim), so `staticStillCacheMisses` counts encodes-still-needed rather than only failures.
function claimFrozenMount(
  engine: ParticleEngine,
  binding: ParticleBinding,
  contentRect?: { width: number; height: number },
): boolean {
  binding.freezeDecided = true;
  // The SWAP's own veto, asked here (see `ParticleEngine.canFreezeSurface`). A refused binding is an
  // ordinary live one from here on and never asks again.
  if (
    engine.canFreezeSurface &&
    !engine.canFreezeSurface(binding.node, binding.canvas)
  ) {
    ensureSurface(engine, binding);
    return false;
  }
  binding.freezeAtMount = true;
  const pin = pinnedRatio(engine);
  const geom = measureCanvasGeometry(
    binding,
    pin ?? engine.pixelRatio,
    contentRect,
    backingDimLimit(
      pin === undefined ? undefined : MAX_PINNED_BACKING_DIM,
      engine.backend?.maxBackingDim(),
    ),
    engine.stats,
    engine.rectCache,
    engine.travelExtents,
  );
  binding.pad = geom.pad;
  binding.drawRatio = geom.ratio;
  // `staticFrameKeyFor` reads `pad`/`drawRatio` off the binding, so both are published above. It
  // refuses a state the live loop has stepped and an undecoded texture — neither is reachable at a
  // first sizing, but the key is the promise the `<img>` rests on and this is not the place to
  // assume that.
  const key =
    geom.w >= 1 && geom.h >= 1
      ? staticFrameKeyFor(binding, geom.w, geom.h)
      : null;
  if (key !== null) {
    // `claimStaticStill`'s preconditions, in its order: the canvas must be in the document (the
    // stand-in is inserted immediately before it) and must already carry the box the stand-in copies
    // verbatim. The BOX only — writing `width`/`height` here would allocate the backing store this
    // whole path exists not to allocate.
    writeCanvasBox(binding, geom);
    mountBinding(binding);
    binding.canvasSyncDeferred = false;
    if (claimStaticStill(binding, key, engine.stats)) {
      binding.stillMounted = true;
      binding.pendingWarm = true;
      binding.frozen = false;
      // The `<img>` IS this surface's frame, and the canvas under it owes nothing: it is not going
      // to be painted at all. Left dirty, the watchdog would read an owed repaint as evidence the
      // stand-in is stale and revert it on its first sweep.
      binding.dirty = false;
      return true;
    }
    // Refused after all (the key is in flight, or failed): the canvas is mounted and boxed, and the
    // caller's sizing pass takes it from here exactly as for a miss.
  }
  ensureSurface(engine, binding);
  return false;
}

// Size ONE binding's canvas through the one rule (live vs pinned) and book the stat. Every in-runtime
// `syncCanvasSize` goes through here so the two paths can't drift. Returns `syncCanvasSize`'s
// "backing store was reallocated (and therefore CLEARED)" flag.
//
// It is also the one place a re-size meets the image swap. A realloc CLEARS the canvas (so it no
// longer holds the frame anything froze) and a placement change moves the box the stand-in `<img>`
// copied at freeze time, so either one reverts the swap — WITHOUT blocking, because a re-size is
// the runtime's own deliberate change and says nothing about whether this surface's content churns.
// The `cssText` compare is paid ONLY by a binding that actually has swap state, so an off runtime
// (the default) reads nothing extra.
function sizeCanvas(
  engine: ParticleEngine,
  binding: ParticleBinding,
  contentRect?: { width: number; height: number },
): boolean {
  // FIRST SIZING under `staticParticleFreezeAtMount`: this is where a binding finds out what kind it
  // is, and where a claimable frame short-circuits the rest of this function entirely. A claim
  // reports FALSE — nothing was allocated, nothing was cleared and nothing needs a redraw.
  if (engine.freezeAtMount && !binding.freezeDecided) {
    if (claimFrozenMount(engine, binding, contentRect)) return false;
  }
  const pin = pinnedRatio(engine);
  if (pin !== undefined) engine.stats.pinnedCanvasSyncs++;
  const swapped = binding.staticImage !== null;
  const boxBefore = swapped ? binding.canvas.style.cssText : "";
  const cleared = syncCanvasSize(
    binding,
    pin ?? engine.pixelRatio,
    contentRect,
    backingDimLimit(
      pin === undefined ? undefined : MAX_PINNED_BACKING_DIM,
      // PENDING (no backend yet): no ceiling of its own to fold in. A WebGPU adoption re-sizes every
      // binding it takes over, so a canvas sized past that device's limit here is corrected there.
      engine.backend?.maxBackingDim(),
    ),
    engine.stats,
    engine.rectCache,
    engine.travelExtents,
  );
  // The canvas is blank until something redraws it: not a surface to freeze, and not one to keep
  // frozen either.
  if (cleared) binding.dirty = true;
  if (swapped && (cleared || binding.canvas.style.cssText !== boxBefore)) {
    revertStaticImage(binding, engine.stats);
  }
  // Whatever sync was owed is paid: the park's backlog, or the wait for the observer's first box.
  // (Never reached while `dormant` — `sizeCanvasOrDefer` is the only way in for a parked binding.)
  binding.canvasSyncDeferred = false;
  // FIRST SIZING mounts (see `mountBinding`). Reported as "cleared" whatever `syncCanvasSize` said,
  // because a just-inserted canvas has never been painted — and a create whose backing store happens
  // to land on the 300x150 default would otherwise report no change and never be drawn.
  if (mountBinding(binding)) {
    binding.dirty = true;
    return true;
  }
  return cleared;
}

// `sizeCanvas`, DEFERRED while the binding is parked (see `ParticleBinding.canvasSyncDeferred`) —
// the shader runtime's `syncCanvasSizeOrDefer`, same contract. EVERY size that is not the wake's own
// goes through here, so a parked canvas cannot be re-allocated behind the park. Returns
// `sizeCanvas`'s "backing store was reallocated" flag, and FALSE when the work was deferred: nothing
// was cleared, so no caller needs to redraw anything.
//
// TWO reasons to defer, and they compose: the binding is PARKED (its canvas is hidden, so re-sizing
// it is pure cost), or it has NO BOX YET and `particleObserverSizing` is on — in which case sizing it
// here would mean reading `clientWidth`, which is exactly the forced layout the observer path exists
// to avoid. The waiting binding is sized by the shared ResizeObserver's first delivery (or, if that
// never comes, by `reconcile`'s mount backstop).
function sizeCanvasOrDefer(
  engine: ParticleEngine,
  binding: ParticleBinding,
): boolean {
  if (binding.dormant || (engine.observerSizing && !binding.boxMeasured)) {
    binding.canvasSyncDeferred = true;
    return false;
  }
  return sizeCanvas(engine, binding);
}

// EVERY path that writes pixels into a binding's canvas ends here — the live loop's `drawBinding`
// (its clear-only frame included: a clear is a write), the frozen path's warm+draw, and the frozen
// path's CACHE-HIT BLIT. That last one is the load-bearing case: it repaints from a cached frame
// while counting as a `cacheHits`, not a `draws`, so a frozen fleet that keeps re-blitting would
// otherwise read as QUIET and earn a swap whose `<img>` then sits over pixels that are still moving.
//
// Being that one convergence point is also why the EXTERNAL notification
// (`GodotHtmlRuntimeOptions.onBindingRendered`) fires from here rather than from the draw: the two
// audiences ask the same question — "did this canvas just change?" — and answering it in one place is
// what stops a future paint path from telling the swap and forgetting the consumer.
//
// THE KEY. `staticFrameKeyFor` names the frame this canvas now holds — the same name the
// static-frame cache stores that bitmap under — and it is reported, because on the pristine path it
// is exactly the evidence the swap module's KEYED-OR-QUIET contract asks for: the frame is a PURE
// FUNCTION of that key (spec + count + seed + textures + geometry), so two paints under one key are
// the same pixels. Three consequences, and all three are the point:
//   - N twins share ONE encode and ONE object URL instead of N private synthetic ones;
//   - the CACHE-HIT BLIT re-states the frame its `<img>` is already showing, so the swap tolerates it
//     without reverting — which is what stops a re-blitting frozen fleet (one binding mounts, the
//     reconcile kicks the parked loop, every twin re-blits) from thawing its whole set every time;
//   - a host may pin `keyedQuietMs: 0` and freeze such a surface the instant it paints, since there
//     is nothing left to wait for.
//
// THE NULL CASES STAY KEYLESS, and they are not conservatism — a key here is a PROMISE, and the swap
// module has no way to catch a broken one (its proxies all read "explained"). `staticFrameKeyFor`
// refuses on its own two: a state the live loop has stepped (its phase depends on WHEN, not on the
// spec) and an undecoded texture/mask (the frame is a placeholder paint). To those this adds the
// caller's: a zero-sized backing store, and the EXPIRED-BURST BLANK (`keyedFrame: false`), whose
// canvas is deliberately NOT the frame its key names — reporting it would hand a blank surface the
// warmed burst every twin on that key is showing.
//
// A keyless surface still gets a private synthetic key inside the swap module, so nothing is shared
// for it and the plain quiet window is all it ever earns — the live-mode steady state, unchanged.
function notePaint(
  engine: ParticleEngine,
  binding: ParticleBinding,
  // Does the canvas now hold the frame `staticFrameKeyFor` names? False for the one paint that
  // deliberately does not: `retireExpiredBurst`'s blank.
  keyedFrame = true,
): void {
  binding.dirty = false;
  const onBindingRendered = engine.onBindingRendered;
  // Nothing to compute a key FOR: no external consumer and no swap. The common configuration, and it
  // stays exactly as cheap as it was.
  if (!onBindingRendered && !binding.staticImage) return;
  const w = binding.canvas.width;
  const h = binding.canvas.height;
  // ONE key for both audiences. It is cheap on the path where it would be paid per frame: a live
  // (stepped) binding is not `pristine`, and `staticFrameKeyFor` answers null on that check alone.
  const key =
    keyedFrame && w >= 1 && h >= 1 ? staticFrameKeyFor(binding, w, h) : null;
  // THE EXTERNAL PAINT NOTIFICATION, from the one function every write already converges on (see the
  // header) — so a consumer that composites this canvas ITSELF hears about the cache-hit blit and the
  // burst-ending clear, not just the instanced draw. Both write pixels; a consumer that only heard
  // about draws would show one system out of a fleet of identical frozen twins, and would keep
  // painting a finished burst forever.
  //
  // BEFORE the `staticImage` gate below, deliberately: that gate is the image swap's, and the swap is
  // OFF in exactly the configuration this callback exists for (a host compositing the surface itself
  // has no compositor layer to trade away, so it disables the swap). Firing under it would be firing
  // never.
  onBindingRendered?.(binding.node, binding.canvas, particleRenderInfo(key));
  if (!binding.staticImage) return;
  noteStaticFrame(binding, key, engine.stats);
}

// Build one particle binding from an outer `[data-godot-particle-runtime]` node: parse its spec,
// mount the overlay canvas in the self-layer and hide the static preview. Returns null when the node
// has no self-layer or no parseable spec.
//
// DOM WRITES ONLY — it deliberately neither measures nor sizes. Sizing needs the self-layer box, and
// reading that here (right after the canvas insert + preview hide this function just did) is a
// forced layout flush PER new binding; `reconcile` instead measures every new binding in one
// contiguous pass and sizes them afterwards. Texture-load hooks are armed there too, for the same
// reason (`armBindingTextures`).
function createBinding(
  node: HTMLElement,
  engine: ParticleEngine,
  onUnsupported?: UnsupportedRenderReporter,
): ParticleBinding | null {
  // The runtime marker is mirrored onto BOTH the outer node and its self-layer;
  // process only the outer node (the self-layer carries `data-godot-self-layer`).
  if (node.hasAttribute("data-godot-self-layer")) return null;
  const selfLayer = ownSelfLayer(node);
  if (!selfLayer) return null;
  const signature = node.getAttribute("data-godot-particle-specs") ?? "";
  const config = parseParticleSpecConfig(signature);
  if (!config) {
    // Fail loud (deduped): a particle node was opted in but its serialized spec is missing/malformed, so it
    // stays on the static preview. Surface which node instead of dropping it silently.
    reportUnsupportedRender(
      {
        kind: "particle",
        id:
          node.getAttribute("data-godot-path") ??
          (signature.slice(0, 80) || "particle"),
        reason: "malformed particle spec",
      },
      onUnsupported,
    );
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.setAttribute("data-godot-particle-canvas", "true");
  // Position + size are driven by `syncCanvasSize` (it grows the canvas beyond the node box
  // by `pad` so large sprites aren't clipped). The self-layer is `overflow: visible`.
  Object.assign(canvas.style, {
    position: "absolute",
    pointerEvents: "none",
  });
  // The renderer claims the canvas (a canvas can hold only ONE context type, ever — see
  // `./render-backend`). Refused ⇒ no binding, and the node keeps its static preview.
  //
  // PENDING (no backend yet — the WebGPU device has not arrived): the binding is built WITHOUT a
  // surface and without textures, and gets both when the gate adopts a backend (`adoptBackend`).
  // Everything else about it — the canvas element, its box, its mount, its simulation — is
  // renderer-agnostic and happens now, so an adoption is a surface hand-over and not a re-create.
  //
  // DEFERRED under `staticParticleFreezeAtMount`: which surfaces are needed at all is a question the
  // first sizing answers (`claimFrozenMount`), and a claimed one never gets a context — so asking
  // for one here would allocate exactly what the option exists to skip. See `ensureSurface`, which
  // is where every deferred acquisition (and every refusal) then happens.
  const surface = engine.freezeAtMount
    ? null
    : (engine.backend?.createSurface(canvas, config) ?? null);
  if (!engine.freezeAtMount && engine.backend && !surface) return null;

  const state = createParticleState(config, engine.maxInstances);
  preprocessParticles(state);

  // Sprite, colour LUT and coverage mask, from the cache of whichever backend will sample them (see
  // `ParticleRenderBackend.resolveTextures`). Until an image decodes its entry is the 1x1
  // TRANSPARENT placeholder, whose red is 0 — so a masked system draws nothing rather than flashing
  // an unmasked square, which is what the game shows too.
  const textures = engine.backend?.resolveTextures(config) ?? null;

  // The canvas is NOT inserted here — `mountBinding` does that at the binding's first sizing, so a
  // canvas never sits in the DOM at its 300x150 default box (see `ParticleBinding.mounted`).
  // Hide the static preview spans so they don't double with the live canvas. They stay hidden
  // through a park too: the subtree is occluded, so swapping a live canvas for a CSS preview would
  // buy nothing and cost paint. Hidden HERE rather than at mount, for that same reason and because a
  // preview left up for the frame before the canvas arrives is a visible flash of differently-placed
  // dots. Both are out-of-flow writes, so neither costs layout.
  const hiddenPreview = Array.from(
    selfLayer.querySelectorAll<HTMLElement>("[data-godot-particle]"),
  );
  for (const span of hiddenPreview) span.style.display = "none";

  // Born under a suspended ancestor ⇒ born PARKED: the canvas starts hidden (so it never gets a
  // compositor layer at all) and the create-time measure + `sizeCanvas` are deferred to the wake.
  // This is the ONE direct write this runtime makes to a canvas's `display`; it happens before any
  // swap state exists, and the swapper's `attach` adopts the hide (see `../surface-image-swap`).
  const suspended = isEffectsSuspended(node);
  const dormant = engine.parkDormant && suspended;
  if (dormant) {
    canvas.style.display = "none";
    engine.stats.dormantParks++;
  }

  // An attribute read, not a layout read — it costs nothing and it must happen before the first
  // sizing, which is the moment the canvas gets its box (and, under freeze-at-mount, its frame key).
  const rectAttr = engine.travelExtents
    ? node.getAttribute(VISIBLE_RECT_ATTR)
    : null;
  // Same terms, and it must land before the first sizing for a stronger reason than the rect does:
  // under `staticParticleFreezeAtMount` the first sizing is where this binding NAMES its frame, and
  // a name computed at the wrong density is a name no twin shares. Read off the SELF-LAYER (where
  // the shader runtime reads it, so a host stamps one element for both families), not off the outer
  // node the spec and the visible rect live on.
  const pixelRatioAttr = selfLayer.getAttribute(SURFACE_PIXEL_RATIO_ATTR);

  const binding: ParticleBinding = {
    node,
    selfLayer,
    canvas,
    surface,
    config,
    state,
    texture: textures?.texture ?? null,
    lut: textures?.lut ?? null,
    mask: textures?.mask ?? null,
    buffer: new InstanceBuffer(),
    hiddenPreview,
    // Inserted by the first `sizeCanvas` — this reconcile's write pass on the read path, the
    // observer's first delivery on the observer path.
    mounted: false,
    textureDisposers: [],
    pad: { left: 0, right: 0, top: 0, bottom: 0 },
    // The host's visible-rect budget, read ONCE here and re-read per reconcile from then on (see
    // `VISIBLE_RECT_ATTR`). Never read at all while `travelExtents` is off — the whole feature is
    // one boolean test for a runtime that has it switched off.
    visibleRectAttr: rectAttr,
    visibleRect: parseLocalVisibleRect(rectAttr),
    pixelRatioAttr,
    pixelRatioScale: parseSurfacePixelRatio(pixelRatioAttr),
    // Both overwritten by the sizing pass `reconcile` runs right after this create (and by every
    // later resize) — a binding is never drawn before it has been sized.
    drawRatio: engine.pixelRatio,
    boxW: 0,
    boxH: 0,
    boxMeasured: false,
    signature,
    // `state.count` (not `config.amount`): the effective count AFTER the engine's `maxInstances`
    // clamp, which is a per-runtime option the module-scoped cache would otherwise alias across.
    staticKeyBase: staticFrameKeyBase(signature, config, state.count),
    frozen: false,
    // Fresh out of `createParticleState` + `preprocessParticles` — both pure functions of
    // (config, count) — so this state is exactly reproducible from the key. The live loop clears it.
    pristine: true,
    pendingWarm: false,
    // A brand-new canvas has never been painted, so it owes a draw and must not be frozen before it
    // gets one (the first `notePaint` clears this).
    dirty: true,
    dormant,
    canvasSyncDeferred: dormant,
    dormantSeq: 0,
    staticImage: null,
    suspended,
    // FIRST SIGHT of this burst (see `ParticleBinding.emitSeenAt`). A create IS first sight: an unchanged spec
    // keeps its binding, and a re-triggered burst arrives as a changed spec, i.e. a new binding.
    emitSeenAt:
      engine.oneShotExpiry && config.oneShot && config.emitting
        ? nowSeconds()
        : null,
    burstCleared: false,
    parkedBlend: null,
    // Decided at the first sizing, and only while the option is on (see `claimFrozenMount`).
    freezeDecided: false,
    freezeAtMount: false,
    stillMounted: false,
  };
  return binding;
}

// Arm a new binding's texture-load hooks. `scheduleRender` wakes the owning loop once an async
// texture lands; resize is watched through the runtime's ONE shared ResizeObserver (see
// `observeBinding` in `createParticleRuntime`), not from here.
//
// Called by `reconcile` AFTER the sizing pass, never from `createBinding`, because
// `onTextureLoaded` fires its listener SYNCHRONOUSLY when the texture is already decoded — the
// common case, since every twin of a VFX family after the first hits the shared texture cache. From
// inside the create that landed a second `sizeCanvas` per binding, in the middle of the mutate pass
// and before anything had measured: a second forced layout, which a live trace put at 29% of this
// runtime's box reads. Armed here, that synchronous re-size sizes from the box the measure pass just
// cached and reads no layout at all.
function armBindingTextures(
  binding: ParticleBinding,
  engine: ParticleEngine,
  scheduleRender: () => void,
): void {
  if (binding.texture) {
    // Re-size once the real texture dimensions are known (the pad depends on them), then redraw.
    // Only the PAD moved — the element box is exactly where it was — so this reuses the cached box
    // (`syncCanvasSize` tier 2) instead of re-measuring the self-layer. Parked ⇒ deferred: the pad
    // is recomputed by the wake's one sync, from a texture that has only got MORE decoded since.
    binding.textureDisposers.push(
      onTextureLoaded(binding.texture, () => {
        sizeCanvasOrDefer(engine, binding);
        scheduleRender();
      }),
    );
  }
  if (binding.mask) {
    // The mask does NOT change the canvas size (it is sampled over the sprite quad), but the loop may be
    // PARKED when it lands (a finished one-shot, or frozen/static mode) — and until then the system drew
    // NOTHING at all. Kick a redraw so the shaped burst actually appears.
    binding.textureDisposers.push(
      onTextureLoaded(binding.mask, scheduleRender),
    );
  }
}

// CUT A BINDING OUT OF THE WORLD: its texture hooks, its swap registration and stand-in, its canvas
// element, the preview spans it hid and the node blend it neutralized. Everything a teardown does
// EXCEPT hand back the GPU resources, because a BAKE DONOR (see `donateStill`) stops exactly here —
// it must be unreachable from the DOM, the observer and the swapper, while its surface and its
// simulation state stay alive because they are what the pending encode reads.
//
// IDEMPOTENT, and it has to be: a donor is detached now and disposed later, and the dispose runs
// this again. `hiddenPreview` is CLEARED rather than merely walked, so a second pass cannot un-hide
// spans that the replacement binding for the same node has since hidden for itself.
function detachBinding(binding: ParticleBinding): void {
  for (const dispose of binding.textureDisposers) dispose();
  binding.textureDisposers.length = 0;
  // Drop the stand-in `<img>`, release this binding's object-URL refcount and unregister it from
  // the swapper BEFORE the canvas goes: a leaked blob URL outlives the node, the runtime and the
  // scene, and `staticImageUrlsLive` is the probe that says so.
  disposeStaticImage(binding);
  // A no-op for a binding that never mounted (disposed before its first box arrived, e.g. a
  // one-frame VFX or a born-parked binding the expiry sweep took) — its canvas was never inserted.
  binding.canvas.remove();
  for (const span of binding.hiddenPreview) span.style.display = "";
  binding.hiddenPreview.length = 0;
  // The preview spans are back (they DO rely on the node blend for their additive look) and the
  // node may outlive this binding — hand its blend back exactly as found.
  unparkBindingBlend(binding);
}

function disposeBinding(
  binding: ParticleBinding,
  backend: ParticleRenderBackend | null,
): void {
  // Every GPU resource this binding owned — its instance buffer, and whatever else the backend hung
  // off the surface — goes back here. A binding with no surface never acquired any (it was created
  // while the backend was still pending, it is standing on a claimed still, or its adoption is what
  // is being undone).
  if (binding.surface && backend) {
    backend.disposeSurface(binding.surface, binding.buffer);
    binding.surface = null;
  }
  detachBinding(binding);
}

// Draw ONE binding's current simulation state: build the instance buffer, then hand it to the
// backend, which submits the draw and puts the pixels on the binding's canvas (see
// `./render-backend`).
//
// `prof` is the LIVE tick's cost attribution or null (see `ParticleProfile`), and it is a PARAMETER
// rather than a read of `engine.profile` because the frozen path calls this too: a frozen binding is
// warmed and drawn ONCE before the loop parks, and charging that one-off to the per-frame buckets
// would make a mode with no per-frame cost look like it had one. Every bracket below — and every
// bracket inside the backend — is behind the one hoisted null check, so an unprofiled draw takes no
// clock reading at all.
function drawBinding(
  engine: ParticleEngine,
  binding: ParticleBinding,
  prof: ParticleProfile | null = null,
): void {
  // No surface yet ⇒ nothing to draw into, and nothing worth packing for (see
  // `ParticleBinding.surface`). No backend implies no surface, but state the pair here so the
  // renderer calls below need no assertion.
  const surface = binding.surface;
  const backend = engine.backend;
  if (!surface || !backend) return;
  const w = binding.canvas.width;
  const h = binding.canvas.height;
  if (w < 1 || h < 1) return;

  packBinding(binding, prof);
  const buffer = binding.buffer;

  if (buffer.count === 0) {
    // Nothing alive to draw: BLANK the canvas (a finished burst wipes itself) and stop. The clear is
    // a write, so this canvas just changed — it is not standing still, and any stand-in over it must
    // come down.
    backend.clear(surface, w, h, prof);
    notePaint(engine, binding);
    return;
  }

  engine.stats.draws++;
  // Everything renderer-specific from here — the shared-canvas sizing or the swap-chain image, the
  // submit, the blit (where one exists), and their `glMs`/`blitMs` brackets — belongs to the backend.
  backend.draw(surface, buffer, drawOptionsFor(binding, w, h), prof);
  // …and the paint is reported from inside `notePaint`, which is where EVERY path that writes this
  // canvas already converges — including the two above that return before this line.
  notePaint(engine, binding);
}

// Pack one binding's live particles into its instance buffer — the BUILD half of a draw, split out
// only so `captureNodePixels` can re-produce a frame through exactly this code rather than a second
// copy of it that could drift.
//
// Bracketed by hoisted guards rather than by wrapping the loop in a closure: the loop must stay
// exactly the code it was, and an off runtime must not even read the clock (`prof ? … : 0` compiles
// to a predictable branch; `performanceNow` is never called).
function bindingPackInput(binding: ParticleBinding) {
  return {
    state: binding.state,
    instances: binding.buffer,
    config: { hframes: 1, vframes: 1, flipbookCropOnly: true },
    textureWidth: 0,
    textureHeight: 0,
    origin: [0, 0] as [number, number],
    transform: { xx: 1, xy: 0, yx: 0, yy: 1, originX: 0, originY: 0, scale: 1 },
  } satisfies ParticleInstancePackInput;
}

function packBinding(
  binding: ParticleBinding,
  prof: ParticleProfile | null,
): void {
  const cfg = binding.config;
  // The ratio this canvas was actually sized at — live, pinned, or clamped-pinned (see `drawRatio`).
  const dpr = binding.drawRatio;
  const { frameW, frameH } = frameSize(cfg, binding.texture);
  // The LEFT/TOP margins shift the particle-local origin into the grown canvas (the canvas's own
  // left/top edges sit at exactly `-padX`/`-padY` within the self-layer, see `measureCanvasGeometry`).
  // Two numbers rather than one because the margin is directional now — a burst that falls 500px and
  // rises 60 has its origin near the TOP of its canvas, not in the middle.
  const padX = binding.pad.left;
  const padY = binding.pad.top;
  const buffer = binding.buffer;
  const buildStart = prof ? performanceNow() : 0;
  binding.packing ??= bindingPackInput(binding);
  const packing = binding.packing;
  packing.state = binding.state;
  packing.textureWidth = frameW;
  packing.textureHeight = frameH;
  packing.origin[0] = cfg.originX + padX;
  packing.origin[1] = cfg.originY + padY;
  packing.transform.xx = dpr;
  packing.transform.yy = dpr;
  packing.transform.scale = dpr;
  packParticleInstances(packing);
  if (prof) {
    prof.buildMs += performanceNow() - buildStart;
    // The instances this buffer really carries — the denominator for `buildMs` AND `glMs`, and it
    // must be read here rather than after the draw, since the clear-only path returns below.
    prof.instances += buffer.count;
  }
}

// One binding's draw inputs at the current canvas size (see `ParticleDrawOptions`). Pure.
function drawOptionsFor(
  binding: ParticleBinding,
  w: number,
  h: number,
): ParticleDrawOptions {
  const cfg = binding.config;
  return {
    width: w,
    height: h,
    texture: binding.texture,
    textured: Boolean(binding.texture),
    lutTexture: binding.lut,
    maskTexture: binding.mask,
    hframes: cfg.hframes,
    vframes: cfg.vframes,
    blendMode: cfg.blendMode,
    alphaFromRed: cfg.alphaFromRed,
    erode: cfg.alphaErode,
    uvPolar: cfg.uvPolar,
  };
}

// The constant half of a binding's static-frame cache key. Computed ONCE in `createBinding`; every
// term is fixed for the binding's whole life (a spec-attribute change re-creates the binding).
function staticFrameKeyBase(
  signature: string,
  cfg: ParticleSpecConfig,
  count: number,
): string {
  return particleStaticFrameKeyBase({
    specJson: signature,
    count,
    blendMode: cfg.blendMode,
    seed: cfg.seed,
    textureUrl: cfg.textureUrl,
    maskUrl: cfg.maskUrl ?? null,
  });
}

// This binding's frozen-frame cache key at the current canvas size, or NULL when the frame it is
// about to produce is not a pure function of that key and therefore must not be shared. Two reasons
// to refuse:
//
//  - NOT PRISTINE: the simulation has been stepped by the live loop, so `warmStaticParticles` will
//    warm from a phase that depends on WHEN the freeze happened, not on the spec (see
//    `ParticleBinding.pristine`). This is the mid-session `setStaticParticles(true)` downgrade; a
//    runtime that is frozen from the start (the low tier a phone boots into) keeps every binding
//    pristine, including every burst re-created later by a spec/epoch change.
//  - TEXTURE NOT DECODED: the sprite/mask are 1x1 placeholders until their image lands, so the frame
//    would be a placeholder paint. Caching it would publish that placeholder to every twin, and the
//    texture-load listener only re-renders THIS binding. (The shader runtime's `texturesLoaded`
//    gate, same reasoning.)
function staticFrameKeyFor(
  binding: ParticleBinding,
  w: number,
  h: number,
): string | null {
  if (!binding.pristine) return null;
  if (binding.texture && !binding.texture.loaded) return null;
  if (binding.mask && !binding.mask.loaded) return null;
  const { frameW, frameH } = frameSize(binding.config, binding.texture);
  return particleStaticFrameKey(binding.staticKeyBase, {
    width: w,
    height: h,
    drawRatio: binding.drawRatio,
    padX: binding.pad.left,
    padY: binding.pad.top,
    frameW,
    frameH,
    textureWidth: binding.texture?.width ?? 0,
    textureHeight: binding.texture?.height ?? 0,
  });
}

// One binding's frozen-mode step: serve the cached frame if this exact frame has already been
// rendered by ANY binding (this runtime's or an earlier one's — the cache is module-scoped and
// survives dispose), otherwise warm + draw once and publish the result.
//
// A HIT skips BOTH halves of the cost: `warmStaticParticles` (a bounded but real fixed-step sim, up
// to ~2 lifetimes) and the instanced GL draw. N identical systems collapse to 1 warm + 1 draw + N
// blits — and each of those blits IS a paint, reported like one (`notePaint`), so a consumer
// compositing these canvases elsewhere sees all N surfaces rather than the one that drew.
function staticStepBinding(
  engine: ParticleEngine,
  binding: ParticleBinding,
): void {
  const w = binding.canvas.width;
  const h = binding.canvas.height;
  // The cache trades a warm+draw for a BLIT of another binding's frame, so it can only play on a
  // surface with a 2D context to blit through (see `ParticleSurface.ctx2d`) — every WebGL binding.
  // No context, no key: neither served nor published, so a frame that cannot be re-blitted can also
  // never be published into the module-scoped cache.
  const ctx2d = binding.surface?.ctx2d ?? null;
  const key =
    ctx2d !== null && w >= 1 && h >= 1
      ? staticFrameKeyFor(binding, w, h)
      : null;
  if (key !== null && ctx2d !== null) {
    const hit = getStaticParticleFrame(key);
    if (hit) {
      engine.stats.cacheHits++;
      ctx2d.clearRect(0, 0, w, h);
      ctx2d.drawImage(hit, 0, 0);
      // A BLIT IS A PAINT (see `notePaint`): pixels were just written, so this surface is not
      // standing still — even though no `draws` was booked and no simulation ran.
      notePaint(engine, binding);
      // `frozen` stays false: the state was NEVER warmed, so a later MISS at another canvas size
      // must still warm before it draws. The owed warm is recorded for the unfreeze path.
      if (!binding.frozen) binding.pendingWarm = true;
      return;
    }
  }
  if (!binding.frozen) {
    warmStaticParticles(binding.state);
    binding.frozen = true;
    binding.pendingWarm = false;
  }
  drawBinding(engine, binding);
  // Publish even a clear-only (no live instances) frame: an empty canvas IS this key's frame, and
  // the twins that would each have re-derived it are exactly what this cache exists to collapse.
  if (key !== null) storeStaticParticleFrame(key, binding.canvas, w, h);
}

// FROZEN-MODE ONE-SHOT EXPIRY — stop drawing a burst that has outlived its own active window.
//
// WHY. Frozen mode warms each system to a representative mid-flight frame and parks it FOREVER. For an ambient
// emitter that is the whole point (it really does emit forever); for a ONE-SHOT it is wrong in a way nothing
// else in this runtime can correct. A one-shot is a burst — in ANIMATED mode this runtime already ends it by
// itself (the sim clears `state.emitting` after one cycle, the last particle dies at
// `lifetime * (2 - explosiveness)`, and the final `drawBinding` leaves the canvas BLANK), and this restores
// exactly that endpoint for the frozen path. Without it the only input that could ever retire the frame is the
// host's `emitting` flag, and a host can get that stuck: the live case was a game-side visual freeze that left
// `Emitting` latched true on every energy-counter VFX, so the mirror painted a permanent "energy ring" over a
// counter the game itself was showing bare.
//
// SCOPE. Only one-shots, only after a FULL active window measured from this client's own first sight of the
// burst (`ParticleBinding.emitSeenAt`), so legitimate transients — hit sparks, card flourishes — still show for
// their natural life. `staticOneShotExpired` is the pure decision and carries the reasoning; the law is shared
// verbatim with the game-side mod so the two sides agree on when a burst is over.
//
// Retiring is a CLEAR, once: no simulate, no draw, no static-frame-cache read or publish (the cached frame is
// keyed by spec+size, not by age — an expired binding must neither serve nor poison it). A parked/unmounted
// binding is skipped and blanked on its wake instead; `burstCleared` keeps it to one paint.
function retireExpiredBurst(
  engine: ParticleEngine,
  binding: ParticleBinding,
): void {
  if (binding.burstCleared || binding.suspended || !binding.mounted) return;
  const w = binding.canvas.width;
  const h = binding.canvas.height;
  // Unbracketed (`prof` null): the retire is a one-off, not a per-frame cost, exactly like the
  // frozen path's own warm+draw.
  if (binding.surface && w >= 1 && h >= 1) {
    engine.backend?.clear(binding.surface, w, h, null);
  }
  binding.burstCleared = true;
  // A CLEAR IS A PAINT (see `notePaint`): this canvas just changed, so a stand-in `<img>` frozen over the burst
  // must come down rather than outlive the burst it copied. KEYLESS on purpose — the blank this just painted is
  // not the frame this binding's static key names (that key names the WARMED burst, which its twins may be
  // showing right now), and a key reported over pixels that do not match it is the one mistake the swap module
  // cannot catch.
  notePaint(engine, binding, false);
}

// Seconds this binding's burst has been on screen, or null when it can never expire (not an emitting one-shot,
// or the expiry is switched off). The frozen loop needs it twice: for the retire decision, and to schedule its
// OWN wake — a parked loop has no other reason to run again, so without that wake an ended burst would sit
// there until some unrelated event (a resize, a reconcile) happened to kick the loop.
function burstElapsedSeconds(
  binding: ParticleBinding,
  now: number,
): number | null {
  return binding.emitSeenAt === null ? null : now - binding.emitSeenAt;
}

// A single shared loop that steps + draws every live binding and self-stops when all are
// idle (finished one-shot bursts cost ~0). `getBindings` is read each tick so the binding set
// can grow/shrink across reconciles without re-creating the loop. Wakeups go through the pacer:
// under an FPS cap it PARKS on a timer to the next cap boundary instead of arming a rAF per
// display frame (see ../effects-loop-pacing).
function createLoop(
  engine: ParticleEngine,
  getBindings: () => Iterable<ParticleBinding>,
  initialMinFrameTime: number,
  isStatic: () => boolean,
  pacing: EffectsLoopPacing | undefined,
  parkBlend: boolean,
): {
  scheduleRender: () => void;
  setMinFrameTime: (v: number) => void;
  cancelPark: () => void;
  dispose: () => void;
} {
  let disposed = false;
  let lastTime = nowSeconds();
  // Mutable so the runtime's setFps can retune the cap live (adaptive quality).
  let minFrameTime = initialMinFrameTime;
  const pacer = createEffectsLoopPacer(() => tick(), pacing);
  const tick = (): void => {
    if (disposed) return;
    // Frozen (static) mode: warm any not-yet-frozen binding to a representative mid-flight state, draw every
    // binding ONCE (a freshly resized canvas — e.g. after a live setRenderScale — was cleared, so redraw all),
    // then PARK the loop (return without rescheduling) → the frozen art stays on-screen at zero per-frame cost.
    if (isStatic()) {
      const staticNow = nowSeconds();
      // Seconds until the earliest burst end we still owe a wake to (see `burstElapsedSeconds`).
      let nextBurstEnd = Number.POSITIVE_INFINITY;
      // The frozen pass is a tick's worth of draws like any other (see `ParticleRenderBackend`) —
      // one that happens to be the LAST one before the loop parks.
      engine.backend?.beginFrame();
      for (const binding of getBindings()) {
        // Parked world: neutralize the node blend BEFORE the suspend skip, so a covered binding's
        // (already-painted, currently invisible) canvas stops costing a blend surface too.
        if (parkBlend) parkBindingBlend(binding);
        // A one-shot whose burst is over stops being drawn (see `retireExpiredBurst`). Evaluated BEFORE the
        // suspend skip so a burst that ends while its subtree is covered is already retired when it wakes —
        // the wake then blanks it instead of warming and drawing a burst the game finished long ago.
        const elapsed = burstElapsedSeconds(binding, staticNow);
        if (elapsed !== null) {
          if (staticOneShotExpired(binding.config, elapsed)) {
            retireExpiredBurst(engine, binding);
            continue;
          }
          const remaining = oneShotBurstSeconds(binding.config) - elapsed;
          if (remaining < nextBurstEnd) nextBurstEnd = remaining;
        }
        // Occluded (see ../effects-suspend): don't even pay the one-shot warm+draw; the resume
        // reconcile kicks the loop and `frozen` is still false, so it warms + draws then.
        if (binding.suspended) continue;
        // Not sized yet, so not in the DOM (see `ParticleBinding.mounted`). Skipping is not just an
        // optimization here: its canvas is still at the 300x150 default, and the frozen path would
        // PUBLISH that frame into the module-scoped static cache under a key derived from it.
        if (!binding.mounted) continue;
        // No surface yet (the WebGPU device has not arrived — see `ParticleEngine.backend`): skipped
        // exactly like an unmounted binding, and for a sharper reason than "it cannot draw" — the
        // frozen path PUBLISHES what it renders into the module-scoped static-frame cache, and a
        // binding with no surface would publish a blank canvas under a key every twin then serves.
        if (!binding.surface) continue;
        staticStepBinding(engine, binding);
      }
      engine.backend?.endFrame();
      // Frozen mode parks the loop, so a pending burst end is the ONE thing that still needs a wakeup. Arm the
      // nearest one (a no-op while a wakeup is already in flight — the pacer's one-at-a-time contract) and let
      // that tick re-derive the next. Each binding can only shorten this a bounded number of times: the window
      // strictly decreases and ends in a retire, so there is no self-sustaining wake.
      if (nextBurstEnd !== Number.POSITIVE_INFINITY) pacer.arm(nextBurstEnd);
      return;
    }
    const now = nowSeconds();
    // FPS cap: particles (esp. screen-filling background ambients) don't need 60fps; wait out the rest of the
    // capped frame interval (the sim still integrates the full dt, so motion stays time-correct).
    const remaining = minFrameTime > 0 ? minFrameTime - (now - lastTime) : 0;
    if (!pacer.isDue(remaining)) {
      pacer.arm(remaining);
      return;
    }
    // Clamp dt so a backgrounded tab (huge gap) doesn't explode the sim.
    const dt = Math.min(0.1, Math.max(0, now - lastTime));
    lastTime = now;
    let anyLive = false;
    // Cost attribution for THIS tick, or null (see `ParticleProfile`). Hoisted once per tick — every
    // bracket below is behind this one null check, so an unprofiled tick costs a compare per binding
    // and no clock reading whatever. Read AFTER the frozen branch and the cap deferral, both of which
    // do no per-frame work and therefore book nothing.
    const prof = engine.profile;
    // Bindings this tick really simulated + drew. Kept locally so the tick can decide whether it did
    // ANY work — `anyLive` cannot answer that (a tick whose last particles just died did a full
    // frame's work and still reports nothing alive).
    let profBindings = 0;
    // Seconds until the earliest FROZEN-AT-MOUNT burst end still owed a wake, exactly as the frozen
    // branch tracks it. Such a binding never simulates, so it can never end its own burst and can
    // never keep the loop alive to be asked again — without this the loop would park on the last
    // live system and a finished burst would sit there until something unrelated kicked it.
    let nextBurstEnd = Number.POSITIVE_INFINITY;
    // One frame's worth of draws (see `ParticleRenderBackend`). Opened AFTER the cap deferral above,
    // which does no work at all, so a deferred tick opens no frame either.
    engine.backend?.beginFrame();
    for (const binding of getBindings()) {
      // Occluded (see ../effects-suspend): FREEZE — no simulate, no draw, and it doesn't keep the
      // loop alive. The state is untouched, so a resume continues from exactly here (the wake
      // resets the loop clock, so there's no dt catch-up spike either).
      if (binding.suspended) continue;
      // Waiting for its first box (see `ParticleBinding.mounted`): no canvas in the DOM to draw
      // into. Skipped WITHOUT setting `anyLive` — the sizing itself kicks the loop, so a binding
      // that is only waiting cannot hold the loop open in the meantime.
      if (!binding.mounted) continue;
      // FROZEN AT MOUNT (`staticParticleFreezeAtMount`): warmed once, drawn once, never stepped.
      // Handled BEFORE `pristine` is cleared, which is the whole point — a state the loop has
      // stepped can never be named by the static frame key again, and the key is what makes this
      // binding's frame shareable, claimable and bakeable.
      //
      // The draw is owed on `dirty` rather than run every tick the way the FROZEN branch runs it.
      // That branch can be unconditional because it parks the loop immediately afterwards; this one
      // is inside a loop that keeps running for as long as any OTHER system is alive, so an
      // unconditional draw here would be a per-frame cost for a system that never changes. `dirty`
      // is precisely "this canvas owes a repaint" — set at create, and again by any re-size that
      // re-allocated (and therefore cleared) the backing store — and every path that sets it also
      // kicks the loop.
      //
      // NOT parked-blend-neutralized (`parkBindingBlend`), deliberately: that is the frozen MODE's
      // trade, made once for a whole runtime whose surfaces are all standing still. A live-mode
      // consumer's compositing must not change because one of its systems stopped moving.
      if (binding.freezeAtMount) {
        const elapsed = burstElapsedSeconds(binding, now);
        if (elapsed !== null) {
          if (staticOneShotExpired(binding.config, elapsed)) {
            retireExpiredBurst(engine, binding);
            continue;
          }
          const remaining = oneShotBurstSeconds(binding.config) - elapsed;
          if (remaining < nextBurstEnd) nextBurstEnd = remaining;
        }
        if (binding.dirty && binding.surface) {
          if (!binding.frozen) {
            warmStaticParticles(binding.state);
            binding.frozen = true;
            binding.pendingWarm = false;
          }
          drawBinding(engine, binding);
        }
        continue;
      }
      // No surface yet (the WebGPU device is still being acquired): skipped like an unmounted
      // binding, and BEFORE the simulation — so an adoption starts the spray from its deterministic
      // post-create state rather than from a phase nobody ever saw, and `pristine` survives to let
      // the frozen-frame cache key it.
      if (!binding.surface) continue;
      // The state stops being a pure function of (config, count) the instant a wall-clock `dt`
      // enters it — from here its phase depends on WHEN this ran, so it can never be shared
      // through the static-frame cache again (see `ParticleBinding.pristine`).
      binding.pristine = false;
      // CPU SIM bucket. The step COUNT comes back from the sim itself (it is what the sim actually
      // did — see `simulateParticles`), so `simMs / simSteps` is a cost per unit of work rather than
      // per display frame.
      if (prof) {
        profBindings++;
        const simStart = performanceNow();
        prof.simSteps += simulateParticles(binding.state, dt);
        prof.simMs += performanceNow() - simStart;
      } else {
        simulateParticles(binding.state, dt);
      }
      drawBinding(engine, binding, prof);
      if (particlesAreLive(binding.state)) anyLive = true;
    }
    engine.backend?.endFrame();
    // A tick that skipped every binding (all suspended/unmounted) did no frame work, so it books
    // none — `ticks` must stay the denominator of the buckets above, not a count of wakeups.
    if (prof && profBindings > 0) {
      prof.ticks++;
      prof.bindings += profBindings;
    }
    if (disposed) return;
    // `lastTime` is `now`, so the next boundary is one whole capped interval away.
    if (anyLive) {
      pacer.arm(minFrameTime);
      return;
    }
    // Nothing is alive, so this tick would be the last — except for a frozen-at-mount burst that
    // still owes a retire (see `nextBurstEnd`). Arm the nearest one and let that tick re-derive the
    // next; the window strictly decreases and ends in a retire, so this cannot self-sustain.
    if (nextBurstEnd !== Number.POSITIVE_INFINITY) pacer.arm(nextBurstEnd);
  };
  // Kick the loop from a wake path (a reconcile, a texture load, a live quality retune). A wakeup already
  // in flight is left alone — including a PARK, which fires within one cap interval, exactly the worst case
  // of the pre-pacing skip-and-re-arm (whose clock reset deferred a wake by the same interval).
  const scheduleRender = (): void => {
    if (disposed || pacer.isArmed()) return;
    // Reset the clock so a wake (e.g. texture load) doesn't inject a large dt.
    lastTime = nowSeconds();
    pacer.arm(isStatic() ? 0 : minFrameTime);
  };
  const setMinFrameTime = (v: number): void => {
    minFrameTime = v;
    // A pending park targets the OLD cap boundary — drop it so the new cap arms from here.
    pacer.cancelPark();
  };
  const dispose = (): void => {
    disposed = true;
    pacer.cancel();
  };
  return {
    scheduleRender,
    setMinFrameTime,
    cancelPark: pacer.cancelPark,
    dispose,
  };
}

/** A persistent particle runtime for a mounted scene root (see `createParticleRuntime`). */
export interface ParticleRuntime {
  /** Diff the current `[data-godot-particle-runtime]` nodes against the live bindings:
   *  unchanged specs keep their running simulation, changed/new specs re-init that node only,
   *  gone nodes are disposed. */
  reconcile(): void;
  /** Live retune the backing-store resolution (devicePixelRatio × clamped `scale`) without a
   *  dispose+recreate — running simulations keep going, only the canvas density changes. While a pin
   *  is in force (see `setStaticParticlePixelRatio`) AND the runtime is frozen this re-sizes nothing:
   *  the frozen canvases are deliberately held still. The new scale applies to live bindings as soon
   *  as frozen mode is left. */
  setRenderScale(scale: number): void;
  /** Live set/clear the pinned FROZEN backing-store ratio (see `staticParticlePixelRatio`). Pass
   *  `undefined` (or a non-positive value) to un-pin. Only frozen bindings are affected. */
  setStaticParticlePixelRatio(ratio: number | undefined): void;
  /** Live retune the particle FPS cap (0 = uncapped). */
  setFps(fps: number): void;
  /** Live toggle frozen (single-shot) mode, mirroring `WebglShaderRuntime.setStaticShaders`: warm each system
   *  to a representative mid-flight state, draw ONCE, then park the loop (true); or resume live simulation (false).
   *  The low-cost fallback that shows a frozen spray of particles instead of a per-frame CPU sim + GL draw. */
  setStaticParticles(value: boolean): void;
  /** Live toggle of the frozen-surface image swap (see the `staticParticleImages` option and
   *  `../surface-image-swap`), mirroring `WebglShaderRuntime.setStaticShaderImages`. Turning it OFF
   *  reverts every live swap immediately and revokes its object URLs — the kill switch, safe to
   *  throw at any time. Turning it ON arms the runtime's CONFIGURED policy (a boolean here never
   *  replaces it) and every binding re-earns its window; a runtime left at the DEFAULT (`false`,
   *  since this option is opt-in) has no configured policy to arm, so ON gives it the same
   *  quiet-window policy `staticParticleImages: true` means — otherwise this switch could never
   *  turn the mechanism on for the consumers it exists for. */
  setStaticParticleImages(value: boolean): void;
  /** HOST-DRIVEN revert of the surface image swap, WITHOUT blocking, mirroring the shader runtime's:
   *  with no argument every swapped surface is handed back to its canvas; with a node list, only the
   *  bindings at (or under) those elements. Each affected surface restarts its gate and re-earns the
   *  swap on its own. This is how a host that knows something the runtime cannot see — it is about
   *  to re-parent a subtree, it just re-themed, its own occlusion pass changed its mind —
   *  un-shadows a stale stand-in immediately instead of waiting for a watchdog window. */
  invalidateStaticSurfaces(nodes?: Iterable<HTMLElement>): void;
  /** The runtime's live counters (see `ParticleRuntimeStats`). Returns the SAME live object every
   *  call — read-only by convention; snapshot (spread) it to diff. All-zero on the no-op handle.
   *  `.profile` carries the opt-in per-frame cost attribution (`effectsProfiling`) and is NULL
   *  whenever it was not measured, the no-op handle included. */
  stats(): ParticleRuntimeStats;
  /**
   * TEST / DIAGNOSTIC HOOK: this node's binding re-rendered into an offscreen texture and read back
   * as tightly-packed RGBA (PREMULTIPLIED, top-down, at the canvas's BACKING-STORE size), or null
   * when there is nothing to read — no binding at (or under) `node`, no surface yet, a zero-sized
   * canvas, or a runtime rendering on WebGL.
   *
   * WEBGL RETURNS NULL ON PURPOSE, and it is not a gap: that canvas holds readable 2D pixels, so a
   * caller who wants them uses `getImageData` on it. This exists because a WebGPU canvas has no such
   * path — `drawImage`/`toDataURL` from one are blank under headless Chrome and pathological on
   * Android (docs/perf-harness.md S7) — so the frame has to be produced a SECOND time, into a
   * texture that `copyTextureToBuffer` can reach (`../webgpu/readback`). It renders the binding's
   * CURRENT state, which for a frozen/static binding is exactly the frame on screen.
   *
   * This is the WebGL↔WebGPU image-parity harness's capture path, and the seam the readback-based
   * surface image swap encodes from — `attachSurfaceSwap` gives a WebGPU binding a `captureCanvas`
   * hook built out of exactly this production (`../surface-image-swap`).
   */
  captureNodePixels?(node: HTMLElement): Promise<Uint8Array | null>;
  /** Tear down every binding and stop the loop. */
  dispose(): void;
}

/** The policy the convenience value `staticParticleImages: true` maps to: the QUIET-WINDOW gate
 *  with the swap module's own defaults (window, watchdog, encode pacing, and `keyedQuietMs` inert at
 *  `quietMs`). NOT the `content-key` gate that `staticShaderImages: true` maps to, even though this
 *  runtime now names its frames (see `notePaint`): that gate swaps on N consecutive unchanged
 *  observations, and its second clock is `noteStaticImageReconcile`, which this runtime never calls
 *  — a frozen system paints ONCE and parks, so `stable` could never reach 2. The key is content
 *  evidence WITHIN the quiet window (`keyedQuietMs`, key dedup, re-statement without a revert), not
 *  a substitute for it. Documented where the option is declared (`../types`). */
const PARTICLE_QUIET_WINDOW_POLICY: StaticSurfacePolicy = {
  gate: { kind: "quiet-window" },
};

/** The option as the swap module wants it: absent/`false` ⇒ OFF (this option is opt-in, so an
 *  absent value must resolve to `false` and NOT to the module's own default policy); `true` ⇒ the
 *  quiet-window mapping above; an object is the host's policy, verbatim. */
function resolveStaticParticleImages(
  option: StaticSurfaceOption | undefined,
): StaticSurfaceOption {
  if (option === undefined || option === false) return false;
  return option === true ? PARTICLE_QUIET_WINDOW_POLICY : option;
}

/**
 * Create a persistent particle runtime over a mounted scene root. The caller keeps this handle
 * and calls `reconcile()` on each re-render. Bindings
 * are keyed by their outer node element; a binding whose `data-godot-particle-specs` is
 * unchanged keeps its running simulation (so ambient emitters and in-flight one-shot bursts are
 * NOT reset by an unrelated re-render), while a changed spec re-inits only that node — the seam
 * a host uses to re-trigger a one-shot burst (bump a value in the spec). A no-op handle when
 * WebGL2/particles are unavailable.
 */
export function createParticleRuntime(
  root: HTMLElement,
  options: GodotHtmlRuntimeOptions,
): ParticleRuntime {
  const engine = createEngine(options);
  if (!engine) {
    // The no-op handle still carries (all-zero, never-incremented) stats so probes need no null case.
    const noopStats = createParticleRuntimeStats();
    return {
      reconcile() {},
      setRenderScale() {},
      setStaticParticlePixelRatio() {},
      setFps() {},
      setStaticParticles() {},
      setStaticParticleImages() {},
      invalidateStaticSurfaces() {},
      stats: () => noopStats,
      dispose() {},
    };
  }
  let disposed = false;
  // Frozen-surface image swap (see `../surface-image-swap`). The option carries the POLICY; the
  // runtime only decides when to consult it. Ships OFF (see `staticParticleImages`), and `null` IS
  // the off state — no binding is ever given swap state, so every swap call site is a no-op on a
  // stateless binding and the runtime takes exactly the path it took before this existed.
  const staticSurfacePolicy = resolveStaticParticleImages(
    options.staticParticleImages,
  );
  // The policy as the SWAPPER gets it. Under freeze-at-mount the runtime takes over
  // `StaticSurfacePolicy.onRevert` — the hook the swap module reserves for exactly this — because a
  // claimed surface is the one case where a revert uncovers nothing: no pixels, no backing store, no
  // context. The host's own handler (if it gave one) still runs, first and unconditionally; this
  // runtime's live-ify runs after it, in the same task, before anything composites. With the option
  // off the policy object is passed through untouched, so an existing consumer's swapper is built
  // from exactly what it configured.
  const swapPolicyFor = (option: StaticSurfaceOption): StaticSurfaceOption => {
    if (!engine.freezeAtMount || typeof option !== "object") return option;
    const hostOnRevert = option.onRevert;
    return {
      ...option,
      onRevert: (binding) => {
        hostOnRevert?.(binding);
        liveifyBinding(binding as ParticleBinding);
      },
    };
  };
  let surfaceSwapper: StaticSurfaceSwapper | null = createStaticSurfaceSwapper(
    swapPolicyFor(staticSurfacePolicy),
    engine.stats,
  );
  // THE way a binding enters the swap. Swap state exists only while the mechanism is on; NO swapper
  // IS the off state. `attach` also REGISTERS the binding, which is what lets the swapper's own
  // quiet-window/watchdog timers enumerate it without this runtime handing them anything. It also
  // ADOPTS the park's create-time hide, so the swap owns that `display` from here on (see
  // `../surface-image-swap`).
  //
  // TWO ENCODE SOURCES, and the choice is the BACKEND's, not the surface's. A 2D-backed (WebGL)
  // surface is read directly: the swap stands an `<img>` of the canvas's OWN pixels in for it, which
  // is the path that shipped first. A WebGPU surface cannot be read at all — `drawImage`/`toDataURL`/
  // `toBlob` go through presentation, blank headless and pathological on Android (S7) — so v1 never
  // registered one. v2 registers it with a CAPTURE HOOK: the backend re-renders the binding's current
  // frame into an offscreen texture and copies it back (`captureStillCanvas` below), and the swap
  // encodes that.
  //
  // Keying off `backend.captureSurface` rather than `surface.ctx2d` says the same thing about every
  // binding that has a surface (a WebGL one that could not give a 2D context was refused at create),
  // and it says it for a binding that has NO surface yet — which under freeze-at-mount is the normal
  // state of one about to claim a still, and a claim needs swap state to attach to.
  const attachSurfaceSwap = (binding: ParticleBinding): void => {
    const backend = engine.backend;
    if (!backend) {
      // PENDING (no backend). Normally `adoptBackend` attaches, since which encode source a binding
      // needs is a question only the backend answers. Freeze-at-mount cannot wait for it: the first
      // sizing may land before the device does, and a claim with no swap state is a silent miss.
      // Attach with the read-the-canvas default and let the adoption re-decide. Nothing can encode
      // in between — an unpainted binding is `dirty`, which the gate refuses, and a claim never
      // encodes at all.
      if (engine.freezeAtMount) surfaceSwapper?.attach(binding);
      return;
    }
    if (!backend.captureSurface) {
      // A re-attach must never leave a hook from a previous backend on a readable surface.
      binding.captureCanvas = undefined;
      surfaceSwapper?.attach(binding);
      return;
    }
    binding.captureCanvas = () => captureStillCanvas(binding);
    surfaceSwapper?.attach(binding);
  };

  // TAKE A CLAIMED SURFACE BACK. The swap can no longer vouch for the stand-in over this binding —
  // the watchdog saw its canvas re-allocated, the host called `invalidateStaticSurfaces`, a re-size
  // or a dormancy wake reverted it, its `<img>` would not decode — and under that stand-in is a
  // canvas with no context, no backing store and no pixels (see `claimFrozenMount`). So build the
  // surface, size it for real, pay the warm this binding never ran, and draw, all on the stack the
  // revert is already on: the revert un-hid the canvas a few lines ago and nothing composites until
  // this task ends, so the blank never reaches the screen.
  //
  // ORDER MATTERS, in the small: `stillMounted` is cleared FIRST because `sizeCanvas` below writes
  // `canvas.width`, which reverts the (already reverted) swap and re-enters here — the flag is what
  // makes that a no-op instead of a loop.
  const liveifyBinding = (binding: ParticleBinding): void => {
    if (!binding.stillMounted || disposed) return;
    binding.stillMounted = false;
    binding.dirty = true;
    // Refused (no backend yet, or no context to be had): the binding stays surface-less and is
    // skipped by every draw path, exactly like one whose device has not arrived. Its next sizing or
    // adoption tries again.
    if (!ensureSurface(engine, binding)) return;
    sizeCanvas(engine, binding);
    if (binding.burstCleared) {
      // An expired burst's frame is BLANK and a freshly allocated backing store already is, so there
      // is nothing to warm and nothing to draw — but the paint must still be reported, keyless (see
      // `retireExpiredBurst`), or the swap would go on believing this canvas holds the warmed burst.
      notePaint(engine, binding, false);
      return;
    }
    if (binding.pendingWarm) {
      warmStaticParticles(binding.state);
      binding.pendingWarm = false;
      binding.frozen = true;
    }
    drawBinding(engine, binding);
    loop.scheduleRender();
  };

  // One binding's current frame as a 2D canvas the encoder can read — the swap's WebGPU encode
  // source. The same production as the handle's `captureNodePixels` (the same pack loop, the same
  // draw options, so the capture is the frame on screen rather than a second interpretation of the
  // state), plus the premultiplied→straight conversion `putImageData` needs
  // (`../webgpu/still-capture`). Null whenever the pixels cannot be produced; the swap books that as
  // a capture failure and leaves the surface on its canvas.
  const captureStillCanvas = async (
    binding: ParticleBinding,
  ): Promise<StaticSurfaceCapture> => {
    const backend = engine.backend;
    const surface = binding.surface;
    if (!backend?.captureSurface || !surface) return null;
    const w = binding.canvas.width;
    const h = binding.canvas.height;
    if (w < 1 || h < 1) return null;
    packBinding(binding, null);
    // THE BLANK GUARD's assertion, read BEFORE the await like `w`/`h` and for the same reason: it
    // describes the instances THIS capture is about to encode, and a live tick landing mid-readback
    // must not re-interpret them. `packBinding` skips every particle that is inactive or at alpha 0,
    // so a non-zero count is exactly the condition under which `drawBinding` DRAWS rather than
    // CLEARS — i.e. a frame the runtime knows put pixels on the canvas. At count 0 the live path
    // blanks the canvas on purpose, so an invisible capture is the truth and is encoded as
    // one: a system that has emitted nothing, or one whose particles have all faded, still freezes.
    // See `../surface-image-swap`'s BLANK CAPTURES.
    const drewInstances = binding.buffer.count > 0;
    const pixels = await backend.captureSurface(
      surface,
      binding.buffer,
      drawOptionsFor(binding, w, h),
    );
    return pixels
      ? canvasFromPremultipliedRgba(pixels, w, h, drewInstances)
      : null;
  };
  const bindings = new Map<HTMLElement, ParticleBinding>();
  // ONE ResizeObserver for the whole runtime, dispatching by observed target, instead of one per
  // binding (each is its own registration + closure + callback slot; a burst of new emitters built
  // a storm of them). Per-binding semantics are preserved: a target's LAST entry in a delivery wins.
  const observedBindings = new Map<Element, ParticleBinding>();
  const sharedObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          const latest = new Map<Element, ResizeObserverEntry>();
          for (const entry of entries) latest.set(entry.target, entry);
          let cleared = false;
          for (const [target, entry] of latest) {
            const binding = observedBindings.get(target);
            if (binding) {
              if (binding.dormant) {
                // PARKED: cache the delivered box — the observer has already paid for it off the
                // main path, and it will NOT re-fire after the wake (the box change has happened),
                // so a wake sized from the stale pre-park box would stay wrong — but do not touch
                // the canvas. Re-allocating the backing store of a hidden canvas is exactly the
                // work the park exists to skip; the wake's one deferred sync does it, from here.
                // A 0x0 delivery is cached like any other, exactly as the awake path caches it: a
                // particle self-layer legitimately measures 0, which is why WS-1 gave "have we
                // measured?" its own flag instead of the shader runtime's `boxW > 0` (whose parked
                // branch must therefore drop a 0 box).
                binding.boxW = entry.contentRect.width;
                binding.boxH = entry.contentRect.height;
                binding.boxMeasured = true;
                binding.canvasSyncDeferred = true;
                continue;
              }
              // The observer already measured this box off the main path, so passing its
              // `contentRect` both sizes the canvas AND refreshes the binding's cached box
              // (`syncCanvasSize`) for free — which is what makes every later re-size that is not a
              // real box change (a `setRenderScale` step, a pin change, a texture-load re-pad)
              // reflow-free.
              //
              // For an unmounted binding this delivery is its FIRST box (`particleObserverSizing`):
              // the same call sizes it and MOUNTS it (`sizeCanvas` → `mountBinding`), returning true
              // so the loop is kicked below. That is the whole optimization — a create then costs no
              // `clientWidth` at all, because the browser measured this box during its own layout
              // step and handed it over. Chrome delivers an initial observation for EVERY newly
              // observed target, a 0x0 one included (verified) — which matters because particle
              // self-layers are routinely 0x0 (a Node2D has no rect; the canvas is all `pad`).
              const resized = sizeCanvas(engine, binding, entry.contentRect);
              cleared = cleared || resized;
            }
          }
          // Re-assigning canvas.width/height REALLOCATES (so CLEARS) the 2D backing store. The
          // loop may be PARKED — always in frozen/static mode, and in live mode whenever nothing
          // is alive — and a parked loop never redraws, so the frozen spray simply VANISHED on any
          // resize (a rotate, a letterbox/viewport change, a panel opening). Kick the loop: its
          // static branch redraws every binding once from the (untouched) frozen state and parks
          // again. Only on a REAL resize, so a no-op observation still costs nothing.
          if (cleared) loop.scheduleRender();
        });
  const observeBinding = (binding: ParticleBinding): void => {
    if (!sharedObserver) return;
    observedBindings.set(binding.selfLayer, binding);
    sharedObserver.observe(binding.selfLayer);
  };
  const unobserveBinding = (binding: ParticleBinding): void => {
    if (!sharedObserver) return;
    observedBindings.delete(binding.selfLayer);
    sharedObserver.unobserve(binding.selfLayer);
  };

  // ---- bake donors (see `donateStill`) --------------------------------------------------------
  //
  // Insertion order is age order (a `Set` iterates that way and a donor is added exactly once), so
  // the bound's eviction is a plain oldest-first walk.
  const donors = new Set<ParticleBinding>();

  /** Let a donor go: its surface and instance buffer back to the backend, everything else already
   *  gone (`detachBinding` ran at donation). `published` splits the two counters. */
  const releaseDonor = (binding: ParticleBinding, published: boolean): void => {
    if (!donors.delete(binding)) return;
    if (published) engine.stats.staticStillDonorBakes++;
    else engine.stats.staticStillDonorsDropped++;
    disposeBinding(binding, engine.backend);
  };

  // BANK THE PIXELS OF A DEPARTING BINDING. Returns whether this binding is now a donor and must NOT
  // be disposed by the caller.
  //
  // The other half of `claimFrozenMount`. A claim can only ever hit a key this document has already
  // encoded, and the ordinary way a key gets encoded is that some surface earned a swap for it —
  // which for a scene that mounts a fleet, holds it briefly and drops it may simply never happen.
  // A binding on its way out is holding the only cheap copy of its frame that will ever exist, so
  // it is kept alive JUST long enough to encode it: its canvas leaves the DOM (so it costs no
  // compositor layer and no paint), its surface and simulation state stay, and the encode goes
  // through the swapper's ordinary pacing (`bakeStill`).
  //
  // WHAT IT REFUSES, and why each one:
  //   - a key that is already known in any state — the pixels exist, are coming, or have been proven
  //     unobtainable, so a bake would be a duplicate readback (`bakeStill` refuses it too; asking
  //     first is how a donor avoids being retained for a job that settles false on the same stack);
  //   - a binding with no key, no surface, no mount or a zero-sized canvas — nothing to read;
  //   - a DIRTY one: a repaint is owed, so those pixels are not the frame the key names, and a key
  //     reported over pixels that do not match it is the one mistake the swap cannot catch;
  //   - a NON-EMPTY encode queue. A bake is speculative work for a surface nobody is waiting on,
  //     and the queue is ordered smallest-first rather than by who asked — so a bake enqueued
  //     mid-burst competes for the slice budget with live candidates that are still costing a
  //     compositor layer each. `queueLength() === 0` is the swapper's own "the fleet has drained".
  const donateStill = (binding: ParticleBinding): boolean => {
    const swapper = surfaceSwapper;
    if (disposed || !engine.freezeAtMount || !swapper) return false;
    if (!binding.surface || !binding.mounted || binding.dirty) return false;
    const w = binding.canvas.width;
    const h = binding.canvas.height;
    if (w < 1 || h < 1) return false;
    const key = staticFrameKeyFor(binding, w, h);
    if (key === null || hasStaticStill(key)) return false;
    if (swapper.queueLength() !== 0) return false;
    // From here the binding belongs to the bake: out of the DOM, out of the swapper, out of the
    // observer (the caller unobserved it) and out of `bindings` (the caller deletes it). The loop
    // and `reconcile` walk `bindings`, so neither can reach it again.
    detachBinding(binding);
    donors.add(binding);
    // BOUNDED BY COUNT, not by bytes: what a donor pins is a canvas backing store and a GPU buffer,
    // which the pool's byte budget does not see. Oldest first, and never the one just admitted —
    // evicting that would be a readback nobody ever asked for followed by an immediate teardown.
    for (const oldest of donors) {
      if (donors.size <= MAX_STILL_DONORS) break;
      if (oldest !== binding) releaseDonor(oldest, false);
    }
    // `onSettled` fires exactly once wherever the job ends — a synchronous refusal included, which
    // is why the donor is registered above first.
    swapper.bakeStill(
      { canvas: binding.canvas, captureCanvas: binding.captureCanvas },
      key,
      engine.stats,
      (published) => releaseDonor(binding, published),
    );
    return true;
  };

  // Take a binding out of the runtime, banking its frame first where that is worth doing. THE one
  // exit for a binding whose NODE went away or whose spec changed; a device loss and a refused
  // adoption dispose directly, because there the surface is exactly what is broken.
  const retireBinding = (binding: ParticleBinding): void => {
    unobserveBinding(binding);
    if (donateStill(binding)) return;
    disposeBinding(binding, engine.backend);
  };

  // ---- the dormancy park (see the module doc + `../shader-dormant`) ---------------------------
  //
  // Expiry is ONE per-runtime timer, armed only while at least one binding is parked, and it
  // compares monotonic ORDINALS rather than a clock: the sweep disposes every binding that was
  // ALREADY parked when the timer was armed (so it has been parked for ≥ one full interval), then
  // re-arms if any remain. No per-binding timer, no clock reading, no drift. Copied from
  // `../webgl/runtime` deliberately — one park, one expiry rule.
  //
  // A node whose subtree stays suspended is RE-CREATED by the next reconcile after its sweep, born
  // parked — no measure, no size, no draw, hidden canvas — and expires again one interval later.
  // That is the same steady state the shader runtime accepts, and it is the point: the binding's
  // canvas, backing store and GL instance buffer are handed back in between. The cost is that its
  // frozen simulation state does NOT survive the sweep (a burst re-created after expiry replays
  // from its start), which is why the window is 30s and not 3.
  let dormantSeq = 0;
  let dormantSweepArmedAt = 0;
  let dormantSweepTimer: ReturnType<typeof setTimeout> | null = null;
  const sweepDormant = (): void => {
    dormantSweepTimer = null;
    if (disposed) return;
    let remaining = false;
    const expired: HTMLElement[] = [];
    for (const [node, binding] of bindings) {
      if (!binding.dormant) continue;
      if (binding.dormantSeq <= dormantSweepArmedAt) expired.push(node);
      else remaining = true;
    }
    for (const node of expired) {
      const binding = bindings.get(node);
      if (!binding) continue;
      retireBinding(binding);
      bindings.delete(node);
      engine.stats.dormantDisposes++;
    }
    if (remaining) armDormantSweep();
  };
  const armDormantSweep = (): void => {
    if (disposed || dormantSweepTimer !== null) return;
    dormantSweepArmedAt = dormantSeq;
    dormantSweepTimer = setTimeout(
      sweepDormant,
      DORMANT_DISPOSE_SECONDS * 1000,
    );
  };

  // Publish a binding's park state, following its (just-updated) `suspended`. THE arbitration point
  // with the frozen-surface image swap: this runtime sets the flag and hands `display` to
  // `applySurfaceVisibility`, which is the swap module's single writer of both surfaces and composes
  // the two states (parked hides the canvas AND any stand-in `<img>`; awake restores what the HOST
  // left on the canvas, never a blanket `""`). Exactly `../webgl/runtime`'s `syncDormant`, including
  // the order: visibility first, then — on the wake — `noteStaticSurfaceWake`, which reverts a
  // stand-in the swap cannot vouch for (always, under the keyless quiet-window gate this runtime
  // uses, and whenever a deferred re-size is about to clear the canvas under it).
  //
  // ALL WRITES, NO READS: the one owed `sizeCanvas` is handed to `owed` instead of run here, so it
  // lands in the reconcile's WRITE pass, after the measure pass has batched whatever box read it
  // needs (a binding born parked has never been measured at all). Running it inline would put a
  // forced layout back in the middle of the mutate pass — the exact interleave WS-1 removed.
  const syncDormant = (
    binding: ParticleBinding,
    owed: ParticleBinding[],
  ): void => {
    const dormant = engine.parkDormant && binding.suspended;
    if (dormant === binding.dormant) return;
    binding.dormant = dormant;
    if (dormant) {
      applySurfaceVisibility(binding);
      binding.dormantSeq = ++dormantSeq;
      engine.stats.dormantParks++;
      armDormantSweep();
      return;
    }
    binding.dormantSeq = 0;
    engine.stats.dormantWakes++;
    applySurfaceVisibility(binding);
    noteStaticSurfaceWake(binding, engine.stats, binding.canvasSyncDeferred);
    if (binding.canvasSyncDeferred) {
      binding.canvasSyncDeferred = false;
      owed.push(binding);
    }
  };
  // Optional FPS cap (options.particleFps). 0/undefined → uncapped (every rAF), preserving prior behaviour.
  const fps = options.particleFps ?? 0;
  const minFrameTime = fps > 0 ? 1 / fps : 0;
  // Frozen (single-shot) mode — warm+draw once per binding, then park the loop; MUTABLE via
  // setStaticParticles so an adaptive/settings consumer can drop into it as a downgrade rung (mirrors the
  // shader runtime's staticShaders) — lives on the ENGINE as `staticMode`, seeded from
  // `options.staticParticles`. The sizing + draw paths are free functions that already carry the engine, and
  // a second copy here would be a second source of truth for the pin condition.
  // Parked-blend neutralization (see `parkBindingBlend` + types.ts). Read once — a code-path
  // selector, not a live quality knob.
  const parkBlend = options.parkStaticParticleBlend === true;
  const loop = createLoop(
    engine,
    () => bindings.values(),
    minFrameTime,
    () => engine.staticMode,
    options.effectsLoopPacing,
    parkBlend,
  );

  // PORTABILITY BACKSTOP for `particleObserverSizing`. Chrome delivers an initial observation for
  // every newly observed target — a 0x0 one included, which is the case that matters here — but the
  // ResizeObserver spec only guarantees a delivery when the observed size DIFFERS from the
  // last-reported one, whose initial value is 0x0. A strict engine may therefore never report a
  // particle self-layer at all (they are routinely 0x0), and a binding that is never delivered is
  // never sized, never mounted and never drawn: the spray would silently vanish.
  //
  // So: two frames after a reconcile deferred any create, sweep whatever is STILL waiting and size it
  // the old way. Timing is what makes this free on Chrome — observer callbacks run after the layout
  // step of a frame, so a double `requestAnimationFrame` is guaranteed to be after the delivery for
  // any observation registered before it, and the sweep finds an empty set (one map walk, no layout).
  // Where it does fire it costs exactly what the read path costs: ONE contiguous run of reads, then
  // the writes — never the per-binding read/write interleave. `boxReads` is the tell: still 0 means
  // the observer really did all the sizing.
  let mountBackstopArmed = false;
  const runMountBackstop = (): void => {
    mountBackstopArmed = false;
    if (disposed) return;
    const waiting: ParticleBinding[] = [];
    for (const binding of bindings.values()) {
      if (!binding.mounted && !binding.dormant) waiting.push(binding);
    }
    if (waiting.length === 0) return;
    for (const binding of waiting) {
      if (!binding.boxMeasured) readBoxInto(binding, engine.stats);
    }
    for (const binding of waiting) sizeCanvas(engine, binding);
    loop.scheduleRender();
  };
  const armMountBackstop = (): void => {
    if (mountBackstopArmed || disposed) return;
    mountBackstopArmed = true;
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(runMountBackstop, 0);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(runMountBackstop));
  };

  const reconcile = (): void => {
    if (disposed) return;
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>("[data-godot-particle-runtime]"),
    ).filter((node) => !node.hasAttribute("data-godot-self-layer"));
    const seen = new Set<HTMLElement>(nodes);

    // Dispose bindings whose node vanished from the DOM (banking the frame first where that pays —
    // see `retireBinding`).
    for (const [node, binding] of bindings) {
      if (!seen.has(node)) {
        retireBinding(binding);
        bindings.delete(node);
      }
    }

    // Creating N new systems in one reconcile is MUTATE → MEASURE → WRITE, in three passes, because
    // doing all three per binding interleaves DOM writes with layout reads and costs one forced
    // layout flush per new system (a card shuffle / an enemy turn mounts many at once — measured at
    // up to 19 reflows in a single 75 ms task). Phasing does not remove reads: each binding has its
    // OWN self-layer, so N new bindings still take N `clientWidth` reads. What it buys is that those
    // reads sit in one contiguous run AFTER every write, so they cost ONE flush instead of N — the
    // flush is the cost, not the read.
    let changed = false;
    const created: ParticleBinding[] = [];
    // Bindings woken from the park that owe a `sizeCanvas` — measured in pass 2 if they have never
    // been measured, sized in pass 3, so a wake burst costs one flush like a create burst.
    const woken: ParticleBinding[] = [];
    // KEPT bindings that owe a RE-SIZE — because their visible-rect budget moved
    // (`VISIBLE_RECT_ATTR`), or because the host restated how magnified they are
    // (`SURFACE_PIXEL_RATIO_ATTR`). Paid in pass 3 with everything else. Deliberately NOT a
    // re-create in either case: both are properties of where the node currently is on screen, and a
    // node that drifts across the stage — or that a container grows — must not have its running
    // simulation restarted every time it does.
    const rebudgeted: ParticleBinding[] = [];
    // PASS 1 — MUTATE. Build + insert every new canvas and hide every preview; nothing measures.
    for (const node of nodes) {
      const existing = bindings.get(node);
      const signature = node.getAttribute("data-godot-particle-specs") ?? "";
      // Unchanged spec → this binding is KEPT (its running simulation is untouched). A changed one
      // is disposed + re-created below, which is also why it is not worth parking or waking.
      const kept = existing !== undefined && existing.signature === signature;
      if (existing) {
        // Re-evaluate occlusion (attribute-only, no layout). A RESUME must re-kick the loop — it
        // may have parked while every binding was suspended.
        const suspended = isEffectsSuspended(node);
        if (suspended !== existing.suspended) {
          existing.suspended = suspended;
          // Either direction owes this canvas a redraw: going under, its next paint is deferred to
          // the resume; coming back, that paint has not happened yet. Marking it dirty is how the
          // shader runtime tells the image swap the same thing — a suspended surface must not be
          // frozen mid-suspension, because the freeze would have to survive a resume it cannot see.
          existing.dirty = true;
          // …and the park follows the same signal: hide the canvas going under (dropping its
          // compositor layer and its backing store), un-hide + pay the one owed `sizeCanvas`
          // coming back. Evaluated here, in PASS 1, because a wake's deferred sync is a WRITE and
          // this pass is the write phase; a park does no layout in either direction. Only for a
          // KEPT binding: one whose spec ALSO changed in this reconcile is about to be disposed, and
          // queueing its owed sync would leave pass 3 sizing an orphan canvas (its replacement is
          // created in the right state anyway).
          if (kept) syncDormant(existing, woken);
          if (!suspended) changed = true;
        }
        // …and re-evaluate the visible-rect budget, on the same terms: one attribute read, no
        // layout, KEPT bindings only (a re-created one reads it fresh in `createBinding`). Compared
        // as the RAW STRING so an unchanged node costs a compare and not a parse.
        let owesResize = false;
        if (kept && engine.travelExtents) {
          const rectAttr = node.getAttribute(VISIBLE_RECT_ATTR);
          if (rectAttr !== existing.visibleRectAttr) {
            existing.visibleRectAttr = rectAttr;
            existing.visibleRect = parseLocalVisibleRect(rectAttr);
            owesResize = true;
          }
        }
        // …and re-evaluate the host's magnification for this surface, on exactly those terms: one
        // SELF-LAYER attribute read, no layout, KEPT bindings only, compared as the RAW STRING so an
        // unchanged node costs a compare and not a parse. Ungated — unlike the visible rect there is
        // no option to switch this off, because "absent" already IS off (it parses to 1, and a
        // binding that has never been stamped never enters this branch at all).
        //
        // The re-size goes to pass 3 like the rebudgeted ones, and it is `sizeCanvas` — not the
        // watchdog — that retires any stand-in `<img>` over it: a re-allocation there is a change
        // this runtime MADE, so it reverts the swap deliberately without disqualifying the surface
        // from freezing again.
        if (kept) {
          const ratioAttr = existing.selfLayer.getAttribute(
            SURFACE_PIXEL_RATIO_ATTR,
          );
          if (ratioAttr !== existing.pixelRatioAttr) {
            existing.pixelRatioAttr = ratioAttr;
            existing.pixelRatioScale = parseSurfacePixelRatio(ratioAttr);
            owesResize = true;
          }
        }
        // ONE entry however many of the two moved: pass 3's `sizeCanvasOrDefer` resolves the whole
        // geometry from current state, so a second visit would re-measure and re-decide identically.
        if (owesResize) rebudgeted.push(existing);
      }
      if (kept) continue;
      if (existing) {
        retireBinding(existing);
        bindings.delete(node);
      }
      const binding = createBinding(node, engine, options.onUnsupported);
      if (binding) {
        bindings.set(node, binding);
        created.push(binding);
        changed = true;
      }
    }

    // PASS 2 — MEASURE. One contiguous run of self-layer box reads (see `readBoxInto`), no writes
    // between them. Skipped entirely when the box cache is off, in which case pass 3 reads per
    // binding exactly the way this runtime always did. A binding BORN PARKED is left out on purpose
    // — its canvas is hidden and its sizing deferred, so measuring it now would be the forced layout
    // the park exists to skip; the wake measures it, here, with whatever else that reconcile mounts.
    //
    // With `particleObserverSizing` on (the default) NEW bindings are left out too, and this pass
    // reads nothing at all in the common case: their first box comes from the shared ResizeObserver's
    // initial delivery, off the main path. That leaves this run as a pure BACKSTOP — the wake of a
    // binding born parked whose observation never landed, which is the only way `boxMeasured` can
    // still be false by now.
    if (engine.rectCache) {
      if (!engine.observerSizing) {
        for (const binding of created) {
          if (!binding.dormant) readBoxInto(binding, engine.stats);
        }
      }
      for (const binding of woken) {
        if (!binding.boxMeasured) readBoxInto(binding, engine.stats);
      }
    }

    // PASS 3 — WRITE. Size each new canvas from the box just measured (no read), then observe it and
    // arm its texture hooks. Sizing goes through the engine (not a captured ratio) so a create under
    // a live `setRenderScale` — or under a frozen-mode pin — uses the ratio in force at that moment.
    //
    // On the observer path nothing has been measured, so `sizeCanvasOrDefer` DEFERS every create and
    // the sizing+mount happens in the observer callback instead. `observeBinding` is therefore the
    // step that starts a new binding's life, not just the step that keeps it current.
    let awaitingFirstBox = false;
    for (const binding of created) {
      // BEFORE the sizing, which is where a freeze-at-mount binding claims its still and a claim
      // needs swap state to attach to. Harmless for every other binding: `attach` writes no
      // geometry, and the quiet window it starts here instead of three statements later is a
      // fraction of a millisecond of a window measured in seconds.
      attachSurfaceSwap(binding);
      sizeCanvasOrDefer(engine, binding);
      observeBinding(binding);
      if (!binding.mounted && !binding.dormant) awaitingFirstBox = true;
      // Born parked: arm the expiry sweep, so a node that is mounted already-occluded and never
      // uncovered still hands its canvas back (`sweepDormant`) instead of being kept forever.
      if (binding.dormant) {
        binding.dormantSeq = ++dormantSeq;
        armDormantSweep();
      }
      // Last: an already-decoded texture fires this listener SYNCHRONOUSLY, and it must land on a
      // binding that is already sized and cached (see `armBindingTextures`).
      armBindingTextures(binding, engine, loop.scheduleRender);
    }
    // The wakes' owed syncs, in the same write phase (see `syncDormant`): however many re-sizes,
    // renderScale steps and observer deliveries piled up while parked, each binding pays ONE.
    for (const binding of woken) sizeCanvas(engine, binding);
    // …and the moved budgets. `sizeCanvasOrDefer` because a PARKED binding must not be re-sized
    // behind its park (the wake pays it); a re-allocation clears the canvas, so kick the loop.
    for (const binding of rebudgeted) {
      if (sizeCanvasOrDefer(engine, binding)) changed = true;
    }
    // Anything left waiting on the observer gets a deadline (see `armMountBackstop`).
    if (awaitingFirstBox) armMountBackstop();

    // Re-assert the parked-blend neutralization on KEPT bindings. The loop's static branch parks
    // on every wake, but a host style pass can re-impose a node blend WITHOUT touching any effect
    // marker (so nothing kicks the loop); the host's own reconcile call is the heal point. Cheap:
    // one inline-style string compare per binding, no layout.
    if (parkBlend && engine.staticMode) {
      for (const binding of bindings.values()) parkBindingBlend(binding);
    }

    if (changed) loop.scheduleRender();
  };

  // ---- THE RENDERER GATE (see `effectsRenderer` in ../types) ----------------------------------
  //
  // Factories are SYNCHRONOUS and a `GPUDevice` is not, so the gate's whole job is to make the
  // asynchronous case rare and the synchronous case exact:
  //
  //   "webgl"                     → adopt WebGL here, having probed nothing.
  //   no `navigator.gpu`          → adopt WebGL here too. This is the branch that keeps every jsdom
  //                                 test and every non-WebGPU browser on the byte-identical path
  //                                 they were on before this existed, even though the DEFAULT is
  //                                 "auto" — no promise, no microtask, no surface-less window.
  //   device already settled      → adopt (or decline) here, synchronously. Page-wide memos make
  //                                 this the answer for every runtime after the first.
  //   otherwise                   → PENDING: bindings are created, sized and mounted with no
  //                                 surface, drawing nothing, until the device resolves and
  //                                 `adoptBackend` hands each one a surface + its textures.
  //
  // Every failure is SILENT and lands in the stats: `webgpuFallbacks`, `webgpuFallbackReason`.
  let gpuShared: WebgpuShared | null = null;
  let unsubscribeDeviceLost: (() => void) | null = null;
  // THIS runtime's first fallback reason. The module-level latch in `../webgpu/device` is page-wide
  // (one device, one story), but a runtime pinned to `"webgl"` must not report a reason it never
  // hit, so the stat is sourced from here.
  let fallbackReason: WebgpuFallbackReason | null = null;

  // Hand every surface-less binding a surface from `backend` (and the textures that go with it).
  // This is the ONLY way a binding acquires one after its create, and it is a HAND-OVER, not a
  // re-create: the canvas element, its box, its mount, its simulation and its frozen state are all
  // renderer-agnostic and survive untouched.
  const adoptBackend = (backend: ParticleRenderBackend): void => {
    if (disposed || engine.backend === backend) return;
    engine.backend = backend;
    const refused: HTMLElement[] = [];
    for (const binding of bindings.values()) {
      if (binding.surface) continue;
      // TEXTURES FIRST, and for every binding — surface or not. A binding whose surface is deferred
      // still needs them: the sprite's decoded size is a term in its frame key, so a binding that
      // keyed itself without them would name a frame nobody else names.
      const textures = backend.resolveTextures(binding.config);
      binding.texture = textures.texture;
      binding.lut = textures.lut;
      binding.mask = textures.mask;
      if (surfaceDeferred(engine, binding)) {
        // FREEZE AT MOUNT: this binding owns no surface on purpose (see `surfaceDeferred`). What the
        // adoption owes it is its textures, above, and the capture-hook decision it could not make
        // while the backend was unknown; the surface itself belongs to `claimFrozenMount` (at its
        // first sizing) or to `liveifyBinding`. A binding already standing on a claimed still is not
        // even sized — its canvas is deliberately storeless, and `dirty` would put the watchdog on it.
        attachSurfaceSwap(binding);
        if (!binding.stillMounted) {
          binding.dirty = true;
          sizeCanvasOrDefer(engine, binding);
        }
        armBindingTextures(binding, engine, loop.scheduleRender);
        continue;
      }
      if (!ensureSurface(engine, binding)) {
        refused.push(binding.node);
        continue;
      }
      // The canvas has never been painted, and the sprite's real dimensions (once they land) move
      // the pad — so re-size before the first draw rather than after it.
      binding.dirty = true;
      attachSurfaceSwap(binding);
      sizeCanvasOrDefer(engine, binding);
      // Last, and only now: an already-decoded texture fires this listener SYNCHRONOUSLY, and it
      // must land on a binding that is already sized (see `armBindingTextures`).
      armBindingTextures(binding, engine, loop.scheduleRender);
    }
    for (const node of refused) {
      const binding = bindings.get(node);
      if (!binding) continue;
      unobserveBinding(binding);
      disposeBinding(binding, backend);
      bindings.delete(node);
    }
    // A canvas that refuses a WebGPU context refuses it FOREVER (a canvas holds one context type for
    // its whole life), and one that refuses is evidence about the build, not about that element — so
    // take the whole runtime back to WebGL and let the reconcile below rebuild the refused nodes on
    // fresh canvases. On WebGL a refusal is the long-standing "no 2D context" case: no binding.
    if (refused.length > 0 && backend.kind === "webgpu") {
      fallbackToWebgl("context-refused");
      reconcile();
      return;
    }
    // The loop may be parked (frozen mode always, live mode whenever nothing was alive), and these
    // bindings have never drawn.
    loop.scheduleRender();
  };

  // Adopt WebGL, silently, counting it. THE one place a fallback happens, so the counter and the
  // reason can never disagree.
  const fallbackToWebgl = (reason: WebgpuFallbackReason): void => {
    if (disposed || engine.backend?.kind === "webgl") return;
    engine.stats.webgpuFallbacks++;
    if (fallbackReason === null) fallbackReason = reason;
    latchWebgpuFallbackReason(reason);
    adoptBackend(engine.glBackend);
  };

  // A lost device takes every WebGPU surface with it — and the canvas ELEMENTS too, because a canvas
  // that has held a webgpu context can never yield a 2d one, so the WebGL rebuild cannot reuse them.
  // Disposing each binding removes its canvas and restores its static preview; `reconcile()` then
  // builds every node again from scratch, on WebGL, with NEW canvas elements.
  //
  // The simulations restart (a burst replays, an ambient emitter pops once). That is the accepted
  // trade for a rare event: preserving them would mean re-homing state onto surfaces that no longer
  // exist, and a device loss has already dropped a frame or several.
  const handleDeviceLost = (): void => {
    if (disposed || engine.backend?.kind !== "webgpu") return;
    for (const binding of bindings.values()) {
      unobserveBinding(binding);
      disposeBinding(binding, engine.backend);
    }
    bindings.clear();
    // Bake donors go too, and BEFORE the fallback re-points `engine.backend`: their surfaces belong
    // to the device that was just lost, so their pending readbacks can only fail, and a release
    // after the fallback would hand a WebGPU surface to the WebGL backend to dispose.
    for (const binding of [...donors]) releaseDonor(binding, false);
    fallbackToWebgl("device-lost");
    reconcile();
  };

  const adoptWebgpu = (
    shared: WebgpuShared,
    backend: ParticleRenderBackend,
  ): void => {
    if (disposed) return;
    gpuShared = shared;
    unsubscribeDeviceLost = onWebgpuDeviceLost(handleDeviceLost);
    adoptBackend(backend);
  };

  // The PENDING resolution: await the device, then its pipelines, then adopt — or fall back with
  // whatever `../webgpu/device` classified the failure as. A runtime disposed while this was in
  // flight does nothing at all (its bindings are gone; there is nothing to hand a surface to).
  const resolveWebgpu = async (): Promise<void> => {
    const shared = await acquireWebgpuDevice();
    if (disposed) return;
    if (!shared) {
      fallbackToWebgl(webgpuFallbackReason() ?? "no-adapter");
      return;
    }
    const backend = await createWebgpuParticleBackend(shared);
    if (disposed) return;
    if (!backend) {
      fallbackToWebgl(webgpuFallbackReason() ?? "pipeline-error");
      return;
    }
    adoptWebgpu(shared, backend);
  };

  const openGate = (): void => {
    const wanted = options.effectsRenderer ?? "auto";
    if (wanted === "webgl") {
      engine.backend = engine.glBackend;
      return;
    }
    if (!hasWebgpuApi()) {
      fallbackToWebgl("no-navigator-gpu");
      return;
    }
    const device = peekWebgpuDevice();
    if (device === null) {
      // Already tried and unavailable (or poisoned by an earlier device loss) — no second probe.
      fallbackToWebgl(webgpuFallbackReason() ?? "no-adapter");
      return;
    }
    if (device === undefined) {
      void resolveWebgpu();
      return;
    }
    const backend = peekWebgpuParticleBackend(device);
    if (backend) {
      adoptWebgpu(device, backend);
      return;
    }
    if (backend === null) {
      fallbackToWebgl(webgpuFallbackReason() ?? "pipeline-error");
      return;
    }
    // Device in hand, pipelines still compiling (this runtime is the second one on the page, in the
    // same turn as the first): finish asynchronously.
    void resolveWebgpu();
  };
  openGate();

  // The binding at `node`, or the first one UNDER it — a host that owns a subtree should not have to
  // know which of its descendants gsw bound (the `invalidateStaticSurfaces` convention).
  const bindingAt = (node: HTMLElement): ParticleBinding | null => {
    const exact = bindings.get(node);
    if (exact) return exact;
    for (const binding of bindings.values()) {
      if (node.contains(binding.node)) return binding;
    }
    return null;
  };

  // Live resolution retune (adaptive quality): change the engine pixel ratio and re-size every binding's
  // canvas; the running simulations are untouched (only the canvas density changes). drawBinding reads
  // the ratio live, so the next frame draws at the new density.
  const setRenderScale = (scale: number): void => {
    if (disposed) return;
    const next = effectivePixelRatio(scale);
    if (next === engine.pixelRatio) return;
    engine.pixelRatio = next;
    // PINNED + frozen: the pin decides the backing store, so nothing re-sizes — re-sizing would clear
    // every parked canvas and force the whole frozen fleet to re-warm + re-draw, on a device that is
    // stepping quality DOWN. The new ratio is recorded above and applies to live bindings the moment
    // frozen mode is left (or the pin is cleared).
    if (pinnedRatio(engine) !== undefined) return;
    // Reflow-free: only the DENSITY moved, so every binding sizes from its cached box (see
    // `syncCanvasSize`) and this loop reads no layout at all. Before the cache it was one forced
    // layout PER BINDING, on the exact path an adaptive consumer takes when it is already struggling.
    // A PARKED binding sizes nothing: its canvas is hidden, so re-allocating its backing store now
    // would be pure cost, and the wake collapses every step it slept through into one.
    for (const binding of bindings.values()) sizeCanvasOrDefer(engine, binding);
    loop.scheduleRender();
  };

  // Live set/clear of the frozen-mode pin. Applied immediately when the runtime is ALREADY frozen
  // (every binding re-sizes — which clears its canvas — so the loop is kicked to redraw the parked
  // spray); otherwise just recorded for the next `setStaticParticles(true)`.
  const setStaticParticlePixelRatio = (ratio: number | undefined): void => {
    if (disposed) return;
    const next = normalizeStaticPixelRatio(ratio);
    if (next === engine.staticPixelRatio) return;
    engine.staticPixelRatio = next;
    if (!engine.staticMode) return;
    // Density-only, so reflow-free — the cached box carries every binding (see `setRenderScale`),
    // and a parked one defers to its wake.
    for (const binding of bindings.values()) sizeCanvasOrDefer(engine, binding);
    loop.scheduleRender();
  };

  // Live FPS-cap retune. 0/undefined → uncapped. Re-kicks the loop so a change takes effect immediately.
  const setFps = (fps: number): void => {
    if (disposed) return;
    loop.setMinFrameTime(fps > 0 ? 1 / fps : 0);
    loop.scheduleRender();
  };

  // Live frozen-mode toggle (mirrors the shader runtime's setStaticShaders). Entering static re-arms every binding
  // for a fresh warm+freeze (so a system already mid-flight is re-warmed to a representative state) then kicks the
  // loop, which warms+draws once and parks. Leaving it resumes live simulation from the current (frozen) state. A
  // no-op if already in the requested mode.
  const setStaticParticles = (value: boolean): void => {
    if (disposed || value === engine.staticMode) return;
    engine.staticMode = value;
    // With a pin configured, the mode flip IS a backing-store change (pinned ratio ⇄ live
    // devicePixelRatio × renderScale), so every canvas re-sizes here (the loop kick below redraws
    // them). With no pin the effective ratio is the same in both modes and no sizing pass runs — as
    // before. Density-only, so reflow-free — the cached box carries every binding (see
    // `setRenderScale`).
    if (engine.staticPixelRatio !== undefined) {
      for (const binding of bindings.values())
        sizeCanvasOrDefer(engine, binding);
    }
    // Every binding is about to repaint: leaving frozen mode the surfaces ANIMATE again, and
    // entering it they are re-warmed and re-drawn. Either way a stand-in must come down NOW rather
    // than at the next paint — which a SUSPENDED binding may not reach for a long time. A
    // runtime-wide mode flip is this runtime's own decision, so nothing is blocked: each re-earns.
    for (const binding of bindings.values()) {
      binding.dirty = true;
      revertStaticImage(binding, engine.stats);
    }
    if (value) {
      for (const binding of bindings.values()) {
        // FROZEN AT MOUNT bindings are exempt, and it is not an optimization. Such a binding is
        // ALREADY warmed to the representative frame and its state was never stepped in between, so
        // re-arming it would make the frozen path warm a warmed state — a phase no key names, while
        // `pristine` still says one does. There is nothing for a mode flip to do to a system that
        // behaves identically in both modes.
        if (binding.freezeAtMount) continue;
        binding.frozen = false;
        binding.pendingWarm = false;
        // …and an already-retired burst re-earns its blank: the live loop owned this canvas in between and may
        // have left a half-drawn burst on it (`retireExpiredBurst` is a once-per-binding paint, so without this
        // those pixels would be the frozen frame forever).
        binding.burstCleared = false;
      }
    } else {
      for (const binding of bindings.values()) {
        // Pay back a warm the static-frame cache skipped (see `ParticleBinding.pendingWarm`), so the
        // resumed simulation continues from EXACTLY the state it would have had if this binding had
        // rendered its own frozen frame. Without this, a cache hit would make the unfreeze restart
        // the spray from the un-warmed post-create state — a visible pop the cache must not cause.
        if (binding.pendingWarm) {
          warmStaticParticles(binding.state);
          binding.pendingWarm = false;
          binding.frozen = true;
        }
        // Leaving the parked world: live simulation must composite EXACTLY as before this option
        // existed (dynamic modes stay byte-identical) — restore every saved node blend now, not on
        // some later tick.
        if (parkBlend) unparkBindingBlend(binding);
      }
    }
    // The cap does not apply in frozen mode (and a resume wants the full rate back), so a park
    // armed under the previous mode is stale.
    loop.cancelPark();
    loop.scheduleRender();
  };

  // Live kill switch / arm for the frozen-surface image swap. OFF disposes the swapper: every live
  // swap reverts, every object URL is released and every timer is cancelled immediately (the state
  // objects are dropped, so every swap call site goes back to being a no-op). ON builds a fresh
  // swapper — under the runtime's CONFIGURED policy, or, for a runtime left at the opt-in default,
  // the same quiet-window policy `staticParticleImages: true` means (see the interface doc) — and
  // each binding must earn its swap again. No loop kick: the quiet-window gate is measured off this
  // runtime's own paints and `attach` starts each window from here, so nothing has to be redrawn
  // for the gate to work (and redrawing a parked frozen fleet would be pure cost).
  const setStaticParticleImages = (value: boolean): void => {
    if (disposed || value === (surfaceSwapper !== null)) return;
    if (!value) {
      // Revert BEFORE the swapper goes: a revert un-hides the canvas and books the counter, while
      // the disposal that follows only drops state (a torn-down surface is gone, not handed back).
      for (const binding of bindings.values()) {
        revertStaticImage(binding, engine.stats);
      }
      // A bake donor exists only to feed this swapper, and the disposal below drops its job with the
      // queue — so nothing would ever settle it and its surface would be held until teardown.
      for (const binding of [...donors]) releaseDonor(binding, false);
      surfaceSwapper?.dispose();
      surfaceSwapper = null;
      return;
    }
    surfaceSwapper = createStaticSurfaceSwapper(
      swapPolicyFor(
        staticSurfacePolicy === false
          ? PARTICLE_QUIET_WINDOW_POLICY
          : staticSurfacePolicy,
      ),
      engine.stats,
    );
    for (const binding of bindings.values()) attachSurfaceSwap(binding);
  };

  // Host-driven revert-without-block (see `ParticleRuntime.invalidateStaticSurfaces`). With no
  // argument the swapper hands its whole set back; with elements, every binding AT or UNDER one of
  // them — a host that owns a subtree should not have to know which of its descendants gsw bound.
  const invalidateStaticSurfaces = (nodes?: Iterable<HTMLElement>): void => {
    if (disposed || !surfaceSwapper) return;
    if (!nodes) {
      surfaceSwapper.invalidate();
      return;
    }
    const targets: ParticleBinding[] = [];
    for (const element of nodes) {
      const exact = bindings.get(element);
      if (exact) {
        targets.push(exact);
        continue;
      }
      for (const binding of bindings.values()) {
        if (element.contains(binding.node)) targets.push(binding);
      }
    }
    if (targets.length > 0) surfaceSwapper.invalidate(targets);
  };

  const dispose = (): void => {
    disposed = true;
    loop.dispose();
    // Stop listening for a device loss this runtime can no longer act on (the subscription is
    // page-wide and would otherwise outlive every binding it exists to rebuild).
    unsubscribeDeviceLost?.();
    unsubscribeDeviceLost = null;
    // The park's ONE timer (see `armDormantSweep`): a disposed runtime leaves nothing armed.
    if (dormantSweepTimer !== null) {
      clearTimeout(dormantSweepTimer);
      dormantSweepTimer = null;
    }
    for (const binding of bindings.values())
      disposeBinding(binding, engine.backend);
    // Bake donors go with the runtime, unpublished. Their jobs are about to be dropped with the
    // swapper's queue, so `onSettled` will never fire for them and nothing else would ever hand
    // their surfaces back — a donor is the one thing in here that outlives its own binding map.
    for (const binding of [...donors]) releaseDonor(binding, false);
    // After every binding has released its URL ref (`disposeBinding` → `disposeStaticImage`):
    // cancels the swapper's gate/watchdog/encode timers, so a disposed runtime leaves nothing armed
    // and `staticImageUrlsLive` comes back to 0.
    surfaceSwapper?.dispose();
    surfaceSwapper = null;
    bindings.clear();
    observedBindings.clear();
    sharedObserver?.disconnect();
  };

  return {
    reconcile,
    setRenderScale,
    setStaticParticlePixelRatio,
    setFps,
    setStaticParticles,
    setStaticParticleImages,
    invalidateStaticSurfaces,
    stats: () => {
      // The two GAUGES among the counters, sampled on read (the shader runtime's contract exactly):
      // object URLs alive MODULE-wide across every runtime in the document — the leak probe — and
      // surfaces swapped right now in THIS runtime, re-derived from the swapper rather than trusted
      // incrementally, so the "is it engaged?" measurement cannot drift if a revert path is missed.
      engine.stats.staticImageUrlsLive = liveStaticImageUrlCount();
      engine.stats.staticImagesLive = surfaceSwapper?.liveSwapCount() ?? 0;
      // The still pool's two gauges, on exactly the same contract — DOCUMENT-wide (the pool is
      // shared by every swapper in the page, like the key registry) and re-read here rather than
      // tracked, because nothing in this runtime is told when the pool evicts. Left unsampled they
      // would report 0 forever, which is worse than absent: 0 retained bytes is what a working
      // budget and a broken one both look like from a dashboard.
      const pool = staticStillPoolStats();
      engine.stats.staticStillRetainedEntries = pool.entries;
      engine.stats.staticStillRetainedBytes = pool.bytes;
      // …and this runtime's own donors, counted rather than trusted (see `donateStill`).
      engine.stats.staticStillDonors = donors.size;
      // …and the park's own gauge, on the same contract: counted from the binding set, so it can
      // never drift from what is really hidden right now.
      let parked = 0;
      for (const binding of bindings.values()) if (binding.dormant) parked++;
      engine.stats.dormantLive = parked;
      // The renderer gauge, re-derived rather than remembered: a runtime can change backend once
      // (WebGPU → WebGL, on a device loss), and "pending" is a state a reader must be able to see.
      engine.stats.renderer = engine.backend?.kind ?? "pending";
      engine.stats.webgpuFallbackReason = fallbackReason;
      // Counters that live on the BACKEND (submits) and on the page-wide DEVICE (losses, errors),
      // sampled here so a fallback leaves the last real reading standing instead of zeroing it.
      const submits = engine.backend?.submits?.();
      if (submits !== undefined) engine.stats.webgpuSubmits = submits;
      if (gpuShared) {
        engine.stats.webgpuDeviceLosses = gpuShared.counters.deviceLosses;
        engine.stats.webgpuErrors = gpuShared.counters.gpuErrors;
      }
      return engine.stats;
    },
    captureNodePixels: async (
      node: HTMLElement,
    ): Promise<Uint8Array | null> => {
      if (disposed) return null;
      const backend = engine.backend;
      // Absent on WebGL (see `ParticleRuntime.captureNodePixels`): its canvas is readable directly.
      if (!backend?.captureSurface) return null;
      const binding = bindingAt(node);
      if (!binding?.surface) return null;
      const w = binding.canvas.width;
      const h = binding.canvas.height;
      if (w < 1 || h < 1) return null;
      // The SAME pack loop and the SAME draw options the live path uses, so what is captured is the
      // frame the canvas is showing and not a second interpretation of the same state. Unprofiled:
      // a capture is a diagnostic, not a frame anyone is paying for.
      packBinding(binding, null);
      return backend.captureSurface(
        binding.surface,
        binding.buffer,
        drawOptionsFor(binding, w, h),
      );
    },
    dispose,
  };
}

/** THE SIZING LAW's output for one binding at one backing ratio — where the canvas goes (CSS px) and
 *  how many device pixels back it. Split out from the writes so `claimFrozenMount` can have the
 *  numbers, and therefore the FRAME KEY, without writing `canvas.width` or asking for a context: the
 *  whole claim rests on the key it computes being the one the ordinary path would have produced, and
 *  a second copy of this arithmetic is exactly how those two would drift. */
interface CanvasGeometry {
  pad: ParticleExtents;
  left: number;
  top: number;
  cssW: number;
  cssH: number;
  /** Backing-store size, and the ratio really granted (see `ParticleBinding.drawRatio`). */
  w: number;
  h: number;
  ratio: number;
}

// Resolve one binding's canvas geometry. READ-ONLY of the DOM apart from the one `clientWidth` tier
// below (which books itself through `readBoxInto`); it writes nothing.
function measureCanvasGeometry(
  binding: ParticleBinding,
  dpr: number,
  contentRect: { width: number; height: number } | undefined,
  // Longest-edge ceiling for the resulting backing store, passed ONLY on the pinned static path
  // (see `staticParticlePixelRatio`). Undefined ⇒ unbounded, which is what the live path always was.
  maxDim: number | undefined,
  stats: ParticleRuntimeStats | undefined,
  // `particleRectCache` (default on): may a previously measured box be REUSED? See `readBoxInto`.
  cacheBox: boolean,
  // `particleTravelExtents` (default on): size the margin from where the particles actually GO
  // (`./extents`), capped by the host's visible rect. False ⇒ the symmetric sprite+emission pad, i.e.
  // byte-identical geometry to before that law existed.
  travelExtents = true,
): CanvasGeometry {
  // Box (content-box) size, in priority order that AVOIDS a forced reflow after creation — the
  // shader runtime's order (`../webgl/runtime` `syncCanvasSize`), which this runtime lacked:
  //   1. the ResizeObserver-provided contentRect (already measured off the main path — no reflow), else
  //   2. the box we last measured (a renderScale step, a pin change, a frozen-mode flip and a
  //      texture-load re-pad all change the DENSITY or the pad, never the element box, so the cached
  //      size is still valid — reusing it is what keeps those paths reflow-free), else
  //   3. a single clientWidth/clientHeight layout read — on creation, when nothing has measured yet.
  // Particle self-layers have no padding, so content-box width == clientWidth. Whatever was resolved
  // is cached, and the observer refreshes it on any real box change.
  let boxW: number;
  let boxH: number;
  if (contentRect) {
    boxW = contentRect.width;
    boxH = contentRect.height;
    binding.boxW = boxW;
    binding.boxH = boxH;
    binding.boxMeasured = true;
  } else if (cacheBox && binding.boxMeasured) {
    boxW = binding.boxW;
    boxH = binding.boxH;
  } else {
    readBoxInto(binding, stats);
    boxW = binding.boxW;
    boxH = binding.boxH;
  }
  // Grow the canvas beyond the node box so what the system draws isn't clipped to the (often tiny,
  // point-emitter) box: sprite size, emission spread and — this is the part the symmetric pad never
  // modelled — how far the particles TRAVEL. Four numbers, one per side, capped by the part of this
  // element's local space the host says can be seen. See `./extents` for the whole law; the canvas is
  // positioned at `-left`/`-top` within the `overflow: visible` self-layer and the draw offsets by
  // the same two (`packBinding`).
  //
  // The box is resolved FIRST because the visible-rect budget is measured from the box's edges.
  const cfg = binding.config;
  const pad = travelExtents
    ? particleCanvasExtents(
        cfg,
        binding.texture,
        binding.visibleRect
          ? visibleAllowance(binding.visibleRect, {
              width: boxW,
              height: boxH,
              offsetX: cfg.boxOffsetX,
              offsetY: cfg.boxOffsetY,
            })
          : null,
      )
    : symmetricCanvasExtents(cfg, binding.texture);
  const cssW = boxW + pad.left + pad.right;
  const cssH = boxH + pad.top + pad.bottom;
  // DENSITY = the runtime-wide `dpr` the caller resolved (live `devicePixelRatio × renderScale`, or
  // the frozen `staticParticlePixelRatio` pin) TIMES this ONE surface's magnification as the host
  // stated it (`SURFACE_PIXEL_RATIO_ATTR`) — the shader runtime's `syncCanvasSize`, same law, same
  // reasoning. An un-stamped binding carries exactly `1`, so its size is what it always was.
  //
  // Folded in HERE rather than at the call site so `claimFrozenMount` — which reaches
  // `measureCanvasGeometry` directly to name a frame without allocating one — cannot name a frame at
  // a density the ordinary path would not have used.
  const { w, h, ratio } = backingStoreSize(
    cssW,
    cssH,
    dpr * binding.pixelRatioScale,
    maxDim,
  );
  return {
    pad,
    // Anchor the canvas at `-pad.left`/`-pad.top` (so the draw origin sits at the node-box corner),
    // then slide the WHOLE canvas by the spec's `boxOffset` so its emission center lands where the
    // CSS-<span> fallback puts it (`self-layer + -rect`), instead of the corner (→ top-left).
    // The canvas moves with its particles, so nothing clips. See core's particles/config.ts.
    left: Math.round(-pad.left + cfg.boxOffsetX),
    top: Math.round(-pad.top + cfg.boxOffsetY),
    cssW,
    cssH,
    w,
    h,
    ratio,
  };
}

// The BOX half of a sizing: four inline style writes, no backing store. This is everything a frozen
// stand-in needs from the canvas (it copies `cssText` verbatim), which is why it is separable at all.
function writeCanvasBox(binding: ParticleBinding, geom: CanvasGeometry): void {
  const style = binding.canvas.style;
  style.left = `${geom.left}px`;
  style.top = `${geom.top}px`;
  style.width = `${geom.cssW}px`;
  style.height = `${geom.cssH}px`;
}

// Size + place a binding's overlay canvas. Returns TRUE when the backing store was reallocated —
// which CLEARS the canvas, so the caller must make sure something redraws it (see the runtime's
// shared ResizeObserver; `setRenderScale` and the texture-load hook already schedule a render).
function syncCanvasSize(
  binding: ParticleBinding,
  dpr: number,
  contentRect?: { width: number; height: number },
  maxDim?: number,
  stats?: ParticleRuntimeStats,
  cacheBox = true,
  travelExtents = true,
): boolean {
  const geom = measureCanvasGeometry(
    binding,
    dpr,
    contentRect,
    maxDim,
    stats,
    cacheBox,
    travelExtents,
  );
  binding.pad = geom.pad;
  // The ratio the canvas REALLY got (= `dpr` unless the pinned-path clamp bit). `drawBinding` scales
  // its particle geometry by this, so a clamped canvas draws a smaller spray that still fits instead
  // of one sized for the backing store it asked for.
  binding.drawRatio = geom.ratio;
  writeCanvasBox(binding, geom);
  let cleared = false;
  if (binding.canvas.width !== geom.w) {
    binding.canvas.width = geom.w;
    cleared = true;
  }
  if (binding.canvas.height !== geom.h) {
    binding.canvas.height = geom.h;
    cleared = true;
  }
  return cleared;
}
