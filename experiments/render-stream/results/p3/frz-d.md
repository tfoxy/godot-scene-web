# FRZ-D: opt-in host freezes with client-side continuation (2026-10-31)

Status: **design.** FRZ-D is the design half of the weak-host freeze work; docs only, no code and
no measurement. It designs the three host CPU freezes (Spine, particles, decor) and the
`tweenReplay` lever, each as an **opt-in freeze whose client-side continuation keeps the viewer
moving while the host stops simulating**. The measurement half is deferred to FRZ-M.

Base: `main` 5282f6ac. Nothing here modifies `sts2-couch-coop`; its mirror source is read as the
reference for what the old freeze covered.

## The weak-host problem

A host running 4 game instances lags every client. The product's weak host is the i5-6200U
(2 cores); four seats saturate it. The user's rule (memory `stream-levers-kept-for-perf`): a frozen
effect beats a laggy host, **if** the freeze costs the pure stream nothing and the viewer still
sees the effect. Freezing on the host also freezes what the viewer sees, so every host freeze needs
a **client-side continuation**. The three freezes save host cost; `tweenReplay` is the continuation
for smooth motion through an intermittent connection, not only fewer bytes.

The old mirror already ships all three host freezes live (`CouchCoopHeadlessVisualSuspender`), and
the render-stream already ships one of the three client continuations (GPU particles). FRZ-D's job
is to say which of the four to build into the render-stream now, which to defer, and which to
reject, and what each builds on.

## The four freezes, at a glance

| freeze | host stops sending | client continues | decision |
| ------ | ------------------ | ---------------- | -------- |
| Spine | the per-frame deformed mesh (`mesh_u8` + `mesh_f32`); the game's skeletal deformation | plays the animation clip by wall-clock | **defer** |
| Particles (GPU) | the game's per-frame particle sim (already not sent: emitter + events only) | re-simulates the emitter (GSW particle simulator) | **build now** (already built) |
| Particles (CPU) | the per-frame multimesh instance buffer | would switch from exact multimesh to the approximate simulator | **defer** |
| Tweens (`tweenReplay`) | nothing (host tweens stay) | interpolates/extrapolates motion between received frames | **defer** (wire form rejected) |
| Decor | per-frame transform churn of decorative animators | replays the authored motion on its own clock | **defer** |

## 1. Spine (`freezeSpines`)

**Host.** The old mirror freezes the Spine family (`SpineSprite` / `SpineMesh2D` / `SpineSlotNode` /
`SpineBoneNode`, identified by native class string, never a spine-godot call) with
`ProcessMode.Disabled`. That stops spine-godot's per-frame skeletal mesh deformation in
`NOTIFICATION_INTERNAL_PROCESS`, which the profiler proved dominates the headless per-frame budget.
Anim-**type** changes still reach the viewer because the producer observes them where they are
*requested* (`Sts2SpineAnimationHooks`) and replays the sequence off wall-clock. Exemptions:
self-freeing one-shot VFX overlays that need their own `animation_completed` to disappear.

**What the render-stream host stops sending.** On a streaming seat, a spine is a dynamic mesh: /13
predicts its `mesh_u8` body and its `mesh_f32` custom AABB (which STS2's spine sets every frame)
against T−1/T−2. Freezing the node stops the deformation, so those predicted blocks stop changing —
the residuals go to zero and the encode drops. The host stop is therefore the *game-side* suspender
(couch), not a render-stream change; the capture just observes a mesh that no longer moves.

**Client continuation.** The client plays the animation clip by clock: anim **name + wall-clock
track time** over a **server-baked clip**. The old mirror bakes a `SpineClipWire` blob (webp frames,
15 fps, q85) through `CouchCoopSpineClipProvider`, served over `/spines/`, and the browser plays it
on its own rAF clock. That channel does **not exist in the render-stream** today; the render-stream
client has no spine semantics, only mesh bodies. The client-side *hold* for the frozen subtree (keep
the last mesh, stop applying updates to it) is the freeze-subtree hook (§5).

**Cost.**

| | OFF | ON |
| - | --- | -- |
| host | zero: nothing changes | game-side deformation stops (the big win); capture sees a static mesh |
| wire | zero: today's predicted `mesh_u8`+`mesh_f32` | the spine's residuals vanish; a once-per-anim-change clip ref + track time travels on a side channel |
| client | zero: pure client | clip decode (webp) + draw, plus the freeze-subtree bookkeeping |

**Primitives.** TAG (identity to tag spine nodes), the freeze-subtree hook (hold the subtree), the
/13 prediction (today's carrier of the per-frame spine mesh), and the **old mirror's spine clip
channel** (spirectl asset baking + a client spine runtime) — a product piece the render-stream does
not carry.

**Decision: defer.** The client continuation needs a Spine clip channel (spine-godot + spirectl), a
large, product-coupled build that is not render-stream-generic; the host-side freeze is already
proven in the old mirror. The measurement that would change this is FRZ-M's per-seat spine leg: host
CPU saved by freezing spine against the client clip decode/draw cost and its visual acceptability.

## 2. Particles (`freezeParticles`)

**Host.** The old mirror freezes `GpuParticles2D` / `CpuParticles2D` with `ProcessMode.Disabled`,
which stops the game-side per-frame particle simulation (again: script sim, not raster — the dummy
renderer does zero draw calls). One-shots that self-free on `finished` are handled two ways: a
narrow exemption list, and a general **end-of-burst nudge** that synthesizes the `finished` signal
and clears the latched `Emitting` flag at `lifetime * (2 - explosiveness)` + margin (Godot's own
`active_time`), so game pacing and the client's re-simulated tail both survive.

**What the render-stream host stops sending.** This is the one freeze where the render-stream
already ships the continuation.

- **GPU particles (/12, PM5/PM6):** the host sends the **emitter, not the particles** — the
  `particles_*` config, seed, restart/emit/emitting events, emission transform and process material.
  The client re-simulates. Freezing the host-side sim costs the render-stream nothing extra: the
  wire already never carries per-frame particle positions, and the client already simulates. The
  host-side freeze is therefore pure waste elimination on the seat, with the render-stream contract
  unchanged. (`rd-particle-color-linearization` is the one colour trap the sim already handles.)
- **CPU particles (/11, PM1):** the host sends the **multimesh instance buffer** — an exact tier.
  Freezing the host-side sim stops those buffer updates, so the client would need to switch that
  node to spec-based simulation. The GSW simulator already unifies CPU/GPU into one
  `ParticleSpecConfig`, so the *simulation* exists, but the *wire* does not carry the CPU spec.

**Cost.**

| | OFF | ON |
| - | --- | -- |
| host | zero | game-side particle sim stops (per-seat CPU win); for GPU the capture work is unchanged, for CPU the multimesh buffer stops changing |
| wire | zero | GPU: already the emitter tier; CPU: the multimesh buffer goes quiet (but only if the client is told to simulate instead) |
| client | zero | GPU: the existing `packages/effects` simulator; CPU: a new approximate sim path |

**Primitives.** The GSW particle simulator (`packages/effects/src/particles/`, PM6b's
`packages/render-stream-client/src/particles.ts`), TAG (identity), and the suspender's
end-of-burst nudge (couch) so one-shots still end.

**Decision: build now for GPU particles — it is already built — and defer CPU particles.** GPU:
PM6b already simulates the emitter, and the host-side freeze is the couch suspender re-run on the
streaming seat, so nothing new is needed in GSW beyond the negotiation and a verification leg
(FRZ-P). CPU: freezing `CPUParticles2D` would downgrade it from the exact multimesh tier to the
approximate simulator; that parity loss needs FRZ-M's host-CPU-vs-error measurement before it is
accepted.

## 3. Tweens (`tweenReplay`)

**Host.** Nothing. TW (`tween-descriptors-design.md`) established the capture cannot see a Tween: at
the RenderingServer it is the same per-frame stream of setters as a `_process` script. A wire
descriptor tier was measured and rejected (ceiling −132 B, −1.1 % of a warm combat frame, most of it
in spine bodies; and the parity-safe form is predictive float coding that WB already rejected).

**Client continuation.** The user's Q6 re-frames `tweenReplay` as *smooth motion through an
intermittent connection*, not only bytes. The continuation is a **client-side module**: keep motion
going between received frames — interpolate toward the last known position, or extrapolate with a
second-order predictor — rather than stalling on a dropped/late frame. This breaks paired-frame
parity by definition, so it is an opt-in extension (TAG2's §3.3 "Not this design"), negotiated and
absent from the pure stream. It saves the host nothing; it is a viewer-smoothness lever.

**Cost.** OFF: zero (pure client, empty extension list). ON: client-only work while the module runs
(one predictor + a redraw loop); host and wire unchanged.

**Primitives.** TAG2's override table + `requestRedraw` (the redraw loop), and the /13
second-order predictor (`P = 2·ord(v[T−1]) − ord(v[T−2])`) as the extrapolation kernel.

**Decision: reject the wire descriptor (TW already did), defer the client continuation.** It saves
no host CPU and departs from parity (opt-in). The measurement that would decide it is a smoothness
leg under a simulated intermittent connection (dropped/late frames), not a bytes leg.

## 4. Decor (`freezeDecor`)

**Host.** The old mirror's decorative freeze is keyed by **C# type name** (not class — these are
script classes on native bases), with **two mechanisms** because "decorative" comes in two shapes:

- `ProcessOnly` (`SetProcess(false)`): the churn is the node's own `_Process` override —
  `NEnergyCounter` (combat energy orb spin), `NIntent` (enemy-intent bob + 15 fps flipbook).
- `WholeNode` (`ProcessMode.Disabled`): the churn is a self-bound tween chain and the node has no
  `_Process` — `NRestSiteFireVfx` (candle flame flicker/sway). `ProcessMode.Disabled` also pauses
  the node's own `TWEEN_PAUSE_BOUND` tweens, which is the point here, but it is exactly what would
  strand a node that still needed a self-bound slide tween (the energy-orb bug) — hence the split.

`NStarCounter` is **deliberately absent**: its per-frame path is the only thing that raises the count
label, and its spin is removed at the *producer* (`Sts2OrbSpinFold`) rather than by this freeze.

**What the render-stream host stops sending.** Decor motion is per-frame transform churn — the
`item_f32` / `cmd_f32` changes the capture walks and emits every frame. Freezing stops both the
game-side `_Process` writes and the capture's per-frame diff for those items.

**Client continuation.** The client replays the authored motion on its own clock — orb spin (nested
concentric rings at `BASE/(i+1)` ms), intent bob (period 2000 ms, amplitude 10 px), flame flicker —
keyed by scene-relative path, composed from the authored rest pose. In the old mirror this is
`animAttributes.ts` over `@spirectl/presentation/render` animation bindings: **product-authored**
motion parameters, not something GSW can derive from the stream. The client-side *hold* for the
frozen subtree is the freeze-subtree hook (§5), with the replay applied as TAG2 overrides over it.

**Cost.** OFF: zero. ON: host transform churn stops; the client runs the replay (one override loop
per replayed node).

**Primitives.** TAG (identity), TAG2's override table + `requestRedraw`, the freeze-subtree hook
(hold the last transform), and the product's animation bindings (couch).

**Decision: defer.** The host-side freeze is reusable and generic in shape (freeze a tagged node
type), but the client replay is product-authored motion, so the full freeze is a couch module on the
extension API; the GSW prerequisite is the freeze-subtree hook. FRZ-M's decor leg decides it on
host CPU saved against client replay cost and acceptability.

## 5. The client hold: the freeze-subtree hook

The shared client primitive for "hold a frozen subtree, keep its last records, resume cleanly" is
already sketched in `client-extensions-design.md` "As built (TAG2)" (not built):

> one more value per override-table entry, `frozen`, with no pure cost — `apply` tests
> `frozen.is_empty()` once; only when set, it skips the upserts and removals of items whose nearest
> frozen ancestor is in the table, keeping their records (rows, lowering, attach entries); the
> retention sweep already keeps every payload a record still references; unfreezing marks the
> subtree changed and the next apply re-reads it from the state (which the validator keeps current);
> the item map needs no parent links (`state.items` has them).

This is the client half of Spine and Decor, and it is also the `staticBgEnabled` lever's client
half (PHG). It is not needed for GPU particles, whose continuation is the simulator's own item type.

## 6. Increments

Each lands as one commit with its result doc; timing legs stay real time and go to the milestone
sweep. The **pure-client-unchanged** check from `client-extensions-design.md` §6 applies to every
GSW row: with the freeze off and the extension list empty, host ms, wire bytes and client apply/draw
must equal today's.

| Id | Scope | Fixture | Checks | Sabotages |
| -- | ----- | ------- | ------ | --------- |
| **FRZ-HOOK** GSW (build first) | land `frozen` in the override table and rs-core's applier (the §5 hook); keep the transport, damage and `is_empty` paths as sketched | `tag-scene` | the pure-client-unchanged check; freeze a subtree, apply a transaction that changes and one that removes it, its records stay and its payloads survive the retention sweep; unfreeze re-reads from state and matches the base shot | `frozen-still-applies` (skip only removals) fails the freeze-then-apply shot; `frozen-sweeps` (drop the subtree's payloads on sweep) fails the retention check |
| **FRZ-P** GSW (build now, mostly verify) | negotiate the particle freeze as an opt-in (a `GRC_*` host grant read at arm; hello absent = pure); confirm a frozen GPU emitter still replays its restart/emit/emitting events through the suspender's nudges | `pm7` / the PM6b particle fixture, `capture-scale` | the pure-client-unchanged check; a frozen GPU emitter's one-shot and looping bursts are shot-equal to the reference; the freeze off leaves the wire byte-identical | `freeze-drop-events` (drop restart/emit on a frozen emitter) fails the burst shot; `freeze-send-positions` (emit per-frame positions) fails the pure-client-unchanged wire check |
| **FRZ-T** GSW (defer) | the `tweenReplay` continuation module: a second-order extrapolate/interpolate between received frames, written through TAG2 overrides + `requestRedraw`, off by default | `tag-scene` `moved` replay, plus a dropped-frame injection | with the module off the client is the pure client; with it on, a run with injected gaps is smoother (bounded per-frame error) than the raw stream, and never stalls on a gap; parity is waived only for the opted-in frames | `tween-no-redraw` (skip the redraw loop) fails the smoothness check |
| **FRZ-S** couch-coop (defer) | the spine clip channel into the render-stream seat: suspend the spine family on the streaming seat, serve the clip + track time, and play it over the FRZ-HOOK-frozen subtree | the product's spine scenes | a frozen spine's clip matches the game's own animation by wall-clock; anim-type switches still arrive; one-shot self-freeing VFX still disappear | `spine-no-hook` (miss an anim-type change) fails the switch shot; `spine-strand` (freeze a node mid self-bound tween) strands it, the known energy-orb class |
| **FRZ-DC** couch-coop (defer) | the decor freeze on the streaming seat + the authored replay bindings over FRZ-HOOK and TAG2 overrides | the product's combat/rest-site scenes | a frozen decor node's replayed motion matches the authored binding; the star counter is never frozen and still counts; the energy orb's slide-in tween is not stranded | `decor-whole-node-on-process` (ProcessMode on a `_Process` type) strands the orb; `decor-freeze-star` fails the count check |

**Order.** FRZ-HOOK first (it is the GSW prerequisite for Spine and Decor, and shared with the
`staticBgEnabled` lever). FRZ-P can land without it. FRZ-T, FRZ-S and FRZ-DC wait on FRZ-M's
measurements to be promoted from defer to build.

## 7. Deferred measurement (FRZ-M)

The per-seat host CPU/GPU leg must measure, on a **4-seat** run under a 2-core `taskset` budget with
machine load < 4 (a real quiet-machine run; today's sustained load is > 4, so it is not valid now):

- **For particles:** per-seat frame time with the freeze ON vs OFF (GPU: confirm the already-shipped
  win; CPU: the host saving of freezing the multimesh against the visual error of the approximate
  simulator), and the client sim cost on the g31.
- **For Spine:** per-seat host saving of freezing skeletal deformation, the client clip decode/draw
  cost, and whether 15 fps webp clips are smooth enough as the continuation.
- **For decor:** per-seat host saving of stopping transform churn, against the client replay cost and
  its acceptability.
- **For `tweenReplay`:** a separate smoothness leg (dropped/late-frame injection), not a host-cost
  leg — it saves no host CPU.

Harness: **C3** for the deterministic fixture route (menu → map → combat, GPU-rendered, and the
`--headless` seat legs as in HSD) to get repeatable per-seat numbers; **MIR-3** (couch-coop's live
streaming-seat leg) to confirm on the real seat that the freeze is opt-in, the pure stream is
byte-identical, and the continuations look right in the product.

## Not this design

- `staticBgEnabled` and `backstopOcclusion` are client levers (PHG), not host freezes; the
  freeze-subtree hook is their shared client primitive, which is why FRZ-HOOK is owned here.
- No per-viewer freeze: a freeze is a **seat** property (every viewer of the frozen seat sees the
  continuation), so P3-SP's shared encodes hold.
- No quantization of the frozen spine/particle content; the parity stream stays lossless, and the
  freezes are the opt-in departures from parity.
