// FROZEN SURFACES AS `<img>` — "the surface image swap".
//
// A generic mechanism, driven by HOST POLICY: this module owns the swap (encode, stand-in, revert,
// refcount, pacing, watchdog); the consumer owns the question of WHICH surfaces may freeze and WHEN
// (see `StaticSurfacePolicy`). It is structurally typed on `{node, canvas, dirty, dormant,
// staticImage}` and imports nothing — no WebGL, no scene graph — so any runtime that owns a
// per-node `<canvas>` can use it (`./webgl/runtime` is the first).
//
// WHY. A canvas that never changes is not free: it keeps a compositor layer, and (with a blend) a
// render surface, and it is re-filled on the GPU every composited frame. Measured on a phone by the
// perf harness's `static-surfaces` scenario (`docs/perf-harness.md`, S5), for 24 surfaces that
// really never change:
//
//   canvas: 31 layers, 4 render surfaces, 140 ms GPU clear/fill, worst activation gap 93 ms
//   <img>:   6 layers, 0 render surfaces,  29 ms GPU clear/fill, worst activation gap 21 ms
//
// THE TRAP, and why this file is mostly a gate rather than an encoder. The SAME scenario INVERTS
// when the surfaces are regenerated every 2 s: the `<img>` arms go to a frame-cost p95 of 18.0 ms
// against the canvas arms' 4.9, main-thread busy 2,934 ms against 1,792, and 70-86 image re-decodes
// against zero. A surface that changes is strictly WORSE as an image, because every change is an
// encode plus a decode on the thread that produces frames. So a surface is only ever swapped after a
// GATE has produced evidence that it is standing still, and any post-swap movement puts it back on
// its canvas.
//
// THE TWO GATES (`StaticSurfacePolicy.gate`):
//   - `content-key` (the default, and what shipped first): the host names each painted frame with a
//     CONTENT KEY, and the surface swaps once that key has been observed unchanged `observations`
//     times (default 3). An observation is either a re-render that produced the same key, or a
//     `reconcile()` in which the surface came out clean. Correct BY CONSTRUCTION: a key change is
//     reported, so the swap can be undone before the stale image is ever wrong. A churn bench over
//     recorded consumer sessions found 93.6% of 1,258 shader nodes never change any component of
//     that key, which is the population this exists for; the other 6.4% pay at most one wasted
//     encode each, once.
//   - `quiet-window`: for surfaces with NO usable content key (a `SCREEN_UV` vignette, a CRT
//     overlay, a particle system — anything whose output is not a pure function of node-local
//     inputs). A surface becomes eligible when `now() - lastDrawAt >= quietMs`, and thaws the
//     INSTANT it draws again.
//
//     The clock is this module's own per-draw signal (`noteStaticFrame`, called from the render path
//     after the pixels land — cache-hit blits included), NEVER `reconcile()`. A host is free to gate
//     `reconcile()` on its own dirty flag, so counting reconciles would stretch a "3 observations"
//     gate into seconds of latency and, worse, would call a surface quiet that had just repainted.
//
//     Because a keyless surface can repaint without telling us anything, the quiet-window gate gives
//     up the content-key invariant — so it MUST be paired with the WATCHDOG below, which is why
//     `watchdogMs` defaults ON for it and OFF for `content-key`.
//
//     KEYED-OR-QUIET (`keyedQuietMs`, default = `quietMs`, i.e. inert). A quiet-window host may
//     report a NON-NULL key for SOME of its paints, and where it does, that key is content evidence
//     and not merely a share key. Two things then change for that surface, and only for it:
//       - it becomes eligible `keyedQuietMs` after its last draw instead of `quietMs`, so a host
//         that pins `0` freezes it the instant it paints;
//       - a repaint reporting the SAME key does NOT revert a live swap. The pixels are identical by
//         the key's own contract — that is what the key MEANS — so the repaint is a RE-STATEMENT of
//         the frame the `<img>` is already showing, not movement. A DIFFERENT key, or a null one,
//         reverts exactly as before.
//     A null key keeps the plain quiet window, unchanged, which is what a surface that cannot name
//     its frames still gets.
//
//     THIS OVERTURNS HALF OF AN EARLIER ARGUMENT, and the half it leaves standing is the important
//     one. The particle runtime's `notePaint` used to withhold its static-frame key from this module
//     deliberately, on the grounds that the key answers "do these two systems render the same
//     bitmap?" and NOT "is this surface standing still" — a system can re-blit one cached frame
//     forever and still be a moving target. That is still true as an argument about STILLNESS, and
//     it is why the quiet window is still the fallback and why `keyedQuietMs` defaults to inert.
//     What is new is the weaker claim this contract actually needs: a host only ever reports a key
//     where the frame is a PURE FUNCTION of it, so two paints under one key are the same pixels
//     whatever else moved. Re-blitting a cached frame under its own key is exactly that case.
//     IF A HOST REPORTS A KEY IT CANNOT HONOUR — the same key over genuinely different pixels — the
//     result is a stale `<img>` standing over a canvas that has moved on, and nothing here will
//     notice: the `drawSeq`/size proxies all say "explained", because a paint WAS explained. Only
//     the watchdog's remaining proxies (the canvas leaving the DOM, a re-allocation, a pending
//     re-render) can catch it, and none of them is a pixel compare. The key is a promise; this is
//     what it costs to break it.
//
// INVALIDATION (`StaticSurfacePolicy.onInvalidate`):
//   - `"block"` (default, today's behavior): a key change after a swap disqualifies that surface for
//     the life of its binding. The right default when a key IS available: a key that moved once is
//     evidence about that node's content.
//   - `"retry"`: revert, reset the gate, do NOT block. Any app with a resizable canvas re-keys on
//     `WxH` at every breakpoint, so "block forever" would disqualify its entire population after one
//     rotation. `retry` also covers a FAILED encode/decode: instead of blocking the surface it is
//     rescheduled on the encode pacing cadence, forever.
//   Runtime-WIDE deliberate changes (a re-size, a mode flip, the kill switch, a host `invalidate`)
//   never block under EITHER setting: they say nothing about this surface's content.
//
// THE WATCHDOG (`StaticSurfacePolicy.watchdogMs`). A standing check over the swapped set that each
// one is still legitimately frozen: its canvas is still in the DOM, has no re-render pending, has
// not been re-allocated (a `width`/`height` write CLEARS a canvas), and has drawn nothing since the
// freeze. Anything else reverts it. It also re-syncs a stand-in whose canvas MOVED (the box is
// copied at freeze time, so a later placement write would leave the image at the old box).
//   HONEST LIMIT: it detects unexplained REPAINTS through those observable proxies. It cannot detect
//   an arbitrary pixel write into a same-size canvas that reports nothing — that would need a
//   readback per surface per poll. The content-key gate does not have this hole (the key is
//   reported); the quiet-window gate does, and the proxies are the mitigation.
//
// ENCODE PACING (`StaticSurfacePolicy.encode`). A mass freeze must not park the main thread:
// downstream, an unbatched `toBlob` across 72 surfaces measured a 736 ms park. So at most `slice`
// encodes (default 4) are kicked per `intervalMs` WINDOW (default 120) — the head of a burst inline,
// the remainder queued `smallest-first` by backing-store area, so the bulk of a fleet of small
// surfaces swaps early and the handful of room-sized monsters go last, one late slice each. See
// `pumpEncodes` for why the budget is on the clock rather than per queue flush, and for the one
// thing that costs: the inline head of a burst is unsorted.
//
// `slice` bounds THROUGHPUT, not the park. That distinction was learned the expensive way: a slice of
// four drains back-to-back inside ONE timer task, so on a device whose GPU was already saturated the
// same four readbacks that cost 6-13 ms each when the screen was calm cost ~290 ms each, and the task
// that held all four measured 1,163 ms with 97% self-time inside native `toBlob` (Moto G86, 30-card
// shuffle). `encode.perTask` is the lever that bounds the PARK: at most `perTask` readbacks per TASK,
// with at least `taskGapMs` between two tasks of the same window. The window budget is untouched —
// with `perTask: 1` a window's four encodes land in four tasks 16 ms apart instead of one task of
// four — so throughput is identical and only the GRANULARITY moves. Two consequences follow and are
// the point: the longest main-thread park this mechanism can cause falls to ONE readback, and `busy`
// (consulted once per PASS) is now consulted once per ENCODE, so a host that becomes busy after the
// first readback stops the second. `staticImageBusyDeferrals` therefore RISES for an identical
// workload — it counts passes, and there are now more of them; the diagnosis pair below is a ratio
// and stays valid. `perTask` defaults to `slice`, i.e. inert, so no existing consumer's pacing moves.
//
// `encode.deferHead` (default `false`, i.e. today's behavior above) trades that inline head away: a
// caller that reaches `maybeSwap` from its OWN hot path (a `reconcile()`, a `TimerFire`) pays the
// head's `toBlob` on its own stack. Setting `deferHead: true` routes every encode — including the
// head — through the timer seam, so the caller that made a surface eligible never itself blocks; the
// trade is a lone surface waiting one scheduler tick instead of swapping the instant it qualifies.
// See `pumpEncodes`'s `allowInline` parameter.
//
// `encode.busy` — WHY THE CLOCK ALONE IS NOT ENOUGH. Pacing decides HOW MANY encodes run per window;
// it cannot decide WHEN in that window they land, and for this encode the "when" is the whole cost. A
// per-node canvas is GPU-accelerated, so `toBlob` is a GPU→CPU READBACK that blocks until the driver
// hands the pixels over: a device trace of a consumer's fleet measured 2.8 ms of encoder CPU against
// ~30 ms of WALL time per surface (52.8 ms of `toBlob` plus 17.1 ms of `createObjectURL` inside ONE
// `TimerFire` on a Moto G86). One such block dropped into the middle of the host's own draw burst
// costs frames however small the slice was. `busy` is the host's "not now": a predicate consulted
// ONCE per drain pass — including the `deferHead` pass — and a pass that defers just re-arms at
// `intervalMs` instead of encoding.
//   BOUNDED, ALWAYS. `busyMaxDeferMs` (default `DEFAULT_ENCODE_BUSY_MAX_DEFER_MS`) caps one unbroken
//   run of deferrals, so a host that is busy forever still drains a slice per bound. Deferring is a
//   SLOWDOWN, never a stop: a surface that has not swapped yet is still a live canvas being re-filled
//   every composited frame, which is the cost this entire file exists to remove. The probe for a stuck
//   predicate is `staticImageBusyForcedEncodes` ≈ `staticImageBusyDeferrals`.
//   WHY THE HOST OWNS THE SIGNAL. gsw cannot see the host's frame loop, and every self-detecting
//   proxy costs something this module refuses to spend: a rAF probe would arm a timer under the
//   DEFAULT policy, which today arms exactly zero (see `nextSweepAt`'s fast path), and there is no rAF
//   at all in jsdom, where this module's own tests run. The host already knows when it is mid-burst.
//   THE STALE-SIGNAL TRAP, and why `busy` alone is not enough either. A host predicate is usually
//   derived from its FRAME LOOP ("a frame was produced in the last N ms"), and a long readback
//   SUPPRESSES exactly the frames that signal is made of: the jam manufactures its own "idle" reading
//   at the instant the system is most overloaded. Measured: two recovery gaps of 362 ms and 674 ms in
//   the middle of the 1,163 ms stall above, both of which a 250 ms frame-recency predicate reported as
//   quiet, releasing the drain back into the hole. Two mitigations, and they are not equals. HOST
//   side: make the predicate say "work is ARMED" (a booked rAF, a live animation) rather than "a frame
//   HAPPENED" — a missing frame then reads as a starved loop instead of a finished animation. gsw
//   side: `encode.slowEncodeMs`, the module's own measurement of the PREVIOUS readback, which cannot
//   be faked by a suppressed frame and self-clears the instant the load passes.
//   REJECTED: an AREA budget per window (encode at most N pixels rather than N surfaces). It answers
//   the wrong question — one 2520×1080 readback is a single unsplittable ~30 ms block whatever budget
//   it is charged against — and `smallest-first` already keeps the room-sized monsters out of the
//   early slices, which is the only thing an area rule would have bought.
//   REJECTED: a fixed not-busy COOL-DOWN (hold N ms, or N consecutive quiet passes, after the
//   predicate goes quiet). The measured jank gaps were 362 ms and 674 ms, so a cool-down long enough
//   to cover them is a guess at one device's number that also delays every legitimate freeze on every
//   other device. The previous readback's MEASURED cost answers the same question with evidence this
//   module already has in hand, for free.
//
// CAPTURE-HOOK SOURCES (WebGPU). Everything above assumes the surface's own canvas can be READ — it
// is what `toBlob` is called on. A WebGPU canvas cannot: `drawImage`/`toDataURL`/`toBlob` all go
// through the presentation path, which is blank under SwiftShader, produces nothing in headless
// Chrome (it never composites a WebGPU canvas) and is pathological on Android (S7: the blit-shaped
// arm ran at 23 Hz against 87 for direct presentation). v1 therefore simply never attached such a
// binding, and every counter here stayed 0 for it.
//
// A binding may now instead supply `captureCanvas` — an ASYNC hook that returns a fresh 2D canvas
// holding the surface's current frame, produced however that renderer can produce it. Both gsw
// runtimes implement it the one sanctioned way: re-render the frozen frame into an offscreen
// `rgba8unorm` texture and `copyTextureToBuffer` it back (`../webgpu/readback`), then unpremultiply
// into a 2D canvas (`../webgpu/still-capture`). The canvas that reaches `toBlob` is therefore an
// ORDINARY CPU one, and every path below it — dedup, pacing, parked stills, the watchdog, the
// stand-in — is byte-identical to the canvas-sourced case. Absent hook ⇒ the canvas is read
// directly, exactly as v1.
//
// THE CONTRACT the hook has to keep: return the pixels of the frame the surface is CURRENTLY
// showing, at its backing-store size, or null. Null (or a throw, or a degenerate canvas) is a
// FAILURE, not a wedge — it books `staticImageCaptureFailures`, feeds the ordinary `fail()`
// semantics (retry on the encode cadence, or block), and leaves the surface on its canvas.
//
// BLANK CAPTURES — THE FAILURE THAT LOOKS LIKE A SUCCESS (`STATIC_CAPTURE_BLANK`,
// `staticImageBlankCaptures`). A capture can complete, throw nothing, report nothing, and produce a
// frame with no visible pixels in it for a surface that was visibly painting. Measured on this box
// (docs/perf-harness.md, S8's traps): headed under Xvfb on Chrome's DEFAULT ANGLE backend, all 12
// WebGPU surfaces of both effect arms swapped perfectly — `staticImagesLive 12/12`, zero capture
// failures, zero encode failures — and every stand-in was a PNG of nothing. The systems vanished
// from the screenshot, because the canvas is hidden by then and the `<img>` over it is empty, and
// every counter in this file said the mechanism had worked. That is a SHIPPED risk, not a harness
// one: any device on which a capture cannot produce pixels blanks a frozen surface in production the
// same way. (On that rung the readback itself was FINE and the accelerated 2D canvas was the broken
// link — `../webgpu/still-capture` records both failures and the evidence for each.)
//
// So a hook may answer `STATIC_CAPTURE_BLANK` instead of a canvas: "I captured this surface and got
// nothing visible, for a frame I know I drew". It is treated as a capture failure — the surface
// keeps its live canvas, which is exactly the state it was in before the mechanism existed — and it
// books `staticImageBlankCaptures` beside `staticImageCaptureFailures`, so the condition is a NUMBER
// rather than a hole in the numbers.
//
// WHO MAY SAY IT is the whole judgement, and it is the PRODUCER's, never this module's. A genuinely
// empty surface — a particle system that has emitted nothing, one whose particles have all faded to
// alpha 0, a shader that outputs transparent — is legitimately all-transparent, and rejecting its
// capture would leave a live canvas up forever and defeat the swap. This module therefore never
// inspects pixels; it takes a verdict from the one place that knows what it just drew. gsw's own
// producers answer it from the draw they encoded for THAT capture (`../webgpu/still-capture`'s
// `expectCoverage`): the particle runtime from its packed instance count — which is exactly the
// number its live path uses to decide between DRAWING and CLEARING, so a zero-count frame is blank
// on the canvas too — and the shader runtime from a full-viewport quad whose node modulate is not
// zero (a fragment program's output is not knowable from outside it; the residual is stated at the
// call site).
//
// TERMINAL FOR THAT SURFACE, whatever `onInvalidate` says — the one place a `"retry"` policy does
// not retry. A blank capture is a statement about the DEVICE (or the launch mode), not about this
// frame: retrying it costs a full GPU re-render plus a `copyTextureToBuffer` per surface per encode
// interval, forever, and cannot succeed while the cause holds. The surface it holds on its canvas is
// already correct, so being terminal costs an optimization and never a pixel.
//
// WHY THE DIRECT PATH IS NOT GUARDED — a documented hole, on evidence, rather than a guess in either
// direction. The obvious symmetry ("a `toBlob` is a canvas read, so a canvas that cannot be read
// publishes a blank still whatever put the pixels there") is FALSE on the very rung that motivated
// all of this, and the measurements are these (this box, 2026-08-21, headed under Xvfb, default
// ANGLE, RTX 2060; docs/perf-harness.md, S8):
//   - the WebGL arms of the swap perf scenario, on that rung, publish CORRECT stills: 12/12 surfaces
//     swapped, all 12 presence samples hit, `nonEmptyRatio` identical to the healthy rung. `toBlob`
//     on a host-painted canvas works there.
//   - and yet a FRESH canvas in that same page, written with `putImageData`, reads back alpha 0 —
//     which is exactly what the capture path's guard catches, and it is right to: the WebGPU arms on
//     that rung really did publish PNGs of nothing.
// So the only cheap probe available for the direct path — paint a scratch canvas, read a pixel of it
// back — reports BROKEN in an environment where the direct path is demonstrably FINE. Shipping it
// would have refused every WebGL surface on a rung where the mechanism works, which is worse than
// the hole it closes. The per-surface variant is no better: reading a witness pixel out of the
// surface's own canvas uses the same instrument, and there is no third instrument — inspecting the
// encoded PNG means decoding it, and the only in-page way to look at a decoded image is the canvas
// read that is broken.
// WHAT REMAINS UNCOVERED, stated plainly: on a device where `toBlob` over a host-painted canvas
// yields an empty PNG (one launcher on this box does exactly that — every 2D canvas is dead there,
// `drawImage` included), a 2D-backed surface still publishes a blank `<img>` and nothing here
// notices. `staticImageBlankCaptures` stays 0, because no capture hook was involved.
//
// CAPTURE TIME AND ENCODE TIME ARE MEASURED SEPARATELY, and that split is the point.
// `staticImageEncodeMs`/`MaxMs` mean one thing — SYNCHRONOUS main-thread park — and a GPU
// `mapAsync` readback does not park the main thread at all; folding its wall time in would corrupt
// the one number that answers "what did this mechanism cost the frame loop?". So the capture's WALL
// time books `staticImageCaptureMs`/`MaxMs` and only the `toBlob` tail books encode-ms. The adaptive
// backoff (`encode.slowEncodeMs`) does read the capture wall time, because there it is measuring the
// GPU's willingness to hand pixels over, which is exactly the condition the backoff exists for.
//
// NO WORKER, still — for the same reason as below, and one more: the readback here is already off
// the main thread, so the only thing a worker could take is the PNG encode, which the harness
// measured as the cheap half.
//
// ONE ENCODE PER KEY, NOT PER SURFACE. When the host names a content key, identical surfaces share
// one encode and one object URL, refcounted (on a real device 7 shader canvases were only 3 distinct
// keys). A keyless (quiet-window) surface gets a private synthetic key, so it is never shared —
// there is no identity to share on.
//
// PARKED STILLS (`encode.parkedStillBytes`, default 0 = off). Key dedup buys nothing for a KEYLESS
// surface, and the quiet-window population reverts constantly for reasons that are not repaints: a
// host `invalidate`, a dormancy wake, a watchdog proxy tripping. Every one of those revokes the URL,
// so the next freeze pays a full readback for pixels the canvas is still holding — `state.drawSeq`
// counts actual PAINTS, and it did not move. So a revert PARKS its entry instead of revoking it,
// stamped with the `drawSeq` and backing-store size it was encoded at, and the next freeze of that
// same surface RE-ATTACHES it for zero readback when the stamp still matches and the binding is not
// dirty (`staticImageReuseHits`). Anything else — a paint, a re-allocation, a decode failure — is a
// disqualification, and a disqualified still is revoked on the spot rather than kept on a hunch.
//   BOUNDED BY BYTES, not by count: the pool is module-wide and evicts least-recently-parked first
//   once `parkedStillBytes` is exceeded, because what is at stake is retained pixel memory (the
//   blob's own `size`, recorded at publish). Parking is exactly a memory-for-readback trade, which is
//   why it is opt-in with a host-chosen budget rather than a default: the module cannot know whether
//   a consumer's device has 24 MB to spend on stills it may never reclaim.
//
// RETAINED STILLS (`encode.stillCacheBytes`, default 0 = off). A parked still is claimable by ONE
// surface — the one that parked it — and dies with it. That is right for the KEYLESS population it
// was written for (there is no identity to share on, so the fingerprint IS the claim) and wrong for
// a KEYED one, where the pixels belong to the key rather than to whoever happened to hold it last.
// So an entry whose last holder lets go — a revert OR a dispose — under a real (non-solo) key is
// RETAINED instead of revoked: it stays in `entriesByKey`, held by nobody, and the next surface to
// reach that key attaches to it for zero readback. That is what makes a surface's SECOND-EVER
// appearance free, which is the whole point (see `claimStaticStill`).
//   ONE POOL, not two. Parked and retained stills are the same commodity — retained blob bytes with
//   no holder — so they share one module-wide LRU (`stillPool`), one running byte total and one
//   eviction walk, budgeted at `parkedStillBytes + stillCacheBytes`. The alternative, two pools with
//   two fixed budgets, is a worse allocator for the same memory: each would starve on its own while
//   the other sat half empty, and an eviction walk would have to guess which one to raid. What the
//   two options still mean SEPARATELY is admission — a keyless entry needs `parkedStillBytes`, a
//   keyed one needs `stillCacheBytes` — so a host can switch either mechanism off without touching
//   the other, and a host that sets neither has no pool at all.
//   NEVER A SOLO KEY. A keyless surface encodes under a private synthetic key (`\0solo:N`, below);
//   retaining one would pin bytes no lookup can ever hit. Those still park, by fingerprint, or are
//   revoked.
//   The retention is per SWAPPER, for teardown only: an entry is retained on behalf of the swapper
//   whose surface last released it, and that swapper's `dispose()` revokes it. Module-wide sharing
//   is unaffected while both live (`entriesByKey` is document-wide, as it always was), but the leak
//   contract does not bend — `staticImageUrlsLive` still returns to 0 once the last runtime is gone.
//
// CLAIMING A STILL (`claimStaticStill`). Everything above is a GATE: a surface paints, waits, is
// measured, is encoded, and only then becomes an `<img>`. For a surface whose frame has ALREADY been
// encoded under a key this document has seen, every one of those steps is redundant — the pixels are
// in hand before the surface exists. `claimStaticStill` is the shortcut: no gate, no paint, no
// encode, just refcount the entry and attach the stand-in. A host that can name a frame before
// rendering it can therefore mount the second, third and thirty-fifth copy of that frame as an
// `<img>` and never configure their canvases at all.
//
// BAKING A STILL (`bakeStill`). The other half of the same trade: a surface that is about to
// DISAPPEAR still holds pixels, and if its key has never been encoded, those pixels are the only
// copy anyone will ever have cheaply. `bakeStill` enqueues an encode for a key with NO waiting
// surface, through the identical pacing/capture/publish tail, and publishes an entry held by nobody
// straight into the retained pool. The host decides when to spend that readback;
// `StaticSurfaceSwapper.queueLength()` exists so it can hold speculative bakes until the surfaces
// that actually need a still have drained.
//
// PRIMING UNSEEN KEYS (`encode.primeUnseenKeys`, default false). The deferral apparatus above
// (`busy`, `slowEncodeMs`, `busyMaxDeferMs`) was tuned by a consumer against ~4821×2156 surfaces
// measured at ~290 ms per readback on a loaded phone: at that size, WHEN a readback lands is the
// whole cost. A different population — ~320 px canvases whose entire fleet is ~2 distinct keys — is
// three orders of magnitude off that: the first encode of each key is the ONLY encode that key will
// ever need (35 surfaces share it), and deferring it does not shave a park, it just leaves 35 live
// canvases in the composite for another window. On a CAPTURE-HOOK source the argument is stronger
// still — the readback is asynchronous and parks the main thread not at all. So a queued job whose
// key has never been encoded in this document may SKIP the deferral check. It bypasses WHEN, never
// HOW MANY: `slice`, `perTask` and `taskGapMs` all still bind, so no pass can turn into a burst of
// readbacks. OFF by default precisely because the trade above is a per-consumer judgement about
// surface size, and this module cannot see a surface's cost from here.
//
// NO WORKER. The encode is inline `HTMLCanvasElement.toBlob`. gsw has no `Worker`/`OffscreenCanvas`
// anywhere, key-dedup keeps the encode count at a handful, and the harness's own fan-out sweep says
// ONE worker is slower than inline (1,827 ms vs 1,725) — a pool is what wins, and a pool is a lot of
// machinery to add on speculation. It would not even address the cost measured since: handing the
// pixels to another thread means capturing them first, and on a GPU-resident source
// `createImageBitmap` captures SYNCHRONOUSLY on the calling thread (576 ms measured), so the transfer
// pays exactly what the `toBlob` pays. The readback is the cost, not the codec — which is why the
// lever this file grew is `encode.busy` (WHEN), not a thread.
//   A single readback is UNSPLITTABLE, and no lever here pretends otherwise: `encode.perTask` cannot
//   make one readback shorter, it only stops four of them sharing a task. `encode.maxDim` is the one
//   lever that shrinks a readback itself, and it does so by reading back fewer PIXELS — which is a
//   fidelity decision, hence off by default.
//
// PNG, NOT WEBP. Both are lossless here, so this is decided on cost and on trap-avoidance:
//   - the harness's bake probe measures PNG as the FASTEST codec on the phone (1,789 ms for 50
//     regions from a 4096² page, against 2,244 for lossless webp — webp is ~25% SLOWER, not faster),
//   - `HTMLCanvasElement.toBlob(cb, "image/webp")` with no quality argument is LOSSY (4.4x smaller,
//     up to 71 levels of channel error), while `OffscreenCanvas.convertToBlob` with the same
//     omission is lossless. That difference has already been sprung once in this project's ecosystem.
//     PNG is byte-identical through BOTH calls, so there is no quality argument to get wrong.
//   WebP's only win is size (185 KB vs 201 KB per region), and these blobs are held in memory in
//   ones and twos, not shipped over a wire.
//
// LIFETIME. A leaked object URL pins its bytes for the life of the document, so the refcount is the
// contract: an entry exists only while at least one surface holds it, and the URL is revoked the
// moment the last one lets go (revert, block, dispose, runtime teardown, kill switch). An eviction
// from the host's own frame cache RETIRES the entry (`onStaticFrameEvicted`) — it leaves the shared
// lookup so no NEW surface attaches to it — but does not revoke under a surface that is still
// showing it: the pixels for a key are immutable, and revoking a URL whose `<img>` has not finished
// loading blanks the surface.
//
// DISPLAY OWNERSHIP. This module is the SINGLE writer of a swapped surface's `display`
// (`applySurfaceVisibility`): it composes "dormant" (the host's park) with "swapped", and when it
// un-hides it restores EXACTLY the value the host had before it first hid — never a blanket `""`,
// which would resurrect a canvas the host itself had hidden. A surface with no swap state is
// untouched beyond the byte-identical dormant park.
//
// The `<img>` REPLACES the canvas visually but not structurally: the canvas stays in the DOM,
// hidden with `display: none` (no box, no paint, no layer), and the `<img>` is inserted immediately
// before it so it takes the canvas's exact place in paint order. That keeps two things working for
// free: a SCREEN_TEXTURE-style capture path that reads an earlier layer's pixels straight off its
// `<canvas>` child, and the revert, which just unhides a canvas that still holds the right frame.

/** The DOM attribute stamped on the `<img>` that stands in for a frozen surface's canvas. */
export const STATIC_SURFACE_IMAGE_ATTR = "data-godot-shader-image";

/** Default `content-key` gate: how many consecutive unchanged observations of a surface's content key
 *  are required before it is swapped. Small on purpose — the revert is the real safety net, and the
 *  clock ticks many times a second — so 3 costs a fraction of a second of latency and excludes a
 *  surface that is merely between two states. */
export const STABLE_OBSERVATIONS_BEFORE_SWAP = 3;

/** Default `quiet-window` gate: a surface's own draws must hold still this long before it freezes. */
export const DEFAULT_QUIET_WINDOW_MS = 1000;

/** Default watchdog cadence, for the gates that need one (see the module doc). */
export const DEFAULT_SURFACE_WATCHDOG_MS = 3000;

/** Default encode pacing: surfaces per batch (see the module doc). */
export const DEFAULT_ENCODE_SLICE = 4;
/** Default encode pacing: gap between batches, ms. */
export const DEFAULT_ENCODE_INTERVAL_MS = 120;
/** Default cap on one unbroken run of encode deferrals, for EITHER reason (see the module doc). Long
 *  enough that an ordinary burst of host activity is ridden out whole, short enough that a host whose
 *  predicate is stuck ON degrades to "the fleet freezes slowly" rather than "the fleet never
 *  freezes". */
export const DEFAULT_ENCODE_BUSY_MAX_DEFER_MS = 3000;

/** Default `encode.perTask`: `0` reads as "the whole slice", i.e. a window's entire budget drains
 *  back-to-back in one timer task — the behavior every existing consumer already has. A host that has
 *  MEASURED its readbacks in the tens or hundreds of ms should pin `1`; see `pumpEncodes`. */
export const DEFAULT_ENCODE_PER_TASK = 0;
/** Default gap between two encode TASKS inside one pacing window (only reachable when
 *  `perTask < slice`). 16 ms ≈ one 60 Hz display frame, chosen so the host's own rAF gets to run
 *  BETWEEN two readbacks — which is what makes a frame-derived `busy` predicate fresh again instead
 *  of stale for the whole drain. */
export const DEFAULT_ENCODE_TASK_GAP_MS = 16;
/** Default `encode.slowEncodeMs`: `0` = the adaptive backoff is OFF, so nothing changes for a host
 *  that has not asked for it. */
export const DEFAULT_ENCODE_SLOW_MS = 0;
/** Default hold after a readback measured at or over `encode.slowEncodeMs`. */
export const DEFAULT_ENCODE_SLOW_BACKOFF_MS = 1000;
/** Default `encode.maxDim`: `0` = the source canvas is read back at its full backing-store size,
 *  exactly as it always has been. */
export const DEFAULT_ENCODE_MAX_DIM = 0;
/** Default `encode.parkedStillBytes`: `0` = parked stills are OFF and a revert revokes immediately,
 *  which is what every consumer has today. The trade is retained pixel memory for skipped readbacks
 *  (see the module doc's "PARKED STILLS"), so the budget is the host's to choose — 24 MB is the
 *  measured shape of one fleet's worth of quiet-window stills, not a number this module may assume. */
export const DEFAULT_PARKED_STILL_BYTES = 0;
/** Default `encode.stillCacheBytes`: `0` = KEYED retention is off, so an entry whose last holder
 *  lets go is revoked exactly as it always has been. Same reasoning as `parkedStillBytes` — the
 *  budget is memory this module cannot know a device has — with one difference that makes it worth
 *  more per byte: a retained still is claimable by KEY, so its bytes serve every surface that ever
 *  reaches that frame rather than the one surface that parked it. */
export const DEFAULT_STILL_CACHE_BYTES = 0;

/** Lossless, and identical through `toBlob` and `convertToBlob` — see the module doc. */
const ENCODE_MIME = "image/png";

/** What a capture hook answers INSTEAD of a canvas to report the failure that otherwise reads as a
 *  success: the capture completed and holds NO VISIBLE PIXELS for a frame the producer knows it drew
 *  (see the module doc's BLANK CAPTURES). A plain `null` stays what it always was — "I could not
 *  produce these pixels at all" — and the two are counted apart. */
export const STATIC_CAPTURE_BLANK = "blank";

/** What `StaticImageSwapBinding.captureCanvas` resolves to: the frame as an ordinary 2D canvas,
 *  `STATIC_CAPTURE_BLANK`, or null. */
export type StaticSurfaceCapture =
  | HTMLCanvasElement
  | typeof STATIC_CAPTURE_BLANK
  | null;

// ---- policy (public) --------------------------------------------------------------------------

/** Whatever the injected `setTimeout` seam returns; only ever handed back to the injected
 *  `clearTimeout`. Deliberately opaque so a host can inject any scheduler. */
export type StaticSurfaceTimerHandle = unknown;

/** The default gate: the host names each painted frame with a content key, and the surface swaps
 *  once that key has been observed unchanged `observations` times (default
 *  `STABLE_OBSERVATIONS_BEFORE_SWAP`). */
export interface StaticSurfaceContentKeyGate {
  kind: "content-key";
  observations?: number;
}

/** The keyless gate: a surface becomes eligible `quietMs` (default `DEFAULT_QUIET_WINDOW_MS`) after
 *  its LAST DRAW, and thaws the instant it draws again. See the module doc on why the clock is the
 *  per-draw signal and never `reconcile()`, and on why this gate needs the watchdog. */
export interface StaticSurfaceQuietWindowGate {
  kind: "quiet-window";
  quietMs?: number;
  /** The window for a surface whose LAST reported key was non-null (see the module doc's
   *  KEYED-OR-QUIET). Default: `quietMs`, i.e. this option is inert unless a host asks for it — a
   *  host that reports no keys, or that wants keyed surfaces held to the same window as keyless
   *  ones, is unaffected by its existence.
   *
   *  `0` means "eligible the instant it paints", which is the setting for a host whose key is a
   *  complete description of the frame: there is nothing to wait FOR, because a second paint under
   *  the same key would not change a pixel and a paint under a different key reverts anyway. The
   *  cost of pinning it wrongly is stated at the module doc: a stale `<img>` no proxy can catch. */
  keyedQuietMs?: number;
}

export type StaticSurfaceGate =
  | StaticSurfaceContentKeyGate
  | StaticSurfaceQuietWindowGate;

/** Batching for the (main-thread) encodes — see the module doc. */
export interface StaticSurfaceEncodePacing {
  /** Encodes kicked per batch. Default `DEFAULT_ENCODE_SLICE`. */
  slice?: number;
  /** Gap between batches, ms. Default `DEFAULT_ENCODE_INTERVAL_MS`. */
  intervalMs?: number;
  /** `"smallest-first"` (default) orders a batch by backing-store area; `"dom"` keeps the order the
   *  surfaces became eligible in. */
  order?: "smallest-first" | "dom";
  /** `true` defers even the head of a burst through the timer seam instead of encoding it inline on
   *  the caller's stack (see the module doc's "ENCODE PACING" section). Default `false` — the head
   *  stays inline, which is today's behavior and every existing consumer's default. */
  deferHead?: boolean;
  /** HOST BUSY SIGNAL: "is this a bad instant to spend ~30 ms on a GPU readback?". Consulted ONCE per
   *  drain pass (never per queued surface), and a pass that it defers re-arms at `intervalMs` rather
   *  than encoding — the head included, `deferHead` or not. The host owns this because only the host
   *  can see its own frame loop; absent, nothing about the pacing changes. A predicate that THROWS
   *  fails OPEN (the pass encodes): a host bug must not be able to stop the mechanism. */
  busy?: () => boolean;
  /** Cap on one unbroken run of deferrals, ms — ONE bound shared by `busy` and by the adaptive
   *  backoff below, so neither of them (nor the two together) can stop the fleet. Default
   *  `DEFAULT_ENCODE_BUSY_MAX_DEFER_MS`; `0` means NEVER DEFER, i.e. the whole deferral apparatus is
   *  switched off — `busy` is not consulted and `slowEncodeMs` is not consulted (the A/B lever for a
   *  host that wants both wired but disabled). Once the bound elapses one pass goes out against a
   *  still-busy host and the bound restarts, so deferring can only ever slow the fleet down — see the
   *  module doc. */
  busyMaxDeferMs?: number;
  /** Readbacks allowed in ONE task. Default: `slice` (today: the whole slice drains back-to-back).
   *  `1` is the setting for a host whose surfaces are GPU-resident and big: `toBlob` on such a canvas
   *  is a SYNCHRONOUS GPU→CPU readback, so N of them in one task is one unsplittable park of
   *  N × readback — measured downstream at 1,163 ms for four ~4821×2156 surfaces on a phone whose GPU
   *  was already saturated, against 6-13 ms each for the SAME surfaces once the load passed. `slice`
   *  still bounds THROUGHPUT per `intervalMs`; this bounds the BLOCK. Setting it below `slice` costs
   *  `taskGapMs` per extra task and buys back the ability to be interrupted. */
  perTask?: number;
  /** Gap between two encode tasks inside one window, ms. Default `DEFAULT_ENCODE_TASK_GAP_MS`.
   *  Unreachable (and therefore inert) while `perTask >= slice`. */
  taskGapMs?: number;
  /** ADAPTIVE BACKOFF, the module's own evidence about readback cost — a readback whose SYNCHRONOUS
   *  part took at least this long holds the next one for `slowBackoffMs`. On a CAPTURE-HOOK source
   *  (`StaticImageSwapBinding.captureCanvas`) there is no synchronous part to measure, so what is
   *  compared against this threshold is the capture's WALL time — the GPU readback's own latency,
   *  which is precisely the condition this lever exists to back off from. Either way a surface over
   *  the threshold books `staticImageSlowEncodes`. Default
   *  `DEFAULT_ENCODE_SLOW_MS` (0 = off). This exists because a host's `busy` predicate is usually
   *  derived from its frame loop, and a long readback SUPPRESSES the frames that signal is made of:
   *  the jam manufactures a stale "idle" reading exactly when the system is most overloaded (the
   *  module doc's stale-signal trap). The measured cost of the previous readback cannot be faked that
   *  way. Bounded by `busyMaxDeferMs` like every other deferral. */
  slowEncodeMs?: number;
  /** How long a slow readback holds the next one, ms. Default `DEFAULT_ENCODE_SLOW_BACKOFF_MS`. */
  slowBackoffMs?: number;
  /** READBACK CLAMP: longest edge (backing-store px) the encode may read. Over it, the surface is
   *  blitted into a scratch canvas at the clamped, ASPECT-PRESERVED size and that is what `toBlob`
   *  reads — a GPU-side downscale, so a 4821×2156 surface reads back 5.5× fewer pixels. Default
   *  `DEFAULT_ENCODE_MAX_DIM` (0 = no clamp).
   *  FIDELITY: the stand-in is presented at the canvas's CSS box with `object-fit: fill`, so a clamp
   *  is a resampling, not a re-layout — but it IS visible on a surface whose backing store was denser
   *  than its CSS box. Soft output (a vignette, fog, a glow) survives it; sharp output does not. Ship
   *  it behind a host A/B, never as a silent default.
   *  KEY SHARING: `entry.key` names the FRAME, not the encode size, and two surfaces on one key may
   *  already have different backing sizes — the first to reach the gate encodes and the other
   *  stretches it. The clamp does not change that contract, only the pixel size of the shared
   *  frame. */
  maxDim?: number;
  /** PARKED STILLS budget, bytes (see the module doc). A revert parks its encoded frame instead of
   *  revoking it, so a re-freeze of the same, unpainted surface costs no readback at all; this is the
   *  ceiling on the retained blob bytes that buys. Default `DEFAULT_PARKED_STILL_BYTES` (0 = off,
   *  today's immediate revoke). The pool is MODULE-wide (key dedup already is), evicts
   *  least-recently-parked first, and applies the budget of whichever policy last parked into it — a
   *  document running several swappers should give them the same number. */
  parkedStillBytes?: number;
  /** RETAINED STILLS budget, bytes (see the module doc's "RETAINED STILLS"). An entry under a real
   *  content key whose LAST holder lets go — by revert or by dispose — is kept, held by nobody, so
   *  the next surface to reach that key attaches for zero readback (`claimStaticStill`) and so
   *  `bakeStill` has somewhere to publish. Default `DEFAULT_STILL_CACHE_BYTES` (0 = off, i.e. the
   *  revoke every consumer has today).
   *  SHARES ONE POOL AND ONE EVICTION WALK with `parkedStillBytes`: the budget the pool is trimmed
   *  to is the SUM of the two, and either kind may evict the other, least-recently-pooled first.
   *  What stays separate is admission — this number alone decides whether a KEYED entry may be
   *  retained — so the two mechanisms can still be switched on and off independently. */
  stillCacheBytes?: number;
  /** Exempt the FIRST encode of each key from the deferral apparatus (`busy`, `slowEncodeMs`), not
   *  from the pacing (see the module doc's "PRIMING UNSEEN KEYS"). Default `false`.
   *  The judgement it encodes is about SURFACE SIZE: deferral was tuned against ~4821×2156 readbacks
   *  measured at ~290 ms on a loaded phone, and a fleet of ~320 px canvases collapsing to ~2 distinct
   *  keys is three orders off that — there, holding the one encode a key will ever need buys no park
   *  back and leaves the whole fleet in the composite for another window. A host with big surfaces
   *  must leave this off. */
  primeUnseenKeys?: boolean;
}

/**
 * The host's policy for the surface image swap. `true` (or an absent option) is exactly
 * `{ gate: { kind: "content-key" }, onInvalidate: "block" }` — the behavior that shipped first;
 * `false` disables the mechanism entirely and the runtime takes the path it took before it existed.
 */
export interface StaticSurfacePolicy {
  /** How a surface earns its swap. Default `{ kind: "content-key" }`. */
  gate?: StaticSurfaceGate;
  /** What a post-swap invalidation (a content-key change, a failed encode/decode) does to the
   *  surface. Default `"block"` — never offer it again. `"retry"` reverts, resets the gate, and lets
   *  it re-earn (failed encodes are rescheduled on the encode cadence, forever). */
  onInvalidate?: "block" | "retry";
  /** Encode batching. */
  encode?: StaticSurfaceEncodePacing;
  /** HOST VETO, consulted inside the "should I swap this?" decision right beside the dormancy check.
   *  Return false to keep a surface on its canvas — for a host running its own occlusion /
   *  virtualizer pass over the same DOM, this is how it says "I already claimed this element",
   *  which is the only way two mechanisms can avoid both owning one element's `display`. */
  canFreezeSurface?: (node: HTMLElement, canvas: HTMLCanvasElement) => boolean;
  /** Standing verification cadence over the swapped set, ms (see the module doc). 0 disables it.
   *  Default: `DEFAULT_SURFACE_WATCHDOG_MS` for the `quiet-window` gate (which REQUIRES it), 0 for
   *  `content-key` (whose invariant makes it unnecessary, and which therefore keeps costing zero
   *  idle wakeups). */
  watchdogMs?: number;
  /** RESERVED FOR THE HOST RUNTIME — the code that owns the bindings, not the end consumer that
   *  configures it. Called once after a swap is undone, for ANY cause, with the revert already
   *  complete (entry released, `<img>` gone, canvas visibility restored), so a re-entrant
   *  `revertStaticImage` from inside it finds nothing to revert and is a no-op.
   *
   *  WHY IT EXISTS. A revert normally uncovers a canvas that still holds the right frame — that is
   *  the mechanism's safety net, and it needs no notification. `claimStaticStill` breaks that
   *  assumption on purpose: a surface mounted straight from a cached still has NEVER painted, so
   *  under its `<img>` is a canvas with no pixels (and, in the runtime this was written for, no
   *  context and no backing store either). An AUTONOMOUS revert — the watchdog, a host
   *  `invalidateStaticSurfaces`, a re-size — would therefore uncover a blank surface with nothing
   *  scheduled to fix it. This is how that runtime hears about it in time to build the surface and
   *  draw, in the same task, before anything composites.
   *  A runtime that wraps a consumer's policy MUST run the consumer's handler too, if one was given;
   *  this module calls exactly the one function it is handed.
   *  A handler that throws is a host bug and is swallowed here: it must not be able to leave a
   *  half-reverted surface behind. */
  onRevert?: (binding: StaticImageSwapBinding) => void;
  /** Injectable monotonic clock, ms. Default `performance.now()` (falling back to `Date.now()`). */
  now?: () => number;
  /** Injectable timer seam. Both must be supplied together; absent ⇒ the globals, and where there is
   *  no timer host at all (SSR) every deferred path is simply inert. */
  setTimeout?: (fn: () => void, ms: number) => StaticSurfaceTimerHandle;
  clearTimeout?: (handle: StaticSurfaceTimerHandle) => void;
}

/** The public option shape: `true`/`false` keep their original meaning, an object supplies policy. */
export type StaticSurfaceOption = boolean | StaticSurfacePolicy;

// ---- counters (public) ------------------------------------------------------------------------

/** Why a live swap was undone. `staticImageRevertsByCause` splits the aggregate by these. */
export type StaticImageRevertCause =
  /** The content key moved (the `content-key` gate's churn case). */
  | "key-change"
  /** The surface stopped producing frozen output at all (the host reported a null key). */
  | "not-frozen"
  /** The surface drew again (the `quiet-window` gate's thaw). */
  | "draw"
  /** A host `invalidateStaticSurfaces` call. */
  | "host-invalidate"
  /** The watchdog found a surface that was no longer legitimately frozen. */
  | "watchdog"
  /** A runtime-wide deliberate change: a re-size, a pixel-ratio pin, a mode flip, the kill switch,
   *  or a geometry move of the canvas itself. */
  | "resize"
  /** A dormancy wake whose next repaint cannot be attributed (see `noteStaticSurfaceWake`). */
  | "dormancy-wake"
  /** The `<img>` would not decode. */
  | "decode-failure";

const REVERT_CAUSES: readonly StaticImageRevertCause[] = [
  "key-change",
  "not-frozen",
  "draw",
  "host-invalidate",
  "watchdog",
  "resize",
  "dormancy-wake",
  "decode-failure",
];

/** The counters this module bumps on the host's live stats object (`WebglShaderRuntimeStats`
 *  extends this). Build one with `createStaticImageSwapCounters()` so a later field addition does
 *  not break every construction site. */
export interface StaticImageSwapCounters {
  /** COUNTER. Surfaces whose `<img>` went live (canvas hidden). Monotonic; a surface that swaps,
   *  reverts and swaps again counts twice. */
  staticImageSwaps: number;
  /** COUNTER. Live swaps undone, for ANY reason — the aggregate of `staticImageRevertsByCause`,
   *  kept under its original name so existing dashboards keep working. Disposal does NOT count
   *  (the surface is gone, not reverted). */
  staticImageReverts: number;
  /** COUNTER, per cause (see `StaticImageRevertCause`). Sums to `staticImageReverts`. */
  staticImageRevertsByCause: Record<StaticImageRevertCause, number>;
  /** COUNTER. Frames encoded — ONE per distinct content key, however many surfaces share it.
   *  Counted when the blob is in hand. */
  staticImageEncodes: number;
  /** COUNTER. Encodes/decodes that failed or are unsupported (`toBlob` missing, a null blob, an
   *  `<img>` that would not decode). Every one of them leaves the surface on its canvas. */
  staticImageFailures: number;
  /** COUNTER. Drain passes the host's `encode.busy` predicate sent away — one per PASS, whatever the
   *  queue length. Zero unless a host supplies the predicate. NOTE, for anyone comparing across
   *  versions: a host that pins `encode.perTask` below its `slice` makes MORE passes for an identical
   *  workload, so this number rises with it. The diagnosis pair below is a ratio and is unaffected. */
  staticImageBusyDeferrals: number;
  /** COUNTER. Passes that encoded against a still-deferring signal because `busyMaxDeferMs` had
   *  elapsed. The diagnosis pair: `staticImageBusyForcedEncodes` ≈ `staticImageBusyDeferrals` means
   *  the host's predicate is stuck ON (every deferral ran the bound out), while forced ≪ deferrals is
   *  the signal working as intended — bursts ridden out, quiet windows drained normally. */
  staticImageBusyForcedEncodes: number;
  /** COUNTER, ms. Summed SYNCHRONOUS cost of every readback (`toBlob`'s own call, any `maxDim` clamp
   *  blit included) — the main-thread park this module is charged for, as a number rather than a
   *  trace. */
  staticImageEncodeMs: number;
  /** HIGH-WATER, ms. The single worst readback. The regression probe for "N readbacks in one task":
   *  under `encode.perTask: 1` this IS the longest task the mechanism can produce. */
  staticImageEncodeMaxMs: number;
  /** COUNTER. Readbacks measured at or over `encode.slowEncodeMs`, i.e. the ones that armed the
   *  adaptive backoff. Zero unless a host asks for it. */
  staticImageSlowEncodes: number;
  /** COUNTER. Passes the ADAPTIVE BACKOFF sent away. Sibling of `staticImageBusyDeferrals`: the two
   *  split the deferral total by who asked for it (the host's predicate, or this module's own
   *  measurement of the previous readback). */
  staticImageBackoffDeferrals: number;
  /** COUNTER. Encodes that read a downscaled scratch instead of the source canvas (`encode.maxDim`). */
  staticImageClampedEncodes: number;
  /** COUNTER. Frames produced through a binding's `captureCanvas` hook — one per ENCODE (so one per
   *  distinct content key, like `staticImageEncodes`), not one per surface. Zero on a runtime whose
   *  surfaces are all directly readable canvases; on a WebGPU runtime it should track
   *  `staticImageEncodes` exactly. */
  staticImageCaptures: number;
  /** COUNTER. Capture hooks that answered null, threw, or handed back a degenerate canvas. Each one
   *  ALSO lands in `staticImageFailures` (it goes through the same `fail()`), so the aggregate keeps
   *  its meaning; this is the split that says the failure was the READBACK rather than the codec. */
  staticImageCaptureFailures: number;
  /** COUNTER. Captures REFUSED because they held no visible pixels for a frame the producer knew it
   *  had drawn (`STATIC_CAPTURE_BLANK`, see the module doc's BLANK CAPTURES). A SUBSET of
   *  `staticImageCaptureFailures` — a capture that produced nothing is a capture failure — split out
   *  because it is the one failure that would otherwise have looked like a success: without it, a
   *  device that cannot produce still pixels reads as `staticImagesLive N/N` over N invisible
   *  surfaces.
   *
   *  NON-ZERO MEANS ONE OF TWO THINGS, and they are told apart by whether the affected surfaces ever
   *  freeze again: a capture path that produces nothing on this device/launch mode (every capture
   *  blank, nothing swaps, and the surfaces stay on their canvases — the correct outcome), or a
   *  producer claiming coverage for a frame that really is invisible, which costs that surface its
   *  freeze and nothing else. Each blank is TERMINAL for its surface under either `onInvalidate`.
   *
   *  ZERO IS NOT A CLEAN BILL OF HEALTH FOR A 2D-BACKED FLEET. Only a CAPTURE HOOK can book this;
   *  a surface read directly through `toBlob` has no equivalent check, on purpose and on evidence
   *  (the module doc's WHY THE DIRECT PATH IS NOT GUARDED). */
  staticImageBlankCaptures: number;
  /** COUNTER, ms. Summed WALL time of every capture hook. Deliberately NOT part of
   *  `staticImageEncodeMs`: that number means synchronous main-thread park, and a GPU `mapAsync`
   *  readback does not park the main thread (see the module doc's CAPTURE-HOOK section). */
  staticImageCaptureMs: number;
  /** HIGH-WATER, ms. The single slowest capture — the probe for a GPU that has stopped handing
   *  pixels over promptly, and the number `encode.slowEncodeMs` is compared against on this path. */
  staticImageCaptureMaxMs: number;
  /** COUNTER. Freezes served from a PARKED still — a re-attach that cost no readback at all because
   *  the canvas had not been painted or re-allocated since the entry was encoded (see the module
   *  doc). Zero unless a host sets `encode.parkedStillBytes`. */
  staticImageReuseHits: number;
  /** COUNTER. `claimStaticStill` calls that found an attachable entry for the key — one with a URL
   *  in hand, live or retained. THE measurement of the second-appearance shortcut: a hit is a
   *  surface that skipped the gate, the paint and the encode entirely. */
  staticStillCacheHits: number;
  /** COUNTER. `claimStaticStill` calls that found nothing attachable, so the caller must render the
   *  surface itself — no entry, a failed one, or an encode still IN FLIGHT (which has no URL yet;
   *  the caller cannot wait, so it renders, and the ordinary gate will swap it when it settles). A
   *  steady stream of these against a stable key population means the stills are not surviving —
   *  check `staticStillRetainedEntries` and `encode.stillCacheBytes` before blaming the keys. */
  staticStillCacheMisses: number;
  /** COUNTER. Claimed stills whose `<img>` actually went live (decoded and mounted). Sits below
   *  `staticStillCacheHits` by exactly the claims that were undone before their decode finished — a
   *  revert, a dispose, or a decode failure — which is the only way to tell "the key was there" from
   *  "the pixels reached the screen". */
  staticStillMounts: number;
  /** COUNTER. `bakeStill` calls that really enqueued an encode (a bake for a known key, a solo key,
   *  or an unreadable canvas is a no-op and books nothing). One per key, by construction. */
  staticStillBakes: number;
  /** GAUGE — entries sitting in the module-wide still pool RIGHT NOW, parked and retained together
   *  (see the module doc's "RETAINED STILLS"). Read through `staticStillPoolStats()`; like
   *  `staticImageUrlsLive` it is document-wide rather than per runtime, and a host refreshes it on
   *  each `stats()` read. */
  staticStillRetainedEntries: number;
  /** GAUGE — bytes those entries pin (each blob's own `size`, as recorded at publish). The number to
   *  compare against `parkedStillBytes + stillCacheBytes`: at the budget, the pool is evicting. */
  staticStillRetainedBytes: number;
  /** GAUGE — how many OBJECT URLS are alive right now, MODULE-wide (across every runtime in the
   *  document), refreshed on each `stats()` read. This is the leak probe: it must come back to 0
   *  after the last runtime is disposed. NOT a swap count — one URL can back many surfaces, and under
   *  `encode.parkedStillBytes` a URL held by NO surface still counts, because its bytes are still
   *  pinned. Dispose revokes those too, so the probe is unaffected. */
  staticImageUrlsLive: number;
  /** GAUGE — how many SURFACES are swapped right now (`<img>` up, canvas hidden) against THIS
   *  counters object, i.e. per runtime. Rises on swap, falls on revert AND on dispose, so it comes
   *  back to 0 at teardown. This is the "is the mechanism actually engaged?" measurement (`72/72`);
   *  `staticImageUrlsLive` cannot answer that, because one URL can back many surfaces. */
  staticImagesLive: number;
}

/** A zeroed counters object (see `StaticImageSwapCounters`). */
export function createStaticImageSwapCounters(): StaticImageSwapCounters {
  const byCause = {} as Record<StaticImageRevertCause, number>;
  for (const cause of REVERT_CAUSES) byCause[cause] = 0;
  return {
    staticImageSwaps: 0,
    staticImageReverts: 0,
    staticImageRevertsByCause: byCause,
    staticImageEncodes: 0,
    staticImageFailures: 0,
    staticImageBusyDeferrals: 0,
    staticImageBusyForcedEncodes: 0,
    staticImageEncodeMs: 0,
    staticImageEncodeMaxMs: 0,
    staticImageSlowEncodes: 0,
    staticImageBackoffDeferrals: 0,
    staticImageClampedEncodes: 0,
    staticImageCaptures: 0,
    staticImageCaptureFailures: 0,
    staticImageBlankCaptures: 0,
    staticImageCaptureMs: 0,
    staticImageCaptureMaxMs: 0,
    staticImageReuseHits: 0,
    staticStillCacheHits: 0,
    staticStillCacheMisses: 0,
    staticStillMounts: 0,
    staticStillBakes: 0,
    staticStillRetainedEntries: 0,
    staticStillRetainedBytes: 0,
    staticImageUrlsLive: 0,
    staticImagesLive: 0,
  };
}

// ---- per-surface state ------------------------------------------------------------------------

/** Per-surface swap state. Present only while the mechanism is enabled — `null` is the kill switch,
 *  and the host's render path then takes exactly the code it took before this module existed. */
export interface StaticImageState {
  /** The content key of the frame the canvas currently holds (null until the first cacheable render,
   *  and typically null throughout for a keyless `quiet-window` surface). */
  key: string | null;
  /** Consecutive unchanged observations of `key` (the `content-key` gate). */
  stable: number;
  /** The stand-in element, once one exists (created at swap time, dropped on revert). */
  img: HTMLImageElement | null;
  /** The refcounted per-key object-URL entry this surface holds, or null. Non-null covers BOTH "the
   *  encode/decode is in flight" and "the `<img>` is live" — see `shown`. */
  entry: StaticImageEntry | null;
  /** The entry this surface's LAST freeze left parked (`encode.parkedStillBytes`), held by nobody and
   *  claimable only by this surface. Mutually exclusive with `entry`: a surface holds its still or
   *  parks it, never both. */
  parked: StaticImageEntry | null;
  /** The reuse fingerprint `parked` was stamped with — the paint count and backing-store size the
   *  entry was ENCODED at. `reclaimParkedStill` re-attaches only while the canvas still reports all
   *  three unchanged, which is the whole correctness argument for handing back old pixels. */
  parkedDrawSeq: number;
  parkedW: number;
  parkedH: number;
  /** The `<img>` is mounted and standing in for the canvas. */
  shown: boolean;
  /** The entry this surface currently holds was taken by `claimStaticStill` rather than earned
   *  through the gate — i.e. this canvas has never painted the frame the `<img>` is showing, and may
   *  never have painted at all. Cleared when the entry is let go. Read only to split
   *  `staticStillMounts` out of the ordinary swap count; the mechanics below treat a claimed surface
   *  exactly like any other, which is deliberate — its stand-in reverts, re-syncs and is refcounted
   *  by the same code. */
  claimed: boolean;
  /** Disqualified for the life of the binding (only reachable under `onInvalidate: "block"`). */
  blocked: boolean;
  /** The swapper this surface belongs to: its policy, its encode queue, its timers. Every free
   *  function in this module reads the policy from here, so one document can run several runtimes
   *  under different policies. */
  swapper: SwapperContext;
  /** The counters object this surface's TIMER-driven paths (sweep, watchdog, retry, dispose) bump.
   *  Seeded when the swapper attaches the binding and refreshed by every call that carries one, so
   *  a deferred revert lands on the same object the synchronous ones did. */
  counters: StaticImageSwapCounters | null;
  /** `now()` of the last reported paint into this canvas — the `quiet-window` gate's clock. */
  lastDrawAt: number;
  /** Monotonic count of reported paints; the watchdog compares it against `drawSeqAtFreeze`. */
  drawSeq: number;
  drawSeqAtFreeze: number;
  /** Backing-store size at freeze time: a `width`/`height` write REALLOCATES (and clears) a canvas,
   *  which the watchdog reads as an unexplained repaint. */
  frozenW: number;
  frozenH: number;
  /** The canvas's inline style at freeze time. The stand-in copies the box ONCE, so a later
   *  placement write would leave it at the old box — the watchdog re-syncs on a mismatch. */
  boxCss: string;
  /** Earliest `now()` at which a failed encode/decode may be retried (`onInvalidate: "retry"`). */
  retryAfter: number;
  /** THIS module hid the canvas (so it, and only it, may un-hide it). */
  hidCanvas: boolean;
  /** The canvas's `display` as the HOST left it, captured the moment this module first hid it and
   *  restored verbatim when it un-hides. */
  hostDisplay: string;
}

/** The subset of a host runtime's node binding this module touches. Structural on purpose: it keeps
 *  the swap independently testable and keeps the host runtimes free of a back-import. */
export interface StaticImageSwapBinding {
  /** The host's node element — passed to `canFreezeSurface`, never otherwise read or written. */
  node: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Set whenever the canvas may not match `state.key` yet (a pending re-render, a realloc that
   *  cleared it). The gate refuses to encode from a dirty binding. */
  dirty: boolean;
  /** Parked by the host: observes nothing, and hides BOTH surfaces. */
  dormant: boolean;
  /** ASYNC ENCODE SOURCE, for a surface whose own canvas cannot be read back — a WebGPU one, whose
   *  every canvas-read path is blank headless and pathological on Android (see the module doc's
   *  CAPTURE-HOOK SOURCES). Returns a fresh 2D canvas holding the frame the surface is CURRENTLY
   *  showing, at its backing-store size, or null when it cannot be produced; this module encodes
   *  that canvas and then releases it. `STATIC_CAPTURE_BLANK` is the third answer: the capture
   *  completed and holds NOTHING VISIBLE, for a frame the producer knows it drew (see the module
   *  doc's BLANK CAPTURES). ABSENT ⇒ `canvas` is read directly, which is what every 2D-backed
   *  surface does and is exactly the path that shipped first. */
  captureCanvas?: () => Promise<StaticSurfaceCapture>;
  staticImage: StaticImageState | null;
}

/** One encoded frame, shared by every surface on that content key. */
export interface StaticImageEntry {
  key: string;
  /** Surfaces holding this entry (swapped or waiting for the encode). At 0 the URL is revoked. */
  refs: number;
  url: string | null;
  /** The encode failed / is unsupported and no one may retry this key. Only ever set under
   *  `onInvalidate: "block"` — a `retry` policy drops the entry instead, so the key stays open. */
  failed: boolean;
  /** Encoded size in bytes, captured from the blob at publish (0 until then). The still pool budgets
   *  on this: what a pooled entry costs is its retained pixels, not its pixel count. */
  bytes: number;
  /** Surfaces waiting for the in-flight encode. */
  waiters: Set<StaticImageSwapBinding>;
  /** BORN HELD BY NOBODY: this entry was created by `bakeStill` for a key with no waiting surface,
   *  so `refs: 0` is its normal state and not the "everyone let go" that the encode tail drops an
   *  entry for. The three places that read `refs <= 0` as abandonment — the queue drain, the capture
   *  tail and `publish` — consult this to tell the two apart. A published bake goes straight into
   *  the retained pool, where the flag stops mattering: from then on it behaves like any other
   *  unheld entry. */
  bake: boolean;
}

// ---- module registry --------------------------------------------------------------------------

/** Live entries by key, DOCUMENT-wide (key dedup is worth more than swapper isolation). An entry
 *  leaves this map when its last holder releases it (revoked) or when the host evicts the key
 *  (retired — current holders keep it, no new holder attaches). */
const entriesByKey = new Map<string, StaticImageEntry>();
let liveUrls = 0;
/** Set once when the environment has no usable `toBlob`/`createObjectURL`, so a swapless environment
 *  (jsdom, an old engine) costs one boolean instead of an entry per key. */
let encodeUnsupported = false;
/** Mints the private synthetic keys keyless surfaces encode under (see the module doc). */
let soloKeySeq = 0;
/** The prefix of those synthetic keys — a NUL, written as an ESCAPE here and not embedded, so this
 *  file stays greppable (an embedded NUL makes `grep` treat the whole source as binary). A host key
 *  is a shader path, a params digest, a spec string; none of them can begin with one, which is the
 *  point: a synthetic key is NOT a shareable identity, and must never be retained, baked or
 *  claimed. */
const SOLO_KEY_PREFIX = "\0solo:";
/** Whether a key is one of this module's own private synthetic ones (see `SOLO_KEY_PREFIX`). */
function isSoloKey(key: string): boolean {
  return key.startsWith(SOLO_KEY_PREFIX);
}

/** One unheld entry's place in the still pool. */
interface PooledStill {
  /** The ONE surface state allowed to reclaim it by FINGERPRINT (a parked still, see `parkStill`),
   *  or null for a still retained by KEY — claimable by whatever surface reaches that key next, and
   *  therefore owned by nobody. */
  owner: StaticImageState | null;
  /** The swapper the entry was pooled on behalf of, so a teardown can revoke exactly the bytes it is
   *  responsible for. An entry re-enters the pool on each release, so this always names the LAST
   *  swapper to let go of it — which is the only one that can still be said to be holding the bytes
   *  open. */
  ctx: SwapperContext;
}

/** THE STILL POOL, DOCUMENT-wide: entries with no holder whose pixels may still be re-attachable —
 *  PARKED (owner-bound, fingerprint-checked) and RETAINED (keyed, ownerless) together, because they
 *  are one commodity and one LRU is a better allocator over it than two (see the module doc's
 *  "RETAINED STILLS"). Map iteration is insertion order and pooling always inserts fresh, which is
 *  what makes the eviction scan a plain least-recently-pooled walk. Bounded by `pooledBytes` against
 *  the sum of the two budgets. */
const stillPool = new Map<StaticImageEntry, PooledStill>();
let pooledBytes = 0;
/** Keys this document has ever ENCODED, for `encode.primeUnseenKeys` — the exemption is for the
 *  FIRST encode of a key, and nothing else here remembers a key after its entry is gone.
 *  CAPPED, and the cap fails safe: past `PRIMED_KEY_MEMORY` the set stops growing, every key then
 *  reads as "seen", and the exemption simply stops applying. A host churning through thousands of
 *  distinct keys is not the population this option is for, and an unbounded set of strings pinned
 *  for the life of the document would be a leak dressed as an optimization. */
const encodedKeys = new Set<string>();
const PRIMED_KEY_MEMORY = 512;

// ---- the swapper ------------------------------------------------------------------------------

/** `SwapperContext.busyDeferSince` when no run of `busy` deferrals is in progress. `+Infinity` so the
 *  bound test (`now - since >= busyMaxDeferMs`) is false by arithmetic rather than by a special case. */
const NOT_DEFERRING = Number.POSITIVE_INFINITY;

interface ResolvedPolicy {
  quietWindow: boolean;
  observations: number;
  quietMs: number;
  /** The quiet window for a surface whose last reported key was non-null (`keyedQuietMs`, defaulted
   *  to `quietMs` here so every read site is one lookup and the inert case costs nothing). */
  keyedQuietMs: number;
  retry: boolean;
  slice: number;
  intervalMs: number;
  smallestFirst: boolean;
  deferHead: boolean;
  busy: (() => boolean) | null;
  busyMaxDeferMs: number;
  perTask: number;
  taskGapMs: number;
  slowEncodeMs: number;
  slowBackoffMs: number;
  maxDim: number;
  parkedStillBytes: number;
  stillCacheBytes: number;
  /** What the shared pool is trimmed to: the two budgets added, because the two kinds of unheld
   *  still are the same bytes (see the module doc). Precomputed so the eviction walk reads one
   *  number. */
  poolBytes: number;
  primeUnseenKeys: boolean;
  watchdogMs: number;
  canFreeze: ((node: HTMLElement, canvas: HTMLCanvasElement) => boolean) | null;
  onRevert: ((binding: StaticImageSwapBinding) => void) | null;
  now: () => number;
  setT: ((fn: () => void, ms: number) => StaticSurfaceTimerHandle) | null;
  clearT: (handle: StaticSurfaceTimerHandle) => void;
}

interface EncodeJob {
  entry: StaticImageEntry;
  canvas: HTMLCanvasElement;
  /** The binding's async encode source, or null for the ordinary "read the canvas" path. Captured
   *  at ENQUEUE so the job stays self-contained: the queue outlives the call that made the surface
   *  eligible, and the pacing must not have to reach back into a binding to drain. */
  capture: (() => Promise<StaticSurfaceCapture>) | null;
  area: number;
  counters: StaticImageSwapCounters;
  /** `bakeStill`'s completion hook, or undefined for an ordinary surface-driven encode (whose
   *  completion IS its `<img>` going up). Called exactly once, wherever the job ends. */
  settle?: (published: boolean) => void;
}

/** One policy + its bookkeeping. Shared by every surface the swapper attached. */
interface SwapperContext {
  policy: ResolvedPolicy;
  counters: StaticImageSwapCounters | null;
  bindings: Set<StaticImageSwapBinding>;
  queue: EncodeJob[];
  /** Start of the current encode WINDOW, and how many encodes it has already kicked (see
   *  `pumpEncodes`). */
  sliceAt: number;
  sliceCount: number;
  /** Readbacks the CURRENT task has already spent (`encode.perTask`). Reset only where a task
   *  boundary is actually observable — inside a timer callback — because the module is handed the
   *  thread many times per task: one `runSweep` calls `maybeSwap` for every eligible surface, and
   *  each of those reaches `pumpEncodes` on the SAME stack. A per-call counter would therefore bound
   *  nothing at all on the path that produced the measured 1,163 ms park. */
  taskKicks: number;
  /** `now()` the CURRENT unbroken run of deferrals started, or `NOT_DEFERRING`. The bound is measured
   *  from here and restarts on every forced pass, so it caps a RUN rather than the queue's total wait
   *  — and it is ONE run whichever reason is deferring (see `encodeDeferred`). */
  busyDeferSince: number;
  /** `now()` until which the adaptive slow-encode backoff holds encodes (0 = not backing off). */
  backoffUntil: number;
  /** The scratch canvas `encode.maxDim` downscales into, allocated on the first clamped encode and
   *  released at dispose. ONE per swapper: `toBlob` snapshots its source synchronously in Blink (the
   *  guarantee gsw's own perf harness already depends on — `scenarios/static-surfaces.ts`), so reuse
   *  cannot race a blob still being compressed. */
  scratch: HTMLCanvasElement | null;
  drainTimer: StaticSurfaceTimerHandle | null;
  sweepTimer: StaticSurfaceTimerHandle | null;
  /** Absolute `now()` the armed sweep fires at (so an arm never postpones an earlier one). */
  sweepAt: number;
  lastWatchdogAt: number;
  disposed: boolean;
}

/** The host-facing handle: everything that needs to enumerate the swapper's surfaces. Per-surface
 *  signalling stays in the free functions below, which read the policy off the surface's state. */
export interface StaticSurfaceSwapper {
  /** Give a binding swap state and start watching it. Idempotent. */
  attach(binding: StaticImageSwapBinding): void;
  /** Drop the stand-in, release the URL ref and stop watching (dispose / kill switch). */
  detach(binding: StaticImageSwapBinding): void;
  /** HOST-DRIVEN revert WITHOUT block: all attached surfaces, or just the given ones. The gate
   *  restarts, so each surface re-earns its swap. */
  invalidate(bindings?: Iterable<StaticImageSwapBinding>): void;
  /** How many of this swapper's surfaces are swapped right now (the `staticImagesLive` gauge, per
   *  swapper rather than per counters object). */
  liveSwapCount(): number;
  /** Jobs waiting in this swapper's encode queue. The seam a host needs to hold SPECULATIVE work
   *  (`bakeStill`) behind the surfaces that actually want a still: the queue is ordered
   *  smallest-first, not by who asked, so a bake enqueued mid-burst competes with live candidates
   *  for the same slice budget. `0` is the host's "the fleet has drained, spend a readback on
   *  something nobody is waiting for". */
  queueLength(): number;
  /**
   * Encode `key` from `source` with NO waiting surface, and retain the result (see the module doc's
   * "BAKING A STILL"). For banking the pixels of a surface that is about to disappear, so the NEXT
   * surface to reach that key can claim it instead of rendering it.
   *
   * `source` is structural — `{canvas, captureCanvas?}`, the same pair a binding carries — so the
   * whole existing encode tail applies unchanged: pacing, `perTask`, `busy`, `maxDim`, the capture
   * hook, and publication into `entriesByKey`. Deliberately NOT gated on `canvas.isConnected`, which
   * the ordinary freeze path does check: the whole point is a surface on its way out, and a canvas
   * out of the document reads back exactly as well as one in it.
   *
   * A NO-OP, booking nothing, when the key is already known in ANY state (live, retained, in flight
   * or failed — its pixels either exist or have been proven unobtainable), when the key is a private
   * synthetic one (nothing could ever look it up), when retention is off (`encode.stillCacheBytes`),
   * when the canvas is zero-sized, or when the environment cannot encode.
   *
   * `onSettled` — if given — fires exactly once, with `true` when the entry was published and
   * retained and `false` for every other outcome, the synchronous no-ops included. It exists so a
   * host holding a donor surface alive for its pixels can release it the moment the bake lands,
   * rather than polling.
   */
  bakeStill(
    source: StaticStillBakeSource,
    key: string,
    counters: StaticImageSwapCounters,
    onSettled?: (published: boolean) => void,
  ): void;
  /** Revert everything, cancel every timer, forget every surface. */
  dispose(): void;
}

/** What `bakeStill` reads pixels from: a canvas, or — where that canvas cannot be read at all — the
 *  same async capture hook a binding supplies (see `StaticImageSwapBinding.captureCanvas`).
 *  Structural on purpose: a host may pass a live binding, or a detached surface it is holding open
 *  only for its pixels. */
export interface StaticStillBakeSource {
  canvas: HTMLCanvasElement;
  captureCanvas?: () => Promise<StaticSurfaceCapture>;
}

function defaultNow(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function resolvePolicy(
  option: StaticSurfaceOption | undefined,
): ResolvedPolicy {
  const policy: StaticSurfacePolicy =
    option === undefined || typeof option === "boolean" ? {} : option;
  const gate = policy.gate ?? { kind: "content-key" };
  const quietWindow = gate.kind === "quiet-window";
  const encode = policy.encode ?? {};
  const hostSetTimeout = policy.setTimeout;
  const hostClearTimeout = policy.clearTimeout;
  let setT: ((fn: () => void, ms: number) => StaticSurfaceTimerHandle) | null;
  let clearT: (handle: StaticSurfaceTimerHandle) => void;
  if (
    typeof hostSetTimeout === "function" &&
    typeof hostClearTimeout === "function"
  ) {
    setT = hostSetTimeout;
    clearT = hostClearTimeout;
  } else if (typeof setTimeout === "function") {
    setT = (fn, ms) => setTimeout(fn, ms);
    clearT = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>);
  } else {
    // No timer host at all (SSR/shell): every deferred path is simply inert.
    setT = null;
    clearT = () => {};
  }
  const slice = Math.max(1, encode.slice ?? DEFAULT_ENCODE_SLICE);
  const quietMs =
    gate.kind === "quiet-window" && typeof gate.quietMs === "number"
      ? Math.max(0, gate.quietMs)
      : DEFAULT_QUIET_WINDOW_MS;
  const parkedStillBytes = Math.max(
    0,
    encode.parkedStillBytes ?? DEFAULT_PARKED_STILL_BYTES,
  );
  const stillCacheBytes = Math.max(
    0,
    encode.stillCacheBytes ?? DEFAULT_STILL_CACHE_BYTES,
  );
  return {
    quietWindow,
    observations:
      gate.kind === "content-key" && typeof gate.observations === "number"
        ? Math.max(1, gate.observations)
        : STABLE_OBSERVATIONS_BEFORE_SWAP,
    quietMs,
    // Absent ⇒ the plain window, so a host that has not asked for the keyed deadline cannot tell
    // this option exists (see `gateSatisfied`, which reads one or the other per surface).
    keyedQuietMs:
      gate.kind === "quiet-window" && typeof gate.keyedQuietMs === "number"
        ? Math.max(0, gate.keyedQuietMs)
        : quietMs,
    retry: policy.onInvalidate === "retry",
    slice,
    intervalMs: Math.max(0, encode.intervalMs ?? DEFAULT_ENCODE_INTERVAL_MS),
    smallestFirst: (encode.order ?? "smallest-first") === "smallest-first",
    deferHead: encode.deferHead === true,
    busy: typeof encode.busy === "function" ? encode.busy : null,
    // 0 is the host asking for the deferral apparatus to be IGNORED, so it is preserved rather than
    // floored to a minimum; a negative number reads the same way.
    busyMaxDeferMs: Math.max(
      0,
      encode.busyMaxDeferMs ?? DEFAULT_ENCODE_BUSY_MAX_DEFER_MS,
    ),
    // Absent (or nonsense) reads as "the whole slice", i.e. today's one-task-per-window drain. A host
    // that pins a number gets at least one readback per task — 0 would be a pump that never encodes.
    perTask:
      typeof encode.perTask === "number" && encode.perTask > 0
        ? Math.max(1, encode.perTask)
        : slice,
    taskGapMs: Math.max(0, encode.taskGapMs ?? DEFAULT_ENCODE_TASK_GAP_MS),
    slowEncodeMs: Math.max(0, encode.slowEncodeMs ?? DEFAULT_ENCODE_SLOW_MS),
    slowBackoffMs: Math.max(
      0,
      encode.slowBackoffMs ?? DEFAULT_ENCODE_SLOW_BACKOFF_MS,
    ),
    maxDim: Math.max(0, encode.maxDim ?? DEFAULT_ENCODE_MAX_DIM),
    parkedStillBytes,
    stillCacheBytes,
    poolBytes: parkedStillBytes + stillCacheBytes,
    primeUnseenKeys: encode.primeUnseenKeys === true,
    // The quiet-window gate has no content invariant, so it does not ship without the watchdog; the
    // content-key gate keeps costing zero idle wakeups unless the host asks for one.
    watchdogMs:
      typeof policy.watchdogMs === "number"
        ? Math.max(0, policy.watchdogMs)
        : quietWindow
          ? DEFAULT_SURFACE_WATCHDOG_MS
          : 0,
    canFreeze:
      typeof policy.canFreezeSurface === "function"
        ? policy.canFreezeSurface
        : null,
    onRevert: typeof policy.onRevert === "function" ? policy.onRevert : null,
    now: typeof policy.now === "function" ? policy.now : defaultNow,
    setT,
    clearT,
  };
}

function createContext(
  option: StaticSurfaceOption | undefined,
  counters: StaticImageSwapCounters | null,
): SwapperContext {
  const policy = resolvePolicy(option);
  return {
    policy,
    counters,
    bindings: new Set(),
    queue: [],
    sliceAt: Number.NEGATIVE_INFINITY,
    sliceCount: 0,
    taskKicks: 0,
    busyDeferSince: NOT_DEFERRING,
    backoffUntil: 0,
    scratch: null,
    drainTimer: null,
    sweepTimer: null,
    sweepAt: Number.POSITIVE_INFINITY,
    lastWatchdogAt: policy.now(),
    disposed: false,
  };
}

/** The context every surface created by the bare `createStaticImageState()` belongs to: the default
 *  policy, no registrations, and therefore no timers of its own. */
const defaultContext = createContext(true, null);

/**
 * Create a swapper for one host runtime. `false` ⇒ null (the mechanism is off and the caller keeps
 * its pre-existing path); `true`/undefined ⇒ the default policy; an object ⇒ that policy.
 */
export function createStaticSurfaceSwapper(
  option: StaticSurfaceOption | undefined,
  counters: StaticImageSwapCounters,
): StaticSurfaceSwapper | null {
  if (option === false) return null;
  const ctx = createContext(option, counters);
  return {
    attach(binding: StaticImageSwapBinding): void {
      if (ctx.disposed) return;
      binding.staticImage ??= createStaticImageState(ctx);
      const state = binding.staticImage;
      state.swapper = ctx;
      state.counters ??= counters;
      state.lastDrawAt = ctx.policy.now();
      // The host may already have parked this canvas before any swap state existed (a binding BORN
      // dormant hides it at create). The dormant park is this module's own semantic, so adopt
      // ownership of that hide rather than reading it as "the host wants this canvas hidden and I
      // must never touch it" — the value to restore on wake is the pre-park default, which is
      // exactly what the un-owned path used to write.
      if (
        binding.dormant &&
        !state.hidCanvas &&
        binding.canvas.style.display === "none"
      ) {
        state.hidCanvas = true;
        state.hostDisplay = "";
      }
      ctx.bindings.add(binding);
      // A surface that never draws at all must still become eligible — its window starts here.
      if (ctx.policy.quietWindow) armSweep(ctx);
    },
    detach(binding: StaticImageSwapBinding): void {
      disposeStaticImage(binding);
      ctx.bindings.delete(binding);
      binding.staticImage = null;
    },
    invalidate(bindings?: Iterable<StaticImageSwapBinding>): void {
      for (const binding of bindings ?? ctx.bindings) {
        const state = binding.staticImage;
        if (!state) continue;
        state.counters ??= counters;
        if (state.entry) {
          revert(binding, state.counters ?? counters, false, "host-invalidate");
        }
        resetGate(state, ctx.policy.now());
      }
      armSweep(ctx);
    },
    liveSwapCount(): number {
      let live = 0;
      for (const binding of ctx.bindings) {
        if (binding.staticImage?.shown === true) live++;
      }
      return live;
    },
    queueLength(): number {
      return ctx.queue.length;
    },
    bakeStill(source, key, counters, onSettled): void {
      bakeStillInto(ctx, source, key, counters, onSettled);
    },
    dispose(): void {
      ctx.disposed = true;
      cancelTimers(ctx);
      for (const binding of [...ctx.bindings]) {
        disposeStaticImage(binding);
        binding.staticImage = null;
      }
      ctx.bindings.clear();
      ctx.queue.length = 0;
      // Every unheld still this swapper is responsible for goes with it. A RETAINED entry has no
      // holder and no owning surface, so nothing above can have reached it — and it must still not
      // outlive the runtime that banked it, or the leak probe (`staticImageUrlsLive` back to 0 at
      // teardown) would be reporting bytes nobody can free. Entries pooled by ANOTHER live swapper
      // are left alone: the pool is document-wide, and so is the sharing it exists for.
      for (const [entry, pooled] of [...stillPool]) {
        if (pooled.ctx === ctx) dropPooledStill(entry);
      }
      if (ctx.scratch) {
        // A 0×0 backing store releases the pixels immediately rather than at the next GC.
        ctx.scratch.width = 0;
        ctx.scratch.height = 0;
        ctx.scratch = null;
      }
    },
  };
}

export function createStaticImageState(
  swapper: SwapperContext = defaultContext,
): StaticImageState {
  return {
    key: null,
    stable: 0,
    img: null,
    entry: null,
    parked: null,
    parkedDrawSeq: -1,
    parkedW: 0,
    parkedH: 0,
    shown: false,
    claimed: false,
    blocked: false,
    swapper,
    counters: swapper.counters,
    lastDrawAt: swapper.policy.now(),
    drawSeq: 0,
    drawSeqAtFreeze: -1,
    frozenW: 0,
    frozenH: 0,
    boxCss: "",
    retryAfter: 0,
    hidCanvas: false,
    hostDisplay: "",
  };
}

/** Object URLs alive across the document (the `staticImageUrlsLive` gauge). */
export function liveStaticImageUrlCount(): number {
  return liveUrls;
}

/** The still pool's two GAUGES, document-wide (`staticStillRetainedEntries` /
 *  `staticStillRetainedBytes`) — parked and retained entries together, since they share the budget
 *  those numbers are read against. Sampled by a host on each `stats()` read, exactly like
 *  `liveStaticImageUrlCount`. */
export function staticStillPoolStats(): { entries: number; bytes: number } {
  return { entries: stillPool.size, bytes: pooledBytes };
}

/** Is there an entry for `key` in ANY state — live, in flight, retained or failed?
 *
 *  The question a host asks before spending anything on a key: "are these pixels already accounted
 *  for?". A `true` means a `bakeStill` would be a no-op and a `claimStaticStill` will probably hit
 *  (probably, not certainly — an in-flight encode has no URL yet, and a failed one never will). It
 *  is deliberately NOT "can I claim this right now": that answer is `claimStaticStill`'s own return,
 *  and asking it twice would be two lookups and a race between them. */
export function hasStaticStill(key: string): boolean {
  return entriesByKey.has(key);
}

// ---- per-surface signalling (the free functions the host render path calls) ---------------------

/**
 * The canvas was just PAINTED, with the frame `key` names — the module's one per-draw signal, and
 * therefore the `quiet-window` gate's clock. `key` is null when the paint was not cacheable frozen
 * output at all (live mode, a screen-space shader, textures still loading), which retires a live
 * swap under the `content-key` gate. Called AFTER the pixels are in the canvas, so a revert always
 * uncovers a correct, current frame.
 */
export function noteStaticFrame(
  binding: StaticImageSwapBinding,
  key: string | null,
  counters: StaticImageSwapCounters,
): void {
  const state = binding.staticImage;
  if (!state) return;
  const policy = state.swapper.policy;
  state.counters = counters;
  state.drawSeq++;
  state.lastDrawAt = policy.now();
  // A PAINT is the one thing a PARKED still cannot survive (its claim is the fingerprint, and a
  // paint moves it — see `reclaimParkedStill`), so its bytes go here rather than at the next freeze
  // attempt, which for a surface that has resumed animating is a whole animation away and the pool
  // is budgeted in bytes. A RETAINED still is untouched by this: it is claimed by KEY rather than by
  // fingerprint, is owned by no surface, and this one repainting says nothing about those pixels.
  if (state.parked) dropPooledStill(state.parked);

  if (policy.quietWindow) {
    // KEYED RE-STATEMENT (see the module doc's KEYED-OR-QUIET): the surface repainted the frame it
    // is ALREADY showing. By the key's contract those are the same pixels, so reverting would take
    // a correct `<img>` down and pay a whole window plus an encode to put an identical one back —
    // which for a host that re-blits a cached frame is every frame, i.e. the mechanism never
    // engaging at all. The freeze's own evidence follows the paint (`drawSeqAtFreeze`), or the
    // watchdog would revert on the next sweep for the paint this branch just accepted.
    if (key !== null && state.key === key && state.entry) {
      state.lastDrawAt = policy.now();
      state.drawSeqAtFreeze = state.drawSeq;
      state.retryAfter = 0;
      return;
    }
    // KEYLESS: the key is not evidence here (it may be null every time), so the ONLY thing a paint
    // means is "this surface is not still". Thaw whatever stands over it and restart its window.
    state.key = key;
    state.retryAfter = 0;
    if (state.entry) {
      // A THAW makes this surface pending again, which can introduce a deadline EARLIER than the
      // one the armed sweep was computed from — so this path pays the full re-arm.
      revert(binding, counters, false, "draw");
      armSweep(state.swapper);
      return;
    }
    // A KEYED paint under a SHORTER keyed deadline is the one draw that can pull a surface's
    // eligibility IN rather than push it out (`quietWindowFor` now answers differently for this
    // surface than it did a line ago), so it pays the full re-arm — an armed sweep computed from the
    // plain window would fire a whole `quietMs` after this surface was ready. `armSweep` itself only
    // re-arms for an EARLIER deadline, so this cannot postpone anything.
    if (key !== null && policy.keyedQuietMs < policy.quietMs) {
      armSweep(state.swapper);
      return;
    }
    // HOT PATH (once per animated surface per frame): for an already-pending surface a draw only
    // ever pushes its deadline OUT, so an armed sweep is always early enough — it re-arms itself
    // when it finds nothing due. Re-computing the whole set's next deadline here would be O(N) per
    // draw per surface. Unreachable under a shorter keyed deadline, and untouched without one.
    armSweepIfIdle(state.swapper);
    return;
  }

  if (key === null) {
    // Not frozen cacheable output any more: whatever the <img> shows is no longer what this surface
    // renders. Never blocking — leaving frozen mode says nothing about the content.
    // (Already-retired is the LIVE-mode steady state, once per animated surface per frame, so it
    // returns before touching anything.)
    if (state.entry === null && state.key === null) return;
    if (state.entry) revert(binding, counters, false, "not-frozen");
    state.key = null;
    state.stable = 0;
    return;
  }
  if (state.key === key) {
    state.stable++;
    maybeSwap(binding, counters);
    return;
  }
  // CHURN. After (or during) a swap this is the case the whole gate exists to catch — the 6.4% — so
  // the surface goes back to its canvas, and under the default policy is never offered again.
  if (state.entry) revert(binding, counters, !policy.retry, "key-change");
  state.key = key;
  state.stable = 0;
  if (policy.retry) armSweep(state.swapper);
}

/**
 * One `reconcile()` in which the binding asked for no re-render — the `content-key` gate's second
 * clock (a frozen node renders once and then nothing calls the render path for it again, so
 * stability has to be observed from the outside). `frozen` is the host's frozen/static mode.
 *
 * DELIBERATELY INERT under the `quiet-window` gate: a host may gate `reconcile()` on its own dirty
 * flag, so reconciles are not a clock — see the module doc.
 */
export function noteStaticImageReconcile(
  binding: StaticImageSwapBinding,
  frozen: boolean,
  counters: StaticImageSwapCounters,
): void {
  const state = binding.staticImage;
  if (!state || !frozen) return;
  if (state.swapper.policy.quietWindow) return;
  state.counters = counters;
  if (state.entry || state.blocked || state.key === null) return;
  // A parked binding measures nothing and paints nothing; a dirty one has a re-render pending, so
  // its canvas is not (yet) the frame `state.key` names.
  if (binding.dormant || binding.dirty) return;
  state.stable++;
  maybeSwap(binding, counters);
}

/**
 * MOUNT AS `<img>` IMMEDIATELY, from a still this document has already encoded for `key` — no gate,
 * no paint, no encode (see the module doc's "CLAIMING A STILL"). Returns whether it did.
 *
 * THE PRECONDITIONS the caller must meet, and what happens when it does not:
 *   - the binding must have SWAP STATE (`swapper.attach`). Without it the mechanism is off for this
 *     surface, so this returns false and books nothing — a miss counter for a surface that could
 *     never hit would just be noise in the one number that says whether the keys are working.
 *   - the CANVAS must be in the document. The stand-in is inserted immediately BEFORE it, so a
 *     canvas with no parent leaves the swap unfinished (the entry is held, nothing is shown) until
 *     the surface is disposed. Not a corruption, but a wasted refcount.
 *   - the canvas must already carry the BOX (the inline geometry the stand-in copies verbatim). A
 *     canvas whose CSS box is written after the claim leaves the `<img>` at the old box until the
 *     watchdog re-syncs it — the same rule the ordinary freeze path lives by, arriving one step
 *     earlier.
 * A surface that is already engaged (holding an entry, already shown, or blocked) is left exactly
 * as it is, and reports a miss: two stand-ins over one canvas is not a thing this module allows.
 * A DORMANT surface is NOT refused, unlike the ordinary gate's — a park hides both surfaces either
 * way, and the caller is the one that knows whether a parked surface is worth claiming for. What is
 * refused is an entry whose encode is still IN FLIGHT: there is no URL to attach, and the caller
 * cannot be asked to wait, so it renders and the ordinary gate swaps it when the encode settles.
 *
 * A CLAIMED SURFACE HAS NEVER PAINTED, and the bookkeeping says so honestly: `drawSeq` is whatever
 * it was (0 for a fresh binding), and `frozenW`/`frozenH` are captured from a canvas that may have
 * no backing store at all. So the FIRST time such a canvas is really sized, the watchdog sees a
 * re-allocation it cannot explain and reverts. That is CORRECT, not a bug — a canvas that has just
 * been allocated is blank, and the `<img>` over it is showing a frame nothing under it can vouch
 * for. The caller hears about it through `StaticSurfacePolicy.onRevert` and takes the surface back.
 */
export function claimStaticStill(
  binding: StaticImageSwapBinding,
  key: string,
  counters: StaticImageSwapCounters,
): boolean {
  const state = binding.staticImage;
  if (!state) return false;
  state.counters = counters;
  if (state.entry || state.shown || state.blocked) {
    counters.staticStillCacheMisses++;
    return false;
  }
  const entry = entriesByKey.get(key);
  // A failed key is not a miss to retry from here: it is a key that has been PROVEN unencodable, and
  // the caller's own render path is the answer either way. It books a miss because from the caller's
  // side that is exactly what happened — there is no still to be had.
  if (!entry || entry.failed || entry.url === null) {
    counters.staticStillCacheMisses++;
    return false;
  }
  // Pooled (parked or retained) ⇒ it has a holder again: its bytes stop being the pool's to evict,
  // and any per-surface claim on it is superseded by this one.
  unpoolStill(entry);
  entry.refs++;
  state.entry = entry;
  state.key = key;
  state.claimed = true;
  counters.staticStillCacheHits++;
  attach(binding, entry, counters);
  return true;
}

/**
 * Undo a live swap and reset the gate WITHOUT blocking — for the host's own deliberate, scene-wide
 * changes (a render-scale step, a pixel-ratio pin, a frozen-mode flip, a canvas geometry move, the
 * kill switch). The surface must re-earn the gate; it is not disqualified.
 */
export function revertStaticImage(
  binding: StaticImageSwapBinding,
  counters: StaticImageSwapCounters,
  cause: StaticImageRevertCause = "resize",
): void {
  const state = binding.staticImage;
  if (!state) return;
  state.counters = counters;
  if (state.entry) revert(binding, counters, false, cause);
  resetGate(state, state.swapper.policy.now());
  armSweep(state.swapper);
}

/**
 * The host woke a DORMANT binding. The wake re-arms a repaint this module may hear nothing useful
 * about (a deferred canvas re-size CLEARS the backing store, and a keyless surface's repaint carries
 * no key to compare), so a stale `<img>` could otherwise sit over a live canvas until the watchdog
 * polls. Reverts — without blocking — when the wake cannot be attributed:
 *   - always under the `quiet-window` gate (no key, so no way to confirm the repaint matches), and
 *   - whenever the host says a canvas re-size is pending (`resizePending`), whatever the gate.
 * Under the `content-key` gate with no pending re-size this is a NO-OP: the wake's re-render reports
 * its key, and an unchanged key means the stand-in still shows exactly the right pixels.
 */
export function noteStaticSurfaceWake(
  binding: StaticImageSwapBinding,
  counters: StaticImageSwapCounters,
  resizePending: boolean,
): void {
  const state = binding.staticImage;
  if (!state) return;
  state.counters = counters;
  const policy = state.swapper.policy;
  if (!policy.quietWindow && !resizePending) return;
  if (state.entry) revert(binding, counters, false, "dormancy-wake");
  resetGate(state, policy.now());
  armSweep(state.swapper);
}

/** Binding teardown (dispose / kill switch): drop the `<img>` and release the URL ref. Not counted
 *  as a revert — the surface is gone, not returned to its canvas — but the LIVE gauge falls, so it
 *  comes back to 0 at teardown. */
export function disposeStaticImage(binding: StaticImageSwapBinding): void {
  const state = binding.staticImage;
  if (!state) return;
  if (state.shown && state.counters) state.counters.staticImagesLive--;
  detachImage(state);
  if (state.entry) {
    // A DISPOSE is a release like any other, and under `encode.stillCacheBytes` the last release of
    // a KEYED entry retains it (see the module doc's "RETAINED STILLS") — which is exactly the case
    // this mechanism exists for: the surface is gone, its pixels are not, and the next surface to
    // reach that key should not have to re-render them. Nothing is retained for a keyless surface's
    // private key, and nothing at all with the budget at 0, so a consumer without the option takes
    // the revoke it has today.
    release(state.entry, binding, null, true);
    state.entry = null;
    state.claimed = false;
  }
  // A PARKED still is claimable only by THIS surface, which is going away — so its bytes would
  // ordinarily be dead the moment this binding is. That argument holds for the fingerprint claim and
  // NOT for the pixels: if the entry's key is a real one, any surface that reaches that key can
  // still use it, so the still is re-homed as an ownerless RETAINED entry instead of being revoked.
  // A private synthetic key has no such second claimant, and `retainStill` refuses it.
  if (state.parked) {
    const parked = state.parked;
    state.parked = null;
    if (!retainStill(parked, state.swapper)) dropPooledStill(parked);
  }
  state.shown = false;
  state.claimed = false;
  state.stable = 0;
  state.key = null;
  state.swapper.bindings.delete(binding);
}

/**
 * The ONE writer of both surfaces' `display`. Dormant hides everything (the host's park); otherwise
 * exactly one of the two is visible. Un-hiding restores the value the HOST left on the canvas at the
 * moment this module first hid it — never a blanket `""`, which would resurrect a canvas the host
 * itself had hidden. With no swap state this is byte-identical to the
 * `canvas.style.display = dormant ? "none" : ""` it replaces.
 */
export function applySurfaceVisibility(binding: StaticImageSwapBinding): void {
  const state = binding.staticImage;
  if (!state) {
    binding.canvas.style.display = binding.dormant ? "none" : "";
    return;
  }
  if (state.img) {
    state.img.style.display = binding.dormant ? "none" : "block";
  }
  if (binding.dormant || state.shown) {
    if (!state.hidCanvas) {
      state.hostDisplay = binding.canvas.style.display;
      state.hidCanvas = true;
    }
    binding.canvas.style.display = "none";
    return;
  }
  if (state.hidCanvas) {
    binding.canvas.style.display = state.hostDisplay;
    state.hidCanvas = false;
    state.hostDisplay = "";
  }
  // Never hidden by this module ⇒ the host owns the property; do not touch it.
}

/** The host's own frame cache dropped this key. Retire the entry: no NEW surface may attach to it,
 *  while current holders keep showing it until they release (see the module doc on why this does
 *  not revoke out from under a live `<img>`). */
export function onStaticFrameEvicted(key: string): void {
  const entry = entriesByKey.get(key);
  if (!entry) return;
  entriesByKey.delete(key);
  if (entry.refs <= 0) {
    // A POOLED entry — parked for one surface, or RETAINED for whatever reaches its key — has no
    // holder but IS still claimable; the host has just said this frame is gone, so the claim goes
    // with the pixels. (An entry still held by a live `<img>` is left alone: it leaves the lookup so
    // nothing NEW attaches, and is revoked by its last holder.)
    unpoolStill(entry);
    revoke(entry);
  }
}

/** TEST-ONLY: revoke every URL, forget every entry and stand the default context down, so a test
 *  starts from a clean registry. */
export function __resetStaticImageSwapForTest(): void {
  for (const entry of entriesByKey.values()) revoke(entry);
  entriesByKey.clear();
  // Pooled entries need their own sweep: `onStaticFrameEvicted` can have taken one out of the lookup
  // while it is still pooled and claimable.
  for (const [entry, pooled] of stillPool) {
    if (pooled.owner) pooled.owner.parked = null;
    revoke(entry);
  }
  stillPool.clear();
  pooledBytes = 0;
  encodedKeys.clear();
  liveUrls = 0;
  encodeUnsupported = false;
  soloKeySeq = 0;
  cancelTimers(defaultContext);
  defaultContext.queue.length = 0;
  defaultContext.bindings.clear();
  defaultContext.sliceAt = Number.NEGATIVE_INFINITY;
  defaultContext.sliceCount = 0;
  defaultContext.taskKicks = 0;
  defaultContext.busyDeferSince = NOT_DEFERRING;
  defaultContext.backoffUntil = 0;
  defaultContext.scratch = null;
  defaultContext.lastWatchdogAt = defaultContext.policy.now();
}

// ---- internals: the gate ----------------------------------------------------------------------

function resetGate(state: StaticImageState, now: number): void {
  state.stable = 0;
  state.retryAfter = 0;
  state.lastDrawAt = now;
  // KEY EVIDENCE EXPIRES WITH THE GATE, on the quiet-window side only. Every caller of this is an
  // event that says the surface's pixels can no longer be vouched for (a host invalidate, a re-size,
  // a dormancy wake) — and under a SHORT keyed deadline a surface whose key survived would re-attach
  // its old still on the very next sweep, without ever repainting, on the strength of a key that was
  // reported before whatever just happened. Clearing it puts the surface back on the plain window
  // until it paints again and re-states its key, which costs a keyed surface nothing in practice
  // (the host repaints; that IS the report) and is the whole safety of the short deadline.
  // NOT on the content-key side: there `state.key` is the gate's own state, `stable` is the counter
  // that resets, and clearing it would change behavior for every existing consumer.
  if (state.swapper.policy.quietWindow) state.key = null;
}

/** The quiet window THIS surface is held to: the keyed one when its last paint named a frame, the
 *  plain one otherwise (see the module doc's KEYED-OR-QUIET). One function so the three places that
 *  need the deadline — the gate, the sweep's due test and the sweep's ARMING — cannot disagree; a
 *  `nextSweepAt` that used the plain window for a keyed surface would simply be late, and the surface
 *  would sit eligible-but-unswept until something else woke the swapper. */
function quietWindowFor(
  state: StaticImageState,
  policy: ResolvedPolicy,
): number {
  return state.key === null ? policy.quietMs : policy.keyedQuietMs;
}

function gateSatisfied(
  binding: StaticImageSwapBinding,
  state: StaticImageState,
  policy: ResolvedPolicy,
  now: number,
): boolean {
  if (policy.quietWindow) {
    // A pending re-render means the pixels are about to move; wait it out rather than encode them.
    return (
      !binding.dirty && now - state.lastDrawAt >= quietWindowFor(state, policy)
    );
  }
  return state.key !== null && state.stable >= policy.observations;
}

function maybeSwap(
  binding: StaticImageSwapBinding,
  counters: StaticImageSwapCounters,
): void {
  const state = binding.staticImage;
  if (!state || state.entry || state.blocked) return;
  const policy = state.swapper.policy;
  const now = policy.now();
  if (state.retryAfter > now) return; // a failed encode is pacing its retry
  if (!gateSatisfied(binding, state, policy, now)) return;
  // Parked: nothing is painting, so there is nothing to win and the canvas may be mid-defer.
  // (`dirty` is deliberately NOT checked on the content-key path: the render path calls in with a
  // canvas it has just painted — and `dirty` is only cleared by its caller AFTER the render — while
  // the reconcile path checks `dirty` itself. The invariant either way is "the canvas holds the
  // frame `key` names".)
  if (binding.dormant) return;
  // HOST VETO, right beside the dormancy check (see `canFreezeSurface`).
  if (policy.canFreeze && !policy.canFreeze(binding.node, binding.canvas))
    return;
  // A zero-sized backing store has no frame to encode (and `toBlob` of one is not a picture); a
  // canvas that has left the document paints nothing, so freezing it is a wasted encode and a URL
  // held until teardown.
  if (binding.canvas.width < 1 || binding.canvas.height < 1) return;
  if (!binding.canvas.isConnected) return;
  // ZERO-READBACK PATH, checked before the key lookup because it is stronger than a key match: this
  // surface's OWN previous still, re-attached when the canvas still holds the exact pixels it was
  // encoded from (see the module doc's "PARKED STILLS").
  if (reclaimParkedStill(binding, state, counters)) return;
  if (encodeUnsupported || !canEncode()) {
    encodeUnsupported = true;
    return;
  }
  // A keyless surface has no identity to share on, so it encodes under a private synthetic key.
  const key = state.key ?? `${SOLO_KEY_PREFIX}${++soloKeySeq}`;
  const existing = entriesByKey.get(key);
  if (existing) {
    if (existing.failed) {
      if (policy.retry) {
        state.retryAfter = now + policy.intervalMs;
        armSweep(state.swapper);
      } else {
        state.blocked = true;
      }
      return;
    }
    // A key hit on a POOLED entry — parked for another surface, or RETAINED by nobody: it has a
    // holder again, so its bytes stop being the pool's to evict and whichever surface parked it
    // loses its claim (the key dedup outranks the private one). This is also the path a surface
    // whose OWN still was retained takes back to its pixels, without any fingerprint at all.
    unpoolStill(existing);
    existing.refs++;
    state.entry = existing;
    if (existing.url) {
      attach(binding, existing, counters);
    } else {
      existing.waiters.add(binding); // an encode is already in flight for this key
    }
    return;
  }
  const entry: StaticImageEntry = {
    key,
    refs: 1,
    url: null,
    failed: false,
    bytes: 0,
    waiters: new Set([binding]),
    bake: false,
  };
  entriesByKey.set(key, entry);
  state.entry = entry;
  // The surface's OWN canvas is the source: it holds exactly the frame `key` names — the same pixels
  // the host's frame cache holds for that key, without this module needing to reach into the cache.
  // Unless the binding supplied a CAPTURE HOOK, in which case the canvas cannot be read at all and
  // the hook re-produces the same frame instead (see the module doc's CAPTURE-HOOK SOURCES). The
  // canvas is still carried: its backing-store size is what the pacing orders the queue by.
  enqueueEncode(state.swapper, {
    entry,
    canvas: binding.canvas,
    capture: binding.captureCanvas ?? null,
    area: binding.canvas.width * binding.canvas.height,
    counters,
  });
}

function canEncode(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.toBlob === "function"
  );
}

// ---- internals: parked stills (the zero-readback re-freeze) -------------------------------------

/**
 * May the entry this revert is letting go be PARKED for a later re-attach (`encode.parkedStillBytes`,
 * see the module doc)? The test is the reuse fingerprint, evaluated while the state still carries it:
 *
 *   - a frame that was never SHOWN has no fingerprint at all (`drawSeqAtFreeze` is -1 and the frozen
 *     size was never captured), so there is nothing to compare a later canvas against;
 *   - a paint since the freeze (`drawSeq`) means the canvas no longer holds the encoded pixels, and a
 *     re-allocated backing store cleared them outright — those are the reverts a re-encode is FOR;
 *   - a decode failure is excluded on its own evidence: the blob would not paint, so re-attaching it
 *     later only fails again;
 *   - a BLOCKING revert disqualifies the surface for the life of the binding, so nobody is ever
 *     coming back for the pixels.
 */
function parkableStill(
  binding: StaticImageSwapBinding,
  state: StaticImageState,
  wasShown: boolean,
  block: boolean,
  cause: StaticImageRevertCause,
): boolean {
  return (
    wasShown &&
    !block &&
    cause !== "decode-failure" &&
    state.swapper.policy.parkedStillBytes > 0 &&
    state.drawSeq === state.drawSeqAtFreeze &&
    binding.canvas.width === state.frozenW &&
    binding.canvas.height === state.frozenH
  );
}

/** The pool's admission rules, split out so a caller can ask BEFORE it gives anything up (see
 *  `parkStill`). A still bigger than the entire budget would evict the pool on admission and then be
 *  evicted by the next park anyway — two revokes and a wasted walk to end up where refusing it
 *  starts. */
function poolAdmits(entry: StaticImageEntry, budget: number): boolean {
  return (
    budget > 0 && entry.url !== null && !entry.failed && entry.bytes <= budget
  );
}

/** Admit an unheld entry to the shared still pool and trim to budget — the one insertion point for
 *  BOTH kinds (`owner` set = parked for that one surface, `owner` null = retained by key), so there
 *  is one byte total and one eviction walk over them. Returns false when the entry cannot be pooled
 *  at all, in which case the caller revokes as before.
 *  `budget` is the ADMISSION budget of whichever mechanism is asking (`parkedStillBytes` or
 *  `stillCacheBytes`); the pool is then trimmed to the policy's `poolBytes`, which is both together. */
function poolStill(
  entry: StaticImageEntry,
  owner: StaticImageState | null,
  ctx: SwapperContext,
  budget: number,
): boolean {
  if (!poolAdmits(entry, budget)) return false;
  const existing = stillPool.get(entry);
  if (existing) {
    // Already pooled (a retained entry being re-homed to a new owner, or the reverse): its bytes are
    // counted once, and re-inserting would double them. The pooling ORDER is left alone too — an
    // entry nobody has held since it was pooled has not become fresher by being re-labelled.
    existing.owner = owner;
    existing.ctx = ctx;
  } else {
    stillPool.set(entry, { owner, ctx });
    pooledBytes += entry.bytes;
  }
  // Least-recently-pooled first (Map iteration is insertion order, and pooling always inserts
  // fresh). One walk over both kinds: they are the same bytes, and a keyed still is not more
  // evictable than a parked one just because it is claimable by more surfaces.
  const poolBudget = ctx.policy.poolBytes;
  for (const pooled of stillPool.keys()) {
    if (pooledBytes <= poolBudget) break;
    if (pooled === entry) continue; // never evict the admission itself on its own walk
    dropPooledStill(pooled);
  }
  return true;
}

/** Hold an unheld entry for its last surface instead of revoking it (`encode.parkedStillBytes`).
 *  The entry deliberately STAYS in `entriesByKey`: its pixels are still valid for that key, so a
 *  different surface reaching the same key should attach to it rather than encode a duplicate
 *  (`maybeSwap` unpools it on the way through). */
function parkStill(entry: StaticImageEntry, state: StaticImageState): boolean {
  const ctx = state.swapper;
  const budget = ctx.policy.parkedStillBytes;
  // Asked BEFORE the previous still is given up: a park that cannot happen must not cost this
  // surface the one it is already holding.
  if (!poolAdmits(entry, budget)) return false;
  if (state.parked && state.parked !== entry) dropPooledStill(state.parked);
  if (!poolStill(entry, state, ctx, budget)) return false;
  state.parked = entry;
  state.parkedDrawSeq = state.drawSeq;
  state.parkedW = state.frozenW;
  state.parkedH = state.frozenH;
  return true;
}

/** Keep an unheld entry claimable BY KEY, by nobody in particular (`encode.stillCacheBytes`, see the
 *  module doc's "RETAINED STILLS"). Refused for a private synthetic key: no lookup can ever reach
 *  one, so retaining it would pin bytes for a hit that cannot happen. */
function retainStill(entry: StaticImageEntry, ctx: SwapperContext): boolean {
  if (isSoloKey(entry.key)) return false;
  return poolStill(entry, null, ctx, ctx.policy.stillCacheBytes);
}

/** Take an entry out of the pool WITHOUT revoking it — for every way a pooled still gets a holder
 *  again (its owner reclaims it, another surface hits its key, or a claim takes it). */
function unpoolStill(entry: StaticImageEntry): void {
  const pooled = stillPool.get(entry);
  if (!pooled) return;
  stillPool.delete(entry);
  pooledBytes -= entry.bytes;
  if (pooled.owner?.parked === entry) pooled.owner.parked = null;
}

/** Give up on a pooled still: nothing holds it (a pooled entry's refs are 0 by construction), so the
 *  URL goes and the key stops being a lookup hit. */
function dropPooledStill(entry: StaticImageEntry): void {
  unpoolStill(entry);
  revoke(entry);
  if (entriesByKey.get(entry.key) === entry) entriesByKey.delete(entry.key);
}

/** Re-attach the still this surface's previous freeze parked, when the canvas still reports the paint
 *  count and backing-store size it was encoded at and no re-render is pending. That is the entire
 *  correctness argument for handing back old pixels, and it is the same evidence the watchdog uses to
 *  decide a live swap is still legitimate — so a stale still is caught here rather than shown.
 *  A disqualified still is revoked ON THE SPOT: it will never match again (the fingerprint only moves
 *  forward), so holding its bytes for the LRU to notice later is pure waste. */
function reclaimParkedStill(
  binding: StaticImageSwapBinding,
  state: StaticImageState,
  counters: StaticImageSwapCounters,
): boolean {
  const entry = state.parked;
  if (!entry) return false;
  const reusable =
    entry.url !== null &&
    !entry.failed &&
    !binding.dirty &&
    state.drawSeq === state.parkedDrawSeq &&
    binding.canvas.width === state.parkedW &&
    binding.canvas.height === state.parkedH;
  if (!reusable) {
    // Disqualified for THIS surface's fingerprint — but if the key is a real one those pixels are
    // still that key's frame, so the entry is re-homed as a RETAINED still rather than revoked. That
    // is only ever a re-labelling: `dropPooledStill` is what happens when nothing can use it.
    state.parked = null;
    if (!retainStill(entry, state.swapper)) dropPooledStill(entry);
    return false;
  }
  unpoolStill(entry);
  entry.refs++;
  state.entry = entry;
  counters.staticImageReuseHits++;
  attach(binding, entry, counters);
  return true;
}

// ---- internals: encode pacing ------------------------------------------------------------------

/** Would this pass encode a key this document has never encoded, under a policy that exempts those
 *  from the deferral apparatus (`encode.primeUnseenKeys`)? Reads the HEAD of the queue, which is
 *  what the pass would kick next; costs one `Set.has` and only for a host that asked. */
function primingPass(ctx: SwapperContext): boolean {
  if (!ctx.policy.primeUnseenKeys) return false;
  const head = ctx.queue[0];
  return head !== undefined && !encodedKeys.has(head.entry.key);
}

/** Remember that a key has been encoded, for `primeUnseenKeys`. Capped, and the cap fails safe: past
 *  `PRIMED_KEY_MEMORY` new keys are simply not remembered, so they read as SEEN and the exemption
 *  stops applying — the conservative direction. */
function noteEncodedKey(key: string): void {
  if (encodedKeys.size >= PRIMED_KEY_MEMORY) return;
  encodedKeys.add(key);
}

/**
 * `StaticSurfaceSwapper.bakeStill` — enqueue an encode for a key NOTHING is waiting on (see the
 * module doc's "BAKING A STILL", and the public method for the contract).
 *
 * The entry is born `refs: 0, bake: true` and goes through the ORDINARY queue: same pacing, same
 * `perTask`, same `busy`, same capture hook, same `publish`. That reuse is the whole design — a
 * second encode path would be a second place for the readback budget to be wrong — and it is why the
 * three "everyone let go" guards downstream had to learn the difference between an entry that lost
 * its holders and one that never had any.
 */
function bakeStillInto(
  ctx: SwapperContext,
  source: StaticStillBakeSource,
  key: string,
  counters: StaticImageSwapCounters,
  onSettled?: (published: boolean) => void,
): void {
  const settle = (published: boolean): void => onSettled?.(published);
  const canvas = source.canvas;
  // Every refusal settles FALSE and books nothing, so a caller holding a surface open for its pixels
  // is released on the same stack it asked on:
  //   - nothing could ever look a synthetic key up, and retention is where a bake LIVES (with it off
  //     `publish` would revoke the entry the instant it made it);
  //   - a key known in ANY state — live, retained, in flight, or failed — already has its answer:
  //     the pixels exist, are coming, or have been proven unobtainable, and baking over it would be
  //     a duplicate readback at best and an orphaned live URL at worst;
  //   - a zero-sized backing store is not a picture.
  // NOTE the guard that is deliberately ABSENT: `isConnected`. The ordinary freeze path refuses a
  // canvas that has left the document because a surface nobody can see is a wasted encode; here it
  // is the POINT — the pixels are banked precisely because the surface is on its way out.
  if (
    ctx.disposed ||
    isSoloKey(key) ||
    ctx.policy.stillCacheBytes <= 0 ||
    entriesByKey.has(key) ||
    canvas.width < 1 ||
    canvas.height < 1
  ) {
    settle(false);
    return;
  }
  if (encodeUnsupported || !canEncode()) {
    encodeUnsupported = true;
    settle(false);
    return;
  }
  const entry: StaticImageEntry = {
    key,
    refs: 0,
    url: null,
    failed: false,
    bytes: 0,
    waiters: new Set(),
    bake: true,
  };
  entriesByKey.set(key, entry);
  counters.staticStillBakes++;
  enqueueEncode(ctx, {
    entry,
    canvas,
    capture: source.captureCanvas ?? null,
    area: canvas.width * canvas.height,
    counters,
    settle,
  });
}

function enqueueEncode(ctx: SwapperContext, job: EncodeJob): void {
  ctx.queue.push(job);
  if (ctx.policy.smallestFirst) ctx.queue.sort((a, b) => a.area - b.area);
  // `deferHead` trades the inline head away: the caller that made this surface eligible (often a
  // `reconcile()`/`TimerFire` already on a hot path) never runs an `encode()` on its own stack — see
  // `pumpEncodes`'s `allowInline` parameter and the module doc's "ENCODE PACING" section.
  pumpEncodes(ctx, !ctx.policy.deferHead);
}

/**
 * At most `slice` encodes per `intervalMs` WINDOW, counted on the clock rather than per queue
 * flush. That is what actually bounds the synchronous block: surfaces become eligible one at a time
 * (one `reconcile()` can walk a whole set), so a queue-length rule would let every one of them
 * encode inline — which is precisely the 736 ms park this exists to prevent.
 *
 * The head of a burst — up to `slice` surfaces — is therefore encoded INLINE by default
 * (`allowInline`, default `true`), before the queue has anything to sort, so `smallest-first` orders
 * the DEFERRED remainder rather than the whole set. That is the deliberate trade for a lone surface
 * not having to wait a whole interval to swap.
 *
 * `allowInline: false` (only ever passed from `enqueueEncode` under `policy.deferHead`) skips that
 * inline loop entirely and, if the window has not spent any of its budget yet, schedules the drain
 * at the minimum delay (1 ms) rather than at the next `intervalMs` boundary — so the head still goes
 * out promptly, just never on the caller's own stack. Every subsequent call in the burst (queue
 * already non-empty, `drainTimer` already armed) is then a no-op until that timer fires, at which
 * point it re-enters with `allowInline` defaulted back to `true` and normal pacing resumes.
 *
 * THE TWO BUDGETS, stated exactly. At most `slice` encodes per `intervalMs` WINDOW **and** at most
 * `perTask` per TASK, with at least `taskGapMs` between two tasks of the same window. Throughput is
 * governed by the first and is unchanged by the second; what `perTask` moves is GRANULARITY, and with
 * it the two things the window budget could never bound: the longest main-thread park (one readback,
 * not `slice` of them) and how often the deferral predicates get a say (once per encode, not once per
 * slice). `perTask` defaults to `slice`, which collapses the second budget into the first — every
 * existing consumer's drain, unchanged.
 *
 * "TASK" is `ctx.taskKicks`, and it is deliberately conservative: it is reset in a TIMER callback and
 * nowhere else, so every inline pump between two timer fires shares one budget. That is what makes
 * the bound real — surfaces become eligible one at a time and each one reaches this function on the
 * CALLER's stack, so a budget scoped to a single call would let one `runSweep` spend the whole slice
 * back-to-back exactly as before. The cost of being conservative is that a lone surface arriving in
 * some later task may wait `taskGapMs` on a timer instead of encoding inline; the cost of being
 * optimistic is the 1,163 ms park.
 */
function pumpEncodes(ctx: SwapperContext, allowInline = true): void {
  if (ctx.disposed) return;
  const policy = ctx.policy;
  const now = policy.now();
  if (now - ctx.sliceAt >= policy.intervalMs) {
    ctx.sliceAt = now;
    ctx.sliceCount = 0;
  }
  // The task budget exists only while it is TIGHTER than the window's. At `perTask >= slice` (the
  // default, where `perTask` resolves to `slice`) the window budget binds first in every case, and
  // tracking the task would actively change behavior: `taskKicks` only clears on a timer while
  // `sliceCount` clears with each window, so a policy that arms no timers — the default one, see
  // `nextSweepAt`'s fast path — would latch its task budget and push every later burst's inline head
  // onto a timer it has never armed.
  const taskBudget =
    policy.perTask < policy.slice ? policy.perTask : Number.POSITIVE_INFINITY;
  // "Not now", asked ONCE per pass and only when there is something to encode — which under a pinned
  // `perTask` means once per READBACK, the point of pinning it. A PRIMING pass (the head of the
  // queue is a key this document has never encoded, and `encode.primeUnseenKeys` is on) does not ask
  // at all: see the module doc's "PRIMING UNSEEN KEYS" for why WHEN is the wrong lever for that
  // encode. It is the head that is tested because the head is what this pass would kick next; the
  // budgets below are untouched, so a priming pass is still at most one slice.
  const deferring =
    ctx.queue.length > 0 &&
    !primingPass(ctx) &&
    encodeDeferred(ctx, now, allowInline);
  // A deferring pass encodes NOTHING — the inline head included, which is the point: `deferHead`
  // moves the head onto a 1 ms timer, and a 1 ms timer still lands inside the host's burst.
  if (allowInline && !deferring) {
    while (
      ctx.taskKicks < taskBudget &&
      ctx.sliceCount < policy.slice &&
      ctx.queue.length > 0
    ) {
      const job = ctx.queue.shift();
      if (!job) break;
      // Superseded while queued: everyone let go, the key failed, or another holder already encoded
      // it. It costs no readback, so it is charged to NEITHER budget. A BAKE is held by nobody by
      // construction (`entry.bake`), so `refs <= 0` is its resting state and not abandonment.
      if (
        (job.entry.refs <= 0 && !job.entry.bake) ||
        job.entry.failed ||
        job.entry.url !== null
      )
        continue;
      ctx.sliceCount++;
      ctx.taskKicks++;
      encode(ctx, job);
    }
  }
  if (ctx.queue.length > 0 && ctx.drainTimer === null && policy.setT) {
    // Re-read the clock: a readback can outlast the whole pacing window, and a delay measured from
    // BEFORE it would be an interval that has already elapsed. (A no-op under an injected fake clock,
    // which is why the pacing tests are unaffected by it.)
    const after = policy.now();
    const delay = deferring
      ? // Re-ask a whole pacing window later. The queue keeps its order and its slice budget; only
        // the instant moved.
        Math.max(1, policy.intervalMs)
      : ctx.taskKicks >= taskBudget && ctx.sliceCount < policy.slice
        ? // The TASK budget stopped this pass, not the window's: yield for a gap and come back for
          // the rest of the window's budget rather than sitting on it until the window turns over.
          Math.max(1, policy.taskGapMs)
        : !allowInline && ctx.sliceCount === 0
          ? 1
          : Math.max(1, ctx.sliceAt + policy.intervalMs - after);
    ctx.drainTimer = policy.setT(() => {
      ctx.drainTimer = null;
      // The one observable task boundary: whatever the previous task spent, this one starts fresh.
      ctx.taskKicks = 0;
      pumpEncodes(ctx);
    }, delay);
  }
  // Drained: the next deferral is a new run, and gets the whole bound to itself.
  if (ctx.queue.length === 0) ctx.busyDeferSince = NOT_DEFERRING;
}

/**
 * May this pass spend a readback? Consulted once per drain pass, and the ONLY place either deferral
 * reason is evaluated: the host's `encode.busy` predicate, and this module's own slow-encode backoff
 * (`encode.slowEncodeMs`, see the module doc's stale-signal trap for why one is not enough).
 *
 * ONE SHARED BOUND. `busyMaxDeferMs` caps one unbroken run of deferrals for ANY reason, not one run
 * per reason — so neither the host's predicate nor the module's own measurement, nor the two
 * alternating, can stop the fleet; they can only slow it. Once the bound elapses the pass encodes and
 * the run restarts from that instant, and the forced pass also CLEARS the backoff, or the bound it
 * just overrode would spend the next one immediately. Under a pinned `perTask` a forced pass is one
 * readback rather than a whole slice.
 *
 * FAIL OPEN. A predicate that throws is a host bug; treating it as "busy" would turn that bug into a
 * fleet that never freezes, so a throw reads as "not busy" and the pass encodes.
 *
 * `kickable` is false for the one pass that could not encode anyway (the `deferHead` enqueue, whose
 * only job is to arm the drain). Such a pass HOLDS the bound rather than spending it, so the forced
 * encode lands on the next pass that can actually kick one instead of being deferred a second bound.
 */
function encodeDeferred(
  ctx: SwapperContext,
  now: number,
  kickable: boolean,
): boolean {
  const policy = ctx.policy;
  // `busyMaxDeferMs: 0` is the host asking for NO deferral machinery at all: the predicate is not
  // consulted and neither is the backoff.
  if (policy.busyMaxDeferMs <= 0) return false;
  let hold: "busy" | "backoff" | null = null;
  if (policy.busy) {
    let busy = false;
    try {
      busy = policy.busy() === true;
    } catch {
      busy = false;
    }
    if (busy) hold = "busy";
  }
  // The host's word first: it knows things a readback measurement cannot, and attributing a deferral
  // to the louder signal keeps the two counters diagnostic.
  if (hold === null && ctx.backoffUntil > now) hold = "backoff";
  if (hold === null) {
    ctx.busyDeferSince = NOT_DEFERRING;
    return false;
  }
  // The swapper's own counters are the pass-level home; a job's are the fallback for the (unreachable
  // in practice) swapper built without one.
  const counters = ctx.counters ?? ctx.queue[0]?.counters ?? null;
  if (ctx.busyDeferSince === NOT_DEFERRING) {
    ctx.busyDeferSince = now;
  } else if (now - ctx.busyDeferSince >= policy.busyMaxDeferMs && kickable) {
    ctx.busyDeferSince = now;
    ctx.backoffUntil = 0;
    if (counters) counters.staticImageBusyForcedEncodes++;
    return false;
  }
  if (counters) {
    if (hold === "busy") counters.staticImageBusyDeferrals++;
    else counters.staticImageBackoffDeferrals++;
  }
  return true;
}

/**
 * Turn one queued job's frame into an object URL and hand it to the surfaces waiting on that key.
 *
 * TWO SOURCES, one tail. Without a capture hook the job's own canvas is read (`toBlob` on it), which
 * is a SYNCHRONOUS GPU→CPU readback and the thing every pacing lever in this file bounds. With one,
 * the pixels arrive asynchronously from the renderer's own readback and land in a throwaway 2D
 * canvas, which is then encoded by the identical tail — see the module doc's CAPTURE-HOOK SOURCES
 * for why the two costs are booked to DIFFERENT counters.
 */
function encode(ctx: SwapperContext, job: EncodeJob): void {
  const policy = ctx.policy;
  const { entry, counters } = job;
  const publish = (blob: Blob | null): void => {
    if (!blob) {
      fail(entry, counters, job.settle);
      return;
    }
    // "Everyone let go while the encoder ran" and "nobody ever held this" are different events with
    // the same `refs` reading, and only the first is a reason to throw the pixels away. A BAKE is the
    // second: it was enqueued FOR the pool, so it publishes and is retained (below) rather than
    // dropped. Without this distinction `bakeStill` would encode faithfully and then delete itself.
    if (entry.refs <= 0 && !entry.bake) {
      // Publish nothing, and make sure the empty entry isn't left behind as a lookup hit.
      if (entriesByKey.get(entry.key) === entry) entriesByKey.delete(entry.key);
      job.settle?.(false);
      return;
    }
    entry.url = URL.createObjectURL(blob);
    // What a pooled still would COST, taken while the blob is in hand — it is the only moment this
    // module ever sees the encoded size.
    entry.bytes = typeof blob.size === "number" ? Math.max(0, blob.size) : 0;
    liveUrls++;
    counters.staticImageEncodes++;
    noteEncodedKey(entry.key);
    if (entry.refs <= 0) {
      // A BAKE, published: held by nobody, so the pool is the only thing that can keep it. Refused
      // (over budget) it is revoked immediately — the alternative is a URL nothing will ever release.
      const retained = retainStill(entry, ctx);
      if (!retained) dropPooledStill(entry);
      job.settle?.(retained);
      return;
    }
    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const waiter of waiters) attach(waiter, entry, counters);
    job.settle?.(true);
  };
  // The synchronous `toBlob` tail, shared by both sources. `source` is the job's own canvas on the
  // direct path and the capture hook's throwaway canvas on the other; `encodeSource` may hand back
  // the swapper's `maxDim` scratch instead of either.
  const encodeFrom = (source: HTMLCanvasElement): number => {
    const started = policy.now();
    try {
      encodeSource(ctx, source, counters).toBlob(publish, ENCODE_MIME);
    } catch {
      fail(entry, counters);
    }
    // The SYNCHRONOUS part is what parks the thread: `toBlob` returns once the readback is done and
    // compresses off-thread. Measuring around the call therefore measures the BLOCK, not the codec.
    const cost = Math.max(0, policy.now() - started);
    counters.staticImageEncodeMs += cost;
    if (cost > counters.staticImageEncodeMaxMs)
      counters.staticImageEncodeMaxMs = cost;
    return cost;
  };

  if (job.capture === null) {
    // The direct path, unchanged: the surface's own canvas, read synchronously, and the adaptive
    // backoff armed from that park.
    armSlowBackoff(ctx, counters, encodeFrom(job.canvas));
    return;
  }
  captureThenEncode(ctx, job, encodeFrom);
}

/** The adaptive backoff's one rule (`encode.slowEncodeMs`), applied to whichever cost the source in
 *  hand actually measures: the synchronous `toBlob` park on the direct path, the capture's WALL time
 *  on a hook path. Split out so the two sources share the rule rather than each re-stating it. */
function armSlowBackoff(
  ctx: SwapperContext,
  counters: StaticImageSwapCounters,
  cost: number,
): void {
  const policy = ctx.policy;
  if (policy.slowEncodeMs > 0 && cost >= policy.slowEncodeMs) {
    counters.staticImageSlowEncodes++;
    ctx.backoffUntil = policy.now() + policy.slowBackoffMs;
  }
}

/**
 * The CAPTURE-HOOK source: await the renderer's own readback, then run the ordinary encode tail over
 * what it produced. Everything downstream of `encodeFrom` — dedup, the stand-in, parked stills — is
 * unchanged, because by then the pixels are in an ordinary 2D canvas.
 *
 * THE GUARD mirrors `publish`'s, because the same thing can happen during a capture that can happen
 * during a compression: every holder can let go (a revert, a dispose, a runtime teardown). A dead
 * entry publishes nothing and is taken out of the lookup so it cannot be a hit for the next surface
 * — and books NO failure, because nothing failed; the surface simply stopped wanting a still.
 *
 * A FAILED capture (null, a throw, a degenerate canvas) goes through the SAME `fail()` every other
 * failure does — so it is retried on the encode cadence under `onInvalidate: "retry"` and blocks the
 * key under `"block"`, and in neither case can it wedge the queue.
 *
 * A BLANK capture (`STATIC_CAPTURE_BLANK`: the capture completed and holds nothing visible, for a
 * surface the producer knows it drew) is that same failure with two differences — it books its own
 * counter, and it is TERMINAL even under `"retry"`. See the module doc's BLANK CAPTURES for both,
 * and for why this module never decides it from the pixels itself.
 */
function captureThenEncode(
  ctx: SwapperContext,
  job: EncodeJob,
  encodeFrom: (source: HTMLCanvasElement) => number,
): void {
  const policy = ctx.policy;
  const { entry, counters } = job;
  const started = policy.now();
  const finish = (source: StaticSurfaceCapture): void => {
    // WALL time, not park time: this is the GPU handing pixels over, and the backoff's whole job is
    // to notice when that has become expensive (see `encode.slowEncodeMs`).
    const cost = Math.max(0, policy.now() - started);
    counters.staticImageCaptureMs += cost;
    if (cost > counters.staticImageCaptureMaxMs)
      counters.staticImageCaptureMaxMs = cost;
    armSlowBackoff(ctx, counters, cost);
    // …with the same exception `publish` makes: a BAKE is held by nobody on purpose, so `refs <= 0`
    // is not the abandonment this guard is looking for.
    if (entry.refs <= 0 && !entry.bake) {
      if (entriesByKey.get(entry.key) === entry) entriesByKey.delete(entry.key);
      releaseCaptureCanvas(source);
      job.settle?.(false);
      return;
    }
    if (source === STATIC_CAPTURE_BLANK) {
      // The capture answered, and answered with nothing. A capture failure like any other — the
      // surface keeps its live canvas — plus its own counter, plus `terminal`: the cause is the
      // device's capture path, which a retry cannot change (see the module doc).
      counters.staticImageBlankCaptures++;
      counters.staticImageCaptureFailures++;
      fail(entry, counters, job.settle, true);
      return;
    }
    if (!source || source.width < 1 || source.height < 1) {
      counters.staticImageCaptureFailures++;
      releaseCaptureCanvas(source);
      fail(entry, counters, job.settle);
      return;
    }
    counters.staticImageCaptures++;
    encodeFrom(source);
    // Released only AFTER `toBlob` has been called on it: Blink snapshots a `toBlob` source
    // synchronously (the same guarantee the `maxDim` scratch's reuse depends on), so zeroing the
    // backing store here cannot race the compression that is still running off-thread.
    releaseCaptureCanvas(source);
  };
  let pending: Promise<StaticSurfaceCapture>;
  try {
    pending = job.capture?.() ?? Promise.resolve(null);
  } catch {
    // A hook that throws synchronously is the same event as one that rejects.
    finish(null);
    return;
  }
  void pending.then(finish, () => finish(null));
}

/** A capture canvas is this module's to own for exactly one encode. A 0×0 backing store releases its
 *  pixels immediately rather than at the next GC — worth stating for a surface fleet whose stills are
 *  megabytes each. A verdict rather than a canvas (`STATIC_CAPTURE_BLANK`) owns no pixels and is
 *  simply skipped. */
function releaseCaptureCanvas(canvas: StaticSurfaceCapture): void {
  if (!canvas || canvas === STATIC_CAPTURE_BLANK) return;
  canvas.width = 0;
  canvas.height = 0;
}

/** The canvas the readback actually reads (`encode.maxDim`). Falls back to the SOURCE for anything it
 *  cannot do — a clamp that will not run must never be the reason a surface fails to freeze. */
function encodeSource(
  ctx: SwapperContext,
  canvas: HTMLCanvasElement,
  counters: StaticImageSwapCounters,
): HTMLCanvasElement {
  const maxDim = ctx.policy.maxDim;
  const longest = Math.max(canvas.width, canvas.height);
  if (maxDim <= 0 || longest <= maxDim) return canvas;
  if (typeof document === "undefined") return canvas;
  const scale = maxDim / longest;
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  if (!ctx.scratch) ctx.scratch = document.createElement("canvas");
  const scratch = ctx.scratch;
  const g = scratch.getContext("2d");
  if (!g) {
    // No 2d context in this environment (jsdom, a lost context): keep nothing around for a path that
    // cannot run.
    ctx.scratch = null;
    return canvas;
  }
  // A width/height write CLEARS the backing store; a same-size reuse does not, and the previous
  // surface's pixels would otherwise show through anything this one leaves transparent.
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  } else {
    g.clearRect(0, 0, w, h);
  }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(canvas, 0, 0, w, h);
  counters.staticImageClampedEncodes++;
  return scratch;
}

/** The encode produced nothing. Under `"block"` the key is poisoned and every waiter disqualified
 *  (today's behavior); under `"retry"` the entry is dropped instead — the key stays open — and each
 *  waiter is rescheduled one encode interval out, forever.
 *
 *  `terminal` overrides that choice and blocks under EITHER policy. Exactly one caller sets it: a
 *  BLANK capture, whose cause is the device's capture path rather than this frame, so a retry can
 *  only spend a GPU readback per interval per surface on a question already answered (see the module
 *  doc's BLANK CAPTURES). */
function fail(
  entry: StaticImageEntry,
  counters: StaticImageSwapCounters,
  settle?: (published: boolean) => void,
  terminal = false,
): void {
  counters.staticImageFailures++;
  settle?.(false);
  // A BAKE has no waiter to disqualify and nobody asked for this key, so poisoning it would let one
  // speculative readback lock a key out of the ordinary swap path for the life of the document. Drop
  // it instead: the key goes back to unknown, and the next SURFACE that wants it may try for real.
  if (entry.bake && entry.waiters.size === 0) {
    if (entriesByKey.get(entry.key) === entry) entriesByKey.delete(entry.key);
    return;
  }
  const waiters = [...entry.waiters];
  entry.waiters.clear();
  let anyRetry = false;
  for (const waiter of waiters) {
    const state = waiter.staticImage;
    if (!state || state.entry !== entry) continue;
    entry.refs--;
    state.entry = null;
    const ctx = state.swapper;
    if (ctx.policy.retry && !terminal) {
      anyRetry = true;
      state.retryAfter = ctx.policy.now() + ctx.policy.intervalMs;
      armSweep(ctx);
    } else {
      state.blocked = true; // a key that cannot be encoded is not worth retrying per surface
    }
  }
  if (anyRetry) {
    if (entriesByKey.get(entry.key) === entry) entriesByKey.delete(entry.key);
  } else {
    entry.failed = true;
  }
}

// ---- internals: the stand-in -------------------------------------------------------------------

/** Point the (possibly new) `<img>` at the entry's URL and, once it can actually paint, put it in
 *  the canvas's place. The decode gate is what keeps the surface from blinking: showing an `<img>`
 *  that has not decoded yet while hiding the canvas is one blank frame on a phone. */
function attach(
  binding: StaticImageSwapBinding,
  entry: StaticImageEntry,
  counters: StaticImageSwapCounters,
): void {
  const state = binding.staticImage;
  if (!state || state.entry !== entry || !entry.url) return;
  const img = state.img ?? createStandIn(binding);
  state.img = img;
  img.src = entry.url;
  const ready =
    typeof img.decode === "function" ? img.decode() : Promise.resolve();
  void ready.then(
    () => finishAttach(binding, entry, counters),
    () => {
      // A frame that will not decode must never hide the canvas.
      const current = binding.staticImage;
      if (current?.entry !== entry) return;
      counters.staticImageFailures++;
      const policy = current.swapper.policy;
      // Under `retry` the GATE is not the thing that failed, so it is restored across the revert and
      // the surface simply re-encodes one interval later — forever, rather than being disqualified.
      const earned = current.stable;
      revert(binding, counters, !policy.retry, "decode-failure");
      if (policy.retry) {
        current.stable = earned;
        current.retryAfter = policy.now() + policy.intervalMs;
        armSweep(current.swapper);
      }
    },
  );
}

function finishAttach(
  binding: StaticImageSwapBinding,
  entry: StaticImageEntry,
  counters: StaticImageSwapCounters,
): void {
  const state = binding.staticImage;
  // Released, churned or re-keyed while the decode ran.
  if (!state || state.entry !== entry || !state.img) return;
  if (!state.img.isConnected) {
    // Immediately BEFORE the canvas: same position in the child list, so the same paint order
    // among the self-layer's positioned children.
    const parent = binding.canvas.parentNode;
    // A canvas already out of the DOM means the node went away mid-decode; leave the swap
    // unfinished (nothing paints either way) and let the pending dispose release the URL.
    if (!parent) return;
    parent.insertBefore(state.img, binding.canvas);
  }
  state.shown = true;
  counters.staticImageSwaps++;
  counters.staticImagesLive++;
  // A CLAIM that made it all the way to the screen (see `claimStaticStill`): counted here rather
  // than at the claim, so the gap between `staticStillCacheHits` and this is exactly the claims
  // undone before their decode landed.
  if (state.claimed) counters.staticStillMounts++;
  applySurfaceVisibility(binding);
  // The watchdog's evidence of a legitimate freeze (see the module doc): the paint count, the
  // backing-store size, and the box the stand-in copied — all read AFTER the hide, which is itself
  // a write to `canvas.style`.
  state.drawSeqAtFreeze = state.drawSeq;
  state.frozenW = binding.canvas.width;
  state.frozenH = binding.canvas.height;
  state.boxCss = binding.canvas.style.cssText;
  armSweep(state.swapper);
}

/** A stand-in whose box is the canvas's box, exactly. The canvas carries its geometry as INLINE
 *  style (`position/left/top/width/height`, `pointer-events`, and for a NinePatch fill a
 *  `mask-box-image`), and no gsw stylesheet keys off `[data-godot-shader-canvas]`, so copying
 *  `cssText` wholesale reproduces the box AND anything a host set on the canvas without this file
 *  having to enumerate it. `mix-blend-mode` is not copied because it does not live here: the host
 *  sets it on the NODE (a canvas-level blend cannot reach the DOM painted behind the node), so the
 *  swap leaves it alone. */
function createStandIn(binding: StaticImageSwapBinding): HTMLImageElement {
  const img = document.createElement("img");
  img.setAttribute(STATIC_SURFACE_IMAGE_ATTR, "true");
  img.alt = "";
  copyStandInBox(img, binding.canvas);
  // Hidden until decoded; `applySurfaceVisibility` owns it from then on.
  img.style.display = "none";
  return img;
}

function copyStandInBox(
  img: HTMLImageElement,
  canvas: HTMLCanvasElement,
): void {
  img.style.cssText = canvas.style.cssText;
  // `fill` + `auto` are the canvas's own semantics (the backing store is stretched to the CSS box
  // with default smoothing), pinned explicitly so a host's `img { object-fit }` cannot resample the
  // frame differently than the canvas presented it.
  img.style.objectFit = "fill";
  img.style.imageRendering = "auto";
}

function revert(
  binding: StaticImageSwapBinding,
  counters: StaticImageSwapCounters,
  block: boolean,
  cause: StaticImageRevertCause,
): void {
  const state = binding.staticImage;
  if (!state) return;
  const wasShown = state.shown;
  detachImage(state);
  if (state.entry) {
    // PARKED STILLS: a revert that is not evidence of a repaint keeps its encoded frame around for
    // this surface's next freeze instead of revoking it (see `parkableStill`).
    // RETAINED STILLS: a KEYED entry's last release keeps it for whoever reaches that key next,
    // whatever this surface's own fingerprint says — the two are tried in that order inside
    // `release`, and the only revert excluded from retention is a DECODE FAILURE, on its own
    // evidence: those pixels would not paint here and will not paint for the next surface either.
    // A BLOCKING revert is deliberately NOT excluded. Blocking disqualifies this SURFACE (the
    // content-key gate's churn case), and says nothing about the frame the old key named — which
    // another surface on that key may still be showing.
    release(
      state.entry,
      binding,
      parkableStill(binding, state, wasShown, block, cause) ? state : null,
      cause !== "decode-failure",
    );
    state.entry = null;
    state.claimed = false;
  }
  state.shown = false;
  state.stable = 0;
  state.drawSeqAtFreeze = -1;
  if (block) state.blocked = true;
  if (wasShown) {
    counters.staticImageReverts++;
    counters.staticImageRevertsByCause[cause]++;
    counters.staticImagesLive--;
  }
  applySurfaceVisibility(binding);
  // LAST, with the revert fully settled (see `StaticSurfacePolicy.onRevert`): the host runtime may
  // need to build and paint the surface this uncovered, and it must find a consistent state to do it
  // from. A re-entrant revert from inside the handler is a no-op — there is no entry left.
  const onRevert = state.swapper.policy.onRevert;
  if (onRevert) {
    try {
      onRevert(binding);
    } catch {
      // A host bug must not leave the surface half-reverted; everything above has already happened.
    }
  }
}

function detachImage(state: StaticImageState): void {
  const img = state.img;
  if (!img) return;
  img.remove();
  // Drop the reference to the blob so the decoded bitmap can go even if the element is retained.
  img.removeAttribute("src");
  state.img = null;
}

/** Drop one holder's ref. At 0 the URL is revoked and the key stops being a lookup hit — unless the
 *  entry can be POOLED instead, in which case it survives unheld:
 *    - `retain` (and a real key, and `encode.stillCacheBytes`) keeps it claimable by ANY surface
 *      that reaches that key — tried FIRST, because it is strictly the stronger claim: it needs no
 *      fingerprint and it outlives this binding entirely;
 *    - `parkFor` keeps it claimable by that ONE surface, on the fingerprint (`parkStill`), which is
 *      all a keyless surface can ever have.
 *  Neither, or both refused ⇒ the revoke this has always done. */
function release(
  entry: StaticImageEntry,
  binding: StaticImageSwapBinding,
  parkFor: StaticImageState | null = null,
  retain = false,
): void {
  entry.waiters.delete(binding);
  entry.refs--;
  if (entry.refs > 0) return;
  const state = binding.staticImage;
  if (retain && state && retainStill(entry, state.swapper)) {
    // The fingerprint claim is superseded, not kept alongside: the entry is now claimable by key,
    // and two claims on one pooled entry would be two ways to un-pool it.
    if (state.parked === entry) state.parked = null;
    return;
  }
  if (parkFor && parkStill(entry, parkFor)) return;
  revoke(entry);
  if (entriesByKey.get(entry.key) === entry) entriesByKey.delete(entry.key);
}

function revoke(entry: StaticImageEntry): void {
  entry.waiters.clear();
  if (entry.url === null) return;
  URL.revokeObjectURL(entry.url);
  entry.url = null;
  liveUrls--;
}

// ---- internals: the sweep (quiet windows, retries, the watchdog) --------------------------------

function cancelTimers(ctx: SwapperContext): void {
  if (ctx.drainTimer !== null) {
    ctx.policy.clearT(ctx.drainTimer);
    ctx.drainTimer = null;
  }
  if (ctx.sweepTimer !== null) {
    ctx.policy.clearT(ctx.sweepTimer);
    ctx.sweepTimer = null;
  }
  ctx.sweepAt = Number.POSITIVE_INFINITY;
}

/** The next absolute `now()` at which the swapper has anything to do, or Infinity for "nothing". */
function nextSweepAt(ctx: SwapperContext): number {
  const policy = ctx.policy;
  // FAST PATH for the DEFAULT policy: with no quiet window, no retries and no watchdog there is
  // nothing this swapper can ever defer, so the O(bindings) scan below is skipped entirely. It
  // matters because `revertStaticImage` re-arms, and a host re-size reverts every binding in a loop
  // — which would otherwise be O(bindings²) for a mechanism that never arms a timer at all.
  if (!policy.quietWindow && !policy.retry && policy.watchdogMs <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  let next = Number.POSITIVE_INFINITY;
  let anyShown = false;
  for (const binding of ctx.bindings) {
    const state = binding.staticImage;
    if (!state) continue;
    if (state.shown) {
      anyShown = true;
      continue;
    }
    if (state.entry || state.blocked) continue;
    if (policy.quietWindow) {
      next = Math.min(
        next,
        Math.max(
          state.lastDrawAt + quietWindowFor(state, policy),
          state.retryAfter,
        ),
      );
    } else if (state.retryAfter > 0) {
      next = Math.min(next, state.retryAfter);
    }
  }
  if (anyShown && policy.watchdogMs > 0) {
    next = Math.min(next, ctx.lastWatchdogAt + policy.watchdogMs);
  }
  return next;
}

function armSweep(ctx: SwapperContext): void {
  const policy = ctx.policy;
  if (ctx.disposed || !policy.setT) return;
  const at = nextSweepAt(ctx);
  if (at === Number.POSITIVE_INFINITY) {
    if (ctx.sweepTimer !== null) {
      policy.clearT(ctx.sweepTimer);
      ctx.sweepTimer = null;
      ctx.sweepAt = Number.POSITIVE_INFINITY;
    }
    return;
  }
  if (ctx.sweepTimer !== null && ctx.sweepAt <= at) return; // an earlier wakeup is already coming
  if (ctx.sweepTimer !== null) policy.clearT(ctx.sweepTimer);
  const now = policy.now();
  // Never 0: a sweep that finds nothing due must not be able to spin on the same instant.
  const delay = Math.max(1, at - now);
  ctx.sweepAt = now + delay;
  ctx.sweepTimer = policy.setT(() => runSweep(ctx), delay);
}

/** `armSweep` for the per-draw hot path: an already-armed sweep is never too late for a deadline
 *  that only moved OUT, and skipping the arm skips the O(bindings) deadline scan. */
function armSweepIfIdle(ctx: SwapperContext): void {
  if (ctx.sweepTimer === null) armSweep(ctx);
}

function runSweep(ctx: SwapperContext): void {
  ctx.sweepTimer = null;
  ctx.sweepAt = Number.POSITIVE_INFINITY;
  if (ctx.disposed) return;
  // A task boundary, like the drain timer's: this sweep may make many surfaces eligible, and the
  // first of them is entitled to the fresh task budget `pumpEncodes` bounds them by.
  ctx.taskKicks = 0;
  const policy = ctx.policy;
  const now = policy.now();
  if (policy.watchdogMs > 0 && now - ctx.lastWatchdogAt >= policy.watchdogMs) {
    ctx.lastWatchdogAt = now;
    runWatchdog(ctx, now);
  }
  for (const binding of [...ctx.bindings]) {
    const state = binding.staticImage;
    if (!state || state.shown || state.entry || state.blocked) continue;
    if (state.retryAfter > now) continue;
    state.retryAfter = 0;
    if (policy.quietWindow) {
      // (`windowMs`, not `window`: shadowing the global in a DOM module is a trap for the next
      // reader, not a name.)
      const windowMs = quietWindowFor(state, policy);
      if (now - state.lastDrawAt < windowMs) continue;
      maybeSwap(binding, countersFor(state, ctx));
      // DECLINED (dirty, dormant, host-vetoed, zero-sized, off-document, no encoder). Its window is
      // already elapsed, so without a back-off the next arm would land 1 ms later and every one
      // after that too — a spin for as long as the surface stays ineligible. One attempt per window.
      // A retry that something else already scheduled (a failed encode paces itself on the encode
      // interval) is left alone.
      // The back-off is the PLAIN window even for a keyed surface, and deliberately: the keyed
      // deadline says how fresh these pixels are, while a DECLINE is about the surface's
      // circumstances (parked, host-vetoed, unsized, off-document), which do not change on that
      // clock. A host pinning `keyedQuietMs: 0` would otherwise turn one vetoed surface into a 1 ms
      // sweep spin for as long as the veto stands.
      if (!state.entry && !state.shown && state.retryAfter === 0) {
        state.retryAfter = now + Math.max(1, policy.quietMs);
      }
    } else if (state.stable >= policy.observations) {
      // A `retry` policy's rescheduled encode: the gate is still satisfied, only the encode failed.
      maybeSwap(binding, countersFor(state, ctx));
    }
  }
  armSweep(ctx);
}

/**
 * THE WATCHDOG (see the module doc). Every swapped surface must still be legitimately frozen; the
 * observable proxies for "it is not" are: the canvas left the DOM, a re-render is pending, the
 * backing store was re-allocated (which CLEARS it), or a paint was reported since the freeze. A
 * canvas that merely MOVED is not stale — its stand-in is just at the old box, so that is re-synced
 * rather than reverted.
 */
function runWatchdog(ctx: SwapperContext, now: number): void {
  for (const binding of [...ctx.bindings]) {
    const state = binding.staticImage;
    if (!state?.shown) continue;
    const canvas = binding.canvas;
    const unexplained =
      !canvas.isConnected ||
      binding.dirty ||
      state.drawSeq !== state.drawSeqAtFreeze ||
      canvas.width !== state.frozenW ||
      canvas.height !== state.frozenH;
    if (unexplained) {
      revert(binding, countersFor(state, ctx), false, "watchdog");
      // The watchdog fires on exactly the evidence a KEY cannot survive: the backing store was
      // re-allocated (and therefore cleared), a repaint is owed, or a paint landed that this module
      // never accepted. So the surface goes back to keyless until it paints and says otherwise —
      // without this, a short `keyedQuietMs` would re-attach the same stale still on the next sweep.
      // (Same rule as `resetGate`, applied here because the watchdog resets the clock by hand.)
      state.key = null;
      state.lastDrawAt = now;
      continue;
    }
    if (state.img && canvas.style.cssText !== state.boxCss) {
      copyStandInBox(state.img, canvas);
      applySurfaceVisibility(binding);
      state.boxCss = canvas.style.cssText;
    }
  }
}

/** The counters a TIMER-driven path bumps: the ones this surface was last noted with, else the
 *  swapper's own. The throwaway is unreachable in practice (a registered surface always has one of
 *  the two) and exists so no timer path can be null-checked into skipping its revert. */
function countersFor(
  state: StaticImageState,
  ctx: SwapperContext,
): StaticImageSwapCounters {
  return state.counters ?? ctx.counters ?? createStaticImageSwapCounters();
}
