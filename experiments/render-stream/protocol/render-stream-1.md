# render-stream/1 wire format

Status: the wire format the capture library publishes and the receiver consumes since G1b2
(2026-10-09). Codecs (G1b1): C++ encoder/diff (`capture/src/rs1_codec.*`, `rs1_diff.*`),
TypeScript decoder/validator/resolver (`scripts/lib/render-stream-1.ts`) and GDScript decoder
(`receiver/rs1_decoder.gd`), all checked byte-for-byte and state-for-state against
`protocol/golden-1/`. Wiring (G1b2): the mirror (`capture/src/rs_mirror.*`, including the
invariant 9 tie detection below) and the two file sinks of `capture/src/rs1_publish.*`
(`GRC_STREAM_OUT` full, `GRC_STREAM_PATCH_OUT` patch), the receiver's file mode
(`receiver/receiver.gd`, `rs_applier.gd`) and the gate 0 and gate 1 runners. Served live since
G1c2 (`capture/src/rs1_live.*` over `rs_ws`, `GRC_LIVE_LISTEN`; the receiver's live mode,
`receiver/rs_live_client.gd`). [render-stream-0.md](render-stream-0.md) is superseded and kept as
frozen history.
Behaviour (what the capture puts into these records, delivery, credit) is in
[gate1-design.md](gate1-design.md).

render-stream/1 is render-stream/0 with: a stream identity, root geometry in the session,
patch-encoded transactions, two more item fields, new unsupported reasons and sabotage kinds,
richer end stats, and a live transport section. Everything this document does not change is
exactly as in render-stream-0.md: record framing (`u32le` lengths, canonical JSON meta, `f32`
blocks), the record sha256 definition, the canonical-JSON rules, the error-string form, and the
"no floats in JSON, no engine RIDs as numbers" rules.

## File layout

```
magic        8 bytes   47 52 53 31 0D 0A 1A 0A   ("GRS1\r\n\x1a\n")
record       session       exactly one, first
record       transaction   zero or more, seq 1..N
record       end           at most one, last; nothing may follow it
```

A file recording always ends with an end record (`recording-incomplete` otherwise). A live stream
is the concatenation of the binary messages received on one connection, which is the same byte
sequence; a stream the receiver itself closed may lack the end record (the receiver records why).
Decoders refuse magic `GRS0` and any other byte 3 with `bad-magic`.

## Session record

Key order (line breaks for reading only):

```
{"type":"session",
 "protocol":"render-stream/1",
 "session_id":<32 hex>,
 "stream":{"stream_id":<32 hex>,"connection":<int>=1>|null,"transport":"file"|"websocket",
           "encoding":"full"|"patch"},
 "engine":{"version_string","sha256","display_server","rendering_driver","rendering_method"},
 "capture":{"calibrator_version":<int>,"hooks_planned":[...],"hooks_omitted":[...]},
 "viewport":{"canvas_cull_mask":<u32>,"root_canvas":1,
             "logical_size":[<int>,<int>],
             "stretch":{"mode":"disabled"|"canvas_items"|"viewport",
                        "aspect":"ignore"|"keep"|"keep_width"|"keep_height"|"expand",
                        "scale_mode":"fractional"|"integer"},
             "stretch_applied_by":"receiver",
             "root_size_policy":"observe"|"enforce-min-size",
             "host_size_status":"match"|"degenerate-visible"|"degenerate-window",
             "host_window_size":[<int>,<int>]},
 "features":{"ops":[...],"item_state":[...],"observed_unsupported_ops":[...],"unobserved":[...],
             "publication":"snapshot-or-patch"},
 "sabotage":null | {"kind":<kind>,"frame":<int>=1>,"op":<str>|null},
 "blocks":[clear_color, root_canvas_xform, host_visible_rect, host_final_xform, content_scale_factor]}
```

- `session_id` identifies the capture session (one per armed process); wire ids are unique within
  it. `stream.stream_id` is fresh per stream: per file sink and per live connection.
  `connection` is the live connection number (1, 2, …), `null` for a file. `encoding` is the
  sink's encoding: `full` streams contain only full transactions; `patch` streams start full and
  may contain both (resync).
- `logical_size` is the root `Window.content_scale_size` (the project's viewport size,
  `main/main.cpp:4456`). `stretch` is the root's content-scale mode, aspect and stretch.
  `host_window_size` is `Window.get_size()` after the root-size policy ran. `host_size_status` is
  defined in gate1-design.md Q1.
- `features` at gate 1, each array sorted ascending by byte value:
  - `ops`: `["add_rect"]`
  - `item_state`: gate 0's list plus `"behind"` and `"z_relative"`.
  - `observed_unsupported_ops`: gate 0's list.
  - `unobserved`: gate 0's list plus `"viewport_set_global_canvas_transform"`. G1e removed
    `canvas_item_set_draw_behind_parent` and `canvas_item_set_z_as_relative_to_parent`.
- Sabotage kinds: `freeze-frame`, `omit-update`, `perturb-transform` (gate 0), `omit-op` (`op` is
  the RenderingServer method name), `patch-drop-item`, `drop-message`, `ignore-credit`,
  `stale-coalesce`. `op` is non-null exactly for `omit-op`.

Blocks:

| name                   | count | floats                                                                    |
| ---------------------- | ----- | ------------------------------------------------------------------------- |
| `clear_color`          | 4     | as /0                                                                     |
| `root_canvas_xform`    | 6     | as /0                                                                     |
| `host_visible_rect`    | 4     | as /0, read **after** the root-size policy                                |
| `host_final_xform`     | 6     | root `Viewport.get_final_transform()` (stretch × global canvas transform) |
| `content_scale_factor` | 1     | root `Window.get_content_scale_factor()`                                  |

## Transaction record

```
{"type":"transaction",
 "seq":<int>=1>,
 "frame":<int>=1>,
 "encoding":"full"|"patch",
 "base_seq":null|<int>,
 "status":"ok"|"capture-failure",
 "failures":[{"reason","detail"}...],
 "unsupported":[{"op","item","reason"}...],
 "removed_canvases":[<int>...],
 "removed_items":[<int>...],
 "canvases":[<canvas>...],
 "items":[<item>...],
 "blocks":[item_f32, canvas_f32, cmd_f32]}
```

`<canvas>` is as /0: `{"id","origin","role","attached","items"}`.

`<item>` (key order):

```
{"id","origin","parent","children","visible","draw_index","z_index","z_relative","behind",
 "clip","custom_rect","visibility_layer","content_version","commands"}
```

`z_relative` (RS default `true`) and `behind` (default `false`) are booleans. `commands` is an array
of `/0` commands, or `null` (below). Blocks are as /0: 18 floats per item entry, 6 per canvas
entry, 8 per `add_rect` in every non-null `commands`, in entry order.

### Full transactions

`encoding:"full"`, `base_seq:null`, `removed_canvases:[]`, `removed_items:[]`, every canvas and
every item present, no `commands:null`. Identical in content to a /0 transaction plus the two
item fields.

### Patch transactions

`encoding:"patch"`, `base_seq` = the previous transaction's `seq` in the same stream (always
`seq − 1` at gate 1).

- `removed_canvases` / `removed_items`: ids present in the base state and absent now, ascending.
- `canvases` / `items`: exactly the entries that are new or differ from the base, ascending by id.
  An entry differs when any JSON value or any of its block floats differs; floats compare by their
  32-bit pattern. `commands` do not take part in the comparison; `content_version` stands for them.
- `commands` is `null` exactly when the item existed in the base with the same `content_version`;
  the receiver keeps the base's commands. A new item, or one whose `content_version` changed,
  carries its full command array.
- `status`, `failures` and `unsupported` are complete, never patched.
- An unchanged state is a valid patch with every list empty.

### Resolution

`state(seq)` for a full transaction is its content. For a patch:
`state(seq) = state(base_seq)` minus the removed ids, with every included entry replacing the
entry of the same id (inserted when new), and `null` commands taken from the base entry. Every
/0 per-transaction invariant (render-stream-0.md 1–8) and invariant 9 below apply to the resolved
state, not to the patch alone.

### Invariant 9: draw-index ties

In every container (a canvas's `items`, an item's `children`), group the children by
`draw_index`. A group in which at least two members are _drawing_ (non-empty `commands` or
non-empty `children`) needs exactly one item-level entry
`{"op":"canvas_item_set_draw_index","item":<smallest drawing id in the group>,"reason":"draw-index-tie"}`,
and no such entry may exist otherwise (`unsupported-mismatch`).

The entry is structural: the capture declares every such group, whether or not the order of its
members can change a pixel. How a gate classifies a declared tie is checker policy, not wire
format (gate1-design.md D7 as amended by G1b2: a tie whose drawing members paint pairwise
disjoint pixel footprints is declared but harmless; any other tie makes the leg `unsupported`).

### Unsupported reasons

/0's `unsupported-op`, `unsupported-state`, `non-root-viewport`, `extra-canvas`, plus:

- `draw-index-tie` (item-level, above);
- `degenerate-host-size`: the session-level entry
  `{"op":"root_viewport_size","item":null,"reason":"degenerate-host-size"}`, present in every
  transaction exactly when `session.viewport.host_size_status != "match"`. Being observed at
  session start, it is the first session-level entry.

Failure reasons: /0's three plus `root-size-enforce-failed`.

### Patch error codes

| code             | rule                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `patch-base`     | a patch is the first transaction of the stream, or its `base_seq` is not the previous transaction's `seq`                             |
| `patch-encoding` | a full transaction with non-null `base_seq` or a non-empty removed list, or a patch in a stream whose session says `encoding: "full"` |
| `patch-removed`  | a removed id is absent from the base, appears twice, or also appears among the entries                                                |
| `patch-commands` | `commands:null` in a full transaction, on a new item, or with a `content_version` different from the base's                           |

`id-reused` keeps its /0 meaning over resolved states within one stream.

Order (G1c2): a transaction whose `seq` is not the previous `seq` + 1 is `seq-gap` before any patch
rule is applied, so a patch that follows a lost transaction (and names it as its base) reports the
gap, not `patch-base`. Golden: `invalid/patch-after-gap.rs1`.

## End record

```
{"type":"end",
 "transactions":<int>,
 "reason":"shutdown"|"disarm",
 "stats":{"bytes_total","encode_ns_total","snapshot_ns_total","diff_ns_total","max_record_bytes",
          "full_transactions","patch_transactions"},
 "blocks":[]}
```

Per stream. `bytes_total` and `max_record_bytes` as /0, over this stream's own bytes;
`full_transactions + patch_transactions == transactions` (`end-stats-mismatch`). `diff_ns_total`
is the time spent forming patches for this stream (0 for a `full` stream).

## Decoded and resolved forms

`decodeRecording()` returns `{"schema":"render-stream-1-decoded/1","magic":"4752533…","records":[…]}`
exactly as /0's decoded form. `resolveRecording()` returns:

```
{"schema":"render-stream-1-resolved/1",
 "session_id":<str>,"stream_id":<str>,
 "transactions":[{"seq","frame","encoding","state":{
     "status","failures","unsupported",
     "canvases":[{"id","origin","role","attached","items","xform":[6]}],
     "items":[{"id","origin","parent","children","visible","draw_index","z_index","z_relative",
               "behind","clip","custom_rect","visibility_layer","content_version",
               "xform":[6],"modulate":[4],"self_modulate":[4],"custom_rect_rect":[4],
               "commands":[{"op":"add_rect","aa":<bool>,"rect":[4],"color":[4]}
                          |{"op":"unsupported","name":<str>}]}]}}]}
```

Floats are JSON numbers holding float32 values; comparison is deep equality after rounding both
sides to float32. `statesEqual(a, b)` compares two `state` objects this way. The GDScript
receiver's state dumps (`state/seq-<n>.json`) use the same `state` shape.

## Golden vectors (`golden-1/`)

`make_golden.py` (standard library only, deterministic, `--check`) writes:

- `full.rs1`: a `full`-encoding stream, seqs 1–6, then an end record.
- `patch.rs1`: the same six states as a `patch`-encoding stream: seq 1 full; seq 2 transform-only
  (an item with `commands:null`); seq 3 an item freed, an item created, a draw-index change, a
  recolour (`content_version` bump); seq 4 unchanged (all lists empty); seq 5 a re-parent and two
  drawing siblings tied on `draw_index` (with the `draw-index-tie` entry); seq 6 full again
  (`base_seq:null`, as after a resync); end record.
- `*.hex`, `*.decoded.json`, and one `resolved.json` that both streams must resolve to. Fixed
  2026-10-09 (this bullet previously read "the `stream_id`, `encoding` and per-transaction
  `encoding` fields excepted", ambiguous about how many fields that names and how a comparison
  excepts them): `resolved.json` is `{"schema":"render-stream-1-resolved/1","transactions":
[{"seq","frame","state":{...}}...]}` -- it omits the top-level `session_id`/`stream_id` and the
  per-transaction `encoding` that `resolveRecording()`'s own return value carries (render-stream-
  1.md "Decoded and resolved forms"), since `full.rs1` and `patch.rs1` legitimately differ there
  (different streams; a patch stream's transactions are mostly `"patch"`). A self-test compares
  `resolveRecording(file)` against `resolved.json` by building `{schema, transactions:
transactions.map(t => ({seq, frame, state: t.state}))}` from the live result and comparing that.
- `corrupt-meta.rs1` (first meta byte of seq 3 zeroed → `meta-json` at record index 3).
- `invalid/<name>.rs1`, with codes in `index.json`: `bad-magic` (a /0 magic), `patch-first`
  (→ `patch-base`), `patch-base-gap` (→ `patch-base`), `patch-after-gap` (seq 4, a patch on the
  missing seq 3, after seq 2 → `seq-gap`; G1c2), `full-with-base` (→ `patch-encoding`),
  `removed-unknown` (→ `patch-removed`), `removed-and-present` (→ `patch-removed`),
  `null-commands-new-item` (→ `patch-commands`), `null-commands-changed-version`
  (→ `patch-commands`), `tie-unflagged` (→ `unsupported-mismatch`), `dangling-after-patch` (a
  patch that removes a parent but not its listed child → `dangling-parent`), `no-end`
  (→ `recording-incomplete`).
- `control/valid/*.json` and `control/invalid/*.json`: control messages (below), used by the C++
  parser test (G1c2).

## Live transport

- WebSocket (RFC 6455) over loopback TCP. Path `/render-stream`. Subprotocol `render-stream.1`,
  required in the request and echoed in the response.
- Host → receiver, binary messages: the first is the magic followed by the session record; each
  later one is exactly one transaction or end record, length prefix included. The concatenation
  of a connection's binary messages is a valid stream as defined above.
- Host → receiver, text: at most one `{"type":"error","reason":<str>,"detail":<str>}` before the
  host closes (reasons `message-too-large`, `protocol`, `hello-timeout`).
- Receiver → host, text, at most 4096 bytes each; flat JSON objects; keys in any order; numbers
  are integers:
  - `{"type":"hello","protocol":"render-stream/1","receiver":<str>,"credit_stage":"submitted"|"applied","inbound_buffer_bytes":<int>}`
    — first and once. The host sends nothing before it.
  - `{"type":"ack","stream_id":<32 hex>,"seq":<int>,"stage":"received"|"applied"|"submitted","t_us":<int>}`
  - `{"type":"resync","stream_id":<32 hex>,"seq":<int>,"reason":<str>}` — the receiver did not
    apply `seq` and will ignore patches until a full transaction arrives.
- Credit: see gate1-design.md Q4. The host never sends a message larger than
  `min(inbound_buffer_bytes, GRC_LIVE_MAX_MESSAGE_BYTES)`; a larger transaction is the `error`
  `message-too-large` and close 1009.
- Close codes used by the host: 1000 (shutdown, disarm), 1002 (protocol, hello timeout),
  1008 (queue safety limit), 1009 (message too large). A refused handshake is an HTTP status
  (400, 404, 503), not a close code. The close reason repeats the error's `reason`
  (`protocol`, `hello-timeout`, `message-too-large`): a client may never read a text message that
  arrives together with the close frame (Godot's `WebSocketPeer` drops it; gate1-design.md G1c2
  "As built").
- End of a stream: the host sends the end record and does not close behind it; the receiver
  closes with 1000 once it has read the end record. A host that stops waits a bounded time (1.5 s
  at G1c2) for that close, then closes with 1000 itself.

## Versioning

As /0: any change to framing, a key, a key order, a block layout or an enum spelling is a new
version (`render-stream/2`, magic byte 3 `0x32`, subprotocol `render-stream.2`). A decoder accepts
only the version it was written for. Control messages are part of the version.
