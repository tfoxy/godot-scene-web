## Gate 7xd result (2026-10-17)

G7xd ([protocol/gate7/g7xd.md](../../protocol/gate7/g7xd.md); [gate7-design.md](../../protocol/gate7-design.md)
D34 amended 2026-10-17) flips the native receiver's and the web export's default core from
`gdscript` to `rust`. `gdscript` stays fully selectable (`RS_RECEIVER_CORE=gdscript`,
`--web-core gdscript`/`--core gdscript`); it is frozen at /7 and runs only in milestone sweeps
from here on. No decode, validate, resolve or apply code changed — G7xn, G7xw, G7xwl and G7o2
already proved the two cores byte-identical on every leg; this increment only moves the
"which one did nothing ask for" default.

### What changed

See [protocol/gate7/g7xd.md](../../protocol/gate7/g7xd.md) "Files" for the full list. In short:

- `receiver/receiver.gd`'s `_parse_core_env()` empty-env fallback is now `rust`.
- `scripts/lib/legs.sh`'s `receiver_core_env` (the runner's own `RS_RECEIVER_CORE` forwarding)
  treats `rust` as the no-op default instead of `gdscript`, and still forwards a non-empty
  `RS_RECEIVER_CORE_EXT` even when the core itself reads the (new) default.
- `scripts/run-gate7.sh --web-core`, `scripts/build-web-receiver.sh --core`,
  `scripts/gate7-tool.ts --core`, `scripts/gate7-bench.ts --core`,
  `scripts/lib/gate7-live-legs.ts`'s `webCoreOf()`/`coreEnv()`, `scripts/check-gate7.ts
  --web-core` and `scripts/lib/gate7-live.ts`'s `knownFailure`/`checkGateLive` defaults all flip
  to `rust`.
- The `GATE7_WEB_CORE_SABOTAGE=drop-env` sabotage's meaningful case flips: it used to show a
  `rust` run silently running GDScript when the env word was dropped; it now shows a `gdscript`
  run silently running `rust` instead (the rust-capable bundle's own unset-env behavior, post-flip).
  A `rust` run with `drop-env` is now a no-op (rust already adds no env word).
- `scripts/test/self-test-gate7l.ts`'s `webCoreOf`/`coreEnv`/`knownFailure` cases are rewritten
  for the flip; nothing that used to pass became untested — the gdscript-specific cases now name
  `gdscript` explicitly instead of relying on a default that no longer means that.
- Every present-tense "the default stays/is gdscript" sentence in `receiver/README.md`,
  `scripts/README.md`, the top-level `experiments/render-stream/README.md`, `protocol/gate7-design.md`
  (D34), `protocol/gate7/g7xn.md`, `protocol/gate7/g7xwl.md`, `results/gate7/g7xn.md` and
  `results/gate7/g7xw.md` gets a dated amendment note. Nothing is rewritten as if it were never
  true at the time.
- **Found by the milestone sweep itself, not by design**: `scripts/lib/gate1-live-checks.ts`'s and
  `scripts/lib/gate2c-checks.ts`'s `checkLiveReplayEqualsLive` compared each pair of `state/seq-
  <n>.json` dumps as raw text (`sa !== sb`) instead of parsing and comparing structurally, unlike
  every sibling state-dump check in the same files (`checkPatchVsFullReceiverState`'s
  `canonicalEqual`, `gate2c-checks.ts`'s own `statesEqual` a few lines above). That was silent
  while both the native "live" ground truth and the GSW "live-replay" happened to spell whole
  floats in their JSON the same way; flipping the native default to `rust` changed which
  spelling the native side's dump uses (`RsRustApplier.state_json()`'s capi `canon::write_state`,
  JS number spelling, e.g. `1`) while GSW's own dump kept its prior spelling (e.g. `1.0`) — same
  value, different text, so every live-replay state-dump comparison failed even though nothing
  was semantically wrong. Fixed by switching both functions to `readJson` + `canonicalEqual` /
  `statesEqual` (the established convention right beside them); verified with both gate1 and
  gate2's self-tests (402/402, 408/408) and a clean sweep rerun.

### Pure checks (no receiver, no browser, no device)

| Check | Result |
| --- | --- |
| Every pure self-test (`xargs -P 4` over `scripts/test/self-test-*.ts`) | 38/38 pass, including the rewritten `self-test-gate7l.ts` core-default cases |
| `cargo test --release` in `rs-core` | 37/37 pass |
| `cargo test --release` in `rs-core-capi` | 6/6 pass (`tests/replay.rs`) |
| `rs-core-check goldens --dir protocol` (native) | golden-2 73/73, golden-3 70/70, golden-4 108/108, golden-5 145/145, golden-6 165/165, golden-7 17/17, cross-version 9/9 — all pass |
| `self-test-rs-core-wasm.mjs` (wasm32 in Node) | 587/587 pass |
| `self-test-rs-core.ts --inputs <G7x bench inputs>` | scene-full/scene-patch/hd-patch/pace-patch: 0 mismatches, every record sha256 and canonical state equal |
| `self-test-record-digest.ts --inputs <same inputs>` | `record-digest-equal`/`record-digest-complete` pass on all four inputs |

Bench inputs: `/home/user/repo/godot-scene-web/artifacts/render-stream/gate7/g7d-r1/g7-bench/inputs/inputs.json`
(the path named in the task pointed at a since-pruned worktree; this is the same
`render-stream-gate7-bench-inputs/1` file under the main checkout's own artifacts tree — see
"Memory-worthy" below). `rs-core` build: `c0ed723722e8` (`artifacts/render-stream/rs-core/c0ed723722e8`).

### Sweep: every landed `g7-*` group, both web cores, GSW, native gates 0-6 both cores

The machine shared the whole sweep with another agent's (G7r, `rs/gate7-g7r`) concurrent exclusive
timing legs throughout (expected per gate7-design.md's quiet-lock design), and for roughly one
hour (≈21:55-23:11 UTC) also with an unrelated repo's (`open-slix-reference`) ~6-process
`dosbox-x` acquisition campaign running outside the quiet lock entirely (load average briefly 18
on a 12-core box). One real check (native rust gate 6's `g6c` rate class) landed inside that
external-load window and needed its one allowed rerun; everything else ran clean the first time or
turned out, on inspection, not to be a real failure at all (see "Reruns").

| Run | Receiver(s) | Core | Groups | Result |
| --- | --- | --- | --- | --- |
| `native/rust/gate<0..55>` | native | rust | g0,g1,g2,g3,g4,g5,g55 | `gate_passed=true`, clean, first pass |
| `native/rust/gate6` | native | rust | g6a,g6h,g6l,g6b,g6s,g6c,g6z | `gate_passed=false` first pass (1/154 checks: `leg-class-sabotage-constrained-ignore-credit`, extra `host-unperturbed` flag) — **load-caused** (dosbox-x window), confirmed by a clean standalone `--legs g6c` rerun (47/47, 0 extra flags) once the external load cleared |
| `native/gdscript/gate<0..6>` | native | gdscript | g0..g6, all 8 | `gate_passed=true`, clean, first pass, including gate 6 |
| `sweep-rust` | gsw | rust | g7-0..g7-6 (8) | 2 `live-replay-equals-live@gsw` fails (g7-1, g7-2) traced to a real bug in the *checker* (raw-text state-dump comparison instead of parse-and-compare); fixed (see "What changed"); re-verified clean (0 fails) both in an isolated `--receiver gsw --legs g7-1,g7-2` rerun and in a full checker re-run over the original capture (no re-capture needed — the fix is comparison-only) |
| `sweep-rust` | web | rust | g7-0..g7-6 (8) | all green once the live-replay fix landed; only the expected stale-provenance `source-run-valid` mismatches remain (re-stamped, see below) |
| `sweep-gdscript` | web | gdscript | g7-0..g7-6 (8, reusing `sweep-rust`'s sources) | 308 PASS; 9 FAIL are exactly the known `g7-5` mesh legs (`web-index-region-update`); 8 FAIL are the expected stale `source-run-valid` (re-stamped) |
| `live-rust` | gsw + web | rust | g7-1,2,5,55,6 (5; gsw is core-invariant) | 277 PASS, 0 FAIL |
| `live-gdscript` | web only | gdscript | g7-1,2,5,55,6 (5; gsw already covered above) | 136 PASS, 5 FAIL — the same known `g7-5` mesh/`web-index-region-update` class, this time on the live-mesh legs |

Every `gate7-source.json` under `sweep-rust/sources-made/gate<N>/` (read by both `sweep-rust` and
`sweep-gdscript`, which reuses the same sources) was re-stamped with `gate7-tool.ts
source-provenance` against this increment's final squash commit after landing, clearing the
`source-run-valid` mismatches above (they are a provenance-metadata artifact of the squash
happening after the sweep ran, not a content problem — see gate7-design.md "Scoped re-runs").

### Known, expected failures

See protocol doc. Unaffected by this increment: web export g7-5 mesh legs on `gdscript`
(`web-index-region-update`, seen on both the file legs and, new to this sweep's `--live` pass, the
live-mesh legs), GDScript receiver + `RS_RECEIVER_MEMORY_BUDGET_BYTES=200000` on gate 6, `pnpm
typecheck` in `upload-bench-entry.ts`, `pnpm check` red on baseline. None of these four are
exercised differently by this increment's own runs (file/gsw/web/live sweeps never set that memory
budget or touch that one file), so they were not independently re-verified here; they stand as
already documented.

### Reruns

- **Native rust gate 6, `g6c` (`leg-class-sabotage-constrained-ignore-credit`)**: first pass failed
  with an extra `host-unperturbed` flag (expected only `pending-bounded, queue-bounded`, the
  sabotage's intended signature). The leg's wall-clock window (≈22:56-23:04 UTC) overlaps the
  external `dosbox-x` load spike. Rerun alone (`run-gate6.sh --legs g6c`) once the load cleared
  (`pgrep -c dosbox-x` 0, load average ~5 on a 12-core box): clean, exactly the intended sabotage
  signature, nothing extra. Counted as the one allowed rerun for this check.
- **Not a rerun, a false alarm**: `g7-6`'s `g6s` sabotage legs (`sabotage-soak-no-evict`,
  `sabotage-soak-retain-superseded`) looked like failures from the per-leg summary line
  (`result_class: "success"` vs `expected_class: "residency-bounded fails"`), but that leg-entry
  pair is cosmetic bookkeeping (`result_class` there is just the host/receiver exit code, nothing
  about residency) — the actual named checks (`g6s-residency-bounded-*`,
  `g6s-cache-budget-respected-*`) both `[PASS]`ed on the original run and on an independent
  standalone rerun, correctly flagging each sabotage's intended metric. No code or check changed;
  recorded under "Memory-worthy" below so the next reader does not re-chase it.
- **`g7-1`/`g7-2` `live-replay-equals-live@gsw`**: not load-caused — reproduced identically on a
  second, much quieter rerun. Root-caused and fixed in code (see "What changed"); the fix itself
  is the "rerun," verified clean after the fix with no further reruns needed.

### Wall time

Approximate, from each run's own quiet-lock summary line (`wall` field) or its log's first/last
timestamp, all overlapping each other and G7r's concurrent runs on the same machine:

| Run | Wall time |
| --- | --- |
| `native-sweep` (both cores, gates 0-6, log timestamps) | ≈9h12m |
| `sweep-rust` (make-sources + gsw + web legs, g7-0..g7-6) | ≈6h48m (24492 s) |
| `sweep-gdscript` (web-core gdscript, reusing sources) | ≈47m (2833 s) |
| `live-rust` (gsw + web, g7-1,2,5,55,6) | ≈1h4m (3828 s) |
| `live-gdscript` (web only, same legs) | ≈31m (1842 s) |
| rerun: native rust gate 6, `g6c` alone | ≈21m (1272 s) |
| rerun: native rust gate 6, `g6s` alone (turned out unneeded) | ≈33m (2003 s) |
| rerun: `g7-1`/`g7-2` gsw-only remake (fix verification) | ≈42m (2544 s) |

Total elapsed wall time for this increment's verification phase (overlapped, not summed): roughly
10-11 hours, dominated by `quiet.sh` serialization against G7r's own concurrent timing legs, not
by this increment's own code.

### Memory-worthy

- The task's bench-inputs path pointed at `.claude/worktrees/agent-afcc2e9f03924d8ff/...`, a
  worktree already removed (memory: "Worktree removal loses artifacts"). The same
  `render-stream-gate7-bench-inputs/1` file survives under the **main checkout's own**
  `artifacts/render-stream/gate7/g7d-r1/g7-bench/inputs/inputs.json` (artifacts there are not
  worktree-scoped the same way); that is what this result used.
- `GATE7_WEB_CORE_SABOTAGE=drop-env` is a case where flipping "the default" silently inverts a
  sabotage's meaning: the same sabotage code path (omit one env word) now demonstrates the
  opposite wrong core. Any default flip with an "omit X, something else happens" sabotage needs
  its assertion re-derived from the new default, not just its literal string swapped.
- **`g6s`'s per-leg `legs[leg].result_class`/`expected_class` fields (`scripts/lib/gate6s-
  checks.ts` `runGate6s`) are cosmetic, not a pass/fail signal.** `result_class` there is literally
  just `ev.hostExitCode === 0 && ev.receiverExitCode === 0 ? "success" : "failed"`, and
  `expected_class` for a sabotage leg is the fixed string `"residency-bounded fails"` — these two
  are *never* going to literally match for a `failsMetric` leg, by construction, regardless of
  whether anything is actually wrong. The real verdict is in `report.checks` (`g6s-residency-
  bounded-<leg>`, `g6s-cache-budget-respected-<leg>`, etc.), which `gate_passed` actually reads.
  Reading the leg-entry mismatch as a failure cost a full standalone `--legs g6s` rerun (≈33 min)
  before the mistake was caught by checking `report.checks` directly.
- **A default flip can change which of two previously-aligned float-JSON spellings a dump
  uses, silently breaking any check that compares dumps as raw text instead of parsing them.**
  `receiver.gd`'s native dump writer branches on `_core_kind` (GDScript's own `JSON.stringify` vs
  the rust capi's `canon::write_state`, a *different* spelling convention, both "correct" in
  isolation); a checker that assumed byte-identical text across two different receiver
  implementations was really assuming "both currently happen to pick the same spelling," which the
  default flip broke. The fix is always to parse-and-compare (the codebase already has
  `canonicalEqual`/`statesEqual` for exactly this); grep a file for a sibling comparison before
  writing a new raw-text one.
- An unrelated repo's background CPU load (`open-slix-reference`'s `dosbox-x` acquisition
  campaigns, 3-6 processes near 100% CPU, load average up to ~18 on a 12-core box) is *not* covered
  by this repo's `quiet.sh` lock at all — it is a different process tree entirely. `quiet.sh status`
  and holder/waiter logs will look perfectly orderly while this kind of external load still
  perturbs a timing leg. `pgrep -c dosbox-x` (or just `ps --sort=-pcpu` and a glance at `uptime`)
  is the quick check; it cleared on its own within about an hour both times it appeared during this
  increment's sweep.
