### G7e — web export: build, shims, gate 0 (opus)

- **Prerequisite**: the official 4.5.1-stable `web_nothreads_release.zip` in
  `~/.cache/godot-render-stream/templates/4.5.1-stable/`, with its sha256 recorded in
  `scripts/README.md`. It is downloaded only with the operator's approval. If it is absent, the
  increment stops and reports.
- **Files**: `receiver/export_presets.cfg`, `receiver/web/shell.html`, `receiver/rs_config.gd`,
  `receiver/rs_io.gd`; the `receiver.gd`/`rs_perf.gd`/`rs_live_client.gd` call sites moved onto them;
  `RS_RECEIVER_PROTOCOL`; `scripts/build-web-receiver.sh`; `build.json`; the `g7-0` web legs; the
  gate 0 adapter in `gate7-adapters.ts`; `render-stream-receiver-applied/7` in all receivers
  and checkers.
- **Checks**: `g7-0@web`; `no-source-scene`; `compositor-equals-readback`; the web receiver's
  `applied.json` equals native's for the same recording on every field except timings and
  `receiver`; gates 0 to 6 natively unchanged.
- **Sabotages**: `RS_RECEIVER_SABOTAGE` through `--rs-env` (gate 0's receiver sabotages must
  classify exactly as natively); `css-opacity` fails exactly `compositor-equals-readback`.

