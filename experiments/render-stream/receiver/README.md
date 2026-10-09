# render-stream/1 receiver (gate 0, extended by gate 1)

A Godot project whose only input is a `render-stream/1` recording. It replays the recording onto
the RenderingServer, one transaction per frame, and writes `applied.json`. It has no autoload, no
extension and no file from `fixtures/`. The contract is
[`../protocol/gate1-design.md`](../protocol/gate1-design.md) ("Q5. Receiver", "G1b2"), extending
[`../protocol/gate0-design.md`](../protocol/gate0-design.md) ("Q5. Receiver"); the bytes are
[`../protocol/render-stream-1.md`](../protocol/render-stream-1.md). File mode only: live mode
(WebSocket) lands in G1c2.

| File                       | Role                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.godot`            | 640×360, stretch disabled, `gl_compatibility`, typed-GDScript warnings at error level. `default_clear_color` is magenta on purpose: the session's `clear_color` must replace it.                                                                                                                  |
| `main.tscn`                | A root `Node` with `receiver.gd`.                                                                                                                                                                                                                                                                 |
| `receiver.gd`              | Orchestration: environment, framing pass, session and viewport check, one record per `_process`, state dumps, shots, `applied.json`, exit code.                                                                                                                                                   |
| `rs1_decoder.gd`           | `Rs1Decoder`: pure `PackedByteArray` → records, with the wire spec's error codes (`split_records`, `decode_record`, `validate_recording`). `Rs1Decoder.Stream.accept` checks the cross-record rules and resolves patches into the full state (`canvases`/`items`).                                |
| `rs_applier.gd`            | `RsApplier`: wire id → RID maps and every RenderingServer call, counted in `rs_calls`. It applies the **resolved** state, never a patch, reconciling it with its own mirror so only changed state costs calls. `apply_record` calls the RenderingServer only after decode and `accept` succeeded. |
| `tests/codec1_selftest.gd` | Golden-vector self-test (`../protocol/golden-1/`): decoded form, resolved state per seq, every invalid vector, `corrupt-meta.rs1`, and the applier: identical per-seq stats for `full.rs1` and `patch.rs1`, 0 calls for an unchanged seq, 0 calls for the corrupt transaction.                    |
| `tests/ws_selftest.gd`     | `WebSocketPeer` interop self-test against the capture library's `rs_ws` echo server (G1c1).                                                                                                                                                                                                       |

## Running

Import once with the editor (it writes the ignored `.godot/` cache the release template needs):

```bash
mise exec -- godot --headless --path experiments/render-stream/receiver --import
mise exec -- godot --headless --path experiments/render-stream/receiver --script res://tests/codec1_selftest.gd
```

The self-test prints `[rs1-selftest] ok` and exits 0, or prints each failure and exits 1.
`RS_SELFTEST_GOLDEN_DIR` overrides the golden directory (default `<receiver>/../protocol/golden-1`).
On the goldens the applier makes `[56, 1, 18, 0, 2, 0]` RenderingServer calls for seqs 1–6 of both
`full.rs1` and `patch.rs1` (plus 3 for the session).

A replay:

```bash
RS_RECEIVER_RECORDING=/abs/recording.rs1 RS_RECEIVER_OUT=/abs/leg/applied.json \
RS_RECEIVER_SHOT_SEQS=1,2 RS_RECEIVER_STATE_SEQS=1,2 <godot or template> --path experiments/render-stream/receiver
```

| Variable                 | Meaning                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RS_RECEIVER_MODE`       | `file` (default when unset). `live` is a usage error until G1c2; any other value is a usage error.                                                                              |
| `RS_RECEIVER_RECORDING`  | absolute `.rs1` path. Missing or unreadable → replay-failure `recording-unreadable`.                                                                                            |
| `RS_RECEIVER_OUT`        | absolute `applied.json` path. Shots go to `<dirname>/shots/seq-<seq>.png`, state dumps to `<dirname>/state/seq-<seq>.json`.                                                     |
| `RS_RECEIVER_SHOT_SEQS`  | optional CSV of transaction seqs to screenshot after `RenderingServer.frame_post_draw`.                                                                                         |
| `RS_RECEIVER_STATE_SEQS` | optional CSV of transaction seqs whose resolved state is dumped right after that seq is applied, in render-stream-1.md's resolved `state` shape (compact JSON, full precision). |

Exit codes: `0` status `ok`; `3` replay-failure (`applied.json` written); `2` usage error
(`RS_RECEIVER_OUT` missing or not absolute, a malformed `RS_RECEIVER_SHOT_SEQS` or
`RS_RECEIVER_STATE_SEQS`, or `RS_RECEIVER_MODE` not `file`), with nothing written. Every output line
starts with `[receiver]`.

Rendered runs go only through a private `gamescope --backend headless`
(`../scripts/lib/gamescope.sh`), never Xvfb or a desktop display. Under `--headless` a requested
shot is replay-failure `shot-unavailable`; state dumps work headless.

## `applied.json` (`render-stream-receiver-applied/2`)

The schema is gate1-design.md Q5. In file mode: `mode: "file"`; `recording` and the single
`streams[0]` describe the input file (`stream_id` from the session, `null` until the session
decoded; `connection`, `closed_by`, `close_code` are `null`); every `transactions[]` and `shots[]`
entry has `stream: 1`; transactions carry `encoding` and `null` `received_us`/`applied_us`/
`submitted_us`/`skipped`; shots carry `step: null` and `state_path` (the seq's state dump, if it was
also requested, else `null`); `shots_missed` is `[]`; `live` is `null`. `viewport.size_check` is
`skipped-headless` under `--headless`, otherwise `ok` or `mismatch` against the session's
`logical_size`, and `null` if the run failed before the session was decoded.

## Behaviour notes

- **Order of work.** The whole file is framed first (`split_records`); a framing error fails with
  `seq: null` before any RenderingServer call. The session is decoded and validated, the viewport
  size is checked, then the session is applied in `_ready` (clear colour, canvas 1 → the root
  viewport's World2D canvas, its transform, the cull mask), and one record per `_process` frame
  after that.
- **Resolved state, identity reconciliation.** Each transaction is decoded and accepted by
  `Rs1Decoder.Stream`, which resolves a patch against the previous state. `RsApplier.apply_state`
  then follows gate 0's Q5 steps 2–8 against the resolved state: free vanished, create new, parent
  pass, order pass (re-`set_parent` from the first divergence), setters only for new items or
  changed values (floats compared as float32; `z_relative` and `behind` included), content rebuild
  only on a `content_version` change, canvas 1 transform. A full and a patch encoding of the same
  frames therefore cost the same calls, and an unchanged transaction costs none.
- **Viewport size.** A rendered receiver requires its visible rect to equal the session's
  `viewport.logical_size` (replay-failure `viewport-mismatch` otherwise). Headless, the size is 64×64
  (`SceneTree` sets the root's minimum size, `scene/main/scene_tree.cpp:2035`, and
  `Window::_update_window_size` clamps to it, `scene/main/window.cpp:1150`) and the check is skipped.
- **Missing seqs.** A requested shot or state dump whose seq never appears is replay-failure
  `shot-unavailable` / `state-unavailable` at the end record.
- **Failure `seq`.** A transaction whose meta cannot be parsed (`meta-json`) has no readable `seq`;
  the receiver reports the seq it was expecting at that position (previous + 1). Errors from the
  session or end record report `seq: null`.
- **Codes the spec leaves open.** `block_count` ≠ `meta.blocks.length` is `block-count`. A
  non-printable meta byte is `meta-json`. An out-of-order or repeated `unsupported` entry is
  `unsupported-mismatch`. `validate_recording` stops at the first record that fails to decode, so a
  bad record is not followed by cascade errors.
- **Unsupported** commands are logged (`[receiver] seq N item I: unsupported command …`) when an
  item's content is (re)built, and not drawn. Top-level `unsupported` entries are reported in
  `applied.json` `unsupported` once, at the seq where they first appear, not treated as a failure.
- **Teardown.** On exit the applier's `dispose()` frees every RID it created (logged as
  `[receiver] disposed: N RIDs freed`).
- **Quantization.** A colour component of 0.5 (the golden's clear colour blue, item 1 green) lands
  on 127 in an 8-bit shot on the RTX 2060 / NVIDIA GL driver, not 128. The gate 0 fixture avoids
  this by using components in {0, .2, .4, .6, .8, 1}.
