## Build, calibrate, run

```bash
# build + unit test (cmake is at /snap/bin/cmake; override with CMAKE=)
experiments/render-stream/scripts/build-capture.sh

# re-derive the committed record, plus uncommitted records for the other local
# templates under artifacts/render-stream/calibration/
experiments/render-stream/scripts/calibrate.sh
experiments/render-stream/scripts/calibrate.sh --check   # diff, do not overwrite

# an engine fork that rebrands GODOT_VERSION_NAME (the version string is "<name> v<build>")
python3 experiments/render-stream/capture/tools/calibrate.py --binary <elf> \
  --header ../godot-4.5.1-stable/servers/rendering_server.h --version-name MegaDot --out <record>
```

The build writes `capture/build/librender_stream_capture.so` and
`capture/build/render_stream_capture.gdextension` (absolute library path,
`entry_symbol = "grc_library_init"`, `compatibility_minimum = "4.5"`). Both are
ignored. Load the `.gdextension` from a fixture autoload, as `fixtures/spike/loader.gd` does:

```gdscript
GDExtensionManager.load_extension(OS.get_environment("GRC_EXTENSION"))
```

### Run gate −1

```bash
experiments/render-stream/scripts/build-capture.sh
experiments/render-stream/scripts/calibrate.sh --check
mise exec -- pnpm render-stream:gate-minus1 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json"
```

About 80 seconds. It imports the fixture once with the mise editor (the release template cannot
run a loose project without `.godot/`), runs the six headless legs and the two rendered legs in a
private `gamescope --backend headless`, then the checker, which writes
`artifacts/render-stream/gate-minus1/<UTC timestamp>/result.json` and exits non-zero unless every
check passed. Legs, evidence layout and criteria: [scripts/README.md](../scripts/README.md). Checker
self-test: `mise exec -- pnpm exec tsx --conditions=development
experiments/render-stream/scripts/test/self-test-checker.ts`.

### Run gate 0

```bash
experiments/render-stream/scripts/build-capture.sh          # + rs_mirror, rs_publish ctests
mise exec -- pnpm render-stream:gate0 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json"
```

About 105 seconds. It imports `fixtures/gate0/` and `receiver/` with the mise editor, runs the
receiver's typed self-test, the headless capture hosts (the 400-frame capture, `preexisting`,
`preexisting-skip`, `unsupported` and the three sabotage captures), the headless receivers
(`corrupt`, `receiver-headless-trace`, `unsupported`), then the reference, the receiver,
`preexisting-reference`, the `preexisting-skip` receiver and the three sabotage receivers in one
private `gamescope --backend headless`, then the checker, which writes
`artifacts/render-stream/gate0/<UTC timestamp>/result.json` and exits non-zero unless every check
passed. Since G1b2 every capture runs under `GRC_ROOT_SIZE=enforce-min-size`; since G2b2 every
capture writes its payload store (`<capture>/store`, which holds only the engine's hue strip here)
and every file-mode receiver gets a fresh cache and that store. Every gate runs on
[protocol/render-stream-4.md](../protocol/render-stream-4.md) since G5d (render-stream/3 from G4e2
to G5d, render-stream/2 from G2b2 to G4e2; /3 is /2 plus the MSDF glyph command, /4 is /3 plus
the immediate geometry ops, `add_set_transform`, `add_clip_ignore`, `add_mesh` and a mesh table):
the capture, the receiver and every checker speak it, the recordings keep their `.rs2` names, and
the receiver's typecheck replays `golden-4/`.
Self-tests: `scripts/test/self-test-rs2.ts` (TS decoder against the /2 golden vectors and, since
G4e1, G5w and G55w, against `golden-3/`, `golden-4/` and `golden-5/`, implemented in
`render-stream-2.ts` itself behind a `version` parameter rather than forked modules; since G5d the
parameter defaults to 4 -- /5 decoding is exercised only against `golden-5/`, since the capture and
receiver do not speak it until G55d), `scripts/test/self-test-gate0.ts` (checker and classifier on
synthetic evidence) and `python3 experiments/render-stream/protocol/golden-2/make_golden.py
--check` (plus `golden-3/`'s, `golden-4/`'s and `golden-5/`'s);
the frozen /0 and /1 history stays checked by `scripts/test/self-test-rs0.ts`, `self-test-rs1.ts`
and both older `make_golden.py --check`.

### Run gate 1

```bash
experiments/render-stream/scripts/build-capture.sh
mise exec -- pnpm render-stream:gate1 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g1a,g1b,g1c,g1d]
```

This takes about nine minutes and runs the landed groups, `g1a`, `g1b`, `g1c` and `g1d`. It imports
`fixtures/gate1/` and `receiver/`, then runs the receiver's typed self-test and the headless
captures, each writing both sinks (`recording.rs2` full, `recording-patch.rs2` patch,
render-stream/2 since G2b2, render-stream/3 since G4e2, render-stream/4 since G5d) and its payload
store: the
400-frame capture under `enforce-min-size`, the four `omit-update` sabotage captures and the
`root-size-observe` capture. Next it runs the headless traced receiver. The reference and the six
g1a rendered receivers share one private gamescope. Group g1b then captures the two `omit-op`
sabotages, the `patch-drop-item` sabotage and the `RS_FIXTURE_TIE=overlap` variant, and runs the
patch receiver, the sabotage receivers and the overlap variant's reference and receiver in a
second private gamescope. Group g1c runs four live legs: a host serving on an ephemeral loopback
port with a headless receiver, then, in a third private gamescope, a host with a rendered live
receiver, a file-mode replay of what that receiver received, and the `drop-message` sabotage.
Group g1d runs six more live hosts: one whose headless receiver is SIGKILLed at frame 600, then, in
a fourth private gamescope, a stalled receiver, a reconnecting one, a resyncing one, and the
`ignore-credit` and `stale-coalesce` sabotages. Last, the checker writes
`artifacts/render-stream/gate1/<UTC>/result.json` (`render-stream-gate1-report/1`). Legs and
criteria: [scripts/README.md](../scripts/README.md) "Gate 1". Self-test:
`scripts/test/self-test-gate1.ts`.

### Run gate 2

```bash
experiments/render-stream/scripts/build-capture.sh          # + rs_sha256, rs_texture_payload, rs_resource_log, rs_publish ctests
mise exec -- pnpm render-stream:gate2 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g2a,g2b,g2c,g2d,g2e]
```

About fifteen minutes for all five groups. g2b, g2c and g2d need g2a's captures and reference,
and g2d also needs g2b's. It imports `fixtures/gate2/` and `receiver/`, runs the headless capture
(400 frames, `enforce-min-size`, strace, both sinks and the store) and the `unsupported` variant's
capture, then the reference, its same-build repeat and the extension-armed reference in one private
gamescope. Group g2b adds the inline capture and the five sabotage captures, the headless
receivers (strace trace, wrong-hash, stale, spurious, reupload), a live host with a headless
inline receiver, then in a second private gamescope the variant's reference and the rendered
receivers (cold, warm, patch, inline, unsupported, the two omit-op sabotages), and last the
ignore-cache receiver. Group g2c runs nine live hosts (S = 300, N = 60, quit 971, fetch http):
the headless live receiver and the drop-resource and live wrong-hash sabotages, then in a third
private gamescope the rendered `live` receiver, its file replay, the warm, stall, reconnect and
animate receivers and the unpin sabotage. Group g2d runs the `canvas` variant on a headless capture
host (the typed refusal), then, in a fourth gamescope, three rendered capture hosts with their
rendered receivers (host-renderer evidence). Group g2e runs three live hosts with
`GRC_LIVE_AUTH=token`. Group g2f is opt-in (`--legs …,g2f`, never in the default set). It runs the
headless `CanvasTexture` shim experiment ("Gate 2f result" below), and it is standalone. The checker writes `artifacts/render-stream/gate2/<UTC>/result.json`
(`render-stream-gate2-report/1`). Legs and criteria: [scripts/README.md](../scripts/README.md) "Gate
2". Self-tests: `scripts/test/self-test-gate2.ts`, `scripts/test/self-test-gate2f.ts`;
`fixtures/gate2/make_expected.py --check`; the receiver's `tests/applier2_selftest.gd`.

### Run gate 3

```bash
experiments/render-stream/scripts/build-capture.sh
mise exec -- pnpm render-stream:gate3 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g3a,g3b,g3c,g3d]
```

About seven minutes for all four groups. It imports `fixtures/gate3/` and `receiver/` with the
mise editor, runs the 400-frame headless capture (`enforce-min-size`, both sinks and the store),
then the reference, its same-build repeat and the armed reference in one private gamescope (group
g3a). Group g3b replays the capture through the unchanged receiver on both sinks, a headless
traced receiver, four fresh sabotage captures (`freeze-frame`, `perturb-transform`, and two
`omit-op` legs dropping `canvas_item_set_clip`/`canvas_item_set_custom_rect`) with their rendered
receivers, the receiver-side `ignore-clip` and `clip-before-clear` sabotages, and the
`root-size-observe` leg, in a second private gamescope. Group g3c imports `fixtures/gate3-xform/`
and its own receiver, then runs a 52-frame capture, three references (reference, repeat, armed)
and two receivers (full, patch), plus the `perturb-transform` and receiver `ignore-clip`
sabotages, in a third private gamescope (`gamescope-xform/`). Group g3d captures the fixture's
`clip-ignore` variant, renders its own reference, and replays it through the unchanged receiver,
in a fourth private gamescope (`gamescope-g3d/`). The checker writes
`artifacts/render-stream/gate3/<UTC>/result.json` (`render-stream-gate3-report/1`). Legs and
criteria: [scripts/README.md](../scripts/README.md) "Gate 3". Self-tests:
`scripts/test/self-test-gate3.ts`; `fixtures/gate3/make_expected.py --check`;
`fixtures/gate3-xform/make_expected.py --check`.

### Run gate 4

```bash
experiments/render-stream/scripts/build-capture.sh
mise exec -- pnpm render-stream:gate4 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g4a,g4b,g4c,g4d,g4e,g4f]
```

About fourteen minutes for all six groups. It provisions each fixture's fonts from
`fonts.lock.json` before import and refuses on any mismatch. It imports `fixtures/gate4/` and
`receiver/`, runs the headless capture and the reference oracle (plus the early shots after each
upload step), in one private gamescope (group g4a). Group g4b needs g4a in the same `--legs`: it
replays the shared capture through the unchanged receiver on both sinks, a headless `openat`
trace, and three fresh sabotage captures (`freeze-frame`, `perturb-transform`, `omit-op` on
`texture_2d_update`) with their rendered receivers, in a second private gamescope
(`gamescope-g4b/`). Group g4c imports `fixtures/gate4-layout/` under `layout/` and runs its own
14-Label capture, reference and early shots, two receivers, the `omit-atlas` sabotage and the
`lcd` variant's reference and receiver, in a third private gamescope (`gamescope-g4c/`). Group
g4d imports `fixtures/gate4-rich/` under `rich-*/` and runs its own `RichTextLabel` capture,
reference, two receivers and the underline variant, in a fourth private gamescope
(`gamescope-g4d/`). Group g4e (G4e2) needs g4a in the same `--legs` for its own
`sabotage-gray-perturb-glyph` leg on `fixtures/gate4`; it imports `fixtures/gate4-msdf/` under
`msdf/` and runs its own capture, reference and early shots, two receivers and three sabotage
receivers (`perturb-glyph`, a receiver `drop-msdf`, and the grayscale sabotage), in a fifth
private gamescope (`gamescope-g4e/`). Group g4f imports `fixtures/gate4-i18n/` under `i18n/`
(four fallback fonts provisioned) and runs its own capture, reference and early shots, two
receivers and the `omit-atlas` sabotage, in a sixth private gamescope (`gamescope-g4f/`). The
checker writes `artifacts/render-stream/gate4/<UTC>/result.json`
(`render-stream-gate4-report/1`); g4c, g4d, g4e and g4f each merge their own checks and legs into
the same report. Legs and criteria: [scripts/README.md](../scripts/README.md) "Gate 4". Self-tests:
`scripts/test/self-test-gate4.ts`; `scripts/test/self-test-gate4d.ts`; `make_expected.py --check`
for `fixtures/gate4`, `fixtures/gate4-layout`, `fixtures/gate4-rich`, `fixtures/gate4-i18n` and
`fixtures/gate4-msdf`.

