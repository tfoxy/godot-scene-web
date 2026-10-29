# SWO: owners for two sweep failures (2026-10-29)

Two failures that had no owner before the pre-release delta sweep. Neither needed a capture or
receiver change: one check was wrong for HC1's quiet path, and the other is runner nondeterminism
below the receiver, which the remote tier now types as a known flake when its evidence holds.

## 1. g6l `live-reconnect`: `pins-bounded` / `obsolete-retired` (failing on main since HC1)

**Cause: the check, not the capture.** HC1 (37c41892, host-cost-design.md D6) pins and retires
nothing while no connection is a viewer. Between a close and the next hello the served set stays
as the last viewer callback left it, and the next viewer's first callback brings it back to
`current ∪ bases`. The pin replay (`pinsReport`, lib/gate2c-checks.ts, shared by g2c, g5f, g55f
and g6l) still compared every frame. In live-reconnect the receiver closes at frame 609 and says
hello again at 612, so frames 609 to 611 fail. These are the same frames and hashes HC4b recorded
(`9e9cfb36dd80 must be servable`, `da5622d1e896 is servable, named by nothing`). Gate 2's
reconnect hid the same gap only because its scene is static between steps.

**Fix (checks only; the capture is unchanged and still takes no snapshot without a viewer):**

- `ConnTimeline.hello` is the frame of the connection's `hello` line. A frame is a viewer frame
  when some connection has said hello and is not closed yet. `connTimelinesAtCallback`'s close
  rule still applies.
- `pinsReport` compares only viewer frames. It counts the others in `unviewed_frames` and reports a
  pin or retire line at one of them in `unviewed`, which fails pins-bounded at every call site
  (g2c, g5f, g55f, g6l). The budget is still judged at every frame.
- Because the first viewer frame after a gap must match exactly, a pin missed at the hello, or a
  hash that is never retired across the gap, still fails there.
- A timeline without a hello line counts as a viewer from the start, which keeps the synthesized
  timelines working.
- g6l's criteria say all this. Its pins note now reads
  `live-reconnect 1036 frames (+3 with no viewer, not compared)`.
- The synthesized gate 2 fixture (`test/gate2c-fixture.ts`) now follows HC1: no serving lines at a
  frame with no viewer. Before, it pinned from frame 1 regardless.
- `self-test-gate5f`'s close-before-callback case now expects HC1's behaviour: frame 851 is
  viewerless, so it is not compared and its pin is reported.

**Proof that the checks still catch a real regression:**

- **Same evidence, before and after.** On one real local g6l run (`artifacts/swo-g6l-base`), main's
  checker fails both checks at frames 609–611 (`g6l-main-check.log`). This branch's checker passes
  them (`live-reconnect 1035 frames (+3 with no viewer, not compared)`).
- **Mutation on that real evidence.** Dropping one retire line at the reconnect's hello callback
  (frame 612, hash `84e236da7f06`) fails both pins-bounded and obsolete-retired
  (`live-reconnect: frame 612: 84e236da7f06 is servable, named by nothing`, then 613 and 614).
  See `g6l-mutation-drop-retire.log`.
- **Unit cases** (`test/self-test-gate6l.ts` section 7):
  - the gap is skipped;
  - without hello frames the gap fails exactly as g6l did;
  - a base never retired across the gap is late at the hello;
  - a state not pinned at the hello is missing;
  - a pin with no viewer is reported.
- **Gate 2's mutation scenarios** `live-pin-missing` and `live-never-retired` still fail
  (self-test-gate2 454/454).
- **Final local g6l run** (`run-gate6.sh --legs g6l`, real time): every g6l check passes. The only
  rows that fail are the 6 not-run groups. Load rose to 8–13 during the run because of other
  agents; the pin checks do not depend on load.

## 2. g7-web-rust g7-8 `mm-reference@web` / `web-repeat-identical@web` (hosted-runner flake)

**Sightings.** 15 hosted remote runs from 10-28 10:24 to 10-29 08:39 failed g7-web-rust@g7-8, and
13 of them failed on these rows: 40671875366, 40687061757, 40692187022, 40700170794, 40727924253,
40730489574, 40775295093, 40793567879, 40800183623, 40806257199, 40817705246, 40826140543,
40826403611 and 40843756181. Four runs passed in the same window. It has failed since g8mm's web
legs existed (e7182407, PM2). It is not a regression.

The rows that fail are always mm-reference, mm-reference-catches-{stale-buffer, perturb-instance,
ignore-identity-transform} and web-repeat-identical, and the differing pixels are always in C_FLIP
and D_GLOBAL.

**Not CPU vendor.** The failures came from AMD EPYC 7763, 9V74 and 9V45 runners and from Intel
Xeon 6973P-C and Platinum 8573C runners alike.

**Reproduced locally on the CI renderer.** Local lavapipe is the same Mesa 25.2.8 and is selected
through `VK_ICD_FILENAMES=.../lvp_icd.json`. The CI allowance env was set by hand for the probe
only; nothing commits it. The probe replayed the g8mm web legs on one bundle and one source:

| renderer / condition | runs with a bad leg | bad shots |
| -------------------- | ------------------: | --------: |
| lavapipe, lazy store (default) | 4/10 | 12/330 |
| lavapipe, `GATE7_WEB_STORE=staged` | 5/10 | 17/330 |
| lavapipe, `LP_NUM_THREADS=1` | 1/8 | 4/264 |
| ANGLE on NVIDIA RTX 2060 (the local default) | 0/10 | 0/330 |
| first 5-run probe (lavapipe) | 1/5 | 8/165 |

**What goes wrong.** In a bad leg, some of C_FLIP's and D_GLOBAL's CPUParticles2D instances draw
as opaque black quads (0,0,0,255). The fixture draws nothing black. A live particle can also show
a stale flipbook frame: in one shot, 104 px are red (frame 0) where the good run has yellow
(frame 3). Particle position and shape are right. The black count grows as particles are emitted
(D_GLOBAL in steps of 9 px, one 3x3 particle per frame), so newly emitted instances are drawn with
an older colour/custom attribute. The pixel counts are the hosted runs' own: 1083/1071/1492/1503
(40775295093, 40793567879 and 40800183623), 942 (40727924253), 1035/1056 and 102.

**Not ours, as far as the evidence reaches:**

- The receiver's input to Godot is identical in a good run and a bad run. Their applied.json files
  are equal apart from the wall-clock and path fields: the same per-transaction digests, process
  frames and RS calls (one `multimesh_set_buffer` of the whole buffer per change).
- The store mode makes no difference (lazy vs staged).
- NVIDIA never shows it. Native llvmpipe GL and GSW on the same lavapipe never show it either.
- It sits below the RenderingServer, in the stock 4.5.1 web template's GLES3, Chromium's ANGLE
  Vulkan and lavapipe. GLES3's canvas has a timing-dependent path. In
  `canvas_render_items`, an unsignaled fence makes it allocate a new instance-data buffer, so a
  slow GPU takes a different path from a fast one. ANGLE's buffer ghosting under a busy GPU is
  another candidate. Pinning down which one is outside this repo; we cannot patch either.

**Fix: a typed known flake, only on its evidence** (`lib/gate7-web-flakes.ts`, wired into
`checkGateWeb` for gate 8 only). A failing `mm-reference@web`, `mm-reference-catches-*@web` or
`web-repeat-identical@web` row gets `status: "known-flake"` only when all of these hold. It keeps
`passed: false`, and its evidence is appended to the detail.

- The checker runs under the CI lavapipe allowance. A local run never types anything.
- Every shot that differs between the same build's two web runs (`web/` and `web-repeat/`) is a
  g8mm shot whose differing pixels all lie in the particle cells: C_FLIP, D_GLOBAL, and the
  identity-transform spill cell G_HIDDEN, where ignore-identity-transform draws D_GLOBAL's
  particles. At least one of those shots also has opaque-black pixels there. A single other
  repeat difference types nothing.
- Every problem in the row is a pixel difference confined to those cells, on a leg whose two web
  runs disagree. A deterministic regression repeats identically, so its leg has no such evidence
  and the row stays FAIL. A missing shot, a missing applied.json, an uncaught sabotage or a failing
  native view also leaves the row FAIL.

`lib/tier-verdict.py` lists such rows as `known_flakes`. Like typed unavailable rows, they explain
a runner exit of 1, never fail or pass the verdict on their own, and never hide a real failure
beside them. `validate-summary.json` carries `known_flakes` per run, and `check-gate7.ts` prints
them as `FLAKE`.

Replaying the failing rows of all 15 hosted result.json files through the typing (with each run's
own repeat list as its evidence) types every particle row. Run 40730489574's unrelated g8w11
`scale/off` hang stays FAIL: its web-repeat-identical row also names `no repeat`. On the local
lavapipe evidence, every bad run meets the signature. NVIDIA-vs-lavapipe differences (a control)
do not.

**Residual risk.** A real web regression that is itself nondeterministic, lives only in the
particle cells and draws black would be typed on hosted runners. Local runs (NVIDIA, no allowance)
would still fail on it. The same race may exist on slow real GPUs. ANGLE on Android usually runs
on GLES, not Vulkan, and the g31 legs never showed it, but nothing here measured that.

## Checks and runs

- **Self-tests:** gate6 273/273, gate2 454/454, gate5f, gate7b (the flake cases), tier-verdict (4
  new cases). The first local pure run caught that the synthesized gate 2 fixture and gate5f's
  close case still modelled pre-HC1 serving, so both were updated (above). Pure then passed 6/6
  shards remotely, and gate6, gate7b and tier-verdict passed again after the rebase onto 3a624e89.
- **Local g6l,** real time: every g6l check passes (`artifacts/swo-g6l-final`).
- **Remote full tier:** `scripts/remote-validate.sh --tier full`, run 40884369243 (key
  `rv-20261029T134209Z-d147d81-21177`, base 8bfb9490), passed 8/8: pure, native gates 2, 5 and
  55, and g7-gsw, g7-web-rust, g7live-gsw and g7live-web-rust, all with sabotage legs. On that run
  (AMD EPYC 7763) the flake happened again. g7-web-rust's `known_flakes` lists `mm-reference@web`,
  `mm-reference-catches-ignore-identity-transform@web`, `mm-reference-catches-stale-buffer@web`
  and `web-repeat-identical@web`, and the run passed on them; nothing else failed.
- **Local refused runs** (`RS_VALIDATE_GROUPS=g7-1 --only g7live-gsw,g7live-web-rust`):
  2/2 pass.
- **Not run:** the timing runs (gate 6's other groups, g7live-*-timing, g7x) go to the milestone
  sweep. In gate 6, the diff reaches only g6l's pin checks.

Evidence: `artifacts/render-stream/p3/swo/` in the main checkout.
