# Tween descriptors (TW): design note (2026-10-28)

**Verdict: no-go.** Render-stream should keep sending per-frame item transforms and modulates.
Tween descriptors (start, end, duration, transition, ease) would not pay for themselves on STS2:

- **The capture cannot see a Tween.** At the RenderingServer it is the same per-frame stream of
  `canvas_item_set_transform`, `set_modulate` and redraws as a `_process` script or an
  AnimationPlayer.
- **Pixel parity needs per-frame correction.** The receiver would need the host's process clock,
  the node-level property mapping and the host's libm, bit for bit. So a parity-safe tier must
  check every frame and correct it.
- **The ceiling is small.** If every item transform and modulate change in warm STS2 combat were
  free, the coded /11 frame would fall from 12,477 B to 12,345 B: **−132 B, −1.1 %**. Spine mesh
  bodies are 97 % of that frame.

Measurements: [results/p3/tw.md](../results/p3/tw.md). This note answers the four design
questions, then gives the criterion for reopening the question and the shape a reopened design
would take.

The binding constraints (user, 2026-10-27; memory `render-stream-pure-client-first`). Anything
proposed must:

- keep pixel parity: the receiver's frame equals the host's at the paired frame;
- add no STS2 or product concepts;
- keep P3-SP's shared encodes, which serve one encode to every viewer at equal seq stamps;
- add no per-frame host work when the feature is unused.

## 1. What the capture can observe

### 1.1 A Tween at the RenderingServer level

The capture interposes the `RenderingServer` vtable of a stock engine (memory
`rs-interposition-megadot-facts`). It sees RS calls and nothing above them. A tween reaches the
RS like this (Godot 4.5.1):

1. `SceneTree::process_tweens(p_delta, p_physics)` (`scene/main/scene_tree.cpp:812`) runs after
   the tree's `_process` / `_physics_process` and its timers (`:648`, `:717`).
2. `Tween::step` (`scene/animation/tween.cpp:315`) scales the delta by `speed_scale`. It walks the
   current step's tweeners and carries any leftover delta into the next step.
3. `PropertyTweener::step` (`:618`) computes `interpolate_variant(initial, delta, time, duration,
   trans, ease)` and calls `target->set_indexed(property, value)`.
4. The property setter runs the node's own logic:
   - `Node2D::set_position` and its rotation, scale and skew siblings rebuild the matrix with
     `set_rotation_scale_and_skew` and call `canvas_item_set_transform`
     (`scene/2d/node_2d.cpp:135-139`).
   - `Control` goes through `_size_changed`: anchors, offsets, pivot and the
     `snap_controls_to_pixels` floor (`scene/gui/control.cpp:716-725`). It may also re-lay out
     children and redraw.
   - `CanvasItem::set_modulate` / `set_self_modulate` are direct RS setters
     (`scene/main/canvas_item.cpp:474-481`).
   - Any other property, such as `size`, a `value`, `visible_ratio` or
     `material:shader_parameter/x`, ends in whatever RS calls its owner makes: often
     `canvas_item_clear` followed by a re-recorded command list.

So **at the RS level a Tween is nothing but per-frame setter calls and redraws**. It cannot be
told apart from `_process` code, an AnimationPlayer property track (which also goes through
`set_indexed`) or physics. In the kept STS2 recording, those per-frame calls are 5.8
transform-only, 0.2 modulate-only and 0.05 transform-and-modulate item changes per warm combat
frame (tw.md).

### 1.2 Routes to the descriptor

| route | generic for any Godot game? | game cooperation? | why not |
| ----- | --------------------------- | ----------------- | ------- |
| **Hook `Tween::tween_property` / `PropertyTweener` setters** | no | no | They are non-virtual C++ methods reached through `MethodBind` from GDScript and C#. Intercepting them means either inline-patching engine code or rewriting `MethodBind` internals, which no GDExtension API exposes. GDScript and C# cache their binds, and engine-internal C++ callers bypass them. The capture's seam is one heap vptr write with no code patching. Couch-coop forbids modifying the executable, and the in-memory equivalent is the same breach. |
| **Interpose `Tweener`'s vtable** (`start` and `step` *are* virtual, `tween.h:45-47`) | no | no | Every `PropertyTweener` is born inside `Tween::tween_property`, so there is no instance to swap a vptr on. Patching the class vtable itself means writing the image's RELRO page, which is code patching again. |
| **Read live tweens from `SceneTree.get_processed_tweens()`** | partly | no | The API returns `Tween` objects, but `Tween` exposes no tweener list and `PropertyTweener` exposes no getters. The descriptor (`initial_val`, `final_val`, `duration`, `trans_type`, `ease_type`, `elapsed_time`, `delay`, `relative`, `custom_method`) is private member data. Reading it needs a per-binary, per-flavour calibrated *data layout*, a weaker contract than the RS vtable layout the calibrator already pins. It also costs a poll every frame while any tween exists. |
| **Script-side observer** (an autoload, or a wrapped `create_tween`) | no | **yes** | An autoload sees the same opaque `Tween` objects as above. A wrapper that records descriptors has to replace the game's own `create_tween` calls, in GDScript and C# alike. That is game-specific code and not allowed in the pure stream. |
| **Inference from the RS stream** (fit an easing curve to an item's transform or modulate run) | **yes** | no | It is fully generic, but it only predicts: it cannot know a kill, a replacement, the next delta or a loop. On STS2 only 30 of 1,380 warm-combat transform/modulate runs (382 of 16,272 moving item-frames, 2.3 %) fit one standard Godot easing curve within 0.2 % of their span. The rest are continuous motion: orbits, bobs and redrawn text (tw.md, "Is it tween-shaped?"). |

**Only inference is generic without the game's cooperation, and inference is a predictor, not a
descriptor.**

### 1.3 Even an exact descriptor is node-level

A descriptor names an `Object` property. The wire carries RS state. Between the two sits node
logic that the receiver does not run:

| tweened property | RS effect | can a receiver map it 1:1? |
| ---------------- | --------- | -------------------------- |
| `modulate`, `self_modulate` | `canvas_item_set_modulate` / `set_self_modulate`, `Color::lerp` in float | **yes**, the one clean case |
| `Node2D` `position` | `canvas_item_set_transform` of `T(position)·R·S·K` | only if the host also sends rotation, scale and skew; the RS matrix does not decompose exactly |
| `Node2D` `rotation`, `scale`, `skew` | the same matrix, rebuilt with `sin`/`cos` in `real_t` | only with the host's libm results (§2) |
| `Control` `position`, `rotation`, `scale` | `_get_internal_transform` around `pivot_offset`, then `floor(+0.5)` under `snap_controls_to_pixels` (on by default) | needs the node's pivot, anchors and the snap flag. The floor turns a curve into a staircase |
| `Control` `size`, `custom_minimum_size`, theme values, `value`, `visible_ratio`, shader parameters | layout of children, `queue_redraw`, a re-recorded command list | **no**: arbitrary engine and script logic |
| `tween_method`, `tween_callback`, `set_custom_interpolator` | any script code | **no** |

## 2. Parity

### 2.1 What one frame needs

To reproduce frame *n*, the receiver must evaluate
`set_indexed(property, interpolate(initial, final, E(trans, ease, elapsed_n / duration)))` and then
the setter's node logic, all bit-exact. It needs:

- **The host's tween clock.** `elapsed_n` sums the *process* deltas: the tree's clamped
  `process_step × time_scale`, or the unscaled `get_process_step()` under `set_ignore_time_scale`
  (`scene_tree.cpp:816`). It is then scaled by `speed_scale`.
  - That is not `shader_time`. P3-CK moved `shader_time` to the `RS::draw` step precisely because
    the tree's step is clamped after a long iteration and the draw step is not
    (results/p3/p3-ck.md).
  - `shader_time` is also absent when no state reads `TIME`.
  - A descriptor tier would need a new per-transaction process clock.
  - Physics-mode tweens (`TWEEN_PROCESS_PHYSICS`) step 0–8 times per frame with the fixed physics
    step, so they need the tick count too.
- **Pause state.** That is `SceneTree.paused` against the tween's `pause_mode`, whether the bound
  node is inside the tree and `can_process()` (`tween.cpp:414-423`), and `pause()`, `play()` and
  `stop()`.
- **The start value.** `from_current` and `do_continue` read `get_indexed` when the tweener
  starts, which may be frames after the tween was created (`set_delay`, a chained step). That value
  is node state, and it is only on the wire for 1:1 channels.
- **The step machinery.** That covers chained and parallel steps, with the leftover delta carried
  across a finished tweener (`tween.cpp:364-407`), loops, `as_relative`, and subtweens.
- **The host's arithmetic.** `run_equation` works in `real_t`, but Penner's functions call
  `std::cos`, `std::sin` and `std::pow` with mixed `float`/`double` arguments
  (`easing_equations.h`). Then come `Vector2::lerp` and `Color::lerp` in float, and for rotation
  `sin`/`cos` again. The host's results are glibc's. The receivers run Rust `libm` (wasm), the
  platform libm (native) or V8. Agreement to the last ulp is likely in most frames and guaranteed
  in none.

### 2.2 What breaks it

| case | effect on a descriptor |
| ---- | ---------------------- |
| `kill()`, `stop()`, a second tween on the same property, `queue_free` of the target | the descriptor is wrong from that frame on; the host must cancel it |
| the property also written by `_process`, `_physics_process`, an AnimationPlayer or a signal handler | the last writer in the frame wins (`_process` runs before `process_tweens`), so the descriptor is wrong in exactly the frames where they collide |
| `tween_method`, `tween_callback`, a custom interpolator | not describable |
| a relative tween over a moving start, or `from_current` after a delay | the start value is unknown until the tweener starts |
| a `Control` under `snap_controls_to_pixels` | the RS value is `floor(v + 0.5)` of the curve, a node-level rule |
| a variable frame time, `time_scale`, a host stall | needs the process clock (§2.1); the receiver's `shader_time` drifts from it under stalls |

**Transform propagation is the one case that helps.** RS transforms are local, so children of a
tweened `Node2D` need no update, and the receiver already composes parents. `top_level` items
are re-parented to the canvas in the RS and do not follow, which is correct. Clip rects and the
rotated-clip AABB are derived from the composed transform, which the receivers already do
(gate 3c). A `Control` whose size is tweened still re-lays out its anchored children, and each of
their RS transforms changes. A descriptor on the parent does not cover them.

### 2.3 The only parity-safe shape

No descriptor alone can guarantee the paired frame, so any tier must be **fallback-safe**:

1. The host and the receiver evaluate the same channel predictor with the same code: one Rust
   function linked into both the capture and rs-core, with no libm (polynomial or table, specified
   bit for bit).
2. On every frame where a descriptor is live, the host compares the prediction's bits with the
   value the RS actually received.
3. If they differ, the item goes into the patch with its real floats, exactly as today, and the
   descriptor is cancelled. The descriptor is only an encoding of "these floats equal the
   prediction".

This is lossless, because the resolved state is unchanged. It also keeps P3-SP's sharing: the
descriptors and corrections are part of the resolved state, so an encode is still a function of
(base, target). And it costs nothing when unused: no live descriptor means no comparison.

It is, however, **predictive delta coding of item floats**. WB already rejected delta-coding
those floats by item id ("not worth it": base-prefix zstd takes 37 KB of item and command floats
down to about 0.26 KB, render-stream-11.md "Warm wire budget (WB)", Decisions). §3 bounds what a
better predictor could add on top of that.

## 3. Benefit, measured

Full method and tables: [results/p3/tw.md](../results/p3/tw.md). The kept /11 STS2 recording
`w11b-a11-1` was rebuilt under ablations, and each arm was coded with W11t's base-prefix zstd-3
against its own previous message:

| warm, per frame | menu | map | combat |
| --------------- | ---: | --: | -----: |
| /11 coded (base-prefix zstd-3) | 1,012 | 293 | **12,477** |
| every item transform and modulate change free (descriptor ceiling) | 1,012 (0) | 183 (−110) | **12,345 (−132, −1.1 %)** |
| every patched item free (ceiling of any item-level scheme) | 1,012 | 36 | 12,047 (−430, −3.4 %) |
| every mesh entry and body free | 173 | 293 | 358 (−12,119, −97 %) |

- The ceiling assumes a descriptor costs nothing and covers every moving item. In fact a
  descriptor is about 40–80 B a time it starts, plus a process clock in every transaction and the
  corrections.
- Only 2.3 % of the moving item-frames fit a standard easing curve.
- So the realistic saving on STS2 is a few tens of bytes a frame, against about 5.6 KB that the
  final binary swap's XOR-delta and quantized mesh bodies would remove (WB, "Projection").
- Uncoded (`GRC_LIVE_CODING=off`, not a target), the ceiling is 3.0 KB of 78.4 KB raw (3.8 %).
- Host CPU does not improve in any arm. The engine still runs the tween and still calls the
  setter. The mirror still records it. Snapshot and diff stay O(table) (WB, "Host capture cost").

## 4. Recommendation

**No-go for render-stream's wire, at /11 and in the final binary swap.** Every route fails
somewhere:

- **Descriptors from hooks** break the capture's no-code-patching seam, or depend on calibrated
  private data layouts. They are also node-level, so they need node logic on the receiver.
- **Descriptors from a game-side wrapper** are product cooperation.
- **The parity-safe form** (§2.3) is generic, but it is predictive float coding worth at most
  132 B (1.1 %) of a warm combat frame. It would add a process clock, a bit-specified math kernel
  on both ends and per-frame verification while descriptors are live.

The bytes are in spine poses, and the next lever there is the final binary swap's mesh tier.

**Reopen criterion.** Reopen this question only for a recording whose warm coded frame has
**at least 25 % of its bytes in the "transform and modulate free" ablation** (tw.md's arm A),
measured with the same method. That would be a game whose motion is UI tweens rather than
skeletal meshes. STS2 is at 1.1 % in combat and 0 % on the menu. The map is at 37 % of a
293-byte frame (110 B, 0.05 Mbps), so it does not qualify: its absolute bytes are noise.

**Not this design:** client-side animation of things the host animates, such as interpolating
between host frames on a 120 Hz display or animating a `_process` motion locally. That breaks
the paired-frame parity by definition. It belongs to the opt-in customization modules (memory
`render-stream-pure-client-first`), negotiated in the hello and absent from the pure stream.

### If it is ever reopened (not scheduled)

The opt-in and version policy would follow /8–/11:

- the tier is a new protocol version (the next free one after /11), never retrofitted into
  /11, with a hello capability (`item_prediction`) that a receiver must offer;
- defaults do not move: the host plans no comparison unless a connection negotiated it;
- older versions stay byte-identical, and their goldens pass unchanged.

Increments, each with its checks and sabotages:

| id | what | checks | sabotages |
| -- | ---- | ------ | --------- |
| TW1 | Fold `tween-scan.py`'s arms into `wire-budget.py measure --ablate item-anim`, so any new recording reports the reopen criterion | a synthetic self-test with hand values, in the pure suite | none (tooling) |
| TW2 | The bit-specified predictor kernel in rs-core (one Rust crate shared by the capture and the receivers, no libm) and its golden vectors | the same bits on native, wasm32 and the capture across every Godot transition and ease | `pred-libm` (the kernel calls `f64::cos`) differs from the goldens on at least one vector |
| TW3 | Capture: inference-only descriptors with per-frame verification, and the wire block | the resolved state with the tier equals the resolved state without it, bit for bit, on every transaction (`gate6-scene` `animate`, `capture-scale`); shared encodes still share | `pred-no-correct` (skip a correction) fails resolved equality; `pred-stale-after-kill` (keep a descriptor after the run stops) fails it too |
| TW4 | Receivers apply it, plus a process-clock key | shot parity on every reached g7 group | `pred-clock-skew` (evaluate at the previous frame's clock) fails shots and resolved equality |
