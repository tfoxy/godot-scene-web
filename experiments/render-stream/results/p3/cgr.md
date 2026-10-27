# P3-CGR: isolate the g8cg reference runs' shader cache

**Problem.** `cg-reference-repeat` (gate 8 g8cg) failed once on a hosted runner (P3-TM's remote full
tier, run 40224586459) and passed elsewhere.

**Cause.** Godot's GLES3 backend keeps compiled program binaries in `user://shader_cache` (enabled by
default, `rasterizer_gles3.cpp:329-352`). `run-gate8.sh` gave `reference` and `reference-repeat` the
same default user data dir, so the repeat loaded the first run's binaries (and under `RS_LEG_SHARDS`
the two legs run in a parallel region and write one cache concurrently). The repeat was then not an
independent second run. No other gate sets a private user dir; this was the only repeat that read a
shader-sensitive back buffer. Not proven by a local failure (none reproduced); the shared-cache path
is confirmed from engine source and `run-gate8.sh`.

**Fix.** `run-gate8.sh` g8cg: each unarmed reference run gets `XDG_DATA_HOME=<leg dir>/xdg-data`, so it
starts with a cold, private shader cache; both dirs are removed after `legs_par_end`. The check and
its tolerance are untouched.

**Validation.**
- Local smoke `native-rust-gate8`: pass (526 s).
- Remote `--tier full --determinism 3,1 --only native-rust-gate8`, run 40462034136: all 4 repeats
  pass their own verdicts (`cg-reference-repeat` included). The cross-repeat comparison disagrees on
  1 of 185 shots between two different AMD EPYC models (7763 vs 9V45): a llvmpipe cross-runner
  difference, not this bug.
- Remote `--tier full`, run 40465393581: 6/6 runs pass (pure, native-rust-gate8, g7-gsw,
  g7-web-rust, g7live-gsw, g7live-web-rust). The `g8t` decode-cost timing group is left to the sweep.
