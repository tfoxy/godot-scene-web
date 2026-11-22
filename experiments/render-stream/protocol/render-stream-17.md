# render-stream/17 wire format and announced client tweens

Status: **specified, not implemented**. /17 is render-stream/16
([render-stream-16.md](render-stream-16.md)) plus an opt-in announced-tween layer.
A participating client evaluates finite, announced property tweens between host
transactions. The host continues capturing and sending its normal frames. This
is a client smoothness option, with approximate visual parity; it neither reduces
capture frequency nor promises to compensate for network latency.

Everything not changed here is /16's. No game-specific node, property or integration
is part of this contract. The producer must announce its tweens: observing
RenderingServer calls alone does not reveal a Godot Tween.

## Version and negotiation

- Magic: `47 52 53 48 0D 0A 1A 0A` (`GRSH`, /16's `GRSG` plus one).
  Recording suffix: `.rs17`. Protocol strings: `render-stream/17` in the hello
  and session, `render-stream.17` on the transport.
- /17 retains /16's viewport surfaces, /15's resource hints, item_meta v1/v2,
  prediction, compact residual and live coding. A tween does not change the host
  scene used by the transaction predictor, digests or validators.
- `createRenderStreamClient` gains `clientTweens: boolean`, default **false**.
  A consuming application chooses its own default. `true` requires /17 and sends
  `"client_tweens":true` as the last hello key, after `item_meta` when present.
  `false` omits the key and keeps the existing protocol-selection behavior and
  hello bytes. There is no silent upgrade or downgrade of a tween request: an
  unavailable /17 connection fails normally; the caller can reconnect without
  the option.
- A host enabled with `GRC_STREAM_VERSION=17` accepts `render-stream.17` first
  and also keeps /16 available
  for clients that do not request tweens. Enabling /17 must not disable the
  host's otherwise available older versions. An old-version connection's session,
  transactions, resource records, coding and control replies remain byte-identical
  for the same captured frames and inputs. Its hello receives no new key.
- A /17 session granted the hello request contains `"client_tweens":true`,
  immediately before `blocks` (after /16's `viewports`). This is the grant.
  Without the request the key is absent, as are every tween record and `t_us`.
  A /17 client requesting tweens requires the grant before it accepts transactions.
  Below /17 the hello key is a control error; any new wire key or record is
  `meta-schema`. `false`, null and other hello values are invalid; absence is off.
- Opting out must never change protocol selection or bytes on an existing
  connection. A caller explicitly selecting /17 without the hello request gets
  /17's version identifiers, but otherwise /16's grammar and transaction bytes;
  selecting a new version is separate from automatically upgrading an old client.
- Ordinary file sinks do not activate tween capture and have no grant or tween
  keys. A tap of a granted live connection records its session, tween records and
  transactions together. This text adds no file-sink enable switch.

**Why a new version:** item_meta entered /13 before its freeze
([render-stream-13.md](render-stream-13.md), "As built (TAG1)"); this was not
permission to extend a frozen version. item_meta v2 required /14 and resource
hints required /15, even though hints are advisory records outside transactions.
/16's version rule likewise requires /17 for new keys, a record type and a block.
Negotiation gates the new bytes; it does not relax old schemas.

## Host API

The `RenderStreamCapture` singleton binds these methods alongside `arm`, `disarm`
and `state`. Call on the Godot main thread. A GDScript caller uses
`Engine.get_singleton("RenderStreamCapture")`; C# uses the same singleton's
`GodotObject.Call("tween_begin", dictionary)` and `Call("tween_cancel", id)`.
Neither language needs a RenderingServer hook or access to a Tween's internals.

```
tween_begin({
  "tween_id": <Godot int>,
  "object_id": <target.get_instance_id()>,
  "started_usec": <Time.get_ticks_usec()>,                 # optional
  "steps": [{
    "property": <String or StringName>,
    "to": <float, Vector2 or Color>,
    "from": <same value type>,                            # optional
    "start_ms": <nonnegative number>,
    "duration_ms": <nonnegative number>,
    "trans": <Godot transition name or int>,
    "ease": <Godot ease name or int>
  }, ...]
})
tween_cancel(<tween_id>)
```

`tween_id` is a caller-chosen signed 64-bit integer, unique among live
announcements in this capture session. Reuse after end or cancel is allowed.
`object_id` is the target node's ObjectID, not its RID or stream item id. The
capture uses the existing GDExtension ObjectID lookup and CanvasItem method-bind
route in `rs_adopt.cpp` to obtain the canvas item, then the mirror's stream item
id. This requires no new calibrated vtable slots and does not require item_meta.
The target must resolve to a published Node2D or Control (subclasses included).
A freed, non-canvas or other unsupported node is rejected with a counted reason.

The capture snapshots the node's local components and both colors, queues the
begin, and associates it with that frame's next eligible transaction. It does not
modify the actual Tween or suppress host RenderingServer updates. Calls while
unarmed, or when **no connected client has a tween grant**, return immediately:
no dictionary traversal, ObjectID lookup, property read, queue, allocation or
per-item work. "Zero cost" here means this early-return path; it is not a measured
claim of literally zero CPU instructions. No per-frame work is installed when
the last granted client leaves. The bound methods have no result contract; the
counters below report acceptance and drops.

`started_usec`, when present, uses `Time.get_ticks_usec()` at creation. Absence
means the announcing capture frame's timestamp. `begin_us` and frame `t_us` use
that same monotonic timebase; internal steady-clock measurements must be converted
to it, not copied with a different epoch. Wall-clock time is never used. Explicit
start times after the announcing frame are invalid. Delayed announcements may
name an older start; the client does not restart them at receipt.

### Supported properties and components

| API property                                                               | Value type      | Claimed components                  | Node2D | Control |
| -------------------------------------------------------------------------- | --------------- | ----------------------------------- | ------ | ------- |
| `position`                                                                 | Vector2         | `position.x`, `position.y`          | yes    | yes     |
| `position:x`, `position:y`                                                 | number          | named component                     | yes    | yes     |
| `rotation`                                                                 | number, radians | `rotation`                          | yes    | yes     |
| `scale`                                                                    | Vector2         | `scale.x`, `scale.y`                | yes    | yes     |
| `scale:x`, `scale:y`                                                       | number          | named component                     | yes    | yes     |
| `skew`                                                                     | number, radians | `skew`                              | yes    | no      |
| `modulate`                                                                 | Color           | `modulate.r`, `.g`, `.b`, `.a`      | yes    | yes     |
| `modulate:r`, `modulate:g`, `modulate:b`, `modulate:a`                     | number          | named color component               | yes    | yes     |
| `self_modulate`                                                            | Color           | `self_modulate.r`, `.g`, `.b`, `.a` | yes    | yes     |
| `self_modulate:r`, `self_modulate:g`, `self_modulate:b`, `self_modulate:a` | number          | named color component               | yes    | yes     |

Only the exact indexed property spellings above are accepted. `rotation:x`,
`position:a`, `global_position`, `rotation_degrees`, `pivot_offset`, arbitrary
properties and deeper paths are unsupported. A Control's `pivot_offset` is a
**host baseline component**, needed for transform reconstruction, not tweenable
in v1. Values must be finite and match the property's type and arity. No automatic
angle wrapping, shortest-path rotation, color-space conversion or clamping of
intermediate easing overshoot occurs. Relative tweens must be announced with
absolute endpoints; loops, pause, speed changes and callbacks are not inferred.
The producer cancels/re-announces when its finite schedule no longer describes
what the game is doing.

`start_ms` already flattens chain, parallel, interval and delay into an offset
from `begin_us`. Convert milliseconds to integer microseconds by rounding to the
nearest microsecond, ties upward. Zero duration is legal and writes `to` at its
start. Start plus duration must fit the wire integer range. `trans` and `ease`
are required: accept the enum integers below or their Godot names, ignoring case,
underscores and an optional `TRANS_`/`EASE_` prefix. Unknown names are dropped,
not silently mapped to the easing library's fallback.

| `trans` int | Name   | `trans` int | Name    |
| ----------- | ------ | ----------- | ------- |
| 0           | Linear | 6           | Elastic |
| 1           | Sine   | 7           | Cubic   |
| 2           | Quint  | 8           | Circ    |
| 3           | Quart  | 9           | Bounce  |
| 4           | Quad   | 10          | Back    |
| 5           | Expo   | 11          | Spring  |

`ease`: 0 In, 1 Out, 2 InOut, 3 OutIn. These are Godot 4.5.1's enums.

## Wire additions

All integer JSON values obey /0's exact integer bound, `abs(n) <= 2^53 - 1`.
`tween_id` instead uses a canonical decimal **string**, retaining the API's full
signed 64-bit range, with no plus, leading zero or negative zero. This preserves caller IDs without introducing numeric u64 JSON.
ObjectIDs and RIDs are resolved on the host and never enter a tween record.

### Transaction timestamp

On every transaction for a granted connection, `"t_us":<int>=0>` stands
immediately after `frame`. It is the capture time of **that snapshot**, never the
send, encoding, enqueue or receive time. It remains the original time if a stale
snapshot is sent later. It is nondecreasing in transaction order. It is mandatory
even when no tween is active, and absent without the session grant. Frame numbers,
sequence numbers, credit and all ordinary transaction fields keep their /16
meaning. The extra key is not a predictor input.

### `tween` record

One optional record describes the events and host component baselines belonging
to a transaction. Keys are in the following order:

```
{"type":"tween","seq":<transaction seq>,"frame":<transaction frame>,
 "t_us":<transaction t_us>,
 "events":[<begin or cancel>...],
 "poses":[{"item":<stream item id>,"kind":"node2d"|"control","f":<offset>}...],
 "blocks":[{"name":"tween_f32","type":"f32","count":<float count>}]}
```

A begin and cancel have these ordered key sets:

```
{"op":"begin","tween_id":<decimal string>,"item":<stream item id>,
 "order":<int>=1>,"begin_us":<int>=0>,"end_us":<int>=0>,
 "steps":[{"property":<supported spelling>,"start_us":<int>=0>,
           "duration_us":<int>=0>,"trans":<int 0..11>,"ease":<int 0..3>,
           "from":null|<float offset>,"to":<float offset>}...]}
{"op":"cancel","tween_id":<decimal string>}
```

`end_us` is `begin_us + max(start_us + duration_us)` over the accepted steps.
`steps` is non-empty and preserves API array order after filtering. All timing
sums must fit the integer range. A dropped step does not extend the lifetime.
There is no implicit infinite or trailing interval; a producer needing a longer
hold represents it with a supported step of that duration.

`order` records host announce order, increasing per accepted begin in an armed
session, across all items and connections. Larger order wins; compare `begin_us`
second if orders tie. The host serializes main-thread calls, so accepted begins
normally have distinct orders; equal `(order, begin_us)` on different begins is
invalid. The timestamp never makes an earlier-announced tween take a claim from
a later-announced one. Events retain host call order, including a begin and its
cancel in the same frame. Reusing a live `tween_id` is an invalid API begin, not an
implicit replacement.

**Float layout.** `tween_f32` is lossless little-endian f32, not predicted or
covered by `predict_check`. It is the record's only block. In event order and
then step order, append explicit `from` values (when non-null), then `to` values;
each offset names the next float, and arity is the property table's 1, 2 or 4.
Then append poses in ascending item-id order, without duplicates. A pose is 16
floats, in this order:

```
position.x, position.y, rotation, scale.x, scale.y, skew,
pivot_offset.x, pivot_offset.y,
modulate.r, modulate.g, modulate.b, modulate.a,
self_modulate.r, self_modulate.g, self_modulate.b, self_modulate.a
```

For Node2D, pivot is `(0,0)`; for Control, skew is `0`.
Each `f` is the next offset after the step values and preceding poses. All floats
are finite. A block of count zero is represented by `blocks:[]`, with no binary
block; a nonempty block must contain exactly the floats implied by these offsets.

The begin's item must have a pose in the same record and exist in its transaction's
resolved host state. The pose is the latest **host** value, not a client sample.
At announcement the capture reads these components through bound node getters.
For every subsequent transaction on that connection while a known tween can own
components, carry that item's current pose, including the final transaction that
releases it on cancel/end. Sample poses with the transaction snapshot, not later
on the encoding thread. This component baseline is necessary even if the ordinary
item upsert contains only a matrix: decomposing a matrix cannot recover an
arbitrary Control pivot or unambiguously preserve negative scale and rotation.
It also makes unowned components and partial handovers exact to the host snapshot.
No poses are read or emitted for a connection's unknown late-join tweens.

### Association, coalescing and lifetime

- Omit the record when both `events` and `poses` are empty. Empty `events` with
  poses is legal. A cancel-only record has `poses:[]` and `blocks:[]` if its item
  has already been removed. Other empty arrays use the literal `[]`.
- Send at most one tween record per transaction: after any resource records,
  before item_meta if present, otherwise immediately before the transaction.
  No other record may intervene except that transaction's item_meta. Thus
  item_meta remains immediately adjacent to its transaction.
- `seq`, `frame`, `t_us` exactly match the associated transaction. The transaction
  must have the grant and timestamp. A tween record does not consume credit and
  is not a transaction or resource-record count in `end`; its bytes count in
  `bytes_total` and `max_record_bytes`. Live framing/coding is /16's, one record
  per binary message before any negotiated live-coding wrapper.
- Buffer the record with that transaction. Do not activate it when only its bytes
  arrive, or while the transaction waits for resources. Apply events in order
  when preparing the associated picture; expose them to playback only when that
  picture can be drawn. Reject an orphan, duplicate or mismatched association.
- Delivery throttling, credit stalls and snapshot coalescing must not lose begins
  or cancels for an eligible connection. Retain pending events in call order and
  attach them to its next sent transaction captured no earlier than the events,
  retaining their original `begin_us` and `order`; the record's `t_us` and poses describe the snapshot actually sent.
  A begin/cancel pair may both reach that transaction; it must leave no owner.
- A connection is eligible for a begin only after its hello grant.
  A connection opening mid-tween gets host frames only for that
  tween: no replay of earlier begins or their cancels, and no ownership. A new
  begin after the grant participates normally, including one associated with its
  initial full transaction. Dropping
  the last granted connection discards pending announcement work.
- A transaction removing an item also retires all its tween ownership. No node
  lookup or pose is required after removal. A freed/replaced stream item cannot
  inherit an old item's tween. Disconnect, disarm, session replacement and resync
  clear playback, pending events and anchors. A resync full starts from host
  state; old live tweens are not replayed. Subsequent new announcements can play.

## Client evaluation and handover

### Time follows the displayed picture

Use the most recently **drawn** transaction's timestamp `F_drawn` and the local
monotonic time `R_drawn` at that draw, in the same units:

```
anchor_estimate_us = F_drawn + (client_now_us - R_drawn)
tween_now_us = max(previous_tween_now_us, anchor_estimate_us)
elapsed_us = max(0, tween_now_us - begin_us)
```

Initialize a tween's previous time at `begin_us`. A late announcement evaluates
with its age relative to the drawn frame; it does not restart its schedule at
receipt. Every newly drawn transaction re-anchors, including one with no begin.
Advance existing playback against that anchor before testing a reused tween ID:
a prior begin whose `end_us` is at or before the drawn frame has ended, even if
the local clock was behind before the re-anchor. Process queued begin/cancel
events in their call order, retiring already-ended begins without an extra draw
or a remaining claim; their claim replacements still apply, without resurrecting
a superseded older tween.
Receiving, decoding, accepting or applying a transaction waiting for payloads does
not re-anchor. Redrawing the same transaction is **not** a new anchor; otherwise
elapsed time would restart on every rAF.

Time is monotonic **per tween**. A backwards correction holds its previous time
until the new estimate catches up; a forward correction takes effect immediately.
For example, after evaluating host time 1,150,000 us, a newly drawn frame stamped
1,100,000 us holds that tween at 1,150,000 us for 50 ms. A new frame stamped
1,200,000 us advances immediately. Ended tweens never reactivate on a backward
correction. During a pure network stall, with no accepted-but-undrawn transaction, the
previous anchor extrapolates on the local clock until all tweens end. While an
accepted transaction is prepared or waiting for payloads, tween redraws pause,
matching extension `requestRedraw` during payload waits. The tween clock does
not pause: time still follows the previous drawn anchor. When the waiting
transaction draws, it re-anchors and playback resumes at the later time; a
forward jump is acceptable. No second scene state is retained. There is no clock exchange, offset
estimator, playout buffer or transit-time correction.

### Ownership and step starts

The claim set is the union of a tween's supported step components. A whole-property
step claims every component listed in the property table. Upon begin, a newer
announce takes each overlapping claim from older live tweens immediately, even
if its first step is delayed. The older tween retains its other components and
is dropped when it owns none. Count each component taken from an older owner.
Ownership never falls back to the older tween after the winner ends or cancels.

Owning a component does not yet mean holding its host value. Before its first
step starts the component continues showing the latest host baseline. At a step
start, capture the component's currently displayed value **before that step's
write**, unless the step has explicit `from`. Preserve that captured value for
all later samples. For a whole property, capture/interpolate each component
separately, applying only the components still owned by this tween.

For delayed first observations, capture this displayed value on the first draw
that observes the crossed start and then sample at the already elapsed time;
there is no historical host-state reconstruction. If a draw crosses several
step boundaries, advance the intervening steps in start-time order, using original
array order at equal starts, so a chained step can capture its predecessor's end.
For multiple started steps on one component, the later start wins, with original
array order breaking equal-start ties. A finished step holds its exact `to` until
the next step on that component starts. Hold in gaps and after the last component
step until the owning tween's `end_us`, even if other components run longer.

Interpolate `from + (to - from) * godotEaseSample(ease, trans, u)`, where
`u = (tween_now_us - begin_us - start_us) / duration_us`. Reuse or port
`packages/effects/src/easing/numeric.ts`'s `godotEaseSample`. The step endpoint
is exactly `to` at/after its duration; zero duration writes `to` immediately.
Transition overshoot inside the interval is preserved. Rotation is a scalar in
radians; position, scale and colors are separate scalar components, never a
linear interpolation of transform-matrix entries.

At `end_us`, or upon the transaction carrying a cancel, release every component
still owned by that tween and show its latest host baseline. Host upserts are
always retained in the host state; only the held **display components** are
replaced. A cancel of a tween that has ended locally is a no-op. Canceling an old
owner cannot release a newer owner's claim. Completion releases on that draw,
so it can snap from the previous interpolated pose to the newest available host
pose, including a stale pose during a long stall. This is acceptable and must be
measured, not hidden by a new handover blend.

### Layering, transforms and queries

Keep two views: the authoritative resolved host state, and the displayed state
formed from the host poses associated with the picture being drawn, with only
held components replaced. Baselines waiting with an undrawn transaction do not
leak into the current picture or an end-of-tween handover. Everything else
about an item continues to apply: parent, visibility, draw order, commands,
materials, resources, clip and viewport changes. Unowned transform/color
components continue taking host updates. When no transform component is held,
use the host's exact matrix; when no color component is held, use its exact color.

The tween layer is in **rs-core below OverrideTable**, before hierarchy composition,
culling, clipping, damage/cover decisions and picking. Rebuild local transforms
from displayed components using Godot 4.5.1's formulas. With rotation `r`, scale
`(sx,sy)`, skew `k` and position `p`, Node2D's columns are
`(cos(r)*sx, sin(r)*sx)` and `(-sin(r+k)*sy, cos(r+k)*sy)`, with origin `p`.
Control uses `k=0` and origin `p + pivot - basis*pivot`. Preserve signed and zero
scales; do not decompose an interpolated matrix. Ordinary host rendering rules
such as pixel snapping still apply after reconstruction.

Extension overrides compose above this displayed local state as usual; the tween
layer does not insert or own an OverrideTable entry, so view scales and raised
items compose without its single-owner conflict. An extension's `setGlobal`
calculation must use the displayed base internally, even though its public host
query stays unchanged. `OverrideTable.effective` remains the extension-only
composition: multiplying it by a host `ItemQuery.transform` does not reconstruct
the drawn transform while a tween is active. Document this opt-in distinction
in those API comments. Existing explicit subtree-freeze overrides continue to
hold their subtree above this layer.

`ItemQuery.transform`, `rect`, `controlRect`, `subtreeRect`, parent/children and
visibility remain facts from the latest accepted **host** state, before tweens
and extension overrides. Tween rAF ticks alone do not advance the host query
epoch. `ItemQuery.hitTest` uses the latest **drawn** pose, including tweens and
extension overrides. The client's tree-order pointer pick likewise uses displayed
transforms and clips, while preserving the existing host mouse-filter and tree
ordering rules. A moving parent moves its descendants' drawing and hit regions.

The draw loop evaluates and draws on every rAF while any tween is live (including
a delayed first step), even without new transactions or extensions, except while
an accepted transaction is prepared or waiting for payloads. Like extension
redraws, tween-only redraws defer during that wait; they resume when it draws.
Count `payload_wait_pauses` once per wait, not once per paused rAF. The option
must not be throttled by the idle frame cap while a tween is live. Its last tick
releases ownership and draws the host handover, then requests no further tween
redraw. Existing reasons to draw may remain; the feature adds no idle redraw,
frame callback, timer, component scan or allocation when disabled or empty.
Context restoration preserves the same monotonic playback timeline within the
session and redraws the then-current pose; it does not restart completed tweens.
No tween-only draw sends transaction acknowledgments or consumes credit.

## Drops, validation and counters

An invalid API step is dropped, with one first reason per step in the order below;
a valid step still plays if other steps are rejected. If no steps remain, drop the
begin with `empty-steps`. A bad outer record or unresolved target drops the entire
begin. Dropping affects only local playback: the host still streams normal items.

| Counter reason         | Scope and first matching condition                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `invalid-record`       | begin: missing/extra key, wrong outer type, malformed steps array, invalid ID or start time |
| `duplicate-id`         | begin: `tween_id` is already live                                                           |
| `unresolved-object`    | begin: ObjectID lookup is null/freed                                                        |
| `non-canvas`           | begin: target is not CanvasItem                                                             |
| `unsupported-node`     | begin: CanvasItem is neither Node2D nor Control                                             |
| `unpublished-item`     | begin: canvas RID has no live published mirror item                                         |
| `invalid-step`         | step: not a dictionary, unexpected key or missing/wrongly typed property                    |
| `unsupported-property` | step: property/path is not supported on this node kind                                      |
| `invalid-value`        | step: missing to, bad value type/arity, nonfinite or not representable as finite f32        |
| `invalid-timing`       | step: start/duration missing, negative, nonfinite or overflowing after conversion           |
| `invalid-easing`       | step: missing/unknown/out-of-range trans or ease                                            |
| `empty-steps`          | begin: no accepted step remains                                                             |
| `unknown-cancel`       | cancel: malformed ID or no host-live announcement with this ID                              |
| `target-gone`          | live begin: target freed/unpublished before it can be associated; retire without a pose     |

Expose host session counters under `client_tweens` in capture state/report output:
`begins_accepted`, `steps_accepted`, `cancels_accepted`, `begins_dropped`,
`steps_dropped`, `cancels_dropped`, `drops_by_reason`, `claims_replaced`,
`records_sent`, `poses_sent`, and current `live_tweens`/`owned_components`.
The acceptance/drop/claim totals count API events once, not once per connection;
record/pose sends count actual per-connection output. Early returns when off do
not increment counters. All counts reset per armed session; cumulative counts
saturate at /0's integer maximum.

Client diagnostics count `begins`, `cancels`, `claims_replaced`, `completed`,
`retired_unowned`, `unknown_cancels`, `backward_anchor_holds`, `tween_redraws`,
`payload_wait_pauses` (once per accepted-transaction wait), and
current `live_tweens`/`held_components`. `claims_replaced` counts component claims,
including claimed components whose first step has not started. Do not count each
rAF of an ongoing backwards hold as a new correction: count its re-anchor once.
An already ended/superseded cancel is harmless and counted, not a protocol error.

Wire errors are different from producer drops. Validate the record without
mutating playback; reject malformed wire rather than partially applying it:

| Code                | Rule                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta-schema`       | new key/type below /17 or without a grant; wrong key set/order, enum, type or integer/string range; unknown property/kind; bad float block descriptor                                           |
| `tween-association` | missing grant timestamp, duplicate/orphan record, or seq/frame/t_us mismatch; an interposed record other than matching item_meta                                                                |
| `tween-offset`      | missing/extra float block, bad count/offset/arity, nonfinite value, nonzero pivot/skew slot required to be zero                                                                                 |
| `tween-entry`       | empty begin steps, inconsistent end_us, duplicate live tween ID, repeated begin precedence, nonascending/duplicate poses, begin item missing from poses/resolved transaction or wrong node kind |
| `tween-time`        | decreasing transaction t_us, begin_us after its associated frame, or timing sum overflow                                                                                                        |

Check schema and association, then float offsets/values, then timing and resolved
entry references. Older /16 validation order is otherwise unchanged. A late
cancel or pose for an item removed in the associated transaction retires its
playback; it is not an unknown host item failure. The decoded form is
`render-stream-17-decoded/1`: it preserves the new meta and decodes `tween_f32`; resolved host form stays the /16 host scene under
`render-stream-17-resolved/1`, without simulated client poses. A transcode to /16
drops the grant, t_us and tween records, leaving ordinary host scene transactions
and their predictor history unchanged. Recompute framing digests and end byte
statistics for the resulting /16 stream, as for earlier transcodes.

## Generic producer helper

Ship a small GDScript helper under `godot/project/scripts/` that can create a Tween
and record its property schedule, or announce an existing caller-built Tween with
an explicit schedule. It maps chain/parallel/interval/delay to start offsets,
uses the same bound API, and routes kill/cancel through `tween_cancel`. It cannot
introspect and recover arbitrary Tween internals. The caller supplies a unique
ID and announces changes to a schedule it built elsewhere. Keep endpoint values
absolute and use `Time.get_ticks_usec()` consistently. A helper call without the
capture singleton must leave the game's Tween working normally.

The helper and client API documentation must state that this is opt-in and
approximate, how to cancel/re-announce for pause/speed/loop changes, and that a
late join follows host frames for already-running tweens. Tests and the playground
consumer use this helper; no downstream game's hook code belongs in this repo.

### Using the helper

Copy `godot/project/scripts/announced_tween.gd` into the game's scripts directory
(or preload it by its project-relative path). IDs are chosen by the producer and
must be unique among its live announcements. For example:

```gdscript
const Announced = preload("res://scripts/announced_tween.gd")

var motion = Announced.create(sprite, 101).set_parallel()
motion.property(^"position", Vector2(300, 100), 1.0, Tween.TRANS_SINE)
motion.property(^"rotation", PI, 1.0)
motion.chain().property(^"scale", Vector2(1.2, 1.2), 0.3)
var native_tween: Tween = motion.play()
# When interrupting the schedule, use motion.cancel(), which also kills native_tween.
```

`property(path, to, duration, trans, ease, delay, from)` uses seconds for duration
and delay, radians for rotation, and native Godot values for vectors and colors.
It serializes offsets/durations in milliseconds. `from` defaults to absent, so
Godot and the client sample the property's value at that step's start. Transitions
and easing use Godot enums; the defaults are Linear and InOut. Endpoints are
absolute. `parallel()` places the next property in the current group;
`set_parallel()` makes this the default. `chain()` starts the next group at the
previous group's end. `interval(seconds)` puts the next group that many seconds
after the previous group's end. Each group's end includes its longest duration
and per-property delay. Build the schedule before calling `play()` once.

For a caller-built native Tween, use
`Announced.announce(target, id, steps, started_usec)` with the explicit flattened
schedule and its creation timestamp. Kill that Tween and call
`Announced.cancel_announcement(id)` when interrupting it. Neither API introspects
native Tweens. Cancel and re-announce when pausing, looping, or changing speed;
calling native `kill()` alone does not inform remote clients.

Clients enable playback with `createRenderStreamClient({ ..., clientTweens: true })`
and a `/17` endpoint; GSW's default remains false. Playback is approximate,
extension overrides compose above it, and joining after an announcement follows
the host frames for that already-running tween.

The executable consumer check is:

```bash
mise exec -- experiments/render-stream/scripts/build-capture.sh
mise exec -- experiments/render-stream/web/client-tweens/run.sh "$PWD/.local/client-tweens"
```

It imports an isolated generic project, rebuilds the client WASM from this checkout,
runs a headless Godot host, and opens the playground's `client-tweens.html` through
the repository's headless Chromium harness. The runner takes the quiet lock per
leg and refuses the real-time leg at machine load above 4. Pass a fresh ignored
absolute output directory. `--self-test-only` checks the helper without capture;
`--sabotage-unannounced` keeps native motion but removes helper announcements as
a negative control. `result.json`, `traces.json`, `host-poses.jsonl`, both `.rs17`
recordings and PNGs preserve diagnostics, draw/transaction times, GPU-uploaded
poses, handover residuals and the visible comparison. Residuals are measurements,
with no additional fidelity budget.

## Acceptance plan for implementation

Validate this protocol text with `mise exec -- pnpm check-public-tree` and
`mise exec -- pnpm format:check`. The existing protocol markdown allowlist covers
this file. Implementation acceptance is split into the following steps.

### Step 2: capture, negotiation and wire

Run `experiments/render-stream/scripts/build-capture.sh` (including ctest).
Add `golden-17/` in the `golden-16/` layout: re-stamped /16 vectors plus opted-in
begin/cancel/poses/time vectors and one invalid vector per new rule. Test:

- Every property and component, both node kinds, signed IDs beyond JS integer
  precision, explicit/omitted from and start time, all 12 x 4 easing enum/name
  combinations, zero duration, rounding and bad-value/drop reasons.
- ObjectID resolution, non-canvas/unpublished/freed nodes, live duplicate IDs,
  reuse after end/cancel, multiple events in a frame, component-claim replacement
  counts, begin/cancel coalescing under credit/send throttling and a removed target.
- Two simultaneous clients, one with the grant and one without; the latter's
  hello/session/transactions/resources/live coding are byte-identical to baseline.
  No grants means no lookups, reads, queued events or per-item work. Leaving and
  reconnecting mid-tween gives host frames only. Include taps and resync.
- Baseline poses match node getters at snapshot time, including an unowned
  component changing, Control pivot changes, negative scales and singular scales.
  Capture timestamps use the same epoch as API started_usec, including stale sends.

Each regression must fail against the implementation without the corresponding
change; record the failing command/output before the fix.

### Step 3: rs-core, wasm binding and client loop

Run `cargo test --offline --release` in `experiments/render-stream/rs-core/`
through `quiet.sh shared`, the render-stream-client vitest suite, and
`mise exec -- pnpm typecheck`. A type-level diff also requires
`mise exec -- pnpm typecheck:ts6`. Tests use deterministic fake local clocks and
known host timestamps, with no sleep-based timing assertions:

- Compare every one of the 48 trans/ease pairs against `godotEaseSample` at
  endpoints and interior/overshoot samples; report maximum absolute progress error.
  Compare rebuilt matrices and colors to the Godot formulas, not matrix lerp.
- Rotation plus nonuniform/negative scale/skew, pivoted Control, whole-property
  and component steps, chained/parallel/delayed/zero-duration steps, gaps and
  implicit-from capture at step start. Exercise first draws crossing boundaries.
- Last begin wins per component, whole/property overlaps, replacement before
  the first step, older partial ownership, retirement when none remains, cancellation
  of either owner and ID reuse. No automatic resurrection of an older owner.
- Host upserts always retained, only started owned components held, all other
  fields and components live, and partial/end/cancel handover to the newest host
  values. Assert exact host handover in component space and record the visible
  residual separately: maximum transformed-corner displacement in pixels, absolute
  rotation jump in radians, scale/skew deltas, and maximum RGBA channel jump.
  Include stale-host-at-end so a residual snap is exercised, not just zero cases.
- Delayed announcements, a transaction waiting for payloads, multiple queued
  transactions but one drawn, repeated redraw of the same picture, forward
  re-anchor, backward hold/catch-up and a stall through completion. Assert that
  tween time never decreases and no early accepted transaction changes the anchor.
- Extensions compose above playback, host ItemQuery facts remain unchanged,
  hitTest and tree-order picks track drawn children/clips, damage and cover update,
  and context loss/restore, removal, resync and session reset cannot strand a tween.
- Active tweens draw between transactions at rAF cadence, bypass the idle cap,
  send no extra ACKs, draw the handover once and request zero additional tween
  redraws/timers when empty or disabled. Include a client with no extensions.

### Step 4: helper and real consumer

Run a generic Godot scene through the capture and playground client using the
helper. It tweens position, rotation, scale and modulate, plus a pivoted Control,
with transactions throttled to approximately 10 per second. Use only the repo's
private headless gamescope runners for rendered Godot/browser legs; no desktop
window or independent headed launch. Build/import each required native leg in
this worktree before its first run. A downstream consumer check, if used, resolves
the toolkit from this worktree and edits no shared sibling checkout.

An automated browser check logs host transaction timestamps, actual draw times,
sampled displayed components and tween diagnostic counts. It asserts intermediate
poses at distinct rAF times strictly between two received/drawn transactions,
including a deterministic withheld-transaction interval; compares the disabled
client's unchanged host-frame behavior; and exercises cancel and completion.
Preserve screenshots of intermediate and handover poses and a machine-readable
residual report with px/radian/channel units under ignored evidence output.
Measure the residuals described above without inventing an acceptance budget for
an approximate handover. This demonstrates smoothness, not a performance or
bandwidth gain. Any timing measurement is real-time, load/quiet-lock gated.

For each implementation step run `validate-increment.sh --plan`, iterate at the
diff's smallest reached leg and run its reached `--tier full` plan before the
last commit. Report passed/failed/skipped counts, first failures, evidence paths,
`validate-summary.json` wall_s/lock_wait_s and any map gap. Remote validation, if
needed, is run by the orchestrator, never by the worker.

## Versioning

As /16: changing framing, a key or its order, a block layout, enum spelling,
payload format, schema table or predictor requires a new protocol version.
