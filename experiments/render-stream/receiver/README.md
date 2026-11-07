# render-stream native receiver

A Godot 4.5.1 project whose only input is a render-stream byte stream: a recording file (file
mode) or one live connection to a capture host (live mode), plus the texture, mesh and shader
payloads the stream names (inline resource records, a content-addressed cache directory, the
capture's store directory, or HTTP GETs on the host). It replays the stream onto its own
`RenderingServer` and writes `applied.json`. It has no autoload and no file from `fixtures/`. The
bytes are the specs under [`../protocol/`](../protocol/); the receiver speaks `render-stream/6`
through `/13` (live: the subprotocol it offers; file mode: whatever magic the recording carries).

Decoding, validation, resolution and the apply itself run in the shared Rust core (`../rs-core`,
through `../rs-core-capi`), loaded as a GDExtension adapter from `ext/`. The GDScript in this
project does configuration, I/O, the live client, evidence and shots.

The same project exports to the web (preset `Web (rust core)`); see "Web export" below.

## Files

| File                                      | Role                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `project.godot`                           | 640×360, stretch disabled, `gl_compatibility`, typed-GDScript warnings as errors. `default_clear_color` is magenta on purpose: the session's clear colour must replace it.                                                                       |
| `main.tscn`, `receiver.gd`                | Orchestration: environment, framing, session and viewport checks, one record per frame, state dumps, shots, `applied.json`, exit code; in live mode the connection, acks and shot windows. `receiver.gd`'s header lists every variable it reads. |
| `rs_config.gd`                            | Every `RS_RECEIVER_*` read: the environment first, then `--rs-env=NAME=VALUE` arguments after `--` (the web export's only source).                                                                                                               |
| `rs_live_client.gd`                       | The WebSocket client: the hello, ack and resync encoders, the host error parser, the bearer header.                                                                                                                                              |
| `rs_wire.gd`                              | Record framing (`split_records`) and small shared helpers.                                                                                                                                                                                       |
| `rs_resource_cache.gd`                    | Verified payloads in memory, the content-addressed cache directory and the store as file-mode origin, with optional byte budgets.                                                                                                                |
| `rs_resource_fetcher.gd`                  | Live payload GETs on the host's HTTP port (one keep-alive client, per-GET timeout); on the web, the browser's `fetch()`.                                                                                                                         |
| `rs_rust_applier.gd`                      | Marshals records into the core and its stats out; the core applies resolved state as `RenderingServer` calls.                                                                                                                                    |
| `rs_shader_payload.gd`                    | GRP1 decode for the operator-local shader library.                                                                                                                                                                                               |
| `rs_io.gd`, `rs_perf.gd`, `rs_row_log.gd` | Web-export source staging and evidence upload; perf instrumentation; row logs.                                                                                                                                                                   |
| `ext/`                                    | The adapter: `rs_core_ext.cpp` (C++ over the raw `gdextension_interface.h`, no godot-cpp), `rs_core_capi.h`, `rs_core.gdextension`, and a `.gdignore` so the editor never registers it. Built into the ignored `ext/build/`.                     |
| `export_presets.cfg`, `web/shell.html`    | The web export's preset and HTML shell.                                                                                                                                                                                                          |
| `tests/`                                  | `receiver_selftest.gd` (every script compiles; golden recordings frame as listed; framing errors fail with their code), `ws_selftest.gd` and `http_selftest.gd` (interop with the capture's `rs_ws` echo server).                                |

## Build

```bash
# One editor import (writes the ignored .godot/ cache the release template needs):
mise exec -- godot --headless --path experiments/render-stream/receiver --import
# The core adapter, once per checkout and after core changes:
experiments/render-stream/scripts/build-rs-core-ext.sh
# Self-test (prints "[receiver-selftest] ok (<n> checks)", exits 0):
mise exec -- godot --headless --path experiments/render-stream/receiver --script res://tests/receiver_selftest.gd
```

Every native launch loads `ext/rs_core.gdextension`. Without the adapter build every run fails with
"`RS_RECEIVER_CORE=rust, but the adapter is unavailable`". `RS_SELFTEST_GOLDEN_DIR` overrides the
self-test's golden directory (default `../protocol/golden-2`; the later golden directories are its
siblings).

## Run: file mode

```bash
RS_RECEIVER_RECORDING=/abs/recording.rs2 RS_RECEIVER_OUT=/abs/leg/applied.json \
RS_RECEIVER_CACHE_DIR=/abs/leg/cache RS_RECEIVER_STORE_DIR=/abs/capture/store \
RS_RECEIVER_SHOT_SEQS=1,2 RS_RECEIVER_STATE_SEQS=1,2 \
  <godot 4.5.1 binary or release template> --path experiments/render-stream/receiver
```

Rendered runs belong in a private `gamescope --backend headless` (`../scripts/lib/gamescope.sh`),
not a desktop display. Under `--headless` a requested shot is replay-failure `shot-unavailable`;
state dumps work headless. For a half presentation, run with `--resolution 960x540` in a 960x540
gamescope.

| Variable                 | Meaning                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `RS_RECEIVER_MODE`       | `file` (default) or `live`; anything else is a usage error.                                                         |
| `RS_RECEIVER_RECORDING`  | Absolute recording path. Unreadable: replay-failure `recording-unreadable`.                                         |
| `RS_RECEIVER_OUT`        | Absolute `applied.json` path. Shots go to `<dir>/shots/seq-<seq>.png`, state dumps to `<dir>/state/seq-<seq>.json`. |
| `RS_RECEIVER_SHOT_SEQS`  | Optional CSV of transaction seqs to shoot after `frame_post_draw`.                                                  |
| `RS_RECEIVER_STATE_SEQS` | Optional CSV of seqs whose resolved state is dumped after apply, in the spec's resolved `state` form.               |

## Resources (both modes)

| Variable                                                            | Meaning                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RS_RECEIVER_CACHE_DIR`                                             | Absolute content-addressed cache (`sha256/<hash>.grt` textures, `.grm` mesh surfaces, `.grp` shader code). Required unless delivery is inline.                                           |
| `RS_RECEIVER_CACHE_MODE`                                            | `fresh` (default: the directory must be absent or empty, else `cache-not-fresh`) or `warm` (it must exist).                                                                              |
| `RS_RECEIVER_STORE_DIR`                                             | File mode: the capture's store, the origin for `fetch: "directory"`.                                                                                                                     |
| `RS_RECEIVER_SHADER_LIBRARY`                                        | Operator-local library (`sha256/<hash>.grp`) for shaders the host withholds. Without it a withheld shader is skipped and reported `shader-withheld`. Never fetched, never cached.        |
| `RS_RECEIVER_MEMORY_BUDGET_BYTES`, `RS_RECEIVER_CACHE_BUDGET_BYTES` | LRU byte budgets for in-memory payloads and the cache directory (default unlimited). A payload the current state still needs is never evicted.                                           |
| `RS_RECEIVER_FETCH_TIMEOUT_MS`                                      | A GET not complete after this long is `resource-unavailable` (default 10000).                                                                                                            |
| `RS_RECEIVER_FETCH_DELAY_MS`                                        | Injected delay before each fetch (default 0).                                                                                                                                            |
| `RS_RECEIVER_ACCEPT_ENCODING`                                       | `Accept-Encoding` on native payload GETs: `auto` (default, `zstd, gzip`), `zstd`, `gzip`, `off`. Bodies are verified after decoding.                                                     |
| `RS_RECEIVER_TEXTURE_ENCODINGS`                                     | `/9` delivery preference (default `block,uastc,decoded`): each texture takes the first listed encoding the entry offers; `block` only for a GPU-supported family, `decoded` always last. |
| `RS_RECEIVER_GPU_FORMAT_MASK`                                       | Comma-separated families (`s3tc`, `bptc`, `rgtc`, `etc2`, `astc`) to leave out of the advertised GPU formats.                                                                            |
| `RS_RECEIVER_VARIANT_POLICY`                                        | `keep` (default) or `upgrade`: whether a better variant that appears later is refetched.                                                                                                 |
| `RS_RECEIVER_CORE`, `RS_RECEIVER_CORE_EXT`                          | `rust` (the only core) and the adapter's `.gdextension` (default `res://ext/rs_core.gdextension`).                                                                                       |

## Run: live mode

```bash
RS_RECEIVER_MODE=live RS_RECEIVER_URL=ws://127.0.0.1:<port>/render-stream \
RS_RECEIVER_OUT=/abs/leg/applied.json RS_RECEIVER_SHOT_WINDOWS=0:307-359,1:367-419 \
  <template> --max-fps 60 --path experiments/render-stream/receiver
```

| Variable                                                     | Meaning                                                                                                                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RS_RECEIVER_URL`                                            | Required. Loopback only (`ws://127.0.0.1:<port>/…`, `ws://[::1]:<port>/…`); `RS_RECEIVER_ALLOW_LAN=1` also allows an IPv4 LAN address. The port is in the host's `evidence/live.json`. |
| `RS_RECEIVER_PROTOCOL`                                       | The version offered: `6` (native default) … `13`; `7` is the web default.                                                                                                              |
| `RS_RECEIVER_CREDIT_WINDOW`                                  | `2` (default) or `1`, from `/7` on; the host grants at most its own maximum.                                                                                                           |
| `RS_RECEIVER_LIVE_CODING`                                    | `/11`–`/13`: unset offers `zstd-base,zstd`; `zstd` or `off`.                                                                                                                           |
| `RS_RECEIVER_TOKEN_FILE`                                     | File holding the bearer token, sent on the upgrade and every GET (`RS_RECEIVER_TOKEN` on the web).                                                                                     |
| `RS_RECEIVER_MANIFEST_SHA256`                                | 64 hex: the hello's feature-manifest digest (from `/7`).                                                                                                                               |
| `RS_RECEIVER_SHOT_WINDOWS`                                   | CSV of `<step>:<from>-<to>` host-frame windows; the first applied transaction inside each is shot and dumped.                                                                          |
| `RS_RECEIVER_SHOT_FINAL`                                     | `1`: after the end record, draw and shoot the last state once more (`shots/final.png`).                                                                                                |
| `RS_RECEIVER_RECEIVED_OUT`, `RS_RECEIVER_RECEIVED_MAX_BYTES` | Where the received bytes are mirrored (default `<dir>/received.rs2`) and an optional cap.                                                                                              |
| `RS_RECEIVER_INBOUND_BYTES`                                  | `WebSocketPeer.inbound_buffer_size`, announced in the hello (default 16777216).                                                                                                        |
| `RS_RECEIVER_CREDIT_STAGE`                                   | `submitted` (default) or `applied`; forced to `applied` headless.                                                                                                                      |
| `RS_RECEIVER_CONNECT_TIMEOUT`                                | Milliseconds to reach the open state (default 10000; `live-connect-failed`).                                                                                                           |
| `RS_RECEIVER_LATE_POLL`                                      | `1`: read, fetch and apply in `frame_pre_draw` instead of `_process` (rendered only).                                                                                                  |
| `RS_RECEIVER_STALL`                                          | `<step>:<ms>`: block the main loop after that step's shot, before its `submitted` ack.                                                                                                 |
| `RS_RECEIVER_RECONNECT`                                      | `<step>`: after that step's shot and ack, close, dispose and connect again as a fresh session.                                                                                         |
| `RS_RECEIVER_RECONNECT_MEMORY`                               | `drop` (default) or `keep`: whether verified in-memory payloads survive a reconnect.                                                                                                   |
| `RS_RECEIVER_RECONNECT_ON_LOSS`                              | `1`: a connection lost without an end record reconnects (at most 3 times) instead of failing `live-disconnected`.                                                                      |
| `RS_RECEIVER_RESYNC`                                         | `<step>`: refuse the first transaction in that window, send `resync`, ignore patches until a full transaction.                                                                         |

The file-mode variables are usage errors in live mode, and so is a stall, reconnect or resync step
without a shot window. On open the receiver sends `hello`. Each binary message is appended to the
received file, framed (the first carries the magic and session, every later one exactly one record,
else `live-framing`), decoded, accepted and acked `received`. The newest accepted transaction is
applied, at most one per frame, and acked `applied`; at the next `frame_post_draw` a due shot is
taken and `submitted` is sent. After the end record the receiver closes with 1000 itself (Godot's
`WebSocketPeer` drops a message that arrives with the peer's close frame, so the host waits for the
receiver's close), writes `applied.json` and exits 0. A close without an end record is
`live-disconnected`; a host close with 1002, 1008 or 1009 is `host-error` with the host's reason. A
reconnect writes `received-2.rs2`, a second `streams[]` entry and `shots/stream-2-seq-<n>.png`.

## Diagnostics and evidence

| Variable                                           | Meaning                                                                                                                                                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RS_RECEIVER_LOG`                                  | `full` (default) or `summary` (drops the per-transaction arrays from `applied.json`).                                                                                                                       |
| `RS_RECEIVER_PERF_OUT`, `RS_RECEIVER_PERF_SAMPLES` | A `perf.json` path (off when unset); `1` adds per-transaction timings (file mode).                                                                                                                          |
| `RS_RECEIVER_RSS_EVERY`                            | File mode: one memory line every N applied transactions.                                                                                                                                                    |
| `RS_RECEIVER_TRANSCODE_LOG`                        | `1`: hash each KTX2 transcode's uploaded blocks into the report.                                                                                                                                            |
| `RS_RECEIVER_BUILD_SHA256`                         | Recorded in `applied.json`'s `receiver` block.                                                                                                                                                              |
| `RS_RECEIVER_SABOTAGE`                             | Test-only faults (`reupload`, `ignore-cache`, `ignore-clip`, `ignore-material`, `stale-texture`, `ignore-presentation`, …; the full list is in `receiver.gd`). Each exists only to make a named check fail. |

**Exit codes.** `0` ok; `3` replay-failure (`applied.json` written); `2` usage error (a missing or
relative `RS_RECEIVER_OUT`, a malformed seq list, an unknown mode, a malformed live variable), with
nothing written. Every output line starts with `[receiver]`.

## `applied.json`

Schema `render-stream-receiver-applied/<n>`. Top level: `status`, `mode`, `recording`, `streams[]`
(per connection: `stream_id`, `connection`, `closed_by`, `close_code`), `viewport` (size, presentation
size, window size, oversampling and their checks), `receiver` (`kind`, `core`, `protocol`,
`credit_window`, `build_sha256`, `manifest_sha256`), `transactions[]` (per applied transaction: seq,
stream, encoding, `received_us`/`applied_us`/`submitted_us`, `skipped`, and a `resources` block of
fetch, cache, upload, mesh, shader, material and canvas counters), `shots[]`, `shots_missed`,
`fetches[]`, `uploads[]`, `mesh_uploads[]`, `resources_summary`, `cache`, `unsupported` (entries
the stream or the receiver typed, reported once where they first appear) and `live` (URL, credit
stage, buffer size, acks, and the stall, reconnect and resync records). State dumps are the core's
resolved state in `scripts/lib/render-stream-2.ts`'s form, so they compare with the capture's.

## Apply rules

- **Order.** The whole file is framed first; a framing error fails with `seq: null` before any
  `RenderingServer` call. The session is decoded and validated, the viewport checked, the session
  applied in `_ready` (clear colour, canvas 1 to the root viewport's canvas, its transform), then one
  record per frame. Within a transaction: textures, meshes, shaders, materials, canvases, items,
  canvas 1.
- **Presentation.** A session with a stretch makes the root window adopt it before any item exists.
  A rendered receiver then requires the window size to equal `presentation_size`
  (`presentation-mismatch`), the root oversampling to equal `font_oversampling`
  (`oversampling-mismatch`) and the visible rect to equal `logical_size` (`viewport-mismatch`).
  Headless, the root is 64×64 (`SceneTree`'s minimum size) and these checks are skipped.
- **Canvases.** Each non-root canvas gets its own `canvas_create`, attached, stacked, transformed and
  modulated only on change; canvas 1 is the viewport's own canvas.
- **Textures and meshes.** Before a transaction applies, every payload its resolved state names that
  is not resident with that hash is taken from memory, the cache, or a fetch, verified and decoded.
  A resident texture is updated in place (`texture_2d_update`, or `texture_replace`), so its RID
  never changes. A mesh payload change with the same layout is a per-buffer region update; a layout
  change rebuilds the mesh. Freed or unsupported resources draw as the engine's invalid texture or
  are skipped, and are recorded.
- **Shaders and materials.** A shader's code goes to `shader_set_code` exactly as its verified GRP1
  payload carries it (never through a `Shader` resource, which would preprocess it again). A
  material is `material_create`, `material_set_shader` and one `material_set_param` per changed
  parameter, rebuilt as the exact Variant type. Residency is lazy: only what items name. A shader
  compile error is the engine's own `SHADER ERROR` print.
- **Items.** Free vanished, create new, parent pass, order pass, setters only for new items or
  changed values (floats compared as float32), content rebuild only on a `content_version` change.
  A full and a patch encoding of the same frames cost the same calls; an unchanged transaction
  costs none.
- **Missing seqs.** A requested shot or dump whose seq never appears is `shot-unavailable` /
  `state-unavailable` at the end record.
- **Teardown.** `dispose()` frees every RID the core created (`[receiver] disposed: N RIDs freed`).

## Web export

Export only through `../scripts/build-web-receiver.sh --core rust` (after
`../scripts/build-rs-core-web.sh`), which pins the editor and the web template by sha256 and stages
`ext/` with the side module. In the browser, configuration comes from the page (`?env=` on the
shell URL becomes `--rs-env` arguments; the token comes from the URL fragment). Sources
(`RS_RECEIVER_RECORDING`, `RS_RECEIVER_STORE_DIR`, `RS_RECEIVER_SHADER_LIBRARY`) are same-origin URL
paths on the serving harness (`RS_RECEIVER_PAGE_ORIGIN`); in file mode the store is fetched per
transaction as needed (`RS_RECEIVER_WEB_STORE=lazy`, the default) or staged up front (`staged`). Every file written under
`RS_RECEIVER_OUT`'s directory is PUT to `RS_RECEIVER_EVIDENCE_URL` before the page exits.
`RS_RECEIVER_CACHE_DIR` is refused on the web (the browser's HTTP cache is the cache).
`RS_RECEIVER_WEB_FETCH` is `fetch` (default) or `httpclient` (Godot's web `HTTPClient`).
