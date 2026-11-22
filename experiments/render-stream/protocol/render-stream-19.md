# render-stream/19 wire format and announced material-parameter tweens

Status: **specified, not implemented**. /19 is render-stream/18
([render-stream-18.md](render-stream-18.md)) plus announced ShaderMaterial
parameter tweens. A producer can announce, for example, a dissolve threshold
from 1 to 0 over two seconds; the client evaluates it between host transactions.
The host continues its real tween and normal capture. /17's approximate visual
parity, displayed-picture clock and opt-in semantics apply. This adds no promise
of reduced capture, bandwidth or latency and contains no product-specific API.

**Base assumptions.** /18 means /17 plus the hello and
`publication.credit_window` range 1..8, with magic `GRSI`
(`47 52 53 49 0D 0A 1A 0A`). Its current text also describes adaptive pacing and
an /18-only host without downgrade. This specification assumes the stated
/17-plus-window base, retains /18's adaptive window, draw pacing and telemetry
for /19 and /18 connections under a /19 host, and explicitly requires the
version availability below. /17 and /16 keep the global period. There is no
/19-specific pacing change; this does not edit /18's text or code. Everything
not changed here is /18's, including /17's node tween grammar and behavior
([render-stream-17.md](render-stream-17.md)).

## Version and negotiation

- Magic: `47 52 53 4A 0D 0A 1A 0A` (`GRSJ`). Recording suffix: `.rs19`.
  Hello/session protocol: `render-stream/19`; transport: `render-stream.19`.
- `GRC_STREAM_VERSION=19` enables /19 first and keeps /18, /17 and /16
  available per connection: the offer is exactly
  `{render-stream.19, render-stream.18, render-stream.17, render-stream.16}`
  in that preference order. Window 1..8 applies on /19 and /18; /17 and /16
  retain 1..2. File streams still declare window 1. /19 and /18 connections
  use /18's adaptive window, draw pacing and telemetry; /17 and /16 use the
  global period. No older connection acquires /19 grammar.
- The existing optional last hello key `"client_tweens":true` grants both
  node and material tweens on /19. The session echoes it immediately before
  `blocks`, as in /17. There is no second capability key. Absence disables both;
  `false`, null or other values are invalid. No tween record or transaction
  `t_us` is legal without the grant.
- `createRenderStreamClient` keeps `clientTweens` default false and its existing
  version selection when omitted/false. An explicitly selected /19 endpoint
  with `clientTweens:true` requests both kinds; a /17 or /18 endpoint requests
  node tweens only. There is no automatic upgrade of existing callers. A caller
  requiring material playback selects /19 and requires its grant; failure does
  not silently reconnect at an older version.
- /19 without the grant has /18's transaction grammar under /19 identifiers.
  Ordinary file sinks still do not activate tween capture; a tap of a granted
  live connection can record both kinds. All resource, predictor, hint,
  item_meta, viewport, ACK and credit rules remain unchanged.
- Filter material events **before encoding** on /17 and /18 connections, and
  all tween events on /16. Also filter cancels of begins that connection never
  knew. Never encode material float data, empty placeholders or new keys there.
  Node begins/cancels/poses on /17 and /18 retain their existing schemas and key order;
  normal scene transactions on every connection continue showing host material
  updates. Global announce order may contain gaps from filtered material begins;
  it is not renumbered per connection. A filtered event is counted, not a control
  or wire error.

## Host API additions

Keep `RenderStreamCapture.tween_begin(dictionary)` and `tween_cancel(tween_id)`.
The outer dictionary and timing/easing keys remain /17's. On /19 a begin's
`object_id` may also name a **ShaderMaterial resource**:

```gdscript
var capture = Engine.get_singleton("RenderStreamCapture")
material.set_shader_parameter("threshold", 1.0)
capture.tween_begin({
    "tween_id": 7001,
    "object_id": material.get_instance_id(),
    "started_usec": Time.get_ticks_usec(),
    "steps": [{
        "property": "shader_parameter/threshold",
        "from": 1.0,
        "to": 0.0,
        "start_ms": 0,
        "duration_ms": 2000,
        "trans": Tween.TRANS_LINEAR,
        "ease": Tween.EASE_IN_OUT,
    }],
})
# Run the corresponding native Godot Tween as well; announcement does not create it.
```

Calls are main-thread only. `object_id` is neither RID nor stream id. Resolve
ObjectID, check ShaderMaterial, obtain its resource RID, then resolve a live
published stream material. Do not retain the object or Resource strongly.
No CanvasItem `material:shader_parameter/<name>` alias is accepted: callers pass
that item's material resource explicitly. A begin targets exactly one node or
one material; its steps cannot mix those kinds. Node targets keep /17's behavior.
CanvasItem targets still use /17's resolver and its existing failure reasons.
The single host validation order below governs both target branches.

Retain the unarmed/no-tween-grant early return before dictionary traversal or
ObjectID lookup. With only node-capable grants, reject a material announcement
with `material-version` at the begin validation stage below, without reading
parameters, creating claims, retaining a live ID or installing per-frame material work.
Count its per-connection filtering as described below. With a material-capable
grant, validate and accept once globally, then queue only for eligible /19 viewers.
The global ID/order namespace includes node and material announcements. Cancel,
reuse after retirement, explicit/implicit start, conversion to microseconds,
finite schedules and the 12 transition / 4 ease enums are /17's.

### Names and Variant values

Accept `shader_parameter/<name>` and optionally one component suffix
`:<component>`. `<name>` is one exact, case-sensitive Godot shader identifier:
`[A-Za-z_][A-Za-z0-9_]*`. No slash, nested path, array index, legacy alias,
instance or global property spelling is accepted. The wire carries the bare
name, not the API path. Components are normalized to zero-based indices.

| Explicit material param type | Arity | Whole endpoint | Allowed scalar suffixes |
| ---------------------------- | ----- | -------------- | ----------------------- |
| `float`                      | 1     | Godot float    | none                    |
| `vector2`                    | 2     | Vector2        | `x`, `y`                |
| `vector3`                    | 3     | Vector3        | `x`, `y`, `z`           |
| `vector4`                    | 4     | Vector4        | `x`, `y`, `z`, `w`      |
| `color`                      | 4     | Color          | `r`, `g`, `b`, `a`      |

Validate only the explicit Variant type recorded in the mirror's material
`params` table. The current value, `from` when provided, and `to` must match
that row exactly, except component endpoints are floats. Explicit mirror params
recorded as scalar Godot ints, integer vectors, bools, textures, arrays/packed
arrays, matrices or other unsupported Variant types are rejected with
`material-param-type`; no coercion or vector padding is performed during host
announcement validation. A syntactically valid
component suffix that is invalid for the recorded type is
`material-param-mismatch`. All baseline/endpoint components must be finite and
convertible to finite f32. Color values use stored RGBA components, with no
playback color-space conversion, clamping or special `source_color` handling.
Overshoot is preserved.

Do not inspect shader uniform declarations, validate declaration arity or scope,
or add a declaration cache. Binding still feeds the effective param through
`uniform_value` using the client's own declarations, exactly as it does for
host params. This preserves existing upload conversion even when a supported
Variant differs from the shader declaration. Global and instance uniforms are
not material-param targets: their property paths/tables are not accepted here.
This adds no declaration-scope validation for a bare material param name.
Builtin materials, null shaders and non-canvas shaders remain unsupported
material targets under the begin checks below.

Require an explicit supported value in the resolved material `params` table.
A default-only/unset parameter is rejected with `missing-material-param`, even
when `from` is explicit. Initialize it with `set_shader_parameter` before
announcing, as above. This makes the retained host baseline sufficient without
adding shader-default evaluation or relying on renderer getters.

## Wire additions and ordered keys

Only the granted /19 `tween` record gains an alternative begin schema. Its
ordered record keys remain exactly /17's:

```text
{"type":"tween","seq":<transaction seq>,"frame":<transaction frame>,
 "t_us":<transaction t_us>,"events":[<node begin, material begin or cancel>...],
 "poses":[<node pose>...],"blocks":[<tween_f32 descriptor if nonempty>]}
```

A **material begin** has these exact ordered keys:

```text
{"op":"begin","tween_id":<canonical signed-i64 decimal string>,
 "material":<stream material id>,"order":<int>=1>,
 "begin_us":<int>=0>,"end_us":<int>=0>,
 "steps":[{"param":<bare uniform name>,
           "type":"float"|"vector2"|"vector3"|"vector4"|"color",
           "component":null|<zero-based component index>,
           "start_us":<int>=0>,"duration_us":<int>=0>,
           "trans":<int 0..11>,"ease":<int 0..3>,
           "from":null|<float offset>,"to":<float offset>}...]}
```

`item` and `material` are mutually exclusive schema alternatives, identified by
that key after `tween_id`; no new `kind` key is added. Node begins and their steps
are unchanged. A cancel remains exactly
`{"op":"cancel","tween_id":<decimal string>}` for either target kind.
All JSON integers obey /0's exact bound; material IDs use the existing positive
stream material id range. The tween ID keeps /17's signed-64-bit string rules.

Material `steps` is nonempty after host filtering and retains API order.
`type` is the explicit baseline Variant type, not a new shader declaration.
`component:null` claims the whole type (1, 2, 3 or 4 floats); an integer claims
one component and consumes one float per endpoint. An integer must be below the
type's arity and is forbidden for `float`. Names/types/components are exact;
`end_us`, precedence and time ranges obey /17, globally across both begin kinds.

### Float layout

Keep the single lossless little-endian `tween_f32` block, unpredicted and outside
`predict_check`. Its exact layout is:

1. **Node step endpoints:** walk events in call order, skipping material begins
   and cancels; within each node begin walk steps in array order, appending
   explicit `from` when non-null, then `to`, using the node step's arity.
2. **Node poses:** append /17's unchanged 16-float poses in ascending item-id order.
3. **Material step endpoints:** walk events in call order, skipping node begins
   and cancels; within each material begin walk steps in array order, appending
   explicit `from` when non-null, then `to`, using `type`/`component` arity.

Events themselves retain call order; only float traversal is partitioned.
Material begins require no node pose and contribute no baseline floats. The
/18 node endpoint-plus-pose view is an exact prefix of the /19 float block;
node-only records retain /17's layout byte for byte. A /19-to-/18 transcode
truncates the material tail and updates `count`, with no surviving offset rewrite.

Offsets count floats from zero and must be exactly the next running offset
in the three traversal phases above: no gaps, aliases, unused tails or overlaps.
`blocks` is either
`[{"name":"tween_f32","type":"f32","count":<exact count>}]` or `[]` for
zero floats, with the corresponding one or zero binary blocks. Every f32 is
finite. A material-only begin record has `poses:[]`; a material cancel-only
record can have `poses:[]` and `blocks:[]`.

### Baselines, association and lifetime

As built, a creation-frame ShaderMaterial already tracked by the mirror may defer publication
resolution once to the next main-thread snapshot, retaining API validation, original time/order
and viewer eligibility; cancellation removes the pending begin without an event, freeing drops
`target-gone`, and failure to publish drops `unpublished-material`. The material baseline belongs
to that snapshot's transaction; wire bytes are unchanged.

Use the **resolved host material table belonging to the drawn transaction** as
the baseline. Each material upsert replaces its complete param list; omission
from a patch retains the previous complete entry. Consequently, an unchanged
material need not be re-sent in the begin transaction. No new material pose,
forced upsert or parameter suppression is introduced. `param_f64` remains the
ordinary authoritative host block, including host changes to claimed parameters
on every frame. Playback endpoints stay f32, as for node tweens; on release the
normal binding path consumes the retained host value with its normal conversion.

The begin material must exist with a supported shader and matching explicit
params in the transaction's **resolved** state, not necessarily its upsert list.
At association, the host rechecks this against an immutable param snapshot taken
on the main thread at `Host::snapshot()`, alongside node poses, and associated
with the scene snapshot being sent. The encoder thread never reads live mirror
or engine state for this check. Invalid pending steps are dropped with
`material-baseline-changed`; if none remain the begin retires and its unsent cancel is suppressed. Recompute `end_us` over the
remaining steps, retaining order/start. Count these step drops once globally,
not for each connection seeing the same invalidation. A viewer's claim on a component may
move off an older tween only through a begin that viewer actually receives. Keep transferred
claims per viewer and pending begin, including through cancelled or fully superseded unsent
replacements. If no delivered begin carries a transferred claim (whether association pruning,
timing suppression or another unsent-begin suppression removes it), retire the older material
tween globally with `material-target-changed` and ordinary cancels, suppressing its unsent begin
and cancel so those claims cannot resurrect on any viewer. A delivered successor can carry the
claim move through an unsent replacement chain; an intact partial replacement needs no cancel.
A parameter update of the same supported type is normal baseline motion and never invalidates a step.

/17's one-record association, placement before item_meta/transaction, timestamp,
resource wait, coalescing, no-extra-credit and byte-statistics rules all apply.
Pending events keep original begin time/order through stalls. No record or
baseline becomes visible before the associated picture can draw. Late join,
resync, disconnect, disarm and session replacement behave as /17: host frames
only for earlier announcements, no replay, and no stale ownership.

Claims are keyed by **(material id, parameter name, component index)**. They
never overlap item transform/color claims, even when numeric IDs match. Whole
and scalar claims follow /17's replacement, partial ownership and no-resurrection
rules. All items using the same material, including inherited material users,
see the animated value. This is the correct meaning of a ShaderMaterial resource
tween; clone the resource first when independent animation is desired.

The host is the sole authority for target-change retirement. Removal/free of
the target material, removal/unsetting of a claimed param, a claimed param's
Variant type change or nonfinite/out-of-finite-f32-range value, shader swap or
shader code version bump, or material/shader status leaving `ok` retires the
entire affected tween globally. The host counts `material-target-changed` once
per retired tween and queues an ordinary `cancel` to every viewer that knows
it. A normal material version bump from `material_set_param` does not retire
it. Keep observing claimed params on host frames even while viewer transactions
are coalesced, so a short-lived change still produces the authoritative cancel.

A removed material ID cannot transfer to a replacement ID; stream resource IDs
are never reused. Replacing an item's material reference detaches only that
item from the old material's animation; other users of the still-live resource
continue its tween. A new material never inherits claims. No CanvasItem
association is retained for a direct resource target.

The client self-retires only at end, on cancel, on claim loss, or when the
material ID is gone from resolved state. It must not independently retire on a
param/type/shader/status change: a coalesced viewer can miss that change and
must consume the same host cancel before a reused tween ID begins. Until cancel
arrives, the display guard below draws host values for missing or wrong-type
params without a wire error. A host cancel is harmless if the client already
retired under one of the permitted conditions, following /17's cancel handling.

## Client evaluation and application

Reuse /17's drawn-picture anchor and monotonic per-tween time, easing, delayed
and chained implicit-from sampling, explicit-from behavior, zero-duration writes,
gap holds, cancellation, precedence and completion handover. The scalar formula
is `from + (to - from) * godotEaseSample(ease, trans, u)`. Apply only components
still owned. Before the first step starts, use the latest drawn host component;
a crossed implicit start samples the currently displayed value before its write.
An endpoint does not remain held after `end_us`.

Maintain a separate material-param display override layer in **rs-core**, below
extensions. `refresh_bindings`/`binding_of` reads the latest drawn host material
params with held components substituted before existing uniform conversion.
For each owned component, substitute only if the drawn host param exists and
its Variant type matches the step's recorded `type`. If absent or wrong-type,
draw the host value through the normal binding path for that component until
the host cancel arrives. This display guard does not release claims, retire the
tween, or report a wire error. Shader/status changes follow the existing binding
fallback while the schedule remains live until authoritative cancel.
It never edits `ResolvedState.Material.params`, shader payloads, host versions,
predictor history, digests or transaction/query epochs. Ordinary instance
uniforms, samplers and all other params stay on their existing paths. There is
no new extension material API or OverrideTable entry. Existing extension item
transforms/visibility and explicit frozen-subtree semantics still compose above
this display layer.

On a tween tick, diff previous and new held values/ownership. Dirty only bindings
using materials whose effective params changed, including every shared or
inherited user; on release refresh them from the host baseline once. Include
binding-dependent alpha/cover/damage invalidation and viewport redraw decisions,
so a shader-only change draws even with no item transform changes. Keep existing
host/texture/program invalidations. Do not force every material or unrelated
binding dirty on each tick. The effective binding for unowned components must
continue taking host updates. Host snapshots waiting undrawn cannot leak into
an implicit-from read or a handover.

The /17 rAF loop remains active for either kind, including delayed steps, pauses
redraws during accepted-but-undrawn payload waits without stopping the clock,
bypasses the idle cap, and sends no additional ACK. The last tick releases and
draws host handover, then requests no further tween redraw. Empty/disabled layers
add no scans, allocations, timer or frame callback. Context restoration keeps the
same timeline. Material playback changes no geometry-query facts or hit-test
shape; shader alpha does not add pixel-based picking.

Client shaders still pass through `transpileGodotItemShader`. A refusal retains
`gsw-shader-transpile` or `shader-withheld` and draws without the material, as
before; playback neither bypasses that refusal nor substitutes a shader. A locally
refused program still advances its validated schedule and retires only under
the permitted conditions above; it cannot apply a visible uniform override.
It is not malformed wire merely because a client cannot compile an otherwise
supported host shader.

## Drops, validation and counters

Use this single first-failure order for host validation. A failed begin rejects
the announcement; a failed step is filtered with one first reason. Keep /17's
cancel validation and counters.

1. Begin: `invalid-record` → `duplicate-id` → `unresolved-object` →
   (CanvasItem: /17's resolution chain) or `unsupported-target` →
   `material-version` → `unpublished-material` → `unsupported-material`.
   Material-specific checks apply only to ShaderMaterial targets; supported
   CanvasItems continue with /17's step chain.
2. Each material step: `invalid-step` → `unsupported-property` →
   `missing-material-param` → `material-param-type` →
   `material-param-mismatch` → `invalid-value` → `invalid-timing` →
   `invalid-easing`.
3. After step filtering: `empty-steps` if none survive.
4. At association: `material-baseline-changed` for incompatible pending steps,
   as defined above; a pending target gone before association keeps `target-gone`.

| Reason                      | Scope / first matching condition                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `unsupported-target`        | begin: resolved object is neither CanvasItem nor ShaderMaterial                                                                        |
| `material-version`          | begin: no granted /19 connection can receive a material begin                                                                          |
| `unpublished-material`      | begin: resource RID has no live published mirror material                                                                              |
| `unsupported-material`      | begin: material/shader status is not `ok`, shader is null, builtin or non-canvas                                                       |
| `unsupported-property`      | step (existing reason): bad material path/name/component spelling                                                                      |
| `missing-material-param`    | step: no explicit non-NIL host material param exists                                                                                   |
| `material-param-type`       | step: explicit mirror param has an unsupported Variant type                                                                            |
| `material-param-mismatch`   | step: suffix is invalid for the recorded Variant type, including any suffix on float                                                   |
| `invalid-value`             | step (existing reason): endpoint disagrees with baseline type, or baseline/endpoint component is nonfinite or exceeds finite f32 range |
| `material-baseline-changed` | pending step: snapshot baseline became incompatible before association                                                                 |
| `material-target-changed`   | live tween: host observes target invalidation; retire globally and queue ordinary cancels to known viewers                             |

No shader-declaration lookup participates in these checks. A null/freed
ObjectID is `unresolved-object`. A component suffix with valid spelling but
wrong type/arity reaches `material-param-mismatch`; unknown suffix spellings
remain `unsupported-property`.

Under host `client_tweens`, retain /17's counters, covering both kinds. Add
`material_begins_accepted`, `material_steps_accepted`, `material_tweens_retired`,
current `live_material_tweens`/`owned_material_components`, and
`material_events_filtered_by_version` (map from negotiated protocol string to
count). The filtered map counts each otherwise granted /17 or /18 connection's
rejected material begin once at announcement and its cancel only if that ID had
an accepted live material announcement globally. A connection without any tween
grant gets no filtering counter or work. This transport count is separate from
API drops: with compatible and incompatible viewers the begin is accepted once,
and each incompatible viewer is counted once; with only old grants it is dropped
once as `material-version` and counted for each old granted viewer. Repeated
encoding attempts do not recount it. Filtered IDs never enter an old viewer's
known set. `poses_sent` remains node-only; material baselines add no sends.
All session totals saturate/reset as /17; off-path calls increment nothing.

Client diagnostics retain /17's totals across both kinds and add
`material_begins`, `material_retired`, current `live_material_tweens` and
`held_material_components`. Count replacement by scalar claim and retirement by
tween, never by shared item user. Completion/cancel remain the existing totals.

### Wire errors and decoded/resolved forms

Validate atomically before mutating playback. Keep /17's validation order and
error codes, extended as follows; older scene validation errors keep precedence
within the associated transaction.

| Code                | /19 additions                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta-schema`       | material schema below /19 or without grant; both/neither item/material, wrong ordered keys, bad name/type/component enum, range or block descriptor                                                              |
| `tween-association` | /17's orphan/duplicate/interposed-record or seq/frame/t_us/grant timestamp mismatch                                                                                                                              |
| `tween-offset`      | endpoint arity/offset/count mismatch, missing/extra block or nonfinite f32, including material endpoints                                                                                                         |
| `tween-time`        | /17's decreasing t_us, future begin or overflowing sum                                                                                                                                                           |
| `tween-entry`       | /17's ID/order/end/empty-step errors; missing/unsupported material or shader in resolved begin transaction, missing param, baseline type/range mismatch, or inconsistent types for the same param within a begin |

Schema fixes endpoint arity from `type`/`component`; entry validation checks it
against the resolved material's explicit Variant value. No declaration checks
or payload-dependent declaration validation are added. A locally refused/withheld
program follows the existing refusal path. Later legitimate host invalidation
is handled by the display guard and authoritative cancel, not by rejecting its
transaction. No material pose is required by `tween-entry`; node pose checks
remain unchanged.

Decoded form is `render-stream-19-decoded/1`, preserving the event alternatives
and decoding `tween_f32`. Resolved form is `render-stream-19-resolved/1`, the
ordinary authoritative host scene with no simulated material values.
`to18_from19` is the only /19 transcoder. It drops material begins and their
matching cancels, preserves node events/poses in order, truncates `tween_f32`
to its node-endpoint-plus-pose prefix and updates `count`. No surviving endpoint
or pose offset is rewritten. Drop an emptied tween record. Keep `t_us` and the
grant for retained /18 node playback, even if no node tween is active; apply
/18's window range. Recompute framing/digests/end byte statistics and record
maxima; preserve ordinary host transactions, `param_f64` and predictor history.
/19-to-/17 and /19-to-/16 transcoders are not provided. The existing rs-core
`tweens::to16` and other older-version `to13`/`to12`/`to14*` paths do not establish
such /19 conversion support.

## Forks decided

1. **Addressing: recommend ShaderMaterial ObjectID only at capture.** Resource
   identity matches sharing and the wire's `material` key. M3 extends
   `godot/project/scripts/announced_tween.gd` to accept material targets and
   resolve `material:shader_parameter/x` to the material in GDScript, forwarding
   its ObjectID and a normalized `shader_parameter/x` path. Capture accepts no
   node-path alias. The material/step key orders are fixed above.
2. **Values: recommend explicit mirror Variant types only:**
   float/vector2/vector3/vector4/color with scalar component suffixes. Reject
   unsupported Variant types as `material-param-type` and suffix/type mismatch
   as `material-param-mismatch`. Do not validate shader declarations or cache
   them: the client passes the substituted param through the same
   `uniform_value` conversion used for host values, with its own declarations.
3. **Baseline: recommend the retained host material table, with an explicit
   value required.** Patch omission retains param components. Normal per-frame
   host writes remain captured. Recheck at association uses the main-thread
   `Host::snapshot()` param snapshot, never live encoder-thread state. This
   avoids a new pose and shader-default evaluation; handover remains approximate
   in time as /17.
4. **Claims: recommend (material, name, component).** Sharing deliberately
   animates every user; item claims are independent. Resource changes never
   transfer claims to replacement IDs. An item's reassignment only detaches it
   from its former material's animation.
5. **Filtering: recommend version-aware queues before encoding.** /17 and /18
   keep node playback and host params, with counted material filters; /16 keeps
   host frames. A /19 host offers exactly {.19, .18, .17, .16}. /19 and /18
   connections get /18's adaptive window, draw pacing and telemetry; /17 and
   /16 keep the global period. This preserves negotiated behavior without a
   /19-specific pacing change.
6. **Application and retirement: recommend a core param display layer and
   host-authoritative target retirement.** Binding refresh substitutes owned
   components below extensions and dirties only changed material users. On
   target invalidation the host globally retires and queues ordinary cancels
   to known viewers. Clients self-retire only at end, cancel, claim loss or
   missing material ID; the display guard draws host params on missing/type
   mismatch until cancel. A coalesced viewer can miss a short-lived change, so
   independent retirement could otherwise cause duplicate-ID errors on reuse.
   Resource IDs are never reused. Refused shaders retain their existing fallback.
7. **Floats: recommend node endpoints → node poses → material endpoints in
   the existing tween_f32 block.** Each endpoint group walks events then steps;
   poses use ascending item id. This preserves /17's node-only layout and makes
   the /18 view an exact prefix. `to18_from19` drops material events and truncates
   `count`, without rewriting offsets or adding another block.
8. **Grant: recommend client_tweens:true implies both kinds on /19.** Selecting
   /19 is the capability boundary. A separate grant adds combinations without a
   requested independent behavior; older negotiated versions stay node-only.

These recommendations define correctness and compatibility; none asserts an
unmeasured performance, memory or latency benefit. Implementation timing results
must be reported before any later optimization changes this contract.

### Source rationale

References below are repository paths and lines at the /18 base. They describe
existing mechanisms, not claims that material playback is already implemented.

- `capture/src/rs_tweens.cpp:56`, `:69`, `:117`, `:357` currently hard-code node
  properties, endpoint arity and begin/encoding. `capture/src/rs_tweens_host.cpp:28`
  resolves ObjectID through CanvasItem to `published_item_id`; a resource branch
  is needed before that cast.
- `capture/src/rs_mirror.cpp:5211` has private mutable `find_material`;
  `:3360` already exposes RID-to-id `material_id_of`, so M1 needs a public
  read-only param snapshot accessor, not a duplicate RID map or declaration cache.
  `:5668` retains parameter values and increments material version per write.
  The complete table and param_f64 layout are
  [render-stream-5.md](render-stream-5.md), lines 206–249.
- `capture/src/rs_adopt.cpp:438`, `:4926`, `:4927` bind Resource.get_rid and
  material_get_param. A bound getter is not proof of headless state:
  Godot 4.5.1 `servers/rendering/dummy/storage/material_storage.h` returns an
  empty material param. Use captured mirror Variant values; declaration scanning
  is not part of announcement validation.
- `rs-core/src/state.rs:960` stores Material.params;
  `rs-core/src/apply/mod.rs:3437` refreshes bindings, `:3557` calls
  `apply/programs.rs:1036`'s uniform conversion. `rs-core/src/tweens.rs:321`
  only displays transforms/colors and `apply/overrides.rs:234` only diffs those.
  `apply/programs.rs:1036–1066` converts host params using client declarations;
  substituting a tween value into that same slot preserves conversion without
  host declaration checks. A material-only tick needs binding invalidation.
- `capture/src/rs_tweens.cpp:358–409` appends node endpoints before node poses.
  Keeping that prefix enables `to18_from19` without surviving offset rewrites.
- [render-stream-5.md](render-stream-5.md), lines 171–175, specifies resource IDs
  are never reused. Missing material ID is therefore safe for client retirement;
  a transient param change missed by coalescing instead needs a host cancel.
- `capture/src/rs_gate8_policy.cpp:280–285` currently offers .18 alone or
  .17 plus .16. M1 must explicitly offer {.19, .18, .17, .16}; this is not
  inherited from the current /18 host.
- `packages/render-stream-client/src/programs.ts:259` transpiles custom shaders;
  `:262` records `gsw-shader-transpile` and `:188` records `shader-withheld`.
  Announcement cannot make a refused program render correctly.

`capture/` and `rs-core/` references above are relative to
`experiments/render-stream/`; the Godot reference is the local version-matched
engine source. New source comments should state the contract, not retain these
line-number references.

## Acceptance plan for implementation

### M0: this specification

Run `mise exec -- pnpm check-public-tree` and `mise exec -- pnpm format:check`.
The existing `allow-md experiments/render-stream/protocol/render-stream-*.md`
rule covers /19; no allowlist change is necessary. This step adds no code.

### M1: capture, negotiation and material events

Build capture with `experiments/render-stream/scripts/build-capture.sh`, including
ctest. Extend `tweens::Value` (`capture/src/rs_tweens.h:13–24`) with
Vector3/Vector4 variants, and record each viewer's negotiated version in
`Viewer` at `grant()`. Regressions must fail before implementation. Cover:

- Direct resource lookup, all supported types/components, exact names and all
  rejection reasons in the single validation order above, including default-only,
  scalar int, integer vectors, bool, textures, arrays, global/instance property
  paths and f32 overflow. No declaration lookup or declaration cache is added.
- Mirror RID-to-id/param snapshot access without dirtying the mirror; snapshot
  recheck on the main thread, never live encoder reads; headless capture uses
  hook values. Declaration/Variant differences keep ordinary client conversion.
- Shared/inherited users, partial claim replacement independent of item claims,
  duplicate/reused IDs, simultaneous node/material events and begin/cancel pairs.
- Baseline from an unchanged material omitted from a patch, moving host values,
  coalesced unsent events, pending invalidation and end/cancel/free/shader change.
- The host writes the param every frame while a tween owns it: for a /19 viewer,
  `materials[]` bytes are identical with and without the announcement; only the
  tween record is added. No capture suppression or forced material upsert.
- A coalesced viewer misses a short param/type change, receives the host cancel,
  then accepts a reused tween ID without a duplicate-ID error.
- Two `resource_local_to_scene` instances: tweening one leaves the other unchanged.
  Reassign an item's material mid-tween: the item detaches, while other users of
  the still-live old material continue playback.
- Simultaneous granted /19, /18, /17 and /16 viewers plus an ungranted viewer;
  older node-only transcripts and coding byte-identical to baseline; mixed
  announcements preserve old schemas with global order gaps, no material floats
  there, exact filtering counters, no old-viewer unknown cancels. Exercise only
  old grants, no grants, disconnect/late join/resync and taps.
- /19 hello/session windows 1 and 8; reject 0/9, retain 1..2 limits on /17–/16.
  Confirm existing node begin keys and ordering are unchanged. Assert the exact
  four-version offer, /18 adaptive window/draw pacing/telemetry for /19 and /18
  connections, and the global period for /17 and /16.

### M2: rs-core, wasm and golden-19

Add `golden-19/` using the existing golden layout. Each invalid file declares
its expected error code in `index.json`. Required matrix:

| Kind / expected code                     | Required vectors                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-stamped vectors                       | All golden-17 vectors as `.rs19`, plus `window1` and `window8`                                                                                                                    |
| Valid records, each with `.decoded.json` | `material-begin`, `material-component`, `material-types` (vector3/vector4/color), `mixed` (node + material + pose, checking the layout), `material-cancel`, `invalidation-cancel` |
| Valid streams / transcode                | `mixed.rs19` and expected `mixed.to18.rs18`                                                                                                                                       |
| Invalid `meta-schema`                    | `material-in-rs18`, `item-and-material`, `bad-type`, `component-on-float`, `component-range`                                                                                      |
| Invalid `tween-offset`                   | `material-wrong-offset`, `material-wrong-count`, `material-nonfinite`                                                                                                             |
| Invalid `tween-entry`                    | `material-missing`, `param-missing`, `param-type-mismatch`, `inconsistent-param-types`, `material-unsupported`                                                                    |

Invalid golden-17 vectors retain their expected codes when re-stamped; only
valid records require decoded companions. Run golden validators, rs-core tests
via `quiet.sh shared -- cargo test --offline --release` in the rs-core directory,
rebuild the reached wasm/native bindings, and test both bindings. Cover:

- Every type/arity/component and atomic wire error; unchanged-material baselines,
  exact node-endpoint → pose → material-endpoint offsets, ID/order namespaces
  and `to18_from19` prefix truncation, including dropped cancels, empty records
  and reused IDs. `to18_from19(mixed)` must pass /18 validation and its node
  float block must equal the /19 prefix, with unchanged endpoint/pose offsets.
- Deterministic fake-clock interpolation, all 48 easing combinations against
  godotEaseSample, delayed/chained/parallel/zero-duration and implicit-from steps,
  partial ownership and no resurrection. Report maximum absolute easing error.
- Retained host values during ownership; unowned components update, release
  matches current host uniform conversion exactly. Log handover jump per scalar
  component in shader parameter units, including nonzero stale-host residuals;
  introduce no unapproved residual budget or smoothing blend.
- Shared/inherited binding invalidation on a material-only tick, alpha/cover/damage
  and viewport refresh, unchanged unrelated bindings, shader refusals, payload
  wait without baseline leaks, context restoration and all retirement paths.
- The display guard draws current host values for missing/wrong-type params
  before cancel, without releasing claims or failing validation; authoritative
  cancel permits tween ID reuse even when coalescing hid the invalidation.
- Disabled/empty layers add no redraw or parameter scan. Node-only regression
  goldens and resolved host digests stay unchanged.

### M3: client and consumer scene

Extend the generic scene in `web/client-tweens` with a transpile-supported
dissolve-style canvas shader, a shared material, a separate Vector2 parameter
step and two `resource_local_to_scene` instances. Announce and run matching native tweens, with host transactions around
10 Hz. Use the repo's private headless gamescope runners for rendered Godot and
browser legs; no independent headed launch. Build/import only the required legs.
Extend `godot/project/scripts/announced_tween.gd` to accept direct material
targets and Vector3/Vector4 values, and resolve a CanvasItem's
`material:shader_parameter/x` path to its material in GDScript before calling
capture with the resource ObjectID. Keep native Godot tween creation and
cancel behavior for both node and material targets; material targets need a
SceneTree or node owner for the native Tween. The capture API stays
ObjectID-of-material only; do not add a capture alias. Test the helper with a
material target and the scene's local-to-scene pair, so one animates while the
other stays unchanged.
A downstream consumer, if used, sets `COUCHCOOP_GSW_ROOT` to this worktree and
edits no shared sibling checkout.

Run the client vitest suite, `mise exec -- pnpm typecheck`, and
`mise exec -- pnpm typecheck:ts6` for public type changes. Browser automation must
observe distinct material samples drawn strictly between transactions in a
deterministic withheld-transaction interval, completion/cancel handover, shared
users, local-to-scene isolation, coexistence with node tweens/extensions, and
unchanged disabled playback.
Preserve intermediate/handover screenshots, uniform samples, draw/host timestamps,
diagnostics and a machine-readable residual report with shader parameter units.
Assert that a refused shader retains its fallback and reason. No tween redraw
sends an ACK, and no tween redraw remains after retirement.

At each implementation step inspect `validate-increment.sh --plan`, iterate on
the smallest reached leg, then run the reached `--tier full` plan before its last
commit. Report passed/failed/skipped legs, first failures verbatim, evidence
paths, and validate-summary.json `wall_s`/`lock_wait_s`; report unmatched paths
as map gaps. Remote validation belongs to the orchestrator. Timing legs use
real time and require load/quiet-lock checks. These checks establish behavior
and record residuals; they make no performance claim.

## Versioning

As /17: changing framing, a key or its order, enum spelling, schema table,
block layout, payload or predictor requires a new protocol version. Opt-in
negotiation never permits extending frozen /17 or /18 schemas. Any later
material type, target alias, baseline block or independent grant requires a
new version; rejected types are not reserved spellings accepted by /19.
