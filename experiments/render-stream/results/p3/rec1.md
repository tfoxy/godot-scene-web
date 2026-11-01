# REC1: the client recorder (2026-10-31)

REC1 is the client-recorder row of the opt-in client-extension layer
([protocol/client-extensions-design.md](../../protocol/client-extensions-design.md), the REC1 row of
§6). A live client that opts in records a bounded ring of the decoded messages it received since its
last full transaction, plus the resource payloads it fetched, and exports them as a recording that
replays through `rs-core-check` byte-identically to the host's tap from that full. A client that
never opts in takes the pure-client path unchanged: no ring, no per-message copy, no hello change, no
wire change.

## What changed

**Client package** (`packages/render-stream-client/src/`).

- `recorder.ts` (new): `createRecorder`, the pure ring. `session(bytes)` keeps the decoded session
  (magic + session record); `record(bytes, kind, full, seq)` appends a decoded record in receipt
  order; `resource(hash, body)` keeps a fetched payload by hex SHA-256; `export()` concatenates the
  session and the ring into one `Uint8Array` and returns `{bytes, resources, records, fullSeq,
  overflow}`. `kind` is carried for evidence; nothing in the recorder branches on it.
- `core.ts`: `StreamCore.receive` takes a `copyDecoded` flag and `takeDecoded()` returns the copy.
  `WasmStreamCore.receive` copies the decoded bytes out of wasm only when `copyDecoded` is true
  (after `decode_rx`, so it is the uncoded form); the pure client passes false and copies nothing.
- `loop.ts`: one `recorder` field; `onBinary` asks `receive` for the copy only when a recorder is
  set and feeds it (`session` / `record` for transaction, resource, item_meta and end; `held` and
  `coding-resync` are not records); `stageFetched` hands each 200 body to `resource` before wasm
  takes it.
- `client.ts`: `RenderStreamClientOptions.recorder?` (absent: no recorder) and
  `RenderStreamClient.recording()`. `createRenderStreamClient` builds the recorder from the option
  and passes it to the loop; with no option it builds none.
- `abi.ts`: `rx_ptr()` (the receive buffer's current pointer after a decode grew it), and it joins
  `CLIENT_CORE_METHODS`.
- The export surface adds `createRecorder` and the types `Recording`, `RecordKind`,
  `RecorderOptions`, `RenderStreamRecorder` (`export-surface.test.ts`).

**rs-gsw-wasm** (`experiments/render-stream/web/gsw-rs/src/lib.rs`): `GswRs::rx_ptr`, a one-line
accessor for the receive buffer pointer (used after `decode_rx`, which may `resize` and so move the
buffer; `rx()`'s earlier pointer is stale).

**Fixture and legs.** `web/client-record-check/` (new page: the client package with the recorder on)
and `scripts/client-record-check.ts` (new driver: mounts it, waits for the end, writes
`recording.rs13`, replays it through `rs-core-check validate`). `run-gate8.sh` group `g8rec1`
(default), judged by `lib/gate8-rec1-checks.ts`; `smoke-map.json` reaches the page, the driver and
the check lib to native gate 8.

## The bound (the design row's open choice)

The ring restarts at each full transaction (**drop-oldest at a full**: a full re-establishes the whole
state, so the deltas before it are redundant — this is the only place a drop is safe, because a delta
depends on every record before it). Between fulls the ring is capped by `maxBytes` (default 64 MiB,
the whole recording: session + records); past it, recording **stops** (`overflow`) rather than drop
the oldest delta, which would corrupt the recording. Fetched payloads are bounded separately by
`maxResourceBytes` (default 256 MiB), drop-oldest by receipt order — a missing body only makes a later
replay fetch again, it never breaks the recording. This is the long-term-best choice: the export is
always a replayable recording, truncated at worst, never a corrupted one.

## Checks

The pure-client-unchanged half is a unit test (`recorder.test.ts` "off is zero copies"): the loop
driven with no recorder makes `FakeCore.copyDecoded === 0` — `receive` is never asked to copy a
decoded record. The replay-equality half is the `g8rec1` group (one live leg): a headless
`fixtures/tag-scene` host at /13 with a live tap, and the client package with the recorder on in the
pinned Chromium. Results below (run `<out>`; see `artifacts/render-stream/p3/rec1/`):

| check | result |
| ----- | ------ |
| `recorder-streamed` | 283 applies, 284 records, full seq 1 (the first transaction is a full), overflow false |
| `recording-replays` | `rs-core-check validate recording.rs13` → `ok` |
| `recording-equals-tap` | the export is byte-identical to the host's tap `stream-1.rs2` (325,959 bytes) |
| `page-is-package-only` | 0 bundle inputs from `web/gsw-receiver/` |
| `off-is-zero-copies` (unit) | `FakeCore.copyDecoded === 0` with no recorder; `2` copies (session + first record) with one |

The export also recorded the 2 fetched payloads (`resources: 2`), so the "plus fetched resources"
half runs end to end.

## What ran vs out of scope

`validate-increment.sh --plan` maps the diff to `pure`, `cargo:experiments/render-stream/web/gsw-rs`,
`pnpm-test`, `native:gate8@*`, `g7:*@gsw`, `g7:g7-8@web/rust`, `g7live:*@gsw`,
`g7live:g7-8@web/rust` (the client package and the web core are shared code, so the live groups
collapse to the first, `g7-1`, and the rest — including `g7-5` — defer to the full tier). The `g8rec1`
group runs under `native:gate8@*`; because the diff touches `check-gate8.ts` (a checker path), native
gate 8's sabotage legs run too.

`--tier smoke` (8 runs): `cargo-gsw-rs`, `pnpm-test`, `native-rust-gate8` (322 checks, sabotage legs
included), `g7-gsw` (g7-0), `g7live-gsw-g7-1` and `g7live-web-rust-g7-8` all pass. Two runs fail and
both are tier artifacts, not regressions:

- `pure` fails `self-test-gate8z` once: "26 landed groups all have a GROUP_COVERAGE_8 decision,
  missing: g8rec1". Fixed by the `g8rec1` entry in `feature-evidence-8.ts`; the self-test re-runs
  43/43.
- `g7-web-rust` (g7-8 smoke) fails 23 checks with "evidence missing (a leg did not run)": g7-8's
  smoke is `@first` (one leg, g8a's born receiver), but its checks read every gate-8 group's legs, so
  the legs smoke never runs show as missing evidence. The one leg that ran produced its
  `applied.json`. This is g7-8's smoke behaviour whenever a gate-8 runner/checker path is touched
  (TAG2 reached the same target); the full tier runs g7-8 whole.

Timing legs stay real time and go to the milestone sweep (`--tier full` remotely, no `--and-local`).

## Deviations from the design row

- The design row names "g7-5 GSW live leg" as the fixture. The recorder lives in
  `createRenderStreamClient` (the product client), which the g7-5 GSW live leg's receiver
  (`web/gsw-receiver/live.ts`) does not mount — it is a separate, richer harness receiver. So the
  live check runs the same /13 live host shape (a headless tag-scene host with a tap) against the
  client package in `g8rec1`; the g7-5 GSW live leg still runs (its group is reached by the diff and
  runs whole in the full tier) as the receiver regression, unchanged.
- The export's `bytes` are the decoded messages (which equal the host's tap, byte for byte); the
  fetched payloads are exported beside them in `resources`, keyed by hash, rather than rewritten into
  inline resource records. Rewriting them is not needed for the row's check (the host's tap also
  references them out of band) and would parse the resource-record wire format in the page.
