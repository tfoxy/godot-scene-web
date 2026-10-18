## Gate 7u result (2026-10-18)

G7u ([protocol/gate7/g7u.md](../../protocol/gate7/g7u.md); gate7-design.md D14, Q10) tests
suspension and lifecycle on both browser receivers, GSW and the web export on the Rust core:
hidden and frozen pages, reload, tab close and WebGL context loss. The mechanism detail, the shim
and `lifecycle.json` are in [protocol/gate7/g7u-as-built.md](../../protocol/gate7/g7u-as-built.md).

Every verdict below is from the finisher's tree: G7u on top of main's 61fe688a (G7wf), GSW bundle
`gsw-bundle-fin` (wasm unchanged, `rs-core` 40c88db92733), web bundle `b1bb7e27d0f273c0` (Rust
core), each judged by the committed checker.

| Run | Pass | Fail | `unavailable` |
| --- | --- | --- | --- |
| desktop GSW | 70 | 0 | 4 |
| desktop web (Rust core) | 72 | 0 | 3 |
| g31 GSW | 66 | 0 | 3 |
| g31 web (Rust core) | 72 | 0 | 0 |

**Every real and simulated leg passes on both receivers and both environments.** The
`unavailable` checks are typed with their reasons (below), never passed: a desktop-only run has no
real hidden or frozen leg, so it never sets `gate_passed`.

**`frozen-30s` now passes on the g31 by D14 as amended.** A CDP `Page.setWebLifecycleState`
freeze closes the page's WebSocket when the page is set `active` again (the page sees 1006, the
host 1001), on both receivers, every time: "the WebSocket stays open" does not hold for a frozen
page. The orchestrator's amendment (a delegated technical call, 2026-10-18): a frozen page may
lose its transport, and recovers by gate 1d's reconnect -- a new connection with a fresh session
and hello, the newest state first, no burst, bounded pending state -- while the host treats the
dead connection as gate 1d's killed receiver. Hidden pages keep "the WebSocket stays open", and
both real hidden legs show it. Neither receiver reconnected on its own: both treated the close as
`live-disconnected`. Both now reconnect under `RS_RECEIVER_RECONNECT_ON_LOSS=1`, which the frozen
legs set, and the frozen leg's `socket-kept` became `socket-kept-or-reconnected` (kept, or lost
and recovered, never neither; [g7u-as-built.md](../../protocol/gate7/g7u-as-built.md), "As built,
part E").

**The web fetch timeout trap showed up on a frozen leg and is fixed.** The first reconnecting g31
web run (bundle `df4c89f05408cf0e`) failed `frozen-30s` with `resource-unavailable`: a GET the host
had served just before the freeze had not run its promise callback, and the first poll after
`resume` was 31 s past its 10-s deadline. `rs_resource_fetcher.gd` now counts only time while the
page runs on the web (a poll gap over 1 s moves the deadline by the gap;
`receiver/tests/fetcher_suspend_selftest.gd`). In the final runs no GET was in flight at a freeze
or a simulated hold (no `spanned a ... suspension` line in any leg), so the rule is shown by its
self-test and by the legs it must not disturb. GSW's `fetcher.ts` still times out by
`setTimeout`, which a frozen page fires on resume: a known gap, not observed.

**Both sabotages fail exactly as required.** `ack-while-hidden` fails exactly
`credit-from-paced-loop` and `pending-bounded`, on the desktop (119 sends inside the suspension)
and on the phone under a real hide (114). `css-opacity` fails exactly `compositor-equals-readback`.
It runs on the desktop only. **A frozen leg that neither keeps nor recovers its socket still
fails:** the pre-fix g31 GSW run re-judged by the final checker fails the same 7 frozen checks
(one connection, `live-disconnected`, no `loss_reconnects`), and the reconnecting web run that hit
the fetch trap fails 7.

```bash
# desktop, per kind (gsw needs --gsw-bundle; web needs --web-core rust --bundle <rust bundle>)
bash experiments/render-stream/scripts/run-gate7.sh --live --legs g7-lc --receiver gsw \
  --gsw-bundle <gsw bundle> --skip-harness-selftest \
  --out artifacts/render-stream/gate7/g7u/fin-desktop-gsw
# the g31 (adb serial ZY22FD8XP3), per kind
bash experiments/render-stream/scripts/run-gate7.sh --env device --device g31 --live \
  --legs g7-lc --receiver web --web-core rust --bundle <rust bundle> \
  --out artifacts/render-stream/gate7/g7u/fin-device-web
# re-judge any of them with the committed checker (a whole g7-lc run needs the runner's 12 GB heap)
NODE_OPTIONS=--max-old-space-size=12288 mise exec -- pnpm exec tsx --conditions=development \
  experiments/render-stream/scripts/check-gate7.ts \
  --out <dir> --legs g7-lc --live --receiver gsw|web [--web-core rust]
```

Box: Ryzen 5 5500, RTX 2060, gamescope headless, headless Chromium (`--headless=new`). The phone
is a moto g31 running Chrome 154, attached over adb. It stayed at battery 100 %, 20.5-24.6 °C and
thermal status `none` on every final leg. The scene is the gate 6 scene, `animate` variant, `live`
timeline, at credit window 1. Every timed leg held the quiet lock exclusive.

### The decision this rests on

headless=new Chromium has no occlusion or freeze model (G7h Finding 1). The user decided on
2026-10-18 how to handle that:

1. Real hidden and frozen legs run on the g31's real Chrome. A leg counts only when the page's own
   evidence shows the hide or freeze: a `visibilitychange` to `hidden` with rAF stopped, or a
   `freeze` event with rAF and timers stopped.
2. On the desktop the legs use an injected shim that holds the page's own rAF callbacks. These
   legs are named `sim-*` and labelled `simulated-suspension` on every check, and they never count
   as a pass of hidden or frozen.
3. A Q10 check that no available mechanism can meet is typed `unavailable` with its reason.

The finisher's amendment of D14 (the orchestrator's delegated call, after both g31 `frozen-30s`
legs closed 1006): a frozen page may lose its transport, and recovers with gate 1d's reconnect
semantics (above). Hidden pages keep the socket-stays-open expectation.

### What was built

- **Group `g7-lc`.** `run-gate7.sh --live --legs g7-lc` runs `run-gate6.sh --legs g6l` with
  `G7U_LEGS`, once per receiver kind, into `<out>/gate6/lc-<kind>[-<device>]/`. With
  `--env device --device g31` the same legs run on the phone. The desktop legs are `sim-hidden-2s`,
  `sim-hidden-30s`, `sim-frozen-30s`, `reload`, `close` and `context-loss`, and GSW adds
  `sabotage-ack-while-hidden` and `sabotage-css-opacity`. The device legs are `hidden-2s` (a new
  foreground tab), `hidden-30s` (the home key), `frozen-30s` (`Page.setWebLifecycleState`), the
  same three lifecycle legs, and GSW's `sabotage-ack-while-hidden`.
- **The shim** (`lib/browser-probes/lifecycle-shim.js`) is injected before any page script and
  survives a reload. It records rAF, timers, visibility and lifecycle events and the context
  events. It fires the action at the receiver's own `shot step 2` line. Then it either simulates
  the suspension or posts it for the harness to perform.
- **The device path** (`lib/gate7-device-legs.ts`) is the browser daemon's device mode. It uses
  one phone session per run, prepares the next leg's tab while no leg runs, captures the console
  over CDP and sends no evaluate while the page is hidden.
- **The checker** (`lib/gate7u-checks.ts`, `check-gate7.ts --live --legs g7-lc`) writes
  `<out>/g7u-summary.json` alongside `result.json`. Its stall model is G6l's, with the suspended seq
  synthesised from the host log.
- **GSW recovers from context loss in place** (`web/gsw-receiver/live.ts`, `web/gsw-rs`,
  `rs-core`'s `restore_missing`). While the context is lost the loop holds: it applies, draws and
  credits nothing. After the restore, one redraw re-uploads every resident texture and the
  vertex and index buffers that carry the meshes, then credit resumes. **The web export cannot
  restore in place**, because the engine only alerts "please reload". Its shell now records a
  `replay-failure` `context-lost` stub and reloads (`receiver/web/shell.html`), so the leg carries
  on as a reload and is judged `success` with `recovered: "reload"`.
- **Reconnect on a lost socket** (the finisher; `RS_RECEIVER_RECONNECT_ON_LOSS=1`, both receivers,
  set on the frozen legs). A close without an end record, other than a host error, after a session
  becomes gate 1d's reconnect instead of `live-disconnected`: dispose, a new tap, a fresh session on
  the next connection, at most 3 per run, each recorded in `live.loss_reconnects`. It reuses each
  receiver's RS_RECEIVER_RECONNECT part 2 (GSW `startNextConnection`, receiver.gd
  `_start_next_connection`). The web export's change is shell code only: receiver.gd's transport
  path and the fetcher, never the gdscript core's decode or apply.
- **The web fetch timeout counts only running time** (`rs_resource_fetcher.gd`, web only).

### Results: real suspension (the g31)

| Receiver | Leg | Credit gap | Resume→newest (host) | Resume→first rAF | Coalesced / sends during | First resumed frame applies |
| --- | --- | --- | --- | --- | --- | --- |
| GSW | hidden-2s (tab) | 2195 ms | 106 ms | 8.3 ms | 131 / 0 | 1 |
| GSW | hidden-30s (home) | 29 837 ms | 120 ms | 83 ms | 1790 / 0 | 1 |
| GSW | frozen-30s (lost, reconnected) | — | 3162 ms | 1188 ms | 2098 / 0 | 1 |
| GSW | sabotage-ack-while-hidden | 19 ms | 174 ms | 2.6 ms | 1 / **114** | 1 |
| web | hidden-2s (tab) | 2354 ms | 244 ms | 6.1 ms | 141 / 0 | 1 |
| web | hidden-30s (home) | 29 836 ms | 373 ms | 30 ms | 1790 / 0 | 1 |
| web | frozen-30s (lost, reconnected) | — | 3422 ms | 1179 ms | 2269 / 0 | 1 |

`max_in_flight` and `max_pending` were 1 on every suspension leg, on every connection, in both
environments, and the host frame rate stayed within `host-unperturbed`'s bounds before and during
each suspension. Both hidden legs kept their socket on both receivers.

**The frozen legs, measured.** Resume→newest on a frozen leg runs from connection 1's host close
(Chrome sends 1001 on `active`, so it marks the resume on the host clock) to connection 2's first
credited ack. It is dominated by the harness, not the receiver: after `active` the g31 page stays
hidden until the HOME + `am start` round trip, and draws nothing until it is visible.

| Receiver | Resume→reconnect open | Resume→visible (page) | Visible→newest applied | Resume→newest (host) | Sends lost with the socket |
| --- | --- | --- | --- | --- | --- |
| GSW | 1226 ms | 2851 ms | 313 ms (page clock) | 3162 ms | 0 |
| web | 1350 ms | 2865 ms | ≈ 557 ms (host − page) | 3422 ms | 1 (seq 70, in flight at the freeze) |

Both receivers noticed the close at their first rAF after `resume` (about 1.2 s; the page runs a
few callbacks while still hidden) and reconnected at the first attempt; GSW received connection
2's seq 1 44 ms after it opened. Its full state was then applied once the page was visible: seq 1 full,
formed after connection 2 opened, one apply in the first frame, nothing of connection 1 after it.
Every connection 2 shot and the final shot equal the reference. The freeze coalesced 2098 (GSW)
and 2269 (web) host frames on connection 1, and the close freed them.

### Results: simulated suspension (desktop)

| Receiver | Leg | Credit gap | Resume→newest (host) | Coalesced / sends during |
| --- | --- | --- | --- | --- |
| GSW | sim-hidden-2s | 1986 ms | 62 ms | 119 / 0 |
| GSW | sim-hidden-30s | 30 001 ms | 95 ms | 1800 / 0 |
| GSW | sim-frozen-30s | 29 988 ms | 94 ms | 1799 / 0 |
| GSW | sabotage-ack-while-hidden | 0.7 ms | 65 ms | 0 / **119** |
| GSW | sabotage-css-opacity | 1993 ms | 62 ms | 119 / 0 |
| web | sim-hidden-2s | 1995 ms | 46 ms | 119 / 0 |
| web | sim-hidden-30s | 29 999 ms | 48 ms | 1800 / 0 |
| web | sim-frozen-30s | 29 997 ms | 47 ms | 1799 / 0 |

Page resume→first rAF was under 1 ms on every simulated leg, since the shim releases the held
callbacks from one real rAF. Every resumed frame applied one transaction. Again `max_in_flight`
and `max_pending` were 1. A simulated freeze defers the socket's events but never closes it, so
both `sim-frozen-30s` legs are judged on the kept branch; only the g31 exercises the lost one.

### Results: reload, close, context loss

| Receiver / env | Reload gap (host) | Repeated GETs | Close code | Context-loss gap | Uploads after restore | Credits after restore |
| --- | --- | --- | --- | --- | --- | --- |
| GSW desktop | 243 ms | 0 | 1001 | 516 ms | 6 textures, 1 mesh (= resident) | 402 |
| GSW g31 | 615 ms | 0 | 1001 | 630 ms | 6 textures, 1 mesh (= resident) | 129 |
| web desktop | 1105 ms | 0 | 1001 | 1465 ms (reload) | — (reloads) | — |
| web g31 | 5521 ms | 0 | 1001 | 5581 ms (reload) | — (reloads) | — |

The web export's context-loss gap is a whole reload. On the g31 that costs about 5.6 s, most of it
the engine's start-up.

### `unavailable`, with reasons

- `compositor-equals-readback` on every device GSW suspension leg. The compositor capture is at
  the phone's DPR of 2.625, so it cannot equal the 640x360 readback pixel for pixel. The desktop
  legs answer this check.
- `real-suspension@<kind>-device:<leg>` for each real leg in a desktop-only out dir: GSW 4 (the
  three suspension legs plus the device sabotage), web 3. This is why a desktop run never has
  `gate_passed`.
- The reload's per-hash preflight counts, inside the passing `reload-warm-cache` check. The host's
  hook log names no `OPTIONS` request, so no CORS preflight reached it. The detail says so.

### Deviations

- `frozen-30s` uses `Page.setWebLifecycleState`, which closes the page's sockets on `active`. A
  natural Android background freeze needs minutes, which is outside the leg budget. So the leg
  measures the CDP freeze, and D14 was amended to judge what it shows: a lost socket recovered by
  gate 1d's reconnect (or a kept one). The recovery needs `RS_RECEIVER_RECONNECT_ON_LOSS=1`, a
  receiver word only the frozen legs set, so every other live leg's behaviour and applied.json
  keys are what they were; a product receiver would turn it on.
- The frozen legs' resume→newest includes the harness's HOME + `am start` round trip (about 2.9 s
  on the g31): the page stays hidden after `active` and draws nothing until it is visible. The
  results report the visible→newest share separately.
- The web device legs start at S=900, not 300 (`G7U_START_FRAME`), because the web export takes
  about 9.5 s to connect on the g31. Every derived frame moves with S, and the checker reads S from
  the hosts' steps.
- HOME breaks the landscape lock: the g31's portrait-only launcher rewrites `user_rotation`. Each
  HOME round trip re-applies the lock before `am start`.
- A new-tab hide draws about 90 ms of rAF callbacks after `hidden` (6 over 87 ms). `took-effect`
  and `raf-stopped` ignore callbacks within 150 ms of the window start and report them.

### Scoped re-runs

The finisher changed both receivers' transport code (GSW `live.ts`/`config.ts`; receiver.gd's
live loop and `rs_resource_fetcher.gd`, shell-side code only), the frozen legs' words
(`run-gate6.sh`) and the G7u checker. So, on the final bundles:

| Run | Result | Before the finisher |
| --- | --- | --- |
| desktop g7-lc, GSW / web | 70 + 4 unav / 72 + 3 unav | the same |
| g31 g7-lc, GSW / web | 66 + 3 unav / 72 | 59 + 7 fail + 3 unav / 65 + 7 fail |
| GSW live g7-1, g7-2 (the reconnect legs) | 38/38, 35/35 | 38/38, 35/35 |
| web (Rust core) live g7-1, g7-2 (the reconnect legs; g7-2's fetch legs) | 40/40, 37/37 | g7-1 39/39 before the merge with G7wf |

Every GSW and web verdict comes from the final checker (the GSW dirs ran before its last two
changes, the 1001 host-close rule and two page measures, and were re-judged). The pure
self-tests pass: `self-test-gate7u` 103/103 (section 8 is the lost-socket evaluators),
and all 41 `self-test-*.ts` pass (`self-test-record-digest` and `self-test-rs-core` on
g7d-r1's bench inputs, since g7b-r1's inputs.json names a removed worktree), plus `receiver/tests/fetcher_suspend_selftest.gd` (7 cases). `tsc` is clean and
Biome formats the changed files.

Out of scope:

- The gdscript web core: the finisher touched only receiver.gd's transport path and the fetcher,
  shared by both cores, and the frozen-30s leg runs on the Rust core (G7xd's default). The
  fetcher's suspension rule is web-only and the reconnect path runs only under the new word.
- The native gates: native receivers keep the wall-clock fetch deadline (`count_running_time_only`
  is false off the web) and never set `RS_RECEIVER_RECONNECT_ON_LOSS`; receiver.gd's refactor of
  the reconnect record is covered by the web g7-1/g7-2 reconnect legs, the same code path.
- The other live groups (g7-5, g7-55, g7-6, g7-r) and the file groups: no leg there loses a
  socket or sets the word, and their fetch paths see no poll gap over 1 s.

### Traps

- **A CDP freeze is not a background freeze.** `Page.setWebLifecycleState frozen` stops rAF,
  timers and WebSocket delivery. On `active` the page's sockets fire error/close 1006 and the host
  sees 1001; the page stays hidden until a HOME + `am start` round trip (about 2.9 s), though it
  runs a few rAF callbacks about 1.2 s after `active`.
- **A frozen GET can time out before its own callback runs.** The host served a GET just before
  the freeze; on resume the receiver's first poll found it 31 s past its wall-clock deadline
  before the browser ran the fetch's promise callback. A timeout on a suspendable page must count
  only running time.
- **A failure for another reason can hide a lost socket.** That web run ended
  `resource-unavailable`, not `live-disconnected`, with one host connection: the kept branch of
  the old checker passed `socket-kept`. The host's close code (1001, not the receiver's 1000) is
  what shows the loss, so `transportLost` reads it.
- **A hidden page still receives.** On the g31, while the page is hidden, timers drop to 1 Hz but
  WebSocket messages keep arriving at the full 60 Hz, and no freeze or discard came within 30 s.
  Credit, not the transport, is what bounds pending state.
- **check-gate7 on a whole g7-lc run needs the runner's heap.** Run alone it dies at node's 4 GB
  default (OOM, exit 134); the runner exports `--max-old-space-size=12288`.
- **Do not edit `run-gate*.sh` in place while a runner may be executing them.** A running bash
  reads its script as it goes. Replace the file by rename instead (`sed -i` renames).
- **Read a real hide's window from the page, not from CDP.** A successful CDP call does not show that
  the page is hidden, and the first ~90 ms after `hidden` still draw. `took-effect` is measured
  from the page's own events.

### Evidence (ignored)

Under `/home/user/repo/godot-scene-web/.claude/worktrees/agent-a17c12f0a6c158b0d/artifacts/render-stream/gate7/g7u/`:

- Final: `fin-desktop-gsw/`, `fin-desktop-web/`, `fin-device-gsw/`, `fin-device-web/` (each with
  `result.json` and `g7u-summary.json`; each device leg's `lifecycle.json` carries the battery and
  thermal samples), `fin-regress-gsw/`, `fin-regress-web/`.
- Negative controls: `device-gsw/` (the pre-fix g31 GSW run, re-judged: 7 frozen fails) and
  `prefetchfix-device-web/` (the reconnecting web run that hit the fetch timeout: 7 fails).
- Bundles: `gsw-bundle-fin/`; the web bundle is
  `artifacts/render-stream/web-receiver/b1bb7e27d0f273c0/`.
