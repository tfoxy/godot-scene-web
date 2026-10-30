# MIR-F: follow-ups to the mirror "Use new renderer (Beta)"

## Item 1: bounded perf timeline

`evidence/perf-timeline.jsonl` (capture `entry.cpp`, `perf_timeline_tick`) was one line per second, opened
once with "w" and never trimmed: ~2 MB/h on a long-running streaming seat. Nothing in the couch-coop product reads
it (grep of the repo finds no reader); only the gate 6/7 checkers and benches do.

Decision: a generic, opt-in bound in the capture rather than turning the timeline off. The timeline is the only
host-side time series when the hook log is off, so a seat keeps its recent history for diagnosis, and the
gates stay byte-identical because the bound is off unless `GRC_PERF_TIMELINE_MAX_BYTES` is set.

`GRC_PERF_TIMELINE_MAX_BYTES=N` (decimal, `0`/unset = unbounded, malformed = unbounded): when the live file
reaches N/2 bytes it is renamed to `perf-timeline.jsonl.1` (replacing the previous one) and a fresh file starts, so
the pair holds the last N/2..N bytes. A file overshoots its half by at most one line.

Checked: g1c live legs with the bound forced to 1200 produced a `.1` rotation beside the live file in every host
evidence dir (live, live-headless, live-rate-30, sabotage-drop-message), with all non-skipped g1a/g1c checks
passing. Default path: no env, no code path change (a single added branch on `timeline_max_bytes > 0`).
couch-coop's streaming seat sets `GRC_PERF_TIMELINE_MAX_BYTES=8388608` (MIR-F commit there).

Validation (diff = capture/src/entry.cpp, protocol doc row, this doc):

- Remote `--tier full` (run 41011074368, key rv-20261030T055500Z-5277441-29023): 22/22 runs pass (native gates -1..8 and
  hc1 with sabotage legs, g7-*, cargo, pnpm-test, bench-instr). Refused remotely and so not run there: the g7live runs
  and every timing run.
- Local smoke (`validate-increment.sh`, tier smoke): lock-tests, pure, capture-build, cargo x4, pnpm-test, native gates
  -1, 0, 1, 2, 3 pass; bench-instr cannot run locally (no valgrind; the remote job produced it). Gate 4 onward was
  stopped for time (the machine's quiet lock was contended; gate 2 alone took 40 min) and is covered by the remote
  full run.
- The refused g7live g7-1 runs ran locally, smoke tier: g7live-gsw-g7-1 and g7live-web-rust-g7-1 both rc=0.
- Timing: not in scope (default path is unchanged; the bound is off unless the env is set).

## Item 2 and 3 (couch-coop commit e13c1192)

Item 2: package-release builds the client core and the capture and ships them (see that commit). Item 3: section 8 of
couch-coop `docs/agents/handoff-mirror-new-renderer.md`.
