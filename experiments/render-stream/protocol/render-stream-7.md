# render-stream/7 wire format

Status: specified and golden-tested at G7w (2026-10-14). Served by the capture's live listener
since G7n (2026-10-15): it accepts `render-stream.6` and `render-stream.7` side by side, and each
connection speaks the one it chose ("As built (G7n)" below). File sinks still speak /6. Since G7l
(2026-10-16) both browser receivers speak /7 live, with the token in the hello, and the native
receiver speaks it under `RS_RECEIVER_PROTOCOL=7` (default 6; protocol/gate7/g7l.md "As
built"). G7q is fork F1, credit window 2. Written with
[gate7-design.md](gate7-design.md) Q2, which this document implements. Codecs (G7w): C++
encoder (`capture/src/rs2_codec.*`, `rs2_diff.*`, behind `Session::version`), TypeScript
decoder/validator/resolver (`scripts/lib/render-stream-2.ts`, behind an explicit `version`
parameter) and GDScript decoder (`receiver/rs2_decoder.gd`), plus the C++ control parser
(`capture/src/rs_live.{h,cpp}`'s `parse_control`), all checked byte-for-byte and state-for-state
against `protocol/golden-7/`, per this text.
[render-stream-6.md](render-stream-6.md) and, through it, render-stream-5.md, render-stream-4.md,
render-stream-3.md, render-stream-2.md and render-stream-1.md are not superseded: `golden-2/`
through `golden-6/` keep passing unchanged (gate7-design.md D2).

As with /3 to /6 (memory g4e1-rs3-version-switch-pattern), /7 is **not** a new forked module. The
version-parameterized C++/TypeScript/GDScript modules /6 already extended grow a sixth value:
C++'s `Session::version` gains `ProtocolVersion::V7` (still defaulting to `V2`, so every existing
/2-/6 caller is unaffected), and the TypeScript/GDScript `version` parameter widens to
`2 | 3 | 4 | 5 | 6 | 7` (both still default to `6`, unlike every earlier switch -- /7 is a
**live-transport-only** delta: nothing about the capture's file sinks or a recorded `.rs7` stream
needs it to become the default, and G7n is the increment that makes the live listener/receiver
negotiate it). Renaming `rs2_codec.*`/`rs2_diff.*`/`render-stream-2.ts`/`rs2_decoder.gd` is not
part of this document.

render-stream/7 is render-stream/6 plus exactly:

- a new magic, protocol string and subprotocol;
- a hello with nine new keys: `receiver_kind`, `credit_window`, `token`, `manifest_sha256` and
  five presentation integers (`presentation_backing_w/h`, `presentation_css_w/h`, `dpr_milli`);
- the top-level session key `publication` (render-stream-6.md) gains `credit_window`;
- `error.reason` gains `unauthorized`, and the close-code table gains 1008 for it (1008 already
  exists for the queue safety limit);
- HTTP gains CORS for any request carrying an `Origin` header (origin allowlist, preflight).

Everything this document does not change is exactly as in render-stream-6.md and, through it,
render-stream-5.md, render-stream-4.md, render-stream-3.md, render-stream-2.md, render-stream-1.md
and render-stream-0.md: record framing, the `u8`/`f32`/`i32`/`f64` block types, the record sha256
definition, canonical JSON, the viewport/canvas/texture/mesh/shader/material tables and their
invariants, every payload format, out-of-band delivery and HTTP resource routes. **Records,
transactions, blocks, items and commands are byte-identical to /6** -- nothing about a canvas, an
item, a command, a texture, a mesh, a shader or a material changes at /7; only the session's
`publication` key and the live control messages (hello, error) change.

## File layout

```
magic        8 bytes   47 52 53 37 0D 0A 1A 0A   ("GRS7\r\n\x1a\n")
record       session       exactly one, first
record       resource      zero or more, each before the first transaction that needs it
record       transaction   zero or more, seq 1..N
record       end           at most one, last; nothing may follow it
```

A decoder configured for /7 refuses `GRS6` (or any other byte 3) with `bad-magic`. A decoder
configured for /6 continues to refuse `GRS7` the same way it already refuses `GRS5`.

A /7 stream exists only as a live connection and the receivers' `received.rs7` copy of it
(gate7-design.md Q2): file sinks stay on /6 until a later cleanup increment chooses to switch them
(gate7-design.md D2, "Deferred").

## Session record

Key order is exactly render-stream-6.md's: `type`, `protocol`, `session_id`, `stream`, `engine`,
`capture`, `viewport`, `resources`, `materials`, `features`, `publication`, `sabotage`,
[`unknown_item_policy`], `blocks` -- /7 adds no new top-level key. `protocol` is
`"render-stream/7"`.

### Publication

```json
"publication":{"mode":"every-frame"|"rate","target_fps":<int 1..240>|null,"credit_window":<int 1..2>}
```

`credit_window` is new, right after `target_fps` (gate7-design.md D2, D4): the granted live credit
window, `1` or `2`. It is always `1` on a `file` stream (/7 has no file streams in practice, but
the invariant holds the same way `publication.mode` is constrained on one). New invariant,
`publication-entry` (extending render-stream-6.md's): `credit_window` is an integer in `1..2`, and
it is `1` when `stream.transport` is `"file"`.

Window 1 is render-stream-6.md/the handoff's rule, byte for byte: at most one transaction in
flight per receiver. Window 2 (in-flight accounting over two bases, a resync of the earlier seq)
is a host *behaviour*, not a wire shape -- it needs no further codec change, and is gated on fork
F1 (gate7-design.md D4; G7q implements the host side only once approved). Before G7q lands, the
host accepts a hello asking for `credit_window: 2` and grants `1`; this codec never enables
window-2 behaviour itself.

## Live transport

### Hello

```json
{"type":"hello","protocol":"render-stream/7","receiver":<str ≤64>,
 "receiver_kind":"native"|"web-export"|"gsw-canvas",
 "credit_stage":"submitted"|"applied","credit_window":1|2,
 "inbound_buffer_bytes":<int>,"token":<64 lowercase hex>|null,
 "manifest_sha256":<64 hex>|null,
 "presentation_backing_w":<int>,"presentation_backing_h":<int>,
 "presentation_css_w":<int>,"presentation_css_h":<int>,"dpr_milli":<int>}
```

That is /6's five keys (`type`, `protocol`, `receiver`, `credit_stage`, `inbound_buffer_bytes`)
plus `receiver_kind`, `credit_window`, `token`, `manifest_sha256` and the five presentation
integers -- fourteen keys total, every one required, flat (no nesting, no arrays, no booleans;
`token`/`manifest_sha256` are the only two keys this wire's control-message grammar ever allows to
be JSON `null`). `receiver_kind` is one of `"native"`, `"web-export"` or `"gsw-canvas"`.
`credit_window` is `1` or `2`. `token`, when not `null`, is 64 lowercase hex, as is
`manifest_sha256`. The five presentation integers are non-negative; headless native receivers send
their logical size and `dpr_milli` 1000 (gate7-design.md Q2).

The subprotocol is `render-stream.7`. `parse_control(ProtocolVersion::V7)` (C++) and this gate's
own TypeScript/GDScript self-test hello checkers accept exactly this shape and refuse: a missing
key, an unknown key, `credit_window` outside `1..2`, a non-hex `token`, a hello whose `protocol` is
not `"render-stream/7"`, and a non-integer (e.g. a JSON float) presentation value. This codec
parses the hello; it does not yet *act* on it -- `GRC_LIVE_CREDIT_WINDOW_MAX`, the bearer-token
check, the `Origin` allowlist and the window grant are `rs_live.cpp`'s Hub, landed by G7n.

### Errors

`error.reason` gains `unauthorized` (sent, with close code 1008, when a `resources.auth: "bearer"`
session's hello carries a null or wrong `token` -- G7n). `error`'s own shape
(`{"type":"error","reason":<str>,"detail":<str>}`) is unchanged; a decoder already accepts any
string `reason` (render-stream-1.md), so no parser change was needed for the new reason itself.

### HTTP (CORS)

For every request carrying an `Origin` header (gate7-design.md D3, Q2 -- G7n's work, specified
here because it is part of /7's wire contract): an origin not in `GRC_LIVE_ALLOWED_ORIGINS` gets
403 on the upgrade, on GET and on `OPTIONS`; for an allowed origin, GETs add
`Access-Control-Allow-Origin: <origin>` and `Vary: Origin`, and `OPTIONS
/resources/sha256/<hash>` answers a 204 preflight
(`Access-Control-Allow-Methods: GET`, `Access-Control-Allow-Headers: authorization`,
`Access-Control-Max-Age: 7200`, `Vary: Origin`) whether or not the hash is servable, carrying no
token. A request with no `Origin` is exactly /6. The routes and non-CORS response shapes
(`/resources/sha256/<hash>`, `Cache-Control`, `ETag`, bearer) are /6's, unchanged.

## Decoded and resolved forms

`decodeRecording()` on a /7-magic stream returns `{"schema":"render-stream-7-decoded/1",...}`,
shaped exactly as /6's (no new wire field besides `publication.credit_window`, carried verbatim as
a plain JSON integer -- it needs no lifting). `resolveRecording()` returns
`render-stream-7-resolved/1`; the per-transaction resolved `state` shape is byte-for-byte /6's,
since `publication` is a session-level field the resolved form has never carried (render-stream-2.md
"resolveRecording()" drops most session info by design).

## Golden vectors (`golden-7/`, G7w)

Unlike /3 through /6, this gate's golden set does **not** re-derive the shared `full`/`patch`/
`inline` states: gate7-design.md D2 says records/transactions/payloads are byte-identical to /6,
so there is no `full.rs7`/`patch.rs7`/`inline.rs7`. `make_golden.py` (stdlib only, deterministic,
`--check` mode) instead re-encodes golden-6's own `rate.rs6` scene (one root canvas, one item, one
`add_rect`) as two small, independent legs:

- `rate.rs7`: the same scene, `publication` `{"mode":"rate","target_fps":30,"credit_window":1}` --
  resolves to `resolved-rate.json`.
- `window2.rs7`: the same scene, `credit_window: 2`, as three transactions: a full (seq 1) then
  two CONSECUTIVE patches whose bases chain (seq 2 bases on seq 1, seq 3 bases on seq 2) -- the
  scene never changes, so both patches carry empty `canvases`/`items`/`textures` arrays (the
  simplest legitimate patch, an idle frame). "As built" below explains how this leg's three
  transactions compare against `resolved-rate.json`'s one.

`invalid/` carries exactly the three new failure modes /7 introduces (every rule /7 leaves
unchanged is already covered by `golden-2/invalid/` through `golden-6/invalid/`):

| name                        | code                | what's wrong                                                         |
| ---------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `bad-magic`                  | `bad-magic`         | golden-6's `rate.rs6`, byte for byte -- a real GRS6 stream handed to a /7 decoder |
| `publication-window`         | `publication-entry` | `publication.credit_window` is `3` (out of `1..2`)                    |
| `publication-file-window`    | `publication-entry` | a `file` stream declaring `credit_window: 2` (always `1` on a file sink) |

`control/` carries the hello vectors (gate7-design.md Q2): `control/valid/` has one hello per
`receiver_kind` (native twice, web-export once, gsw-canvas once), covering both `credit_window`
values and both with and without a `token`; `control/invalid/` has a missing key, an unknown key,
`credit_window` `0` and `3`, a non-hex `token`, and a `render-stream/6` `protocol` string on an
otherwise-/7-shaped hello.

## Versioning

As /6: any change to framing, a key, a key order, a block layout, an enum spelling or a payload
format is a new version.

## As built (G7w)

- **`window2.rs7`'s three transactions compare against `resolved-rate.json`'s one.**
  Gate7-design.md Q2 says "Both resolve to `resolved-rate.json`" without spelling out how a
  three-transaction stream and a one-transaction stream can resolve to the same document byte for
  byte -- they can't, as whole documents. This gate's own reading (recorded here, not left
  implicit in test code): every transaction's resolved **state** (`seq`/`frame`/`encoding` aside,
  the same exception class render-stream-1.md's `resolved.json` rule already uses) must equal
  `resolved-rate.json`'s sole transaction's state, since the scene never changes across
  `window2.rs7`'s three transactions. The TypeScript, GDScript and C++ self-tests all implement
  this same per-transaction comparison, not a whole-document one.
- **`credit_window`'s wide/narrow range split.** Both decoders check "is this an integer at all"
  with the schema's own generic bounds (reported `meta-schema` on failure, like every other
  malformed field) and separately recheck the narrower `1..2` business rule (reported
  `publication-entry`) -- the same two-tier pattern render-stream-6.md's `target_fps` already
  uses (a wide shape check, then the narrower `1..240` "rate" bound).
- **The control-message parser now accepts `null`.** Every control message before /7
  (render-stream-1.md's grammar: flat, strings and non-negative integers only, explicitly "no
  null") never needed it. `token`/`manifest_sha256` are the first fields this wire ever lets be
  absent-as-`null` rather than absent-as-omitted, so `rs_live.cpp`'s hand-written JSON value
  parser gained a `null` literal (and `num()`'s existing "is this a string" rejection became "is
  this a string or null", so a stray `null` on an integer field still fails instead of silently
  decoding as `0`).
- **G7w touches no Hub, socket or receiver-live-path file.** `parse_control`'s new branch is
  parsing only (gate7-design.md Q2, G7w's own scope): no `ConnectionSummary` field, no
  `GRC_LIVE_CREDIT_WINDOW_MAX`, no bearer check and no CORS header exist yet on the wire this
  capture actually serves. Those land with G7n (`rs_live.cpp`'s Hub, rebased onto G6c) and are
  specified above only because they are part of /7's *wire* contract, which this document owns in
  full regardless of which increment implements the runtime behaviour.

## As built (G7n)

The capture's listener (`capture/src/rs_ws.*`, `rs_live.*`, `entry.cpp`) implements the live
contract above. Where the text above left room, G7n decided:

- **Subprotocol choice.** The upgrade takes the first of `render-stream.7`, `render-stream.6`
  that the client offered, whatever the client's order. A connection's version comes from that
  choice alone. A /7 hello on a /6 connection, or the reverse, is `error` `protocol`, close 1002.
- **Bearer at /7.** The /7 upgrade is never bearer-checked: its token is the hello's. A /6
  upgrade on a bearer session still needs `Authorization: Bearer` (401 otherwise, as at /6).
  Resource GETs keep the bearer header at both versions. A /7 hello on a session without auth is
  not token-checked, whatever it carries (`token_ok` null in the evidence).
- **Order of the HTTP checks.** A foreign `Origin` is refused (403) before anything else is
  looked at, on the WebSocket path and on the resource route, whatever the method. A 403 is
  reported as one `OriginRejected` event, never as an `http-get` hook-log line.
- **CORS on every resource response.** For an allowed origin, every response on the resource
  route carries `Access-Control-Allow-Origin` and `Vary: Origin`, not only 200: 304, 400, 401,
  404, 405 and 503 too, so a page can read the status (a browser hides a response without ACAO).
- **The preflight.** `OPTIONS` under the resource prefix from an allowed origin answers 204 for
  any hash, servable, unknown or malformed alike, with exactly `Access-Control-Allow-Origin`,
  `-Allow-Methods: GET`, `-Allow-Headers: authorization`, `-Max-Age: 7200`, `Vary: Origin` and
  `Connection`. It carries **no `Content-Length`**: RFC 9110 8.6 forbids one on a 204, and only
  browsers send preflights (Godot's `HTTPClient`, which needs an explicit length, never does).
  `OPTIONS` without `Origin` is still 405, exactly as at /6.
- **Window.** The grant is `min(credit_window, GRC_LIVE_CREDIT_WINDOW_MAX, 1)` until G7q: the
  host implements window 1 only, so a hello asking 2 under `GRC_LIVE_CREDIT_WINDOW_MAX=2` is still
  granted 1.
- **Listener sabotages are not on the wire.** `no-cors`, `accept-any-origin` and `token-ignored`
  act on the listener, never on a record. The session's `sabotage` key enumerates record-level
  kinds, and their spelling is part of the version, so adding three there would have changed
  /6's wire. The session therefore declares `sabotage: null` under them, and
  `evidence/live.json` carries `listener_sabotage` instead. `token-ignored` needs
  `GRC_LIVE_AUTH=token`, and all three need `GRC_LIVE_LISTEN`; otherwise they refuse.
