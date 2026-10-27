# render-stream/11 wire format

Status: **design; codecs, validators and capture built** (W11-D, 2026-10-25; W11a, 2026-10-27:
the C++ encoder, TypeScript and rs-core match `golden-11/`, see "As built (W11a): decisions"; W11b,
2026-10-27: the capture emits /11 under `GRC_STREAM_VERSION=11`, see "As built (W11b): decisions";
the receivers are W11c to W11e). The measurements behind every number here are
in [results/p3/w11-d.md](../results/p3/w11-d.md). /11 builds on render-stream/10
([render-stream-10.md](render-stream-10.md): CG1's back-buffer item state and P3-TM's
`shader_time`). Like /8 to /10 it is **opt-in**: nothing below /11 changes, and no default moves
("Opt-in and version policy").

## Why

A browser viewer of a long STS2 session runs out of memory. GSW's wasm heap grows 5–7 MB a second
in combat (P3-SP, `p3sp-new-3`), so it reaches wasm32's 4 GB after about ten minutes. Two rules
cause it, and they hold on both ends:

- Every spine pose is a new content-addressed mesh payload: 102 new hashes per combat transaction
  in `a8-2`, of which almost none recurs.
- render-stream/2's resource rules make "carried" lifelong. A hash may be sent inline at most once
  per stream (`resource-duplicate`), and every inline-sized hash a transaction names must have
  arrived inline before (`resource-missing`). So the host can neither re-send a hash nor skip one,
  and the receiver can drop none of them. P3-SP made the host's set compact (40 B a hash, shared by
  every viewer), but not bounded.

/11 converges four designs:

- **P3-SP's prune rule** (render-stream-2.md, "Design, not built"): after each transaction, both
  ends prune the carried set to what the resolved state names.
- **P3-LV's dynamic mesh surfaces** (results/p3/p3-lv.md, "Design: dynamic mesh surfaces by id,
  inline"): a mesh that animates sends its bytes by mesh id, inside the transaction.
- **P3-PM's multimesh tier** (particles-multimesh-design.md, "/11: multimesh"): a multimesh's
  instance buffer goes inline in `mm_f32`, only when it changed.
- **P3-SP's shared publication**: several viewers share each encode. Under /11 the resource
  records become a function of the transaction's base and target, so sharing covers them too.

**render-stream/11 is render-stream/10 plus exactly:**

1. a new magic (`GRSB`), protocol string (`render-stream/11`), subprotocol (`render-stream.11`) and
   file extension (`.rs11`);
2. the **carried-set rules** ("Resource retention") and one new invariant, `resource-unnamed`;
3. **dynamic mesh surfaces**: a mesh entry key `u8`, a surface `hash` that may be `null`, and a
   transaction block `mesh_u8` of type `u8`;
4. the **multimesh table**, the `add_multimesh` command and a transaction block `mm_f32` (PM1);
5. one session key, `resources.mesh_dynamic`, which declares the host's classification policy;
6. **a stable `content_version`** (WB): it moves only when an item's commands change, with one new
   invariant, `content-version-stable` ("Warm wire budget (WB)");
7. **a patched `unsupported`** (WB): `null` in a patch means "as the base".

Everything else is /10's: record framing, the record sha256, canonical JSON, every other table and
payload, out-of-band delivery, HTTP routes and D7's serving rule, and the hello (/9's fifteen keys,
with `protocol` set to `"render-stream/11"`). Like /3 to /10 (memory
`g4e1-rs3-version-switch-pattern`), /11 is not a forked module. The version-parameterized
C++/TypeScript/Rust modules gain the value 11: `ProtocolVersion::V11`, TypeScript `version` widens
to `2..=11` (the default stays `6`), and the Rust `version: u8` widens likewise.

## File layout

```
magic        8 bytes   47 52 53 42 0D 0A 1A 0A   ("GRSB\r\n\x1a\n")
```

then as /10. Byte 3 is the version as one uppercase hex digit (render-stream-10.md "File layout"):
`B` is 11. A /11 decoder refuses `GRSA`, and a /10 decoder refuses `GRSB`, both with `bad-magic`.
Recording files use `.rs11`.

## Session record

/10's key order. `resources` gains one key, `mesh_dynamic`, last (right after
`texture_delivery`):

```json
"mesh_dynamic":{"mode":"auto"|"off"|"all","frames":<int 1..60>,"max_bytes":<int>=0>}
```

- It declares the capture's classification policy ("Dynamic mesh surfaces", "Capture policy").
  Receivers do not need it. Checkers use it to verify the host's choices.
- `off` makes every mesh static, so the stream is /11 with the prune rule alone. `all` makes every
  mesh dynamic at its first content-bearing entry, within `max_bytes` (for tests).
- Invariant `mesh-dynamic-policy` (self-coded, like `adoption-entry`): the object has exactly these
  keys, `mode` is one of the three spellings, and `frames` and `max_bytes` are in range.
  `max_bytes` 0 means no surface qualifies, the same as `off`.

`features.ops` gains `add_multimesh`, and `features.observed_unsupported_ops` loses
`canvas_item_add_multimesh` when its hook is planned (PM1, CG1's conditional-hook rule).
`features.resources` gains `"multimesh"`.

## Resource retention: the carried set

### Definitions

For a resolved state S:

- **names(S)**: every payload hash S names. That is each `ok` image texture's `hash` and every
  variant's `hash`, each **static** surface of an `ok` mesh, and each `ok` shader whose `source` is
  `payload`. Dynamic surfaces have no hash (below) and are not in names(S).
- **required(S)**: the subset that `resource-missing` constrains. It is names(S) without variant
  hashes (render-stream-9.md: a variant is never required inline), restricted to entries whose
  `payload_bytes ≤ inline_max_bytes`.
- **C**: a stream's carried set. It is a set of hashes and is empty when the stream starts.

### Rules

Over a stream's records, in order:

| record | /2–/10 | /11 |
| ------ | ------ | --- |
| resource record, hash h | `resource-duplicate` if h was ever carried; then add h | `resource-duplicate` if **h ∈ C**; then C ← C ∪ {h} |
| transaction S | `resource-missing` unless required(S) ⊆ ever-carried | `resource-missing` unless required(S) ⊆ C; **`resource-unnamed`** unless every hash added since the previous transaction is in names(S); then **C ← C ∩ names(S)** |
| end record | — | `resource-unnamed` if any record follows the last transaction |

- **Prune.** C ← C ∩ names(S) runs after S's checks, on both ends. A hash that leaves the state is
  forgotten. If it returns, the host carries it again with a new resource record, which is legal
  because h ∉ C.
- **`resource-unnamed`** (new at /11, an invariant and its error code). A resource record must
  name a hash that the next transaction's resolved state names. The capture already behaves this
  way at every version: it sends each record immediately before the transaction that needs it.
  The rule makes that behaviour part of the contract. Without it, a record could be pruned before
  any transaction used it, and a receiver could not tell a host bug from a deliberate send.
- `resource-payload`, `resource-hash` and the payload decode codes are unchanged.
- End stats: `resource_records` and `resource_bytes` count every record, re-sends included.

### Properties

**L1: the two ends hold the same C.** C is a function of the stream's record sequence alone. The
host computes it over the records it sends on a connection, and the receiver over the records it
accepts. Every receiver accepts every record on arrival:

- native and the web export through `receiver.gd`'s message path (`_accept_record` for each
  message);
- GSW through `live.ts` `onMessage` and `accept_bytes`.

Folding (`/7` window 2), stale-coalesce, `superseded` and a resync's ignored patches act at apply,
never at accept (`receiver.gd` `_apply_newest` and `_refuse_for_resync`, `live.ts` `takeQueued`).
So the two sequences are the same, and the two sets are equal after every record. A reconnect
starts a new stream, so both sets start empty. **This corrects P3-SP's note**, which expected a
receiver that skipped a transaction to prune less than the host. Receivers skip applies, not
accepts, so `resource-duplicate` stays an exact error at /11, never a tolerance.

**L2: after a transaction, C has a closed form.** Assume the host's inline decision for a hash
depends on the payload alone (its size and payload format; the capture's `ResourcePolicy` does). Write
inline(S) for the hashes of names(S) that the host sends inline (required(S) ⊆ inline(S)). The
host sends, before a target T, a record for each hash of inline(T) not in C. Then after every
transaction S, C = inline(S). By induction over the stream, with B the previous transaction
(C = ∅ before the first):

```
C after T = (inline(B) ∪ (inline(T) \ inline(B))) ∩ names(T)
          = (inline(B) ∩ names(T)) ∪ inline(T)
          = inline(T)
```

The last step holds because a hash of names(T) that B's state sent inline is inline-eligible in T
too: the decision depends on the payload alone.

So the records before a target T, on a connection whose previous transaction was B, are exactly
inline(T) \ inline(B), and inline(T) when T is the stream's first transaction. **The host keeps no
per-connection carried set at /11.** Its records are a function of (B, T), which are snapshots it
already holds.

**T1: a receiver's memory is bounded by the resolved state plus a constant.** At any moment a /11
receiver holds:

- S_n, the newest accepted state;
- S_d, the state it last drew. S_d = S_n except while an apply is pending.
- R, the records accepted since S_n. By `resource-unnamed`, each is named by the transaction it
  precedes, and at credit window w at most w transactions follow S_n in flight. So R ⊆
  inline(S_n+1) ∪ … ∪ inline(S_n+w), and its bytes are at most w·Î, where Î is the largest
  inline-sized payload total of one state.

With the retention rule below, the receiver's payload store holds exactly the payloads of
C ∪ names(S_n) ∪ names(S_d). Since C ⊆ names(S_n) ∪ R:

```
store bytes      ≤ P(S_n) + P(S_d) + w·Î
validator C      ≤ |names(S_n)| + |R|          entries
dynamic bodies   ≤ D(S_n) + D(S_d)             one body per dynamic surface
multimesh floats ≤ B(S_n) + B(S_d)             one buffer per multimesh
```

Here P(S) is the payload bytes S names, D(S) the dynamic geometry it holds, and B(S) its
multimesh buffers. None of these terms depends on the session's length. Written as one state plus
a constant:

- P(S_d) beyond P(S_n) is the hashed content that the at most w pending transactions replaced;
- w·Î is the hashed content they bring.

Both are at most w transactions' hashed churn, and under `auto` that churn is small: 48 B of
records per combat transaction in `a8-2`, because the poses are no longer hashes. In `a8-2`
combat the store held at most 876 entries against 778 names (results/p3/w11-d.md).

The bound covers the protocol's state, not evidence sinks. `applied.json` and the browsers'
received-stream copies are evidence, streamed since P3-HX, and a product receiver runs without
them. The acceptance leg below measures with them off or streamed.

**T2: the host's per-viewer state is bounded and flat.** Per /11 connection the host holds:

- a pointer to its base snapshot;
- at most w in-flight entries;
- counters.

The snapshots are shared between connections (P3-SP). By L2 there is no carried set, so
`rs_carried.h`'s host-wide index serves only /6–/10 connections. D7's served set pins the hashes
of each connection's in-flight transactions and of the current captured state. That is at most
(viewers·w + 1) states, all shared. None of it grows with the session. P3-SP measured +0.2 MB a
minute with the index. /11 also removes the index's 40 B a hash: 19 MB for 479,034 hashes in a
ten-minute null leg.

### Receiver retention

Every /11 receiver keeps a payload exactly while its hash is in **H = C ∪ names(S_n) ∪
names(S_d)**. It drops the payload as soon as the hash leaves H. Nothing is kept by recency.

- A dropped **inline-sized** hash that returns arrives inline again. The host pruned it too (L1),
  so it sends the record. A /11 receiver therefore **never fetches an inline-sized hash over HTTP**.
  Check `inline-fetch-zero` makes this visible.
- A dropped **out-of-band** hash that returns is a GET, served under D7's unchanged rule. The
  browser's HTTP cache (`immutable`) usually answers it. The cost is bounded by the host's churn of
  large payloads. In `a8-2` that is 4 re-fetches in 1,152 menu transactions and none in combat.
- An explicit `RS_RECEIVER_MEMORY_BUDGET_BYTES` (G7k) still evicts within H, oldest first, as
  today. It is the only recency-based eviction left, and it is opt-in.
- Context restore (G7u) needs the payloads of S_d's resident textures. They are in names(S_d) ⊆ H.

### The P3-SP re-fetch storm

P3-SP built a default bound on GSW's `PayloadStore` (`2aebd324`, dropped in `92bddd81`): an LRU
beyond the referenced set, live mode with HTTP fetch only. On the fixture it re-fetched 63,409
payloads in 20 minutes with the applier's resident set as the floor. With every hash of the
newest accepted state added to the floor it still re-fetched 16,553 in 6 minutes.

The kept counters say what came back (`artifacts/render-stream/p3/p3-sp/fixture/*/rx-perf.json`).
The GETs moved 295,441,414 and 258,104,570 bytes. Take out the 187 textures every viewer fetches
once at 1,310,836 B each: the remainder averages **796 B and 793 B a GET**. That is one fixture
mesh surface (GRM1, 24 vertices). The re-fetched payloads were therefore **inline-carried mesh
poses**, not textures or shaders.

A fixture pose never recurs (its heights carry `frame * 0.001`). So a pose GSW needed after
evicting it is named only by the transaction its record precedes, until the mesh's next update.
The second floor covered every hash of the newest accepted state. So the pose was evicted
**between its record's accept and its transaction's accept**: an apply, and the eviction that
followed it, ran in that window. GSW accepts each WebSocket message in `onmessage` and applies in
rAF, so rAF can run between a transaction's records and the transaction itself.

**That window is exactly what the floor lacked.** In /11 terms, the floor needs R as well as
names(S_n), and /11 provides it: R ⊆ C. Two things are not settled by the kept counters:

- why LRU order reached those newest entries;
- why the first floor also lost shaders, which its own comment reports.

/11 makes both questions moot:

- **Exact retention.** The receiver's retention is the wire's own set H, not a recency guess, so
  no payload a coming transaction needs is ever dropped.
- **No inline GET.** Even a wrongly dropped inline hash could not cause a GET storm: at /11 an
  inline-sized hash is never fetched (`inline-fetch-zero`), and dropping one that is still in C
  is a receiver bug that W11c's sabotage `evict-carried` proves is caught.

Under /2 no receiver bound can be both safe and general. Any inline-carried hash a receiver drops
can come back only over HTTP, because the host never re-sends it.

## Dynamic mesh surfaces

### Mesh entry

```json
{"id","origin","adopted_content","status","reason","version","f",
 "u8":<int>|null,
 "surfaces":[{"hash":<64 hex>|null,"payload_bytes":<int>,"primitive","format",
              "vertex_count","index_count"}, ...]}
```

- `u8` is new, right after `f` and before `surfaces`. Every other key is /10's mesh entry
  (render-stream-4.md "Mesh table", render-stream-8.md's `origin` and `adopted_content`).
- A **static** mesh is /10's: every surface carries its payload `hash`, and `u8` is `null`.
- A **dynamic** mesh carries `hash: null` on every surface. Its bytes travel in the transaction:
  `u8` is the offset in `mesh_u8` of its surfaces' **bodies**, concatenated in surface order.
- A surface's body is a `render-stream-mesh/1` payload without its first 12 bytes and its meta:
  - 40 bytes of geometry (AABB, uv_scale);
  - the vertex, attribute, skin and index bytes, in that order.

  The four lengths follow from the surface's `primitive`, `format`, `vertex_count` and
  `index_count` by render-stream-4.md's `payload-size` rules. A dynamic surface's `payload_bytes`
  is its body's length. Dropping the GRM1 header and meta saves 186 B a surface on average: about
  20 KB a combat frame in STS2.
- **`u8` may be `null` on a dynamic mesh only in a patch whose resolved entry was already dynamic,
  with the same surface count and the same four shape fields on every surface.** It means "the
  bytes you hold". It is the case of a re-sent entry whose `version` moved for a custom AABB or a
  region update that left the bytes equal. In every other case `u8` is non-null: in a full
  transaction, for an entry new in the table, at the transition from static, and after a shape
  change.

Invariants (each with its own error code):

- **`mesh-dynamic`**:
  - an `ok` mesh's surfaces are all static or all dynamic;
  - `u8` is non-null only on a dynamic `ok` mesh, and non-null wherever the rule above requires;
  - a dynamic `ok` mesh has at least one surface;
  - an `unsupported` or `freed` entry has `u8` null.
- **`mesh-u8-offset`**: over the transaction's `meshes` in entry order, each non-null `u8` is the
  running byte count so far (starting at 0). It grows by the sum of that entry's body lengths, and
  the `mesh_u8` block's `count` equals the final total.
- **Payload codes on bodies**: a body whose length disagrees with its shape is `payload-size`
  (offset reported as the transaction record's).
- **`mesh-version`** is unchanged: every mutating call moves the version, as now.

A dynamic mesh never appears in names(S), so it never takes a resource record, a store file, a
`ServedResources` pin or an HTTP route. Static to dynamic is a patch entry with `hash: null` and a
non-null `u8`. Dynamic to static (only through a new mesh id, see "Capture policy") follows /10's
rules for the new entry.

### Resolution and resolved form

- **Resolution.** Each dynamic surface of the resolved state carries its current body. A non-null
  `u8` replaces all of the mesh's bodies. A null one keeps the previous ones. Removing or freeing
  the entry drops them.
- **The validator** keeps the SHA-256 of each body, 32 B a surface, and none of the bytes. The
  receivers keep the bytes they upload (below).
- **The resolved form** (`render-stream-11-resolved/1`) gives a dynamic surface
  `"hash": null, "body_sha256": <64 hex>` and a static one `"body_sha256": null`. The key is
  resolved-only, so `resolved.json` comparisons see a pose change on a dynamic mesh. The decoded
  form keeps the wire keys verbatim, and `mesh_u8` decodes as `{"u8_bytes","sha256"}`, like every
  `u8` block (render-stream-2.md "Decoded and resolved forms").

### Capture policy

- **Classification** (`GRC_MESH_DYNAMIC`, default `auto` at /11; declared in
  `resources.mesh_dynamic`):
  - Under `auto`, a mesh becomes dynamic at its **second content change within
    `GRC_MESH_DYNAMIC_FRAMES` host frames** (default 4: P3-LV's K). A content change is a hook
    call that changes the mesh's surface bytes.
  - It **stays dynamic until it is freed**. An unchanged dynamic mesh costs nothing. Demoting it
    would buy only HTTP caching and dedupe across mesh ids, at the price of a transition state.
    In `a8-2` all 106 dynamic meshes animate until the session ends.
  - A mesh whose bodies total more than `GRC_MESH_DYNAMIC_MAX_BYTES` (default 65,536) stays
    static. Its out-of-band GET stays cacheable, and the transaction stays far below
    `GRC_LIVE_MAX_MESSAGE_BYTES`. STS2's largest surface is 2,284 B.
  - The flag lives in the mirror, which every connection's snapshot shares. Connections never
    disagree on it.
- **Change detection.** The mirror keeps a content serial per dynamic mesh. A region update or
  surface add bumps it when the new bytes differ from the shadow copy (a memcmp of at most a few
  KB). A connection sends a dynamic mesh's bodies (`u8` non-null) when:
  - its serial at the target differs from the serial at the connection's base;
  - or the rule above requires them (full, new entry, transition, shape change).

  That is a function of (B, T) again. Dynamic surfaces skip SHA-256 entirely. The capture's
  biggest per-pose cost (P3-CAP) is gone for them.
- **Host sabotage** `perturb-vertex` (render-stream-4.md) also perturbs dynamic bodies.
  `stale-dynamic` (new) leaves `u8` null for one changed mesh from `GRC_SABOTAGE_FRAME` on.
- **File sinks.** Dynamic bodies are in the recording's transactions, so no store file is written
  per pose. That is 351,984 of `a8-2`'s 352,744 store files.

## Multimesh (PM1)

As particles-multimesh-design.md "/11: multimesh":

- the `multimeshes` table (and `removed_multimeshes` on a patch), immediately after the material
  table's keys and before `shader_time`;
- the `add_multimesh` command (`{"op":"add_multimesh","multimesh":<id>,"tex":<id>|null}`, no
  floats, so no `f`, like `add_clip_ignore`);
- the `mm_f32` block.

With one change to align it with dynamic meshes: `buffer_f` follows `u8`'s rule exactly.

- It is non-null in a full transaction, for a new entry, and after a change of `instances`,
  `format`, `colors` or `custom`.
- Otherwise it is non-null exactly when the mirror's buffer serial moved between the connection's
  base and its target.
- `mm-offset` is `mesh-u8-offset`'s rule over `mm_f32` floats, with stride 8 + 4·colors +
  4·custom.

A multimesh buffer is state, one per entry, so T1 already covers it. The headless pre-draw pump
and the particles RID shim stay **opt-in** (`GRC_PREDRAW_PUMP=1`, particles-multimesh-design.md
"Headless shims"). Without the pump a headless host never calls `multimesh_set_buffer`, and its
multimeshes publish their adopted or creation buffer only. That is typed in the hook census, not
silently wrong. GPU particles stay `/12`.

## Transaction blocks

Nine, in this order: `item_f32`, `canvas_f32`, `cmd_f32`, `cmd_i32`, `mesh_f32`, `param_f64`,
`backbuffer_f32`, **`mesh_u8`** (type `u8`), **`mm_f32`** (type `f32`). At /11 a `u8` block is legal
in a transaction only as `mesh_u8`; anywhere else it is still `meta-schema`. Every /11 transaction
carries all nine, empty when unused, which costs 8 bytes of framing plus their descriptors in the
meta.

## Interactions

- **Late join.** A new connection starts with C = ∅. Its first transaction is full, so it carries
  every inline(T) record, every dynamic body (`u8` non-null) and every multimesh buffer. In `a8-2`
  combat a joiner gets 175 records (222 KB) and 39.9 KB of bodies, against 281 records (300 KB) at
  /10. In `late-1` it gets 25 records (23 KB) against 131 (102 KB). Adoption (`GRC_ADOPT=arm`)
  needs nothing new: an adopted mesh is static until it changes twice within K frames.
- **Resync.** The host's next transaction is full and its records are inline(T_full) \ inline(B),
  where B is the previous transaction in the stream, applied or not. The receiver's C equals the
  host's (L1), so the records it needs are there. The full carries every dynamic body. GSW's
  `live_rebuild` walks the whole state: its inline payloads are in C and its out-of-band ones are
  fetched as today.
- **Credit window 2 (folding).** Every transaction is accepted, so C and each dynamic body follow
  the stream. A fold applies the newest state once. Its dynamic bodies are the newest accepted
  ones, so a body a later folded transaction replaced is never uploaded. A record that arrived
  for a transaction not yet accepted is in R ⊆ C ⊆ H, so it is never dropped (the window the P3-SP
  storm lived in). D7's pins over in-flight transactions are unchanged.
- **Multiple viewers (P3-SP's shared encodes).** A connection's message batch for a target T is
  determined by (B, T, version): the records inline(T) \ inline(B), plus the transaction with its
  `mesh_u8` and `mm_f32` content. So P3-SP's re-stamp sharing extends from the transaction to the
  whole batch. The per-hash encode cache stays. Lockstep viewers share everything, and diverged
  viewers share whatever (B, T) pairs coincide.
  A /10 and a /11 viewer on one host share snapshots but never encodes: the share key holds the
  version, as it does now. /6–/10 connections keep `rs_carried.h`.
- **Stale-coalesce repeat** (window ≥ 2, G7q): a repeated target gives records
  inline(T) \ inline(T) = ∅ and only null `u8`s. Nothing changes.
- **Reconnect** opens a new stream, so C = ∅ and the full transaction carries everything, as at
  /2–/10.
- **File recordings and replay.** A file sink's stream is one stream, so the same rules apply. An
  `inline` file re-carries a returning hash. A `directory` store keeps writing each hash once.
  The store is a file, not receiver memory, and replays read it through the retention rule like a
  live receiver.

## Validators: rule changes

| code | where | /11 change |
| ---- | ----- | ---------- |
| `resource-duplicate` | rs-core `validate.rs` `accept_resource`, `render-stream-2.ts`, C++ test reader | "h ∈ C", not "ever carried" |
| `resource-missing` | `check_resources` | unchanged text, over the pruned C |
| `resource-unnamed` | new | a record's hash is not named by the next transaction's state, or a record precedes the end record |
| prune | after every accepted transaction | C ← C ∩ names(S): one reference count per named hash, updated from the delta (each changed or removed entry's old hashes), so a transaction costs O(its delta), not O(state) |
| `mesh-dynamic`, `mesh-u8-offset` | new | "Dynamic mesh surfaces" |
| `payload-size` | body checks | also on `mesh_u8` bodies |
| `multimesh-entry`, `multimesh-ref`, `multimesh-version`, `mm-offset` | new (PM1) | particles-multimesh-design.md |
| `mesh-dynamic-policy` | session | "Session record" |
| `bad-magic` | framing | `GRSB` only |
| `content-version-stable` | new (WB) | a patch entry carries `commands` equal to the base's (JSON and floats, by bit pattern) under a moved `content_version` |
| `unsupported` | transaction schema (WB) | `null` legal in a patch only; it resolves to the base's list |

Below /11 every rule is /10's, byte for byte. The TypeScript checkers change with it:

- gate 6's `checkCarriedGrowthBounded` (G6s, a 200-a-minute growth ceiling) becomes, on /11 legs,
  `carried-bounded`: C never exceeds |names(S)| + |R|. Its growth half no longer applies.
- `residency-bounded`'s host and receiver bounds follow T1 and T2.

## Live transport

`render-stream.11` is /10's live transport with /11's session, tables and blocks. The hello is
/10's under `protocol` `"render-stream/11"`. Nothing new is negotiated: supporting /11 implies
dynamic meshes, pruning and multimeshes. A /10 hello on a /11 connection, or the reverse, is
`error` `protocol`, close 1002. A dynamic body counts against the message's size like any other
byte (`message-too-large`, close 1009). In combat a transaction is about 210 KB, against
the receivers' default `inbound_buffer_bytes` of 16 MiB.

## Opt-in and version policy

| variable | values | effect |
| -------- | ------ | ------ |
| `GRC_STREAM_VERSION` | `6` (default), `8`, `9`, `10`, `11` | `11` makes file sinks /11, puts `.11` first in the listener's offer and installs the multimesh hooks |
| `GRC_MESH_DYNAMIC` | `auto` (default at /11), `off`, `all` | classification. `off` gives the prune rule alone. Ignored below /11 |
| `GRC_MESH_DYNAMIC_FRAMES` | 1–60, default 4 | K |
| `GRC_MESH_DYNAMIC_MAX_BYTES` | default 65,536 | the largest mesh that may be dynamic |
| `GRC_PREDRAW_PUMP` | `0` (default), `1` | headless only: emit `frame_pre_draw` before the snapshot (PM1) |
| `RS_RECEIVER_PROTOCOL` | `…`, `11` | the native receiver and GSW offer `render-stream.11` |
| `GRC_LIVE_CODING` | `zstd-base` (default), `zstd`, `off` | W11t: the live coding a /11 hello that offers `live_coding` gets ("As built (W11t)"). Nothing below /11, no file sink and no HTTP body is coded |

- **Defaults do not move.**
  - File sinks stay /6.
  - The listener offers `.11` only under `GRC_STREAM_VERSION=11`, then `.10`, `.9`, `.8`, `.7`,
    `.6` (under a gate 8 policy `.11`, `.10`, `.9`, `.8`).
  - No receiver offers `.11` unless asked.
  - Every /2–/10 session is byte-identical to what it was. `golden-2/` to `golden-10/` pass
    unchanged, and `rs_live_window_test`'s window-1 transcripts stay pinned.
- **Conditional hooks.** The multimesh slots follow CG1's rule (gate8-design.md "Calibration for
  /10 (CG1)"): installed only under `GRC_STREAM_VERSION=11`, and otherwise neither planned nor
  omitted. An older calibration record omits them and keeps the methods unobserved. The
  calibrator version does not move.
- **The product hand-off** (gate8-product-handoff.md) names /11 for a long-session seat only after
  W11z passes. Until then it keeps its current version.
- /11 is unreleased until W11z, so increments may still extend it (PM1 adds its states to
  `golden-11/`, as P3-TM extended /10).

## Receivers

**rs-core (shared by GSW, `rs-core-capi`, the CLIs).**

- The validator prunes C after each transaction (reference counts from the delta) and keeps one
  body digest per dynamic surface.
- `Accepted::Transaction` exposes the hashes that left H, so every store drops them on the spot.
- The applier keys mesh geometry by mesh id for dynamic meshes, replaced in place on a non-null
  `u8`. Its `meshes.resident_hashes()` no longer collects one entry per pose.

**GSW** (`gsw-rs`, `live.ts`).

- `PayloadStore` applies the retention rule after every accept, not only after an apply:
  - a hash leaving H is removed at once;
  - G7k's budget eviction keeps its LRU inside H.
- The applier uploads a dynamic body straight from the transaction to the mesh's GL buffers
  (`bufferSubData` when the shape is unchanged). No store entry and no hash verification.
- `inline-fetch-zero`: the fetcher refuses to GET a hash whose entry is inline-sized, and logs it
  as a receiver failure. A /11 stream never needs such a GET.

**Native receiver and web export** (`rs-core-capi` planner, `receiver.gd`, `RsResourceCache`).

- The capi's own maps follow the validator's prune.
- `RsResourceCache` drops an entry when capi reports its hash left H.
- A dynamic body becomes `mesh_surface_update_vertex_region` and
  `mesh_surface_update_attribute_region` when the surface's shape and index bytes are unchanged.
  Otherwise it becomes `mesh_clear` plus `mesh_add_surface`, as a hashed surface does today.
- That leaves one WebSocket message per transaction in combat instead of about 103 (P3-LV's
  bottleneck 3). The web export does the same through the same capi, with no JavaScriptBridge
  fetch for dynamic meshes.
- Multimesh (PM2): re-issue the `multimesh_*` calls and `canvas_item_add_multimesh`
  (particles-multimesh-design.md "Receivers").

## Golden vectors (`golden-11/`, W11a)

`make_golden.py` (stdlib, deterministic, `--check`) loads golden-10's generator and re-binds what
changes. States 11 to 16 follow golden-10's ten:

As built, the six states differ in detail from this list ("As built (W11a): decisions", 1).

- **11.** A second mesh changes twice: under `mesh_dynamic.mode` `auto` with `frames` 4, it
  becomes dynamic (patch: `hash: null`, `u8` non-null).
- **12.** The dynamic mesh's custom AABB changes with equal bytes (`u8` null). A texture hash
  leaves the state.
- **13.** The texture hash returns. `inline.rs11` re-carries it with a new record. The same bytes
  at /10 are the invalid vector `resource-duplicate-v10`.
- **14.** The dynamic mesh's shape changes (`u8` required).
- **15.** The dynamic mesh is freed.
- **16.** Unchanged, re-sent in full as after a resync, with every dynamic body and every record
  that inline(T) \ inline(B) implies (none).

PM1 then adds the multimesh states. Invalid vectors, each by its code:

- `resource-duplicate` (a re-send while still in C);
- `resource-missing` (the returning hash without a record);
- `resource-unnamed` (a record its next transaction does not name);
- `mesh-dynamic` (mixed surfaces; `u8` null on a full; `u8` on a static mesh);
- `mesh-u8-offset` and `mesh-u8-offset-short`;
- `payload-size` (a body one byte short);
- `meta-schema` (a `u8` block in the `mm_f32` slot);
- `bad-magic` (golden-10's `full.rs10` given to a /11 decoder);
- `mesh-dynamic-policy`.

Checks:

- `self-test-rs2.ts` `runSuite(golden-11, 11)`;
- `capture/test/rs11_codec_test.cpp`: the C++ encoder and `make_patch` match every `.rs11` byte
  for byte, and the records come from (B, T) alone;
- `rs-core-check goldens` and `cargo test`.

### As built (W11a): decisions

W11a built `golden-11/` and the codecs. Where the sketch above left a choice open, or got a
detail wrong, these rules are now the wire. They are frozen with /11.

1. **The six states** (`golden-11/make_golden.py`'s docstring). Mesh 1, static since state 4,
   is the one that turns dynamic at 11: a patch entry with `hash: null` and a non-null `u8`, while
   its old hash leaves the state. Mesh 2 is new at 11, dynamic, with two surfaces, so its bodies
   follow mesh 1's in `mesh_u8` and the offset rule runs over two entries. Texture 5's hash F
   leaves at 12 (the texture is updated to another image) and returns at 13. Mesh 2's bytes change
   at 13 with the same shape. Mesh 1's shape changes at 14. Mesh 2 is freed at 15. `unsupported`
   changes at 14 (item 15 draws the unsupported texture 3) and back at 15, so `patch.rs11` has a
   null list in every patch except 14 and 15. `patch.rs11`'s fulls are seqs 1, 5 and 16.
2. **Record order.** The records before a target T are inline(T) \ inline(B) in **table order**:
   textures by id (each texture's `hash`, then its variants in list order), then meshes by id
   (static surfaces in order), then shaders by id, at each hash's first occurrence. That is a
   function of (B, T), so shared encodes share it. golden-10 used a hand order. Index entries in
   `inline_resources` carry `before_seq`, because a hash may now be carried more than once. The
   golden's inline stream carries texture variants inline, which the format allows. The capture
   never does (texture-delivery D12(c)), so its inline(S) has no variants: the C++ planner's
   `InlinePolicy::inline_variants` is off by default and on only for the golden.
3. **Multimesh before PM1.** Every /11 transaction carries the ninth block `mm_f32`. Until PM1
   adds the `multimeshes` table, it must be empty: a float in it is `mm-offset`, the code PM1's
   rule uses ("no entry claims it"). `features` stays /10's (no `"multimesh"`, no
   `add_multimesh`) until PM1 plans the hooks, because features declare what the capture does.
4. **Check order inside a transaction.** Per mesh entry, `mesh-dynamic` first, then
   `mesh-u8-offset` over the entries, then `payload-size` on each body. Each invalid vector fails
   one rule only (`mesh-dynamic-full-null` also drops the body from `mesh_u8`).
5. **Resolved and decoded forms.** A resolved surface's keys are `hash`, `body_sha256`,
   `payload_bytes`, `primitive`, `format`, `vertex_count`, `index_count`. A resolved mesh has no
   `u8`, which is a per-transaction offset, not state. The decoded form keeps `u8`, the null
   `hash` and a null `unsupported` verbatim.
6. **`resource-unnamed`** covers every record accepted since the previous transaction, checked
   at the next transaction (against names(S)) or at the end record. A stream truncated without an
   end record is not flagged.
7. **`content-version-stable`** compares a patch entry's commands with the base item's resolved
   commands: the JSON values, and the floats by float32 bit pattern. A full transaction is exempt:
   it has no base.
8. **`mesh-dynamic-policy`** covers the `mesh_dynamic` object's key set and values. A
   `resources` object without the key is `meta-schema`, like any missing key.
9. **`inline-fetch-zero`'s predicate** belongs to the validator, so that every receiver asks the
   same question: a GET of hash h is refused with `inline-fetch-zero` when h is a non-variant name
   of the newest accepted state, or is in C, with `payload_bytes ≤ inline_max_bytes`. Variants are
   never required inline (render-stream-9.md), so a variant may be fetched, unless it is in C
   (it arrived inline, so a GET for it is a receiver bug). W11a ships the
   predicate (rs-core `Validator::check_fetch`, TypeScript `checkInlineFetch`), and W11c and W11d
   call it from their fetchers.
10. **Sabotages.**
    - `keep-carried` is a C++ codec flag. The encoder keeps /10's lifelong carried set at /11, so
      F's record before seq 13 is never written. Its output is exactly
      `invalid/resource-missing.rs11`, which every validator rejects at seq 13.
    - `early-prune` is a validator flag (rs-core and TypeScript). It prunes C to the base state's
      names when a transaction arrives, before resolving and checking it. That drops the records
      the transaction brings, so `inline.rs11` fails `resource-missing` at the first transaction
      with records (seq 1). The sketch's "on state 12" assumed a prune against S itself, which can
      never fail, because required(S) ⊆ names(S).
11. **`resource-duplicate-v10`** is a /10 file in golden-11's `invalid/`. Every invalid entry in
    `index.json` carries its `version`, so runners decode each at its own version.
12. **rs-core-capi** accepts /11 (`VERSIONS` gains 11), so /11 files decode and validate through
    the capi. Its planner draws static meshes as before and leaves dynamic ones undrawn, counting
    them, until W11d adds the region uploads. The live hello still does not offer `.11` (W11d).
13. **The GDScript codec** (`rs_wire.gd`) is not touched. The native receiver decodes in rs-core
    through the capi. Its magic table gains `B` with W11d's offer.

### As built (W11b): decisions

W11b wired the capture ([results/p3/w11b.md](../results/p3/w11b.md)). Where the design left a
choice open, or could not hold as written, these rules are now the capture's. Only the first one
touches what a validator sees; it is a refinement of WB's rule, not a new rule.

1. **A stable `content_version` is a digest of the command list.** At /11 every item's
   `content_version` is the first 53 bits of the SHA-256 of its commands as a transaction encodes
   them (the JSON array, then their `cmd_f32` and `cmd_i32` floats and indices from offset 0; 0 is
   never used). The sketch restored "the published" version when a re-record matched the last
   snapshot. That fails `content-version-stable` whenever a connection's base is older than the
   previous snapshot: a list that goes X, Y, X between B and T gets a third version over X's
   commands. Bases are older at window 1 under phase lock, at window 2, after a stall and at every
   resync, so the rule must hold for any (B, T). A digest makes equal lists carry equal versions
   whatever lies between them and needs no history. It is recomputed only for an item whose
   commands were recorded since the last snapshot (one encode and one hash each; STS2 re-records
   about 170 items a combat frame). Two different lists of one item colliding is a 2^-53 event; it
   would show as stale commands, never as a validator error. The digest applies to every
   connection of a /11 host, a /10 one included: at /10 equal versions over equal lists are what
   /1 always meant.
2. **Classification.** A content change is a hook call that changes a mesh's surface bytes: a
   region update whose re-encoded payload hashes differently (the hook's own SHA-256, so no shadow
   memcmp is kept), a surface added or removed, a clear of a mesh with surfaces. Changes count per
   host frame, never in the frame the mesh was built in (create plus its first surfaces). Under
   `auto` the mesh is promoted at its second change frame f2 with f2 − f1 ≤ `frames`; under `all`
   at its first snapshot with content. Promotion is decided at the snapshot, so a clear and a
   re-add in one frame see the final shape, and needs an `ok` mesh with at least one surface whose
   bodies total at most `max_bytes` (checked at promotion only). It is never demoted. A dynamic
   mesh that is empty at a snapshot is encoded like a static one (it has no surface to carry) and is
   dynamic again once refilled. The serial moves at every byte change.
3. **The hook still hashes dynamic surfaces.** The design's "dynamic surfaces skip SHA-256" is
   deferred: the hook log (the `dyn-wire` evidence), change detection (rule 2) and a /10 viewer
   of a /11 host all read the GRM1 hash, so the snapshot keeps each dynamic surface's GRM1 payload
   and hash beside its body. Skipping the hash when no evidence log and no older viewer exist is a
   host-cost follow-up (P3-CAP's area).
4. **`payload_bytes` of a dynamic surface** is written by the /11 encoder from the body's length;
   the snapshot keeps the GRM1 length for /10 connections.
5. **Records.** File sinks and live connections send `records_before(B, T)` with B the stream's
   previous transaction: the previous published snapshot for a file sink, the last snapshot sent
   for a live connection, a resync included. The live hub memoizes each (B, T) pair's record list,
   and each record's encode by hash, per frame callback, so lockstep viewers share records as they
   share the transaction; a /11 connection takes no `CarriedIndex` slot, and its summary's
   `carried_size` is |inline(T)|. `rs_captured.h` `payload_refs(state, skip_dynamic)` leaves
   dynamic surfaces out of /11 stores and records.
6. **Conditional hooks.** /11 installs /10's three conditional hooks (`canvas_item_set_copy_to_backbuffer`,
   `canvas_item_set_canvas_group_mode` and P3-CK's `draw`). `GRC_MESH_DYNAMIC*` are parsed only
   at /11 (an invalid value refuses the stream there) and ignored below it.

#### Sabotage kinds (W11b)

Three capture sabotages are legal only in a /11 session (`session.sabotage.kind`; the TypeScript
validator and rs-core refuse them below /11 like the /8-only kinds), and need
`GRC_STREAM_VERSION=11`:

| kind | behaviour | caught by |
| ---- | --------- | --------- |
| `cv-churn` | the mirror's own counter as `content_version` (every re-record moves it, /10's rule) | `content-version-stable` |
| `stale-dynamic` | the first dynamic mesh that changes at or after the frame keeps its serial, so its patches leave `u8` null over new bytes | `dyn-wire` |
| `keep-carried` | file sinks and live connections keep /10's lifelong carried set | `resource-missing` (at the first return) |

`fixtures/capture-scale` redraws nothing by default, so its `cv-churn` leg runs with
`RS_SCALE_REDRAWS=150` (identical re-records, STS2's shape); the design's claim that the default
fixture shows it did not hold.

### As built (W11c): decisions

W11c makes GSW apply /11 ([results/p3/w11c.md](../results/p3/w11c.md)). Nothing here changes the
wire; these rules are rs-core's receiver API, which W11d (`rs-core-capi`, the native receiver) and
W11e (the web export) call too.

1. **Dynamic geometry by mesh id.** `PayloadStore::dynamic` (`apply::dynamic::DynamicMeshes`) holds
   one decoded body per dynamic surface, keyed by mesh id and surface index. An adapter calls
   `PayloadStore::accept_transaction(&validator, record)` right after every `accept` that returned
   `Accepted::Transaction`, with the record `accept` was given: a live message buffer is reused by
   the next message, so the bodies are decoded then, not at the apply. Each body named by
   `Validator::dynamic_bodies()` replaces its surface's geometry in place; then every mesh the new
   state does not hold as dynamic (freed, gone, emptied) is dropped. A credit-window-2 fold needs
   nothing more: a later null `u8` keeps the earlier body. No hash is computed or checked on the
   receiver side (the validator already digests each body for `body_sha256`), and these bodies are
   not store entries: `len()`, `total_bytes()` and the G7k budget never count them.
2. **Mesh residency rows** (`apply::meshes`). A dynamic mesh is `create`d when it first becomes
   resident, `rebuild`t when a surface's shape (primitive, format, counts, buffer sizes) or its
   index bytes change, and otherwise gets one `update` row per surface whose body moved, listing
   the region buffers (vertex, attribute, skin when present): W11d's region-upload rule. A static
   mesh that turns dynamic is freed and created again. GSW keeps no per-mesh GL buffers (G7t lowers
   meshes into the list's shared vertex buffer), so the design's `bufferSubData` is the item's
   in-place re-lower; the native receiver's region uploads are W11d's.
3. **Retention** (`apply::retention::Retention`). `note(&validator)` after every accepted
   transaction queues `Validator::released()`; `sweep(&validator, &mut store, displayed)` after
   every accept and after every apply drops each queued hash that is back in names(S_n) or C (kept)
   or that the display does not draw from (`displayed()`, GSW: `Applier::referenced_payload_hashes`).
   A hash the display still holds waits for the sweep after the apply that moves it. Below /11
   `released()` is empty, so /2-/10 stores behave as before.
4. **`inline-fetch-zero`.** GSW's live and file fetchers call `Validator::check_fetch` (wasm
   `check_fetch(hash)`) before every GET at /11; a refusal fails the replay with that reason.
5. **`content_version`** is compared for equality only (the applier's re-lower test), so a digest
   needs no receiver change. `unsupported: null` and the empty `mm_f32` are resolved by the
   validator.
6. **Evidence.** At /11 only: `residency_json()` adds the dynamic bodies held, |names(S)|, |C| and
   the rule's drops; `evidence_json()` adds `w11` (the store's most entries and most beyond
   |names| + |C|, bodies, `dynamic_mismatched`); a full log's applied.json transactions carry
   `dynamic_sha256` (per mesh id and surface, the held body's SHA-256). G7kh's summary-log rule now
   holds in wasm too: `RS_RECEIVER_LOG=summary` keeps no per-transaction evidence there, only the
   dispose counters, so a long live run's heap is bounded by the state.
7. **The fast meta path** reads /8+ created mesh entries (`adopted_content: null`), /11's `u8` and
   null surface hashes, and integers of up to 16 digits that an f64 holds exactly (≤ 2^53): /11's
   53-bit `content_version` digests sent every STS2 item to the general path. On STS2's /11
   recording every one of 4,932 transactions now takes it, equal to the general path.
8. **Receiver sabotages** (GSW options; `no-prune` is `Validator::set_no_prune`):
   `stale-dynamic-rx` (a body is ignored when its surface's shape holds), `no-prune` (C kept
   lifelong: `resource-duplicate` at the first return), `evict-carried` (a carried record dropped
   on arrival: the next GET is `inline-fetch-zero`) and `ignore-released` (the store keeps what
   left H: `store-bounded`).
9. **Live.** `RS_RECEIVER_PROTOCOL=11` offers `render-stream.11` with /10's hello under
   `render-stream/11` and accepts only a /11 session. Windows 1 and 2 both run.
10. **Live coding (W11t).** At /11 GSW's hello ends with `"live_coding": "zstd-base,zstd"`
    (`RS_RECEIVER_LIVE_CODING=zstd|off` narrows or drops the offer). One `LiveCoding` per
    connection decodes each message in place (`decode_rx`) before `live_session`/`live_accept`; a
    skipped message (0) is neither applied nor acked; on -1 with a non-zero seq GSW sends
    `resync` with reason `coding` and the full transaction that ends it is applied by a fresh
    applier (`live_rebuild`); with seq 0 the stream fails. The live block reports each
    connection's coding stats (`live.coding`).

## Predicted cost (STS2, from the kept recordings)

One viewer that takes every transaction, `GRC_RESOURCE_INLINE_MAX_BYTES=4096`. Method and both
recordings are in results/p3/w11-d.md. `a8-2`, combat (3,315 transactions):

| | /10 | /11, prune only (`off`) | /11 (`auto`) |
| - | -: | -: | -: |
| bytes per transaction (records included) | 252,422 | 252,558 | 210,182 (−16.7 %) |
| WebSocket messages per transaction | 103.3 | 103.5 | 1.06 |
| new receiver store entries per transaction | 102.3 | 0 (bounded) | 0 (bounded) |
| receiver store entries, maximum | 352,744 at the end, growing | 884 | 876 |
| inline re-sends per transaction | — | 0.19 | 0.000 |
| GSW heap growth at 49.6 applies/s | 6.6 MB/s (P3-SP measured 6.7) | ~0 | ~0 |

On the menu, prune-only re-sends 5.9 records a transaction: the looping menu animations' poses
recur, and the bytes rise by 6 %. With `auto` those meshes are dynamic, and /11 is 8.8 % below /10.
The map is unchanged within 0.4 %. Multimesh adds P3-PM's 2,944 B a combat frame (+1.4 %), which
the recordings cannot show (the hooks did not exist).

## Warm wire budget (WB)

WB ([results/p3/wb.md](../results/p3/wb.md), `scripts/lib/wire-budget.py`) measured where a warm
transaction's bytes go in both STS2 recordings, and what each candidate coding saves. Warm combat
(`a8-2`, per transaction, at 60 fps):

| | bytes | Mbps |
| - | -: | -: |
| /10 transaction record | 176,480 | 84.7 |
| /11 as designed above | 210,343 | 101.0 |
| of which item state JSON / command JSON / command floats / `item_f32` | 63,736 / 32,821 / 24,406 / 12,499 | |
| of which mesh bodies / mesh entries / `unsupported` | 39,012 / 32,678 / 9,512 | |

Every byte is draw-state churn. **163 of the 174 items in a combat patch carry nothing new**: STS2
redraws them every frame, and each `canvas_item_clear` and add moves `content_version`. Their
header, floats and commands all equal the base's, and they make up 120,878 B. On the menu, all 38
patched items are like this (19,478 B).

### Decisions

Each measured win and where it belongs:

| change | saving (combat, measured) | where |
| ------ | ------------------------- | ----- |
| **stable `content_version`** (below) | −120,878 B raw (−57 %); about 70 % of the meta the receivers parse | **/11** (W11a invariant, W11b capture) |
| **patched `unsupported`** (below) | −9,512 B raw (−4.9 KB of the map's 17.6 KB) | **/11** (W11a) |
| **zstd-3 with the base message as prefix** (transport, below) | 210,343 → 12,682 B; lean 79,968 → 12,471 (6.0 Mbps) | **/11's live transport option, on by default** (W11t) |
| zstd per message, no context | → 36,859 B (17.7 Mbps) | the fallback when the base is unknown (a full transaction) |
| zstd streaming (one context a connection) | → 12,751 B, equal to base-prefix | not worth it: per connection, so it breaks P3-SP's shared encodes |
| zstd with a trained dictionary | → 16,598 B (8.0 Mbps) | not worth it: worse than base-prefix, and the dictionary must be distributed |
| permessage-deflate (context takeover) | → 40,340 B (19.4 Mbps): the 32 KB window cannot reach the previous frame | not the default: Godot's `WebSocketPeer` has no extension support, so it is browser-only |
| zstd-9 instead of 3 | −1 to −6 %, 5x the host time (2.2 ms) | not worth it |
| delta-coded transforms and item floats by item id (XOR, then compress) | 12.5 KB + 24.5 KB of floats → 0.26 KB. Base-prefix zstd already gets them to the same size | **not worth it**: no wire change for item or command floats |
| XOR-delta mesh bodies against the base's body of the same mesh | lean base-prefix 12,471 → 10,322 B (−1 Mbps) | **final binary-structure swap**, with the quantized tier |
| quantized mesh bodies: AABB-relative u16 positions, u16 UVs | with XOR: → 5,586 B (2.7 Mbps); max error 0.05 px | **final binary-structure swap** |
| quantized item and command floats (fixed-point positions, u8 colours) | 25 KB raw, < 0.3 KB once compressed | final swap at most; transform linear parts and overbright colours stay f32 |
| binary structure instead of canonical JSON | 42 KB of key names raw, ~0 once compressed; meta is 43 % of the GSW core's time | **final binary-structure swap** (deferred until after /11 and /12, as agreed) |

### Stable `content_version` (/11)

- **Capture (W11b).** As built, the version is a digest of the command list, so this holds for
  any base ("As built (W11b): decisions", 1). The sketch: at /11 the mirror keeps an item's
  published command list (its commands and
  their floats). When a frame's re-recorded list is byte-identical to the published one, the
  snapshot restores the published `content_version`. The item then leaves the patch unless its
  state or floats moved.
  - The comparison is one memcmp of the item's command buffer, done when the item was cleared
    this frame.
  - Below /11 the counter moves as today, so /2–/10 stay byte-identical.
- **Wire rule.** At /11, `content_version` in T differs from B's only if T's command list differs
  from B's. When it differs, `commands` is non-null, as at /1.
- **Validator (W11a).** `content-version-stable` rejects a patch entry whose non-null `commands`
  equal the base's resolved commands, by JSON value and by float bit pattern, under a moved
  `content_version`. The validator already holds the base's commands, so the check costs one
  comparison per re-sent list.
- **Sabotage.** `cv-churn` (capture: bump the counter on every re-record, today's behaviour) fails
  `content-version-stable` on `fixtures/capture-scale` and on `gate6-scene` `animate`.
- **Predicted:**
  - combat 210,343 → 89,465 B raw, and to 79,968 B with the next rule;
  - menu 41,844 → 17,374 B;
  - parse: about 0.3 of the GSW core's 0.45 ms of `meta` per combat transaction (the rules remove
    about 95 KB of the 132 KB meta: the redundant items' JSON and `unsupported`).

### Patched `unsupported` (/11)

- In a patch, `unsupported` is `null` when the list equals the base's. Otherwise it is the complete
  list, as at /1.
- A full transaction always carries the list. The resolved state always holds one.
- The decoded form keeps `null`, and the resolved form holds the list.
- Saves 9,512 B a combat transaction and 4,940 B a map transaction (28 % of the map's message).

### Transport: base-prefix zstd (W11t, a live option, not record semantics)

- **Coding.**
  - A /11 live message for target T with base B is one zstd frame (level 3, content size
    present).
  - Its dictionary is the raw bytes of B's uncompressed transaction message, as a prefix.
  - A full transaction, and every resource record, is coded with no prefix.
  - The coded message is a function of (B, T), so P3-SP's shared encodes still share it: lockstep
    viewers share the compressed bytes.
- **Receiver.** It keeps the uncompressed message of every transaction that may still be a base.
  - At window 1 that is the last accepted one. At window 2, the in-flight ones too, until the
    host's base moves past them.
  - That is at most 2–3 combat messages (≤ 0.7 MB).
  - A message whose prefix is missing is `error` `coding`, which resyncs.
- **Negotiation.** The receiver offers it and the host accepts it. Default: on whenever both ends
  support it (`GRC_LIVE_CODING=zstd-base|zstd|off`, default `zstd-base`). Per-message zstd is the
  fallback for a receiver that keeps no bases.
- **Cost** (desktop, combat):
  - compression 0.49 ms per distinct (B, T);
  - decompression 0.16 ms natively.
  - The capture already vendors zstd 1.5.7 (G8kz).
- **Dependency.** The receivers decode in rs-core, which has no zstd decoder. The local Cargo
  registry holds `flate2` and `miniz_oxide`, not zstd. Two options:
  - compile the capture's vendored zstd C decoder into `rs-core-capi` and `rs-gsw-wasm`;
  - add a pure-Rust zstd crate, which is a download and needs the user's sign-off.

  W11t decides. The HTTP payload coding (G8kz) is unchanged. **Decided (W11t):** the pure-Rust
  `ruzstd` crate, approved by the user ("As built (W11t)", 1).

### As built (W11t): decisions

W11t built the transport ([results/p3/w11t.md](../results/p3/w11t.md)). Measured on W11b's STS2
recording through the capture's own encoder: warm combat **12,506 B a frame (6.0 Mbps)**, the map
321 B and the menu 1,111 B, records included. These rules are now the coding's:

1. **The decoder is `ruzstd` 0.9.1** (pure Rust, MIT; exact pin, `default-features = false`,
   `std` only: no dependency at all), in rs-core's `coding` module, so `rs-core-capi`,
   `rs-gsw-wasm` and the web export's core share it and wasm32 needs no C toolchain. ruzstd has no
   public raw-content dictionary, so a base is a 117-byte formatted template dictionary (entropy
   tables from zstd 1.5.7's trainer, repeat offsets 1, 4, 8, no content) with `dict_content` set to
   the base, forced onto the frame (`force_dict`). That is what `refPrefix` is to a decoder: a
   `refPrefix` frame starts with no entropy repeat state, so the template's tables are never read.
2. **Every binary message of a coded connection is coded, the first included.** There is no
   acceptance field: the record stream is unchanged, so nothing in the session says it is coded.
   The receiver learns the host's answer from its first message: zstd (or envelope) magic means
   coded, `GRS` means uncoded. A coded message on an uncoded connection, or the reverse, is
   `coding`. The host's acceptance is in its live log (`live_coding_chosen`) and its summary
   (`live_coding` per /11 connection).
3. **A transaction carries an envelope:** a zstd skippable frame (magic `0x184D2A5B`, 16 bytes of
   content: u64le `seq`, then u64le `base_seq`, 0 for none), then one zstd frame. Records, the
   session message and the end record are one zstd frame with no envelope. The envelope lets the
   receiver pick the prefix before it decodes, and name the seq to resync when it cannot. A coded
   message is still a valid zstd stream: `zstd -d --patch-from=<base>` decodes it.
4. **Every frame has its content size and an XXH64 checksum** (+4 B). A wrong prefix then fails
   at the transport as `coding`, not at the record parser as garbage. rs-core computes the XXH64
   itself (ruzstd's `hash` feature would pull in a second crate). A frame declaring more than the
   receiver's `inbound_buffer_bytes` is `coding` before anything is allocated.
   `message-too-large` stays on the uncoded size.
5. **The base is the last transaction the host formed on the connection**, the dropped one
   included (`drop-message`), so it is always the patch's own `base_seq`. Under `zstd` and for a
   full transaction there is none.
6. **Receiver retention:** after decoding T against B, the decoder drops every base older than B
   and keeps T. That is two messages at any window (measured: 2 at window 1 and 2 on capture-scale
   and STS2, 1.1 MB at most in combat). The cap is three.
7. **`coding` resyncs.** After a missing base, a checksum mismatch or an undecodable frame, the
   decoder skips every based transaction (not decoded, not applied, not acked) until a full one.
   The receiver sends `resync` with the envelope's seq and reason `coding`. A `coding` error on a
   message that is not a transaction (session, record, end) ends the stream.
8. **Negotiation:** a /11 hello may carry `live_coding`, the codings the receiver decodes, in its
   preference order (`^[a-z0-9-]+(,[a-z0-9-]+)*$`, at most 96 characters). It is the only optional
   key of any control message, so a /11 receiver that predates W11t stays valid and uncoded. The
   host chooses: under `zstd-base` it picks `zstd-base` if offered, else `zstd` if offered, else
   none; under `zstd`, `zstd` if offered; under `off`, none. Unknown tokens are ignored. Below /11
   the key is unknown (`protocol`). Golden-11 gains `control/valid/hello-live-coding.json` and
   `control/invalid/hello-live-coding-grammar.json`.
9. **Sharing:** the hub memoizes each coded transaction per frame callback by its uncoded base and
   target messages, seqs included, and each record's coding by hash. Lockstep viewers with equal
   seqs share the compressed bytes (`rs_live_test`). Viewers at different seq offsets do not: the
   base messages differ in their stamps. They cost one encode each, 0.19 ms in combat. The tap
   (`GRC_LIVE_TAP_DIR`) keeps the uncoded messages, so it is still a valid stream.
10. **Receivers.** Each receiver makes one call on every WebSocket message before it parses it:
    GSW's `LiveCoding.decode_rx(g, len)` (rs-gsw-wasm, in place in the receive buffer), or
    `rsc_coding_decode` in `rs-core-capi` (declared in `receiver/ext/rs_core_capi.h`). Its hello
    offers `live_coding: "zstd-base,zstd"`, and it answers -1 with `resync` for `seq` (reason
    `coding`). At W11t's landing no receiver speaks /11 live yet. The calls and the g8w11
    `coding/` legs' Node viewer (`scripts/lib/coding-receiver.ts`, on the wasm `LiveCoding`) are
    what W11c (GSW), W11d (native) and W11e (web export) wire.
11. **Sabotages.** A dropped base is the existing `drop-message`: under `zstd-base` the next patch
    names a base the receiver never got. `coding-wrong-prefix` (a listener sabotage, `GRC_SABOTAGE`
    with `GRC_SABOTAGE_FRAME`, /11 and `zstd-base` only) codes one based transaction against its
    base plus one byte. Every match into the prefix then shifts by one. The host keeps the wrong
    encode only once it has checked that it really decodes differently against the true base. A
    flipped byte that no match reads would not.
12. **Wire vectors.** `golden-11/coding/{full,patch,inline}.coded` are the capture encoder's coding
    of golden-11's recordings (u32le length, then the message, repeated), each transaction against
    the previous one. The capture's ctests pin them byte for byte, and rs-core's tests decode them
    back to the recordings.

### Bottom line

| warm combat | bytes / frame | Mbps |
| ----------- | ------------: | ---: |
| /10 live today (record + inline mesh records) | ~256,300 | 123 |
| /11 as designed above | 210,343 | 101 |
| + stable `content_version` + patched `unsupported` | 79,968 | 38.4 |
| **+ base-prefix zstd-3 (recommended default)** | **12,471** | **6.0** |
| + final swap: XOR-delta + quantized mesh bodies | 5,586 | 2.7 |
| 1080p60 video baseline | 31,000–52,000 | 15–25 |

**/11 with the two WB rules and base-prefix zstd is about 6 Mbps for warm combat**, 2.5–4x under
video. The menu is 0.43 Mbps and the map 0.21. Uncompressed, the lean /11 message is still
38 Mbps, so the transport coding is what meets the video comparison.

What is still missing:

- the zstd decoder in the receivers: **built (W11t)** in rs-core; each receiver still has to call
  it ("As built (W11t)", 10);
- the cold start's texture GETs;
- the phone's decode cost: unmeasured; the projection is about 5 ms of `meta` per combat
  transaction on the g31 before the lean rule;
- the host's capture cost: 7–8 ms a frame against NVENC's 1–3 ms.

The host cost is snapshot and diff (O(table)), not encoding (0.6 ms), so it is P3-CAP's dirty-set
publication, not a wire question.

## Increments

Each lands as one commit with its result doc. Timing legs stay real time and go to the milestone
sweep.

| Id | Scope | Stock-template fixture | Checks | Sabotages |
| -- | ----- | ---------------------- | ------ | --------- |
| **W11a** | codecs, goldens and validators: `ProtocolVersion::V11` in the C++ encoder (`rs2_codec`, `rs2_diff`: records from (B, T), `u8` from serials), `render-stream-2.ts` and `rs-core` (prune by reference count, `resource-unnamed`, `mesh-dynamic`, `mesh-u8-offset`, `body_sha256`; WB's `content-version-stable` and `unsupported: null`), `golden-11/`; `rs-core-capi` pin to /11 | `golden-11/` | the golden checks above. A property test (`cargo test`): over random state sequences with resyncs, folds and window 2, the validator's C equals inline(S) after every transaction (L2), and a hub serving N connections from different bases emits records that each connection's validator accepts (L1). `rs_live_test` gains `test_records_from_base_and_target` | `keep-carried` (codec flag: the encoder keeps /10's lifelong set at /11, so state 13 fails `resource-missing`); `early-prune` (prune before the transaction's checks fails `resource-missing` at the first transaction with records, decision 10) |
| **W11b** | capture: mirror classification and serials, `mesh_u8` from the snapshot, `resources.mesh_dynamic`, `GRC_MESH_DYNAMIC*`, /11 file sinks and listener offer, `rs_carried` bypassed for /11 connections, `stale-dynamic`; WB's stable `content_version` and patched `unsupported` (sabotage `cv-churn`) | `fixtures/capture-scale` (P3-CAP; STS2's combat shape, every pose new); `fixtures/gate6-scene` `animate` (the `MS` mesh recurs every 90 frames); `gate5-mesh` (g5c, g5e) | `dyn-wire`: every body at every transaction, rebuilt into GRM1, hashes to the hook log's surface hash for that frame. `dyn-classify`: dynamic from the second change within K, never demoted. `carried-equals-names`: the host's per-connection records are inline(T) \ inline(B). `resend-on-return` (gate6-scene with `GRC_MESH_DYNAMIC=off`: each return of `MS`'s hash re-carried exactly once). `host-flat`: `bench-live-scale.sh --viewers 4` null, 10 min, host RSS ≤ +0.2 MB/min. Byte identity below /11 (`cmp-rec.ts`, gates 1, 2, 5 against `main`) | `perturb-vertex` fails `dyn-wire`; `stale-dynamic` fails `dyn-wire`; `keep-carried` (host) fails `resend-on-return` with the receiver's `resource-missing` |
| **W11c** | GSW: rs-core retention (H, prune on accept), applier geometry by mesh id, `bufferSubData` uploads, `inline-fetch-zero`; GSW offers `.11` under `RS_RECEIVER_PROTOCOL=11` | `capture-scale` through `bench-live-scale.sh` with a GSW viewer; `gate6-scene` soak (`soak-inline`) at /11; g7-5 and g7-2 groups at /11 | `store-bounded`: 20 min on `capture-scale` with the payload store's entries ≤ \|names\| + window and a wasm-heap slope after warm-up ≤ 1 MB/min (at /10 the same leg grows about 280 MB/min, P3-SP `long-rx-before`). `inline-fetch-zero`. `resend-applied`: gate6-scene `MS` returns pixel-match the reference. `gsw-band` on gate 5 meshes at /11. Apply rate ≥ /10's on the same leg (real time, milestone) | `no-prune` (receiver keeps C lifelong) fails `resend-applied` with a typed `resource-duplicate`; `evict-carried` (drop a hash still in C) fails `inline-fetch-zero`; `stale-dynamic-rx` (ignore a body) fails `gsw-band` |
| **W11d** | native receiver: capi maps prune, `RsResourceCache` drops on leave, dynamic region uploads | `capture-scale` with a native viewer; `gate5-mesh`; `gate6-scene` | `store-bounded` (RSS slope and cache entries); `records-per-tx` ≤ 1 + static churn (≈ 1 on `capture-scale`); `resend-applied`; g5c and g5e `reference` at /11 | `no-prune`, `evict-carried`, `stale-dynamic-rx` as W11c, failing the native checks |
| **W11e** | web export: the same capi on wasm, the web leg of every W11d check | as W11d through the web export (g7-5 and g7-2 web groups at /11) | as W11d, plus `rss-bounded-renderer` (G7kr) on a 20-minute `capture-scale` leg | as W11d |
| **W11t** | the live transport coding: base-prefix zstd ("Transport", "As built (W11t)"), `GRC_LIVE_CODING`, the hello's `live_coding`, rs-core's decoder (`ruzstd`), the capi and wasm calls | `golden-11/coding/`; g8w11's `coding/` legs (capture-scale, live, Node viewers on rs-core's wasm) | `coding-wire` (capture encoder to rs-core, byte-equal, golden-11 and g8w11 captures), `coding-negotiated`, `coding-lossless` (decoded = the host's tap), `coding-validates`, `coding-applies-as-off`, `coding-smaller`; `rs_live_test` (lockstep viewers share the coded bytes) | `drop-message` (a dropped base) and `coding-wrong-prefix`: `coding`, then resync |
| **PM1** (in /11) | particles-multimesh-design.md's PM1, with `buffer_f` on W11a's (B, T) rule; adds multimesh states to `golden-11/` before /11 is released | `fixtures/gate8-mm` (hook-log legs), goldens | `mm-hook-census`, `mm-wire`, `mm-frame-pairing` (particles-multimesh-design.md) | `perturb-instance`, `stale-buffer` |
| PM2, PM3 | receivers (native and web, then GSW), unchanged from particles-multimesh-design.md but on /11 | `gate8-mm` | as there | as there |
| **W11z** | STS2 acceptance | none (game leg) | **one GSW viewer, /11, window 2, inline 4096, in combat for ≥ 20 min** (the combat idles; spine keeps animating): wasm heap slope over minutes 2–20 ≤ 1 MB/min (/10: about 400 MB/min); payload store entries ≤ \|names\| + window; zero inline-sized GETs; applies/s and latency no worse than P3-SP's 49.6/s and 16.5 ms (load-gated); combat dB within 0.1 of P3-CT's replay; host RSS flat; `survivors: none` and hash sets unchanged. A 3-minute /10 leg first, as the "before" slope | none in game (the sabotages live on the fixtures) |

Order: W11a → W11b → W11c → W11d and W11e in parallel → W11z. PM1 follows W11b (both touch the
capture's mirror and encoder) and must land before W11z releases /11. PM2 and PM3 can follow
W11z.

## Not proven by this design

- A **grace window** for returning hashes (pruning to the names of the last N states). The
  recordings do not justify it: with `auto` the only recurring content is spine poses, and they
  stop being hashes. Prune-only on the menu re-sends 2.9 KB a transaction. The rule would cost N
  states of memory, and N = 1 is what /11 specifies.
- **zstd on the WebSocket** (P3-LV) is no longer unproven: WB measured it, and "Warm wire budget
  (WB)" specifies base-prefix zstd as a live transport option beside /11. The transport increment
  itself (W11t) still has to land.
- **Quantized multimesh encodings** and GPU particles (`/12`).
- Whether STS2's product seat runs headless (the pre-draw pump's criterion 5).
- Why the dropped P3-SP bound's LRU order reached the newest entries ("The P3-SP re-fetch storm").

## Versioning

As /10: any change to framing, a key, a key order, a block layout, an enum spelling or a payload
format is a new version.
