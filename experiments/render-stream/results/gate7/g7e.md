## Gate 7e result (2026-10-15)

G7e ([protocol/gate7-design.md](../../protocol/gate7-design.md) "G7e", D5, Q4) passes. The native
receiver in `receiver/` now also runs as a Godot 4.5.1 web export (Compatibility, WebGL 2, no
threads, no GDExtension). It is the same GDScript, with two platform shims and a shell, and
gate 0's receiver legs replay in it with every check green.

`pnpm render-stream:gate7 -- --legs g7-0 --make-sources --extension … --calibration …` passes:
**gate_passed true**, 7/7 G7h harness checks, and 22 g7-0@web checks (20 gating, 2 reported).
Evidence is in `artifacts/render-stream/gate7/g7e-r3/` (ignored). That one run did four things in
order:

1. It made the gate 0 source run natively on the changed receiver (`sources-made/gate0/`,
   **gate 0 PASS**, every leg in its expected class). This doubles as the "gate 0 native
   unchanged" check.
2. It ran G7h's harness self-test.
3. It exported the bundle (`build-web-receiver.sh`).
4. It replayed 9 web legs through `browser-harness.ts`: gate 0's seven receiver legs, the
   `css-opacity` sabotage and the render-time probe.

**The build** (D5). The non-mono editor `Godot_v4.5.1-stable_linux.x86_64` is pinned by sha256
`db07cae7…b199`. The template `web_nothreads_release.zip` is pinned by sha256 `7f6c5efc…76e9c8`.
`build-web-receiver.sh` refuses to build if either digest differs. It stages the receiver's
git-visible files into `artifacts/render-stream/web-receiver/<sha>/project/`, puts the template
path into the committed preset's `@RS_WEB_TEMPLATE@` placeholder, imports, exports, and writes
`build.json`. The **export is reproducible**: two clean stagings exported byte-identical bundles
(all 7 files' sha256 equal, `.pck` `1a69d8f6…` included). A build takes 8 to 10 s.

| Export file | Bytes |
| --- | --- |
| `receiver.wasm` (the template's engine) | 38 034 280 |
| `receiver.pck` (17 entries; the scripts as text, `script_export_mode=0`; no `tests/`, nothing from `fixtures/`) | 448 972 |
| `receiver.js` | 305 185 |
| `receiver.png` (boot splash, unused by the shell), `receiver.html`, two audio worklets | 38 376 |
| **Total** | **38.8 MB** (37.0 MiB) |

**Pixel outcome against the prediction.** **P-W1 held.** All **25/25** web shots are byte-for-byte
equal to the native shots: 5 steps on each of `receiver`, `preexisting-skip` and the three
sabotage legs. Each web receiver's shots also equal the rendered reference under gate 0's own
budgets (`receiver-vs-reference@web`: 5 checkpoints, 0 px, delta 0), and each sabotage
mismatches at exactly its native steps. `applied-equals-native@web` passes on all 7 legs: every
field equals native except timings, paths, process frames, `receiver`, `cache` (Q4's
`http-cache`) and `display_server`. On the two legs that ran `--headless` natively, the
`viewport` block is also excluded (D11). `compositor-equals-readback@web` is exact: the CDP
screenshot equals the last shot, 0 px out of 230 400. The `css-opacity` sabotage fails exactly
that check, on all 230 400 px with max delta 3. Its readback shots still equal the honest
leg's, and it exits 0.

**Startup** (cold: a fresh browser and profile per leg, navigation-relative, median of the 9 legs
of r3; desktop, RTX 2060):

| Mark | ms |
| --- | --- |
| `Engine.init` resolved (wasm fetched and compiled) | 268 |
| `startGame` resolved / first receiver line | 1 313 / 1 293 |
| sources staged in memory (recording plus 2 store files, about 0.86 MB, about 135 ms) | 1 432 |
| session applied | 1 449 |

Replaying the 400-transaction `receiver` leg ends at 8.1 s, one record per rAF at 60 Hz. The wasm
heap is 58.1 MB after a 52-transaction leg and 69.7 MB after the 400-transaction one. Native
startup was not measured beside these numbers, and neither were warm loads (G7k).

**Shims** (Q4):

- **`rs_config.gd` (`RsConfig.get_env`).** Every `RS_RECEIVER_*` read in `receiver.gd` (26
  sites) goes through it. It reads the environment first, then `--rs-env=NAME=VALUE` after `--`
  (`OS.get_cmdline_user_args()`).
- **`rs_io.gd` (`RsIo`).** On the web, before the session it fetches `RS_RECEIVER_RECORDING`,
  `_STORE_DIR` and `_SHADER_LIBRARY` through `HTTPClient` (8 at a time, one poll per frame). The
  three are same-origin URL paths. A directory's file list comes from the harness's `GET <dir>/?list`.
  The files land in emscripten's in-memory filesystem **at the same absolute path**, so every
  `FileAccess` read is unchanged. At exit, `RsIo` PUTs every file under `RS_RECEIVER_OUT`'s
  directory to `RS_RECEIVER_EVIDENCE_URL`, and only then disposes the applier and quits.
  Natively both are no-ops, and `_quit` still disposes, then quits.
- **`RS_RECEIVER_CACHE_DIR` is a usage error on the web.** The web's cache is `cache.mode:
  "http-cache"`, and a disk budget there is typed `cache-budget-unsupported`.
- **`rs_perf.gd` on the web.** `rss_bytes` is null there.
- **Render-time probe.** `viewport_get_measured_render_time_cpu` is nonzero on WebGL 2 (384 of
  384 frame samples). `_gpu` is always 0, so it is `unavailable`, which agrees with D13. The
  snapshot `render_time.cpu_render_ms` reads whichever frame came last: `measured` 0.10 ms in r2,
  and 0 (`unavailable`) in r3.

`applied.json` is `render-stream-receiver-applied/7` for both receivers: it adds `receiver: {kind,
build_sha256, manifest_sha256, protocol, credit_window}`. The checkers accept /6 and /7.

**Native gates unchanged (re-verified after rebasing onto `main` `1b9b2b53`).** The native gates,
on the changed receiver with the capture rebuilt (19/19 ctests), were run one after another in
`artifacts/render-stream/g7e-native/r1/`, and none needed a rerun:

| Gate | Checks | Result |
| --- | --- | --- |
| −1 | 29/29 | PASS |
| 0 | 24/24 | PASS |
| 1 | 66/66 | PASS |
| 2 | 85/85 | PASS |
| 3 | 56/56 | PASS |
| 4 | 185/185 | PASS |
| 5, all groups | 116/116 | PASS |
| 5.5, all groups | 130/130 | PASS |
| 6, `--legs g6a,g6h,g6l,g6b,g6s,g6c` | 150/150 for the groups run | PASS |

Gate 6 scores 150/151 overall: the one failing check is `group-g6z`, which reports that `g6z`
was not in the leg set.

Gate 7 `--legs g7-0,g7-dev,g7-bench --make-sources` on the desktop had gate_passed true, with
these counts:

- G7h harness: 7/7
- g7-0@web: 22/22 (P-W1 again 25/25 shots identical)
- g7-dev: 12/12
- g7-bench: 16/16

All 34 `scripts/test/self-test-*.ts` pass, including G7d's `self-test-device-harness`.
`self-test-gate2` passes 406/406.

### Findings

1. **The web readback path is not native's, and it still matched.** On GLES (the web),
   `texture_2d_get` copies the RGB10_A2 target into a temporary RGBA8 texture with a shader. It
   then calls `glReadPixels` (`drivers/gles3/storage/texture_storage.cpp:1159-1198`). Desktop GL
   calls `glGetTexImage(GL_RGBA, GL_UNSIGNED_BYTE)` (`:1117-1155`). Q1a did not list this as a
   risk. Gate 0's flat colours land on the same bytes on both paths. Translucent or gradient
   values near a level midpoint could still differ (memory g7c-gpu-blend-conversion-facts: GPU
   float-to-unorm conversion is not guaranteed round-to-nearest). G7b watches for that.
2. **The first compositor run failed because `_quit` disposed the applier before the upload.**
   The canvas then showed only the clear colour while the PUTs ran. The fix moves the dispose
   after the upload on the web; natively the order is unchanged. The same run also showed the
   engine's start-up canvas focus ring, a 1 px dark border in the screenshot. The shell now sets
   `#canvas:focus { outline: none }`.
3. **Godot's web print hooks must be in the `Engine` constructor's config.** `init()` builds the
   module config, so an `onPrint` passed to `startGame` is ignored. (`onExit` is read at start
   time and does work there.)

### Deviations

- **`RS_RECEIVER_PROTOCOL` and the /7 hello are not built.** G7w (golden-7 and the /7 codecs) and
  G7n (the /7 listener) are not on `main`, so a /7 client could be neither built nor tested.
  Live mode on the web is G7l's. `RS_RECEIVER_TOKEN` (fragment to `--rs-env`) is plumbed through
  the shell only.
- **D11 says headless receiver legs are `not-applicable` in a browser.** G7e still runs gate 0's
  two headless classification legs, `corrupt` and `unsupported`, rendered, because a browser
  always renders. Both classify as they do natively.
- **G7d's `ctl-bench-<input>-web` arm stays `unavailable`.** The bundle now exists. G7m and G7o
  own the web bench, and Q13e's bench entry scene is theirs too.
- **The `g6z` group of gate 6 was not run.** It was not in the requested leg set, so gate 6
  scores 150/151, and the only failing check, `group-g6z`, records just that it did not run.
- **D21's dirty digest covers only the build's paths** (`receiver/`, `capture/`, `fixtures/`), so
  editing a checker does not invalidate a source run.
- **The `receiver-typecheck` support leg is native only.** Its self-test runs on the debug
  editor.

### What G7e does not prove

It does not prove gates 1 to 6 on the web (G7b), live mode or any WebSocket in a browser (G7l), the
web export's payload paths (gate 0 draws no texture: the store fetch and the `http-cache` mode
ran, the upload paths did not), warm startup or memory over time (G7k), or anything on a phone.

