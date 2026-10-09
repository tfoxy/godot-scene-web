# render-stream/0 receiver (gate 0, WP4)

A Godot project whose only input is a `render-stream/0` recording. It replays the recording onto
the RenderingServer, one transaction per frame, and writes `applied.json`. It has no autoload, no
extension and no file from `fixtures/`. The contract is
[`../protocol/gate0-design.md`](../protocol/gate0-design.md) ("Q5. Receiver") and the bytes are
[`../protocol/render-stream-0.md`](../protocol/render-stream-0.md).

| File                      | Role                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.godot`           | 640×360, stretch disabled, `gl_compatibility`, typed-GDScript warnings at error level. `default_clear_color` is magenta on purpose: the session's `clear_color` must replace it.                          |
| `main.tscn`               | A root `Node` with `receiver.gd`.                                                                                                                                                                         |
| `receiver.gd`             | Orchestration: environment, framing pass, viewport check, one record per `_process`, shots, `applied.json`, exit code.                                                                                    |
| `rs0_decoder.gd`          | `Rs0Decoder`: pure `PackedByteArray` → records, with the wire spec's error codes (`split_records`, `decode_record`, `Stream.accept`, `validate_recording`). No I/O, no RenderingServer.                   |
| `rs0_applier.gd`          | `Rs0Applier`: wire id → RID maps and every RenderingServer call, counted in `rs_calls`. `apply_record` decodes and validates a record fully and calls the RenderingServer only if that produced no error. |
| `tests/codec_selftest.gd` | Golden-vector self-test (decoded form, every invalid vector, `corrupt-meta.bin`, and the applier's per-transaction RS call counts, including 0 for the corrupt transaction).                              |

## Running

Import once with the editor (it writes the ignored `.godot/` cache the release template needs):

```bash
mise exec -- godot --headless --path experiments/render-stream/receiver --import
mise exec -- godot --headless --path experiments/render-stream/receiver --script res://tests/codec_selftest.gd
```

The self-test prints `[rs0-selftest] ok` and exits 0, or prints each failure and exits 1.
`RS_SELFTEST_GOLDEN_DIR` overrides the golden directory (default `<receiver>/../protocol/golden`).

A replay:

```bash
RS_RECEIVER_RECORDING=/abs/recording.rs0 RS_RECEIVER_OUT=/abs/leg/applied.json \
RS_RECEIVER_SHOT_SEQS=1,2 <godot or template> --path experiments/render-stream/receiver
```

| Variable                | Meaning                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `RS_RECEIVER_RECORDING` | absolute `.rs0` path. Missing or unreadable → replay-failure `recording-unreadable`.    |
| `RS_RECEIVER_OUT`       | absolute `applied.json` path. Shots go to `<dirname>/shots/seq-<seq>.png`.              |
| `RS_RECEIVER_SHOT_SEQS` | optional CSV of transaction seqs to screenshot after `RenderingServer.frame_post_draw`. |

Exit codes: `0` status `ok`; `3` replay-failure (`applied.json` written); `2` usage error
(`RS_RECEIVER_OUT` missing or not absolute, or a malformed `RS_RECEIVER_SHOT_SEQS`), with nothing
written. Every output line starts with `[receiver]`.

Rendered runs go only through a private `gamescope --backend headless`
(`../scripts/lib/gamescope.sh`), never Xvfb or a desktop display. Under `--headless` a requested
shot is replay-failure `shot-unavailable`.

## Behaviour notes

- **Order of work.** The whole file is framed first (`split_records`); a framing error fails with
  `seq: null` before any RenderingServer call. Then the session is applied in `_ready` (clear
  colour, canvas 1 → the root viewport's World2D canvas, its transform, the cull mask), and one
  record per `_process` frame after that. Each transaction follows Q5 steps 2–8: free vanished,
  create new, parent pass, order pass (re-`set_parent` from the first divergence), setters only on
  change (floats compared as float32), content rebuild on `content_version` change, canvas 1
  transform.
- **Failure `seq`.** A transaction whose meta cannot be parsed (`meta-json`) has no readable `seq`;
  the receiver reports the seq it was expecting at that position (previous + 1). Errors from the
  session or end record report `seq: null`.
- **Codes the spec leaves open.** `block_count` ≠ `meta.blocks.length` is `block-count`. A
  non-printable meta byte is `meta-json`. An out-of-order or repeated `unsupported` entry is
  `unsupported-mismatch`. `validate_recording` stops at the first record that fails to decode, so a
  bad record is not followed by cascade errors.
- **Unsupported** commands are logged (`[receiver] seq N item I: unsupported command …`) and not
  drawn. They are reported in `applied.json` `unsupported`, not treated as a failure.
- **Headless viewport size** is 64×64, not 0×0: `SceneTree` sets the root's minimum size to 64×64
  (`scene/main/scene_tree.cpp:2035`), and `Window::_update_window_size` clamps to it
  (`scene/main/window.cpp:1150`). The size check is skipped under headless either way.
- **Quantization.** A colour component of 0.5 (the golden's clear colour blue, item 1 green) lands
  on 127 in an 8-bit shot on the RTX 2060 / NVIDIA GL driver, not 128. The gate 0 fixture avoids
  this by using components in {0, .2, .4, .6, .8, 1}.
