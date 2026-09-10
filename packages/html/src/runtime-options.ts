import type { UnsupportedRenderReporter } from "./diagnostics";
import type { EffectsLoopPacing } from "./effects-loop-pacing";
import type { StaticSurfaceOption } from "./surface-image-swap";
import type { GodotEffectRenderInfo, GodotHtmlRenderOptions } from "./types";

/** Browser effect hosting controls, separate from HTML model projection. */
export interface GodotHtmlRuntimeOptions
  extends Pick<
    GodotHtmlRenderOptions,
    "enableWebglShaders" | "enableParticles"
  > {
  // The HOST attaches (and reconciles) the live WebGL shader + particle runtimes
  // itself — e.g. a persistent `createWebglShaderRuntime` kept across re-renders.
  // The built-in per-render attach in `GodotSceneView`/`mountHtmlScene` then skips
  // its own runtimes (which would double-bind every node: two stacked canvases,
  // translucent shader output painted twice). Attribute stamping (`material.ts` /
  // `visual-2d.ts`) is unaffected — the enable flags above still control that.
  externalRuntimes?: boolean;
  // Fetch a `.gdshader` source by its resource path and/or uid (the runtime
  // transpiles + compiles it). Required for `enableWebglShaders` to do anything;
  // a node whose source is unavailable or unsupported stays on the CSS/SVG paint.
  resolveShaderSource?: (
    path?: string,
    uid?: string,
  ) => Promise<string | undefined> | string | undefined;
  // Per-system cap on simulated/drawn particles (safety valve against a pathological
  // `amount`). Defaults to 2048.
  particleMaxInstances?: number;
  // Optional FPS cap for the particle runtime's step+draw loop. Live retune:
  // `ParticleRuntime.setFps`. Background ambient emitters
  // (screen-filling, slow-moving) don't need 60fps; a cap (e.g. 30) roughly halves the per-frame
  // draw cost. 0/undefined → uncapped (every rAF).
  particleFps?: number;
  // Cache each particle binding's measured self-layer content box instead of re-reading
  // `clientWidth`/`clientHeight` every time its canvas is (re-)sized. ON by default.
  //
  // That read is a FORCED SYNCHRONOUS LAYOUT: it follows the canvas insert, the preview hide and the
  // canvas style writes the same pass just made, so the browser must flush style+layout before it can
  // answer. Measured on a live combat scene it was ~all of the document's `get clientWidth` self-time
  // (468 forced layouts / 332 ms over 9.6 s), because a reconcile that mounts N new systems paid one
  // flush per system and every fleet re-size loop paid one per binding. With the cache a binding reads
  // its box ONCE, at create, inside a batched measure pass; every later size — an adaptive
  // `renderScale` step, a frozen-mode pin change, a texture-load re-pad — reuses it, and the runtime's
  // shared ResizeObserver refreshes it for free from the `contentRect` it has already measured off the
  // main path. This is exactly how the sibling WebGL shader runtime has always sized its canvases.
  //
  // Set false as a kill switch: every sync re-reads the element, i.e. the read-every-time behaviour
  // from before the cache existed. `ParticleRuntime.stats().boxReads` counts the reads either way.
  // (Scope: this switches the CACHE only. A reconcile always builds every new canvas before it
  // measures anything — that phasing changes no value the runtime computes, only when the writes
  // happen, so it is not on a switch.)
  particleRectCache?: boolean;
  // Take a NEW particle binding's first self-layer box from the runtime's shared ResizeObserver's
  // INITIAL delivery instead of a create-time `clientWidth`/`clientHeight` read. ON by default;
  // requires `particleRectCache` (the box cache is where a delivered `contentRect` lands) and a real
  // `ResizeObserver`, so a jsdom/SSR environment always takes the read path.
  //
  // `particleRectCache` cut this runtime's forced layouts to one per binding CREATED — a floor, not a
  // zero, and on a live phone trace that floor was the single largest remaining forced-layout cost in
  // the client (191 ms of `get clientWidth`, essentially all of it in the create measure pass). The
  // floor exists only because the runtime asked the browser for the box on the main thread. The
  // observer has already measured it during the browser's OWN layout step, so a create can simply
  // wait for it: `reconcile` measures nothing, and `stats().boxReads` settles at 0.
  //
  // The cost is one frame. A new binding's canvas is not inserted until it has a real box (an unsized
  // canvas is a 300x150 default box, a wrong picture and an unconditional compositor layer), so its
  // first particle frame lands one browser frame later — the static CSS preview is already hidden by
  // then, so what shows for that frame is nothing, not a stale preview. Fine for the ambient emitters
  // and one-shot bursts this runtime draws; set false if a consumer needs the first frame to be
  // synchronous with the mount.
  //
  // PORTABILITY. Chrome delivers an initial observation for every newly observed target, 0x0
  // included — which is the load-bearing case, since a particle self-layer is routinely 0x0 (a Node2D
  // has no rect; the canvas is entirely sprite/emission `pad`). The spec only guarantees a delivery
  // when the size DIFFERS from the last-reported one, initially 0x0, so a strict engine might never
  // report one at all. A binding still unmounted two frames after its reconcile is therefore swept
  // and sized the old way; on Chrome that sweep finds nothing and reads no layout.
  particleObserverSizing?: boolean;
  // PARK a particle binding whose subtree the host has suspended (`data-godot-effects-suspended`)
  // instead of only freezing its simulation: hide its canvas, defer every `sizeCanvas` it is owed
  // to the wake, and dispose it outright after ~`DORMANT_DISPOSE_SECONDS` still parked. ON by
  // default — this is the particle sibling of the WebGL runtime's `data-godot-shader-dormant`
  // contract (`./shader-dormant`), which has no switch at all.
  //
  // WHY IT MATTERS. Suspending stopped the CPU cost but not the GPU one: every binding owns a
  // `<canvas>`, which is an UNCONDITIONALLY promoted compositor layer, so an occluded system kept
  // its layer, its render surface and its backing store for as long as the node stayed mounted. In
  // a live combat trace the discard→draw shuffle cost tracked what was standing on screen rather
  // than what changed (an 85-byte delta costing 95 ms), with `Commit` self-time up 4.8x, 401
  // layers created against 61 deleted, and GPU-process memory climbing monotonically 148 → 276 MB.
  // Hiding the canvas is what actually drops the layer and hands the memory back.
  //
  // WHY IT IS DEFAULT-ON. It needs no new signal and makes no guess of its own: the host has
  // already said this subtree is occluded/off-screen, and `./effects-suspend` is explicit that
  // nothing there is visible. (Contrast `staticParticleImages`, which is opt-in precisely because
  // a quiet WINDOW is a cadence only the host can know.) The cost of being wrong is bounded and
  // reversible — the wake un-hides and redraws.
  //
  // SET FALSE IF your suspend stamp is LOOSER than "invisible" (e.g. you suspend a subtree behind
  // a translucent overlay, or one that is merely idle): a parked system does not show its last
  // frame, it shows nothing. False restores the pre-park behaviour exactly — `dormant` stays false
  // for every binding, no canvas `display` is ever written, the expiry sweep never arms, and a
  // suspended canvas keeps its last drawn frame as before. Probe it with
  // `ParticleRuntime.stats()`: `dormantLive` (parked right now), `dormantParks`, `dormantWakes`,
  // `dormantDisposes`.
  particleDormant?: boolean;
  // Size each particle system's overlay canvas from where its particles actually TRAVEL — four
  // per-side margins instead of one symmetric pad — capped by the part of the node's own local space
  // the host says is visible. ON by default.
  //
  // WHY. A `GPUParticles2D` is a POINT: its node box is zero-size and the spray happens entirely
  // outside it, so the canvas has always been the box grown by a margin. That margin modelled how big
  // one sprite is and how far apart the particles are BORN — and nothing about where they GO. Every
  // system therefore got a SQUARE canvas centred on its node origin, and anything that travelled was
  // cropped at the square's edge, hard, with the backing store as the cut line (there is no CSS clip
  // to relax). Measured on a chest's gold-coin burst: a 710x710 canvas over particles that fly
  // ~1264px sideways and fall ~2500px — a rectangle visibly cut out of the screen. Velocity, spread,
  // gravity, acceleration, damping, orbit and lifetime were all on the wire and none of them were
  // read. `./particles/extents.ts` now reads them.
  //
  // THE VISIBLE RECT is how this stays affordable. Travel bounds alone are unbounded in principle, so
  // a host that knows which part of an element's local space can be seen stamps it as
  // `data-godot-particle-visible-rect="x,y,width,height"` on the particle node, and the margin is
  // clamped to it (re-read per reconcile; a change RE-SIZES the canvas and never re-creates the
  // binding, so a moving emitter keeps its running simulation). Without the attribute the margin is
  // capped per side at the same 1024 the symmetric pad always was, so the worst-case canvas is
  // unchanged — but a far-travelling system on a host that stamps nothing will allocate more than it
  // used to. The floor is the symmetric pad itself: this law can only ever GROW a canvas, never
  // shrink one, whatever the travel math or the clamp say.
  //
  // SET FALSE as the kill switch: the margin is `spriteExtentPad + emissionExtentPad` on all four
  // sides again, the attribute is never read, and every canvas geometry (and every frozen-frame key)
  // is byte-identical to the pre-directional one.
  particleTravelExtents?: boolean;
  // Frozen (single-shot) mode for the particle runtime, mirroring `staticShaders`. Live toggle:
  // `ParticleRuntime.setStaticParticles`. Each system is
  // WARMED to a representative mid-flight state, drawn ONCE, then the loop self-parks (no per-frame
  // simulate/draw). The frozen spray of particles stays on-screen at ~zero ongoing cost. A re-triggered
  // system (spec/epoch change) or a newly mounted node is re-warmed and re-frozen. Default false (live sim).
  staticParticles?: boolean;
  // Stop drawing a FROZEN one-shot burst once its own active window has elapsed (`staticParticles` mode only).
  // ON by default.
  //
  // WHY. `staticParticles` warms each system to a representative mid-flight frame and parks it FOREVER. For an
  // ambient emitter that is exactly right. For a ONE-SHOT it is not: a one-shot is a BURST, and in animated
  // mode this runtime already ends it by itself — the sim clears `emitting` after one cycle, the last particle
  // dies at `lifetime * (2 - explosiveness)` (Godot's own `active_time`), and the canvas ends BLANK. This
  // restores that same endpoint for the frozen path, so the two modes agree on what a finished burst looks
  // like. Without it the only thing that can ever retire the frame is the host's `emitting` flag, and a host
  // can get it stuck: the case this was built for is a game-side visual freeze that left Godot's `Emitting`
  // latched true on a cluster of one-shot VFX, so the browser drew a permanent burst over UI the game itself
  // was showing bare.
  //
  // MEASURED FROM FIRST SIGHT. The client cannot know when the host started the burst — it sees only "this
  // spec says one_shot + emitting". One full active window from the moment this runtime first saw the binding
  // is precisely what the burst itself would do, so legitimate transients (hit sparks, card flourishes) still
  // show for their natural life; only a burst that outlives its own window is dropped. A re-triggered burst
  // arrives as a spec change, which re-creates the binding and therefore restarts the window.
  //
  // SET FALSE to restore the previous behaviour exactly: no binding is ever retired and a frozen one-shot's
  // warmed frame is parked for as long as its node is mounted. Worth doing if your host deliberately uses a
  // one-shot spec as a STILL (authoring a permanent decoration as an un-simulated burst), since this option
  // reads that as a burst that should have ended.
  staticParticleOneShotExpiry?: boolean;
  // OPT-IN pinned backing-store ratio for FROZEN particle bindings (`staticParticles` mode only) — the exact
  // sibling of `staticShaderPixelRatio`, same rationale and same clamp (`MAX_PINNED_BACKING_DIM`, longest
  // edge, aspect preserved). The particle draw scales its instance geometry by the SAME ratio the canvas was
  // sized at, so a pinned system draws its sprites at the pinned density, not the live one. Unset ⇒ frozen
  // bindings size exactly like live ones (today's behavior). Live retune:
  // `ParticleRuntime.setStaticParticlePixelRatio`.
  staticParticlePixelRatio?: number;
  // PARKED-canvas blend neutralization for `staticParticles` mode. A particle node commonly carries a
  // non-normal CSS `mix-blend-mode` (additive VFX → `plus-lighter`, via `material.ts` or a host's own
  // style pipeline), and each such element keeps a STANDING compositor blend render surface — an
  // offscreen render pass per composited frame — even while the parked canvas never changes (measured
  // dominant on a GPU-bound phone: parked particle fleets owned most of the scene's blend surfaces).
  // The live canvas does not need it for correctness: additive systems are resolved to source-over-
  // complete pixels in the canvas itself (core's `particles/render-webgl.ts` resolve pass — the accumulated
  // `light` premultiplied against peak-channel coverage, "the closest source-over approximation of
  // Godot's pure `light + dst`"). With this option, a binding PARKED in static mode forces the host node's inline
  // `mix-blend-mode` to `normal` and restores the prior value the moment it unparks (animated resume,
  // dispose, mode off). Blend-vs-normal differs only by the `dst * (1 - coverage)` term, so this is a
  // fidelity trade the resolve pass was designed for — verify visually on additive-heavy scenes.
  // Default false: byte-identical behavior.
  parkStaticParticleBlend?: boolean;
  // Show a FROZEN particle surface as an `<img>` of its own drawn frame instead of its `<canvas>` —
  // the particle sibling of `staticShaderImages`, running the same mechanism
  // (`./surface-image-swap`) for the same measured reason: a canvas that never changes still costs
  // a compositor layer, a blend render surface and per-frame GPU fill. Particles are usually the
  // LARGER half of that population downstream (33 of 45 effect canvases in one measured combat
  // scene), so a shader-only swap leaves most of the win on the table.
  //
  // DEFAULT FALSE — opt-in, unlike the shader option, and the mapping of `true` differs too:
  //
  //   `true` ⇒ `{ gate: { kind: "quiet-window" } }` with the module defaults
  //     (`DEFAULT_QUIET_WINDOW_MS`, and `DEFAULT_SURFACE_WATCHDOG_MS` — the quiet-window gate ships
  //     with its watchdog). Deliberately NOT the `content-key` gate that `staticShaderImages: true`
  //     means: that gate swaps on N consecutive unchanged observations and takes its second clock
  //     from `noteStaticImageReconcile`, which the particle runtime never calls — a frozen system
  //     paints ONCE and then its loop parks, so the count could never get there.
  //
  // FRAMES ARE NAMED. Within the quiet window, a paint whose frame IS a pure function of its
  // static-frame key (a pristine system whose textures have decoded) reports that key, so: N
  // identical systems share ONE encode and ONE object URL; a cache-hit re-blit re-states the frame
  // its `<img>` is already showing instead of thawing it; and a host may pin `gate.keyedQuietMs: 0`
  // to freeze such a surface the instant it paints. A live-simulating system, an undecoded texture
  // and an expired-burst blank all stay KEYLESS and earn nothing but the plain window. See
  // `notePaint` in `./particles/runtime` for the whole contract, and the swap module's KEYED-OR-QUIET
  // section for what a key a host cannot honour would cost.
  //   `false` / unset ⇒ the mechanism is OFF: no swap state, no timers, no encodes, and every
  //     binding takes exactly the path it took before the swap existed.
  //   A `StaticSurfacePolicy` object supplies the policy in full: the quiet window length, the
  //     watchdog cadence, encode pacing, a `canFreezeSurface` host veto, and injectable
  //     clock/timer seams.
  //
  // WHY OPT-IN. The only gate a keyless surface can ever satisfy is `quiet-window`, and a quiet
  // window is a cadence only the HOST knows: how long its scene really stands still, and how much
  // stale-frame exposure it accepts (that gate trades away the content-key invariant and leans on
  // the watchdog's observable proxies). gsw will not guess that for every consumer, so it stays off
  // until asked. Live arm/kill switch: `ParticleRuntime.setStaticParticleImages`.
  //
  // ON A WEBGPU BINDING the swap runs through a capture READBACK rather than a canvas read (that
  // canvas cannot be read — see `effectsRenderer`); the frame is otherwise identical and the extra
  // cost is visible as `staticImageCaptureMs`.
  staticParticleImages?: StaticSurfaceOption;
  // FREEZE A NAMED PARTICLE BINDING AT MOUNT — warm it once, draw it once, never simulate it, and
  // where this document has ALREADY encoded that frame, mount it as an `<img>` with no canvas
  // context and no backing store at all. Default false: byte-identical behaviour.
  //
  // WHICH BINDINGS. Exactly the ones the swap policy's `canFreezeSurface(node, canvas)` accepts —
  // ONE predicate, two mechanisms, consulted ONCE per binding at its first sizing and never again.
  // A host that supplies no predicate is saying "all of them", which is what an absent veto already
  // means to the swap; a host that wants only some of its systems frozen must name them there.
  //
  // WHAT IT COSTS AND BUYS. A frozen-at-mount binding is skipped by the live loop entirely (no
  // simulate, no draw, and it does not hold the loop open), so a fleet of ambient emitters costs
  // nothing per frame even in a runtime that is otherwise LIVE — `staticParticles` without the
  // whole-runtime flip. What it gives up is motion: those systems show one representative frame
  // forever. The second appearance of a frame is where the real win is — with
  // `staticParticleImages` on AND `encode.stillCacheBytes` set (which is what keeps an encoded
  // frame alive after its last holder lets go), a binding whose key is already in hand mounts
  // straight to an `<img>`: nothing is simulated, drawn, allocated or encoded for it, and its
  // canvas never gets a context. Measured shape of the population this is for: two emitters per
  // card, 35 identical instances each, 2 distinct keys for 70 nodes.
  //
  // A frozen-at-mount surface takes its canvas back the moment the swap can no longer vouch for it
  // (the watchdog, a host `invalidateStaticSurfaces`, a re-size, a dormancy wake) or the runtime
  // leaves frozen mode — it builds the surface, pays the warm it skipped and draws, so nothing ever
  // uncovers a blank canvas. Probe it with `ParticleRuntime.stats()`: `staticStillCacheHits` /
  // `staticStillCacheMisses` (claims that found a still and claims that had to render),
  // `staticStillMounts` (claims that reached the screen) and `staticStillDonors` /
  // `staticStillDonorBakes` (departing bindings whose pixels were banked for their successors).
  staticParticleFreezeAtMount?: boolean;
  // Optional FPS cap for the WebGL shader runtime's rAF loop, mirroring `particleFps`. Live retune:
  // `WebglShaderRuntime.setFps`. TIME-driven
  // shaders re-render every animated frame; on a GPU-bound device a cap (e.g. 30) halves that draw
  // cost for an imperceptible change to slow pulses/scrolls. 0/undefined → uncapped (every rAF).
  shaderFps?: number;
  // How BOTH capped effect loops (shader + particle) arm their next tick. "timer" (default) PARKS
  // on a setTimeout until the cap boundary and re-enters through one rAF, so a capped loop costs
  // no wakeup on the display frames it would only skip; "raf" keeps a rAF armed every display
  // frame and skips in the tick (the pre-pacing behaviour, kept as the kill switch). Only meaningful
  // with `shaderFps`/`particleFps` — an uncapped loop arms rAF every frame either way. See
  // `./effects-loop-pacing`.
  effectsLoopPacing?: EffectsLoopPacing;
  // WHICH GPU API the live effect runtimes render with. Default `"auto"`.
  //
  //   "auto"   — use WebGPU where a real adapter exists, WebGL everywhere else. The choice is made
  //              once per runtime and is SILENT: no throw, no console noise, no visual difference
  //              beyond what the two rasterizers disagree about. Read it back from
  //              `stats().renderer` (`pending` while the device is still being acquired, then
  //              `webgpu`/`webgl`), with `webgpuFallbacks` / `webgpuFallbackReason` saying whether
  //              and why WebGL was adopted instead.
  //   "webgl"  — today's path exactly, synchronously, with no WebGPU probe at all (so
  //              `webgpuFallbacks` stays 0 — nothing was ever asked for). This is what a parity
  //              reference or a benchmark's control arm pins.
  //   "webgpu" — the SAME never-throw mechanics as "auto": a device that cannot be acquired still
  //              falls back to WebGL rather than failing to render. It differs only in intent, which
  //              is readable against the stats — a run that asked for "webgpu" and reports
  //              `renderer: "webgl"` has a `webgpuFallbackReason` to explain itself, whereas "auto"
  //              reporting the same thing is business as usual.
  //
  // WHY WEBGPU. Measured on a mid-range Android (docs/perf-harness.md S6/S7): the shipped WebGL
  // architecture renders every effect into one shared canvas and BLITS it onto each node's own 2D
  // canvas, which saturates Chrome's GPU process and halves whole-page update rates (89 → 47 Hz).
  // Rendering straight into each node's canvas — no shared canvas, no blit, one submit per frame —
  // restored 87 Hz. WebGL stays as the fallback and as the Godot-parity reference.
  //
  // WHAT DIFFERS ON WEBGPU BINDINGS. Both of the mechanisms below are 2D-canvas ones, and a WebGPU
  // canvas cannot be read back at all (`drawImage`/`toDataURL`/`toBlob` from one are blank headless
  // and pathological on Android), so neither can work the way it does on WebGL:
  //   - `staticParticleImages` / `staticShaderImages` (the surface image swap) DOES run here, since
  //     v2. It never reads the canvas: a frozen WebGPU binding is given a CAPTURE HOOK that
  //     re-renders its current frame into an offscreen texture and copies the pixels back, and the
  //     `<img>` is encoded from those. The swap's counters therefore move exactly as they do on
  //     WebGL (`staticImageSwaps`, `staticImagesLive`, `staticImageEncodes`, …), plus two that only
  //     this path books: `staticImageCaptures` and `staticImageCaptureMs`/`MaxMs`, which are kept
  //     OUT of `staticImageEncodeMs` because a GPU readback does not park the main thread the way a
  //     canvas `toBlob` does. A third, `staticImageBlankCaptures`, counts the readbacks REFUSED
  //     because they came back entirely transparent for a frame the renderer knew it had drawn —
  //     measured on real hardware under one launch mode, and a surface that hits it keeps its live
  //     canvas rather than publishing a picture of nothing (see the swap module's BLANK CAPTURES).
  //   - the frozen-frame cache that lets N identical frozen systems share one bitmap stays INERT
  //     here: it trades a redraw for a 2D blit, and there is no 2D canvas to blit into. Each WebGPU
  //     binding re-warms and re-draws its own frozen frame (cheap — the simulation is <3% of a core)
  //     and `cacheHits` stays 0.
  // Neither changes what is on screen. A runtime that falls back to WebGL gets the cache back too.
  effectsRenderer?: "auto" | "webgl" | "webgpu";
  // OPT-IN per-frame cost attribution for BOTH live effect runtimes (particle + shader). A benchmark
  // that only sees "the tick took 9 ms" cannot tell a CPU-bound simulation from a fill-bound blit, and
  // those two have opposite fixes (lower `particleFps`/`amount` vs lower `renderScale`), so the
  // particle runtime brackets its tick into CPU SIM / instance-buffer BUILD / GL SUBMIT / GL→2D BLIT
  // and the shader runtime into GL SUBMIT / BLIT. Read them from `ParticleRuntime.stats().profile`
  // and `WebglShaderRuntime.stats().profile` (see `ParticleProfile` / `ShaderProfile`).
  //
  // OFF IS OFF, AND SAYS SO. Unset/false ⇒ `stats().profile` is `null` — not an object of zeros —
  // because "not measured" and "measured, cost nothing" are different facts and a benchmark that
  // confused them would report a fantasy. Off, the hot path takes no clock reading at all (the
  // brackets are behind one hoisted null check, so a production frame pays a predictable-branch
  // compare and nothing else); on, it pays a handful of `performance.now()` calls per binding per
  // frame, which is why this is a benchmark switch and not a default.
  //
  // GL TIMES ARE SUBMIT TIMES. The GPU runs asynchronously, so `glMs` measures how long the main
  // thread spent ISSUING the draw, never how long the GPU took to execute it. A GPU-bound frame shows
  // up as back-pressure elsewhere (typically the blit), not as a large `glMs`.
  effectsProfiling?: boolean;
  // Backing-store resolution multiplier for BOTH live runtimes' per-node canvases (shader + particle).
  // Live retune: `WebglShaderRuntime.setRenderScale` / `ParticleRuntime.setRenderScale`.
  // applied on top of `devicePixelRatio`. <1 renders the WebGL effects at a lower internal resolution
  // and lets the browser upscale the (CSS-sized) canvas — a near-linear GPU fill / blit saving for
  // GPU-bound (low-end) devices, at the cost of effect sharpness. Clamped to (0, 1]; default 1.
  renderScale?: number;
  // Frozen-TIME (single-shot) mode for the WebGL shader runtime. Live toggle:
  // `WebglShaderRuntime.setStaticShaders`. Render each shader ONCE at a pinned
  // representative TIME, then stop the loop, instead of re-rendering TIME-driven shaders every frame. The
  // still frame is correct for any shader (blend is a node CSS mix-blend-mode, applied regardless of frame
  // count) at ~zero ongoing GPU cost — the low-end fallback below an animated tier. Default false (animated).
  staticShaders?: boolean;
  // The representative TIME (seconds) the frozen frame renders at, when `staticShaders` is set. Tune it so
  // looping shaders (glows, ripples) land on a visible phase rather than a trough. Default 1.
  staticShaderTime?: number;
  // OPT-IN pinned backing-store ratio for FROZEN shader bindings (`staticShaders` mode only). Normally a
  // node canvas is sized `contentBox × window × devicePixelRatio × renderScale`, so every change to the
  // host's fit scale (rotation, fullscreen entry, a widescreen-stretch toggle, an adaptive `setRenderScale`
  // step) re-sizes every canvas — which CLEARS it, re-renders it, and changes its static-frame cache key, so
  // the whole frozen set re-renders. When this is set, a frozen binding is sized at THIS ratio instead, so
  // its backing store (and its cached frames) stop moving with the fit scale; `setRenderScale` then re-sizes
  // only LIVE bindings. The consumer picks the value — typically "what fullscreen would be on this device",
  // so the frozen art is rendered once at the resolution it will eventually be shown at. The resulting size
  // is clamped to `MAX_PINNED_BACKING_DIM` on its longest edge (aspect preserved).
  //
  // The trade is deliberate and one-directional: a frozen surface may be shown at a size it was not rendered
  // at (browser-scaled, softer or sharper) in exchange for not re-rendering the static set on a device that
  // chose static mode for performance. Unset ⇒ frozen bindings size exactly like live ones, i.e. today's
  // behavior for every consumer that does not opt in. Live retune: `WebglShaderRuntime.setStaticShaderPixelRatio`.
  //
  // SCOPE: this pins the DENSITY, not the node's layout box. A host that scales its scene with a CSS transform
  // leaves the content box (and therefore the whole backing size) fixed; a host that RE-LAYOUTS on a fit change
  // moves the box, and a frozen canvas still follows it — it has to, or the shader would be sampling the wrong
  // geometry. What the pin removes is the density axis: `devicePixelRatio × renderScale`, i.e. every fit-derived
  // or adaptive-quality scale step.
  staticShaderPixelRatio?: number;
  // Show a frozen shader surface as an `<img>` of its own rendered frame instead of its `<canvas>`.
  // A canvas that never changes still costs a compositor layer, a blend render surface and
  // per-frame GPU fill; measured on a phone for 24 never-changing surfaces, the `<img>` form is 6
  // layers against 31, 0 render surfaces against 4, 29 ms of GPU clear/fill against 140, and a
  // worst activation gap of 21 ms against 93.
  //
  // A surface that CHANGES is worse as an image (every change is an encode plus a main-thread
  // decode: at a 2 s update cadence the same measurement inverts to an 18.0 ms frame-cost p95
  // against 4.9), so a surface is only swapped once a GATE says it is standing still.
  //
  //   `true` (the default) / unset ⇒ the gate that shipped first: FROZEN mode only, the
  //     static-frame key must be observed unchanged across several renders/reconciles, and any
  //     change after a swap puts that binding back on its canvas permanently.
  //   `false` (or `WebglShaderRuntime.setStaticShaderImages(false)`, live) is the kill switch and
  //     restores the canvas-only path exactly.
  //   A `StaticSurfacePolicy` object supplies the policy instead: which gate (including
  //     `quiet-window`, for surfaces with no usable content key — a SCREEN_UV vignette, a CRT
  //     overlay), whether an invalidation blocks or retries, encode pacing, a host veto over
  //     individual surfaces, and injectable clock/timer seams. See `./surface-image-swap`.
  //
  // ON A WEBGPU BINDING the swap runs through a capture READBACK rather than a canvas read (that
  // canvas cannot be read — see `effectsRenderer`); the frame is otherwise identical and the extra
  // cost is visible as `staticImageCaptureMs`.
  staticShaderImages?: StaticSurfaceOption;
  // Cap (longest edge, source px) for GL texture UPLOADS in the shader runtime: an image larger than this is
  // downscaled before `texImage2D`, so a huge full-screen background doesn't cost a ~250ms main-thread upload
  // spike when it loads. Aspect preserved (uvFit unchanged), shader samples at a lower internal resolution.
  // Unset/0 ⇒ upload at native size (back-compat default).
  maxTextureDimension?: number;
  // Opt-in SCREEN_TEXTURE/SCREEN_PIXEL_SIZE support for the WebGL shader runtime. When set,
  // a shader reading them compiles and the runtime feeds it an APPROXIMATE screen capture:
  // the scene's self-layers drawn BEFORE the node (DOM order) that overlap its on-screen
  // rect, composited onto an offscreen canvas from their already-loaded image/canvas
  // sources (text and other non-drawable paints are skipped), refreshed throttled (~300ms)
  // and on resize — never per frame. Unset/false ⇒ such shaders keep today's behavior
  // (treated as unsupported → CSS/SVG fallback), so existing consumers are unaffected.
  enableScreenTextureCapture?: boolean;
  // Cap (longest edge, px) for the SCREEN_TEXTURE capture canvas: the viewport-sized
  // composite is downscaled to fit, bounding the per-refresh 2D composite + GL upload
  // cost. Only meaningful with `enableScreenTextureCapture`. Unset/0 ⇒ 1024.
  maxScreenCaptureDim?: number;
  // Fail-loud sink for shaders/particles the live runtimes CANNOT render (unsupported shader construct,
  // compile failure, unresolved source, malformed particle spec). The node still falls back to its CSS/SVG/
  // preview paint; this only reports the gap. Unset ⇒ a deduped `console.warn`. A consumer (e.g. a CI corpus
  // gate) can supply its own reporter to collect the failures instead. See `./diagnostics`.
  onUnsupported?: UnsupportedRenderReporter;
  // ADDITIVE per-binding render notification for BOTH live effect runtimes (shader + particle): fired
  // synchronously right after a runtime HANDLED/PRESENTED that binding's current frame. The rule is
  // presentation, not the GL draw or necessarily a pixel write. That distinction is load-bearing
  // for a consumer that composites the canvas ITSELF (uploads it as a texture, blits it into its
  // own stage) and tracks which binding currently presents each frame. So it fires on:
  //   * a real draw — the shader runtime's `renderNode` reaching `gl.drawArrays` (loop tick or the
  //     synchronous `renderBindingNow` anti-flicker path) and the particle runtime's `drawBinding`
  //     reaching `drawParticles`;
  //   * a STATIC-FRAME CACHE-HIT BLIT, in both runtimes. This is the case that must not be dropped: a
  //     fleet of N identical frozen surfaces settles at ONE draw and N-1 blits, so a consumer that only
  //     heard about draws would composite exactly one of them and silently lose the rest;
  //   * a shader same-canvas static-frame cache hit. It intentionally skips clearRect/drawImage
  //     because its named pixels are already presented, but remains a handled frame notification.
  //   * the particle CLEARS that write a blank canvas — a burst with no live instances left, an expired
  //     burst retired, a cleared burst re-surfaced — because a consumer holding the burst's last frame
  //     would otherwise keep painting it forever.
  // It is NOT fired where no frame was handled: a dirty skip, a suspended/dormant park, a zero-sized or
  // context-less canvas, a binding standing on a claimed still. The draw-vs-blit split is still
  // available, in the stats (`draws` / `cacheHits` / shader `blitSkips`) — this callback answers
  // "was this frame presented/handled", which is a different question from "did pixels change" or
  // "did the GPU work". `node` is the consumer's effect node element (the reconcile key), `canvas`
  // the runtime-owned canvas for that frame, `info` what the runtime knows
  // about the frame (see `GodotEffectRenderInfo`). Absent ⇒ byte-identical behavior.
  onBindingRendered?: (
    node: HTMLElement,
    canvas: HTMLCanvasElement,
    info: GodotEffectRenderInfo,
  ) => void;
}

/** Options accepted by a host that both emits a model and mounts its effects. */
export type GodotHtmlMountOptions = GodotHtmlRenderOptions &
  GodotHtmlRuntimeOptions;

export const RUNTIME_OPTION_KEYS = [
  "enableWebglShaders",
  "enableParticles",
  "externalRuntimes",
  "resolveShaderSource",
  "particleMaxInstances",
  "particleFps",
  "particleRectCache",
  "particleObserverSizing",
  "particleDormant",
  "particleTravelExtents",
  "staticParticles",
  "staticParticleOneShotExpiry",
  "staticParticlePixelRatio",
  "parkStaticParticleBlend",
  "staticParticleImages",
  "staticParticleFreezeAtMount",
  "shaderFps",
  "effectsLoopPacing",
  "effectsRenderer",
  "effectsProfiling",
  "renderScale",
  "staticShaders",
  "staticShaderTime",
  "staticShaderPixelRatio",
  "staticShaderImages",
  "maxTextureDimension",
  "enableScreenTextureCapture",
  "maxScreenCaptureDim",
  "onUnsupported",
  "onBindingRendered",
] as const satisfies readonly (keyof GodotHtmlRuntimeOptions)[];
