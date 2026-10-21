# G7u as built: the lifecycle legs, the shim, `lifecycle.json` and the checks (the implementers' contract, kept with its as-built sections; the verdicts are in results/gate7/g7u.md)

Worktree: `/home/user/repo/godot-scene-web/.claude/worktrees/agent-a17c12f0a6c158b0d` (branch
`rs/g7u`). Contract: `protocol/gate7/g7u.md`, gate7-design.md D14 (Decisions table) and Q10
(suspension/lifecycle bullets only; startup/soak are G7k's).

## The user's decision (2026-10-18)

headless=new Chromium has no occlusion or freeze model (G7h Finding 1). So:

1. **Real** hidden/frozen legs run on the g31's real Chrome (adb serial ZY22FD8XP3, standing approval;
   close the tabs you open, never touch accounts/data, record battery/thermal per leg). The page is
   hidden for real (a new foreground tab via CDP `Target.createTarget`, or `adb shell input keyevent
   KEYCODE_HOME` then bring Chrome back), and the leg is only trusted after the page's own evidence
   shows it hidden (`visibilitychange` to `hidden`, rAF stopped) / frozen (`freeze` event, rAF and
   timers stopped).
2. **Desktop** headless legs use a page-side suspension: an injected shim holds the page's own rAF
   callbacks. Labelled `simulated-suspension` everywhere; they NEVER count as a pass of
   hidden/frozen, and their check ids name them separately (leg names start `sim-`).
3. A Q10 check no available mechanism can meet is typed `unavailable` with the reason, never a
   silent pass.

## Legs (group `g7-lc`, gate6-scene `animate`, `live` timeline S=300 N=60, steps time)

Run by `run-gate6.sh --legs g6l` with `G7U_LEGS=<csv>` (only those legs, then
reference-live-frames; the g6l legs and reference-file are skipped), under `GATE7_LIVE_KIND`,
into `<out>/gate6/lc-<kind>/live/<leg>/` (desktop) or `<out>/gate6/lc-<kind>-<device>/live/<leg>/`
(device). Each leg is a `g6l_leg` with receiver words (below) and, for the 30-s legs, the host word
`RS_FIXTURE_QUIT_FRAME=3180` (the reference-live-frames run gets the largest quit frame of the run's
legs). Every lc receiver also gets `RS_RECEIVER_SHOT_FINAL=1`.

`RS_RECEIVER_LIFECYCLE=<action>:...` is a HARNESS word: `mapBrowserLeg` drops it from the page env
(listed in `dropped`) and returns it parsed as `lifecycle`. `RS_RECEIVER_SHELL_SABOTAGE=css-opacity`
is also a harness word: it becomes `pageConfig.sabotage` (the shell's sabotage).

| Leg (desktop) | Leg (device) | Words |
| --- | --- | --- |
| `sim-hidden-2s` | `hidden-2s` | `RS_RECEIVER_LIFECYCLE=suspend:hidden:2:2000` (device mechanism `tab`) |
| `sim-hidden-30s` | `hidden-30s` | `suspend:hidden:2:30000:home` (desktop ignores the mechanism) + quit 3180 |
| `sim-frozen-30s` | `frozen-30s` | `suspend:frozen:2:30000` + quit 3180 |
| `reload` | `reload` | `reload:5` |
| `close` | `close` | `close:5` |
| `context-loss` | `context-loss` | `context-loss:5:500` |
| `sabotage-ack-while-hidden` (gsw) | same (gsw) | `suspend:hidden:2:2000` + `RS_RECEIVER_SABOTAGE=ack-while-hidden` |
| `sabotage-css-opacity` (gsw) | — | `suspend:hidden:2:2000` + `RS_RECEIVER_SHELL_SABOTAGE=css-opacity` |

`<step>` is the trigger: the receiver's own console line `shot step <k> seq <n> frame <f> -> ...`
(both receivers print it) for `k = step`, first occurrence.

## The shim (`scripts/lib/browser-probes/lifecycle-shim.js`, injected before any page script)

Desktop: `context.addInitScript`; device: `Page.addScriptToEvaluateOnNewDocument`. Both survive a
reload. The spec is prepended (`window.__rsLifecycleSpec = {...}`). It exposes
`window.__rsLifecycle` with `state()` (JSON-able record below), `suspended()` (boolean, true while
a simulated OR real suspension is in force) and `pending()` (an action the harness must perform:
`{id, what: "hide"|"freeze"|"close", ms}` or null; the harness calls `ack(id)` when done).

- Wraps `requestAnimationFrame`: counts callbacks run, keeps timestamps around the window. In a
  simulated suspension it HOLDS every callback requested while suspended, then on release runs
  them all from one real rAF (as a browser's pending list on resume).
- Wraps `console.log`/`info`/`debug` to see the trigger line. A 50-ms `setInterval` probe counts
  timer ticks (frozen evidence).
- Listens for `visibilitychange`, `freeze`, `resume`, `pagehide`, `pageshow`, and
  `webglcontextlost`/`webglcontextrestored` on every canvas.
- Actions at the trigger:
  - `suspend` (desktop): simulated. `hidden` holds rAF; `frozen` holds rAF AND defers every
    WebSocket `message`/`close` event dispatch (patched `WebSocket`) until release. Release after
    `ms` by `setTimeout`.
  - `suspend` (device): posts `pending()` = `hide`/`freeze`; the harness does it for real and
    restores it after `ms` (tab: `Target.createTarget` about:blank in front, later
    `Target.activateTarget` on the receiver tab + close the aux tab; home: `input keyevent
    KEYCODE_HOME`, later `am start` Chrome's package / `Target.activateTarget`; freeze:
    `Page.setWebLifecycleState frozen`, later `active`). No CDP evaluate polls while it is hidden.
  - `reload`: `location.reload()` (records survive in `sessionStorage`).
  - `close`: posts `pending()` = `close`; the harness closes the tab (exit code 0, the leg ends).
  - `context-loss`: `WEBGL_lose_context.loseContext()` on the receiver canvas's `webgl2` context,
    `restoreContext()` after the restore ms.

## `lifecycle.json` (written by the harness into the receiver dir at leg end)

```
{ "schema": "render-stream-lifecycle/1", "leg", "kind": "gsw"|"web", "env": "desktop"|"device",
  "spec": {"action", "suspend_kind": "hidden"|"frozen"|null, "step", "ms", "restore_ms", "mechanism_hint"},
  "simulated": bool,
  "mechanism": "simulated-suspension" | "real-hidden:new-foreground-tab" | "real-hidden:home-key"
             | "real-frozen:Page.setWebLifecycleState" | "location.reload" | "tab-close" | "WEBGL_lose_context",
  "pages": [ { "time_origin": performance.timeOrigin, "navigation": n, ...record } ],  // one per document (reload => 2)
  record = { "trigger": {"line","step","seq","frame","t"} | null,
             "window": {"requested_t","start_t","end_t"} | null,   // page performance.now() ms
             "raf": {"total","during","held","first_after_t","after_intervals_ms":[<=10]},
             "timers_during": n, "ws_events_deferred": n,
             "visibility": [{"t","state"}], "lifecycle_events": [{"t","type"}],
             "context": {"lost_t","restored_t"} | null },
  "took_effect": bool, "took_effect_detail": string,   // measured on the page, never the CDP reply
  "harness": {"actions": [{"wall_ms","what","detail"}]},
  "device": null | {"serial","model","chrome","conditions_before","conditions_after"},  // battery %, temp, thermal
  "compositor": "compositor/screenshot.png" | null }
```

For a simulated suspension `took_effect` is true by construction and `simulated` is true; the
checker labels every such check `simulated-suspension`. For a real one, hidden needs a `hidden`
visibility event inside the window and `raf.during == 0`; frozen needs `freeze`/`resume` events or
`raf.during == 0 && timers_during == 0`.

Every lc leg also writes `compositor/screenshot.png` (the canvas, CSS-pixel clip, at exit, after
`shots/final.png`), for `compositor-equals-readback` (gsw).

## Checks (`lib/gate7u-checks.ts`, `check-gate7.ts --live --legs g7-lc`)

Ids `<check>@<kind>:<leg>` (device legs `<check>@<kind>-<device>:<leg>`), each with `evidence:
"simulated-suspension"|"real"`. The stall model is G6l's: the suspended (stalled) seq is the one
whose credit spans the suspension (host log: the send whose credited ack is the latest after it;
for gsw the receiver clock equals the shim clock, so the window maps through the acks' receiver
timestamps), synthesised into `applied.live.stall` before `classifyG6lLeg`/`stallReport`.

- suspend legs: `took-effect` (real only), `raf-stopped`, `pending-bounded`, `host-unperturbed`
  (frame-interval p95 within 5 %, rate within 2 % of the same leg's pre-suspension window),
  `socket-kept`, `stall-latest`, `fetch-latest-only`, `resume-no-burst` (<= 2 applies in the first
  resumed frame, none skipped silently), `stall-recovery`, `credit-from-paced-loop`,
  `compositor-equals-readback` (gsw). Measured: resume-to-newest latency (host: the stalled seq's
  credit -> the recovery's applied ack; page: visible -> first rAF), coalesced count during.
- `reload`: `reconnect` (connection 2: new stream_id, seq 1 full; connection 1 closed by the
  receiver, its state freed), `reload-warm-cache` (0 repeated GETs; preflights per hash recorded or
  typed unavailable), `reload-pixels` (post-reload shots equal the reference).
- `close`: `close-seen` (host sees the close), `close-pins-retired`, `host-unperturbed`.
- `context-loss`: gsw `success` in place (uploads after restore == resident textures + meshes,
  credit resumes, shots equal the reference); web: `replay-failure context-lost` recorded, the shell
  reloads, the leg continues as `reload`, class `success` with `recovered: "reload"`, gap reported.
- Sabotages: `sabotage-ack-while-hidden` fails exactly {`credit-from-paced-loop`,
  `pending-bounded`}; `sabotage-css-opacity` fails exactly {`compositor-equals-readback`}.
- A missing device run makes every real hidden/frozen check `unavailable` (reason), never pass.

## As built, part A (harness + runner, desktop)

Files: `scripts/lib/browser-probes/lifecycle-shim.js`, `scripts/lib/gate7-lifecycle.ts` (spec
parsing, init script, `LifecycleDriver`, `LifecycleActions`), `scripts/lib/gate7-live-legs.ts`
(mapBrowserLeg, runBrowserLeg), `scripts/run-gate6.sh` (`g6l_lc_words`, `run_g7u_lc`),
`scripts/run-gate7.sh` (g7-lc landed), `scripts/gate7-tool.ts` (device refusal),
`scripts/test/self-test-gate7u-harness.ts`. Deviations and precisions to the contract above:

- The shim is injected with `page.addInitScript` (the leg's receiver page), not
  `context.addInitScript`: same reload survival, scoped to the one page.
- `pending()` is `{id, what, ms, mechanism}` (`mechanism` = the spec's `mechanism_hint`).
- Each `record` also has `errors: [string]` (shim-side failures: no `WEBGL_lose_context`, a
  sessionStorage quota, a `restoreContext` throw).
- Real (device) window: `requested_t` = the action posted; `start_t` = the first `hidden`
  visibilitychange (hidden) or `freeze` event (frozen) after it; `end_t` = the following
  `visible`/`resume`, or the harness's `ack(id)` if that never came. `raf.during` and
  `timers_during` count only inside [start_t, end_t). `suspended()` on the device is true from the
  post until end_t. Simulated: start_t = requested_t (the trigger's next task), end_t = release.
- `raf.first_after_t` is `performance.now()` when the first callback after `end_t` ran (the rAF
  frame timestamp is the frame's begin time and measured up to ~5 ms BEFORE the release on the
  desktop); `after_intervals_ms` are deltas of the distinct frame timestamps after it.
- Simulated frozen holds rAF and defers WebSocket `message`/`close` (both `addEventListener` and
  `onmessage`/`onclose`); timers keep running (so `timers_during` > 0 there by construction).
- A lifecycle leg's `stdout.log` is every document's lines in order (the shim stashes
  `__rsShell.lines` in sessionStorage at `pagehide`, newest 5000/1000 if over quota); timings.json
  stays the last document's. `page-config.json` gains `lifecycle: {spec, env, injected}` (only on
  a lifecycle leg; every other leg's files are byte-for-byte as before).
- `close`: the harness takes compositor/screenshot.png and the final state, then `page.close()`;
  exit code 0. On every other lc leg the screenshot is taken at exit (or timeout).
- Leg names are checked per environment in `run-gate6.sh`: `sim-*` and `sabotage-css-opacity` are
  desktop only, `hidden-*`/`frozen-*` device only (GATE7_LIFECYCLE_ENV=device); G7U_LEGS needs
  GATE7_LIVE_KIND. lc runs use 300-s host/receiver timeouts.
- `run-gate7.sh --env device --device <id> --live --legs g7-lc` (and only that group set) passes
  GATE7_LIFECYCLE_ENV=device and GATE7_DEVICE to run-gate6.sh / the daemon, into
  `<out>/gate6/lc-<kind>-<id>/`; default device lists: web hidden-2s, hidden-30s, frozen-30s,
  reload, close, context-loss; gsw adds sabotage-ack-while-hidden. The browser daemon
  (`gate7-tool.ts browser-daemon`) has no device support yet: it refuses with a `lifecycle:` error
  and run-gate7.sh exits 1 after printing it. `deviceLifecycleActions` (gate7-lifecycle.ts) is the
  stub interface the device agent implements (hide/freeze hold `ms` with no page evaluate, then
  restore; the driver acks).

## Device facts (g31 probe, Chrome 154, 2026-10-18; scratchpad g7u-probe)

- New-foreground-tab hide (`Target.createTarget {url: about:blank, browserContextId: <the receiver
  tab's>}` flat; it comes to the front by itself): hidden 4984 ms, but **3 rAF callbacks at the
  window's edges** (max rAF gap 4.9 s). `raf-stopped` on a real hide counts only callbacks strictly
  inside (hidden event + 50 ms, visible event) and reports the edge ones. Restore:
  `Target.activateTarget` (flat) + `Page.bringToFront` on the receiver session + `Target.closeTarget`
  on the aux tab (its "Render process gone" detach is expected). Restore to first rAF 21 ms.
- HOME hide (`adb shell input keyevent KEYCODE_HOME`): 0 rAF during, 5 s and 30 s. Restore:
  `adb shell am start -n com.android.chrome/com.google.android.apps.chrome.Main` (visible after
  ~120-170 ms, first rAF ~200-290 ms). The CDP session answered after every restore.
- While hidden: timers drop to 1 Hz, inbound WebSocket messages keep arriving at the full 60 Hz,
  sockets stay open over 30 s; no freeze or discard within 30 s.
- `Page.setWebLifecycleState frozen`: rAF 0, timers 0, WS 0 during; on `active` **both sockets fire
  error/close 1006**, and the page stays hidden until a HOME + `am start` round trip (3.6 s). So the
  real frozen-30s leg is expected to end `live-disconnected`: the checker reports `socket-kept` and
  what follows as measured failures with the reason, and must not crash on it.

## As built, part C (checker)

Files: `scripts/lib/gate7u-checks.ts`, `scripts/check-gate7.ts` (`--live --legs g7-lc`, g7-lc
landed), `scripts/test/self-test-gate7u.ts` (73 pure cases). Deviations and precisions:

- **`unavailable`** is a check with `status: "unavailable"`, `passed: false`, `gating: true`
  (printed `UNAV`; Gate -1's rule: not a pass). A kind with a desktop run and no
  `lc-<kind>-<device>/` gets one `real-suspension@<kind>-device:<leg>` per real leg (hidden-2s,
  hidden-30s, frozen-30s, and gsw's device sabotage), so a desktop-only run never has
  `gate_passed`. On a device leg whose took-effect fails, every check but took-effect,
  browser-provenance, console-clean, hello-recorded and receiver-core turns `unavailable`.
- Every check carries `evidence`: `simulated-suspension` when lifecycle.json says `simulated`
  (any `simulated` other than `false` counts as simulated), else `real` (reload, close and
  context-loss are real on the desktop too). Desktop suspension legs add `simulated-window` (the
  shim's window is at least 0.9 x ms and labelled simulated); `took-effect` is the device legs'.
- Per leg, besides the listed checks: `browser-provenance`, `console-clean` (the loss's own
  `CONTEXT_LOST_WEBGL` lines excepted on context-loss legs), `hello-recorded` (every host
  connection), `receiver-core` (web) and `leg-class` (G6l's classification over the synthesised
  stall, or over connection 2 for reload/web context loss). A sabotage leg's checks are folded into
  one `sabotage@<kind>:<leg>` check (as G7r), whose detail lists each one's status.
- The stall: gsw maps the page window by the acks' smallest `t_us - receiver_t_us`; the stalled seq
  is the first send credited at or after the window end less one host frame, and any other send
  inside the window (before that credit) fails `pending-bounded` (that is what the
  ack-while-hidden sabotage trips). web: the send after the trigger seq with the largest credit
  delay (must be at least half the requested ms).
- Pixels: each browser shot is compared with the reference frame it claims under Q7's band
  (readback/delta1 pixels snapped to that frame, never to a nearest candidate);
  compositor-equals-readback stays exact (`compositor/screenshot.png` vs `shots/final.png`). The
  final shot (`final: true`) is judged at its own frame and joins stall-recovery / *-pixels.
- `stall-latest` is G6l's rule re-implemented (pure) so that a recovery after the last shot window
  (frame > 1080: the 30-s legs) is judged by its state alone; `fetch-latest-only` and
  `stall-recovery` are G6l's own checks over a one-entry `live-stall` map, renamed.
- `close` `host-unperturbed` compares only the frame rate (perf-timeline.jsonl's 1-s samples
  before/after the close frame): the connection's live log ends at the close, so there is no
  per-frame p95 after it; the detail says so.
- `reload` reads `pages[i].navigation` as the shim's document ordinal (1, 2), and requires the
  second time origin after the first. Preflights are the host hook log's `http-get` lines with
  `method: "OPTIONS"`; none at all is typed `unavailable` in the detail and the summary.
- Context loss: gsw `context-restored` (applied.json `live.context_loss`: uploads_after_restore
  == resident, textures and meshes; a redraw after the restore; the page's lost/restored pair),
  `credit-resumes` (credited acks with `receiver_t_us > restored_us`, and sends after them),
  `context-pixels`; web `context-lost-recorded` (receiver/context-lost.json,
  render-stream-context-lost/1, and 2 documents), then reload's `reconnect`, `reload-warm-cache`,
  `context-pixels`, leg-class `success` with `recovered: "reload"`, the host-clock gap reported.
- `<out>/g7u-summary.json` (render-stream-g7u-summary/1): `real` and `simulated` leg lists (class,
  per-check status, measures: resume-to-newest host credit -> applied ack, page resume -> first
  rAF, coalesced/sends during, max in flight/pending, queued bytes, band-snapped px), the
  `unavailable` list and the runs. `raf.first_after_t` is a rAF timestamp (frame start), so the
  simulated page latency can be slightly negative (-4.5 ms on dev-a1).
- `host-unperturbed` (suspension legs) takes the suspension's host-frame range from the window on
  the host clock (gsw: the mapped page window; web: the credit gap), never from where a credit
  happened to land, and compares it with an equally long range before it. `fetch-latest-only`
  counts TEXA versions after the stalled send (G6l's) unless that send came more than 10 frames into
  the window (credit kept flowing), then after the window's first frame.
- Smoke results (2026-10-18, desktop): dev-a1 gsw sim-hidden-2s / reload / close, dev-b2 gsw
  sim-hidden-2s / context-loss and dev-a2 web sim-hidden-2s / context-loss pass every check.
  dev-b2's `sabotage-ack-while-hidden` fails more than its set because the receiver itself failed
  (`replay-failure` at seq 411, `resource-invalid: provide: nothing is needed`, after fetching
  TEXA d221cdc885fe twice): part B's, not the checker's.

## As built, part D (the real-device path)

Files: `scripts/lib/gate7-device-legs.ts` (new: the daemon's device mode), `scripts/lib/
gate7-lifecycle.ts` (`deviceLifecycleActions`, `DEVICE_LIFECYCLE_SUPPORT.ok`, `rafInsideWindow`,
the `device` block), `browser-probes/lifecycle-shim.js` (device-only `raf.during_t`),
`scripts/gate7-tool.ts` (browser-daemon under GATE7_LIFECYCLE_ENV=device; browser-receiver
refuses it), `scripts/lib/legs.sh` (the device daemon gets GATE7_HARNESS_PORT/GATE7_HOST_PORT),
`scripts/run-gate6.sh` / `run-gate7.sh` (G7U_START_FRAME), `scripts/lib/gate6l-checks.ts`
(`setG6lStartFrame`), `scripts/lib/gate7u-checks.ts` (device expectations), and both G7u
self-tests.

- **The daemon** (`gate7-tool.ts browser-daemon` with GATE7_LIFECYCLE_ENV=device): one
  `openHarnessDevice` per daemon (the device table's entry; `adb reverse` of the page port and
  the host port; session settings applied once, restored at exit). It refuses with a
  `lifecycle: device: ...` line in daemon.log (exit 1) when the phone cannot be opened, and any
  non-lifecycle or warm leg. Like the desktop's spare browser, the NEXT leg's tab is prepared
  while no leg runs: `targets.acquire` (perf-harness's ladder: `browser-context` on the g31's
  Chrome 154), the battery/thermal sample, and `checkDeviceProvenance` on its about:blank
  (provenance.json gets `kind: "device-provenance"`), so a leg costs only navigation + start-up.
- **Per leg**: `Runtime.enable` + `Page.enable`, the shim by `Page.addScriptToEvaluateOnNewDocument`
  before `Page.navigate`; console capture from `Runtime.consoleAPICalled` (args joined as
  Playwright's `text()`), `Runtime.exceptionThrown` (`pageerror`) and dialogs, filtered by the
  leg's session; the same files as the desktop leg (`page-config.json` adds `profile: null` and a
  `device` block); the exit poll is one expression per 100 ms and pauses while an action holds a
  hide/freeze; the tab is released (closed, its browser context disposed) at the end, by the
  `close` leg's action, or on abort (curl gone: the host sees the close; the phone's browser is
  never killed). **No compositor screenshot**: `compositor-equals-readback` is `unavailable` on
  every device gsw leg (a capture at DPR 2.625 cannot equal the 640x360 readback).
- **Actions** (`deviceLifecycleActions`): tab = `Target.createTarget` about:blank in the receiver's
  browser context, hold, `Target.activateTarget` + `Page.bringToFront`, close the aux tab; home =
  `input keyevent KEYCODE_HOME`, hold, `am start -n com.android.chrome/
  com.google.android.apps.chrome.Main`; freeze = `Page.setWebLifecycleState frozen`, hold,
  `active`, then (the page stays hidden) HOME + 1.5 s + `am start`. After each restore the
  harness polls `document.visibilityState` (1.5-s evaluates, up to 4 s) and falls back to
  `activateTarget` + `bringToFront`. lifecycle.json `harness.actions[].detail` has the timings.
- **The landscape lock does not survive HOME** (first device-gsw attempt): the g31's
  portrait-only launcher rewrites `system user_rotation` 1 -> 0, so after hidden-30s every later
  leg's tab was portrait (980x1836) and refused `device-orientation`. Every HOME round trip now
  re-applies the recorded landscape lock while the launcher is in front (before `am start`) and
  waits for a landscape viewport; each tab preparation re-asserts it too and gives a settling
  rotation up to 8 s (re-checked, never passed on a portrait page). Restore at exit still writes
  the recorded `before` values.
- **The start edge** (measured, dev-d-gsw1 hidden-2s): after a new-foreground-tab `hidden`, the
  g31 keeps 60-Hz rAF for ~90 ms (6 callbacks over 87 ms), then none until `visible`. The device
  shim records each in-window callback's time (`raf.during_t`, first 100); took-effect (harness and
  checker) and raf-stopped count only callbacks after `start_t + 150 ms` and report the edge ones
  (`REAL_HIDE_EDGE_MS` / `REAL_EDGE_MS`). A desktop record has no `during_t`: unchanged.
- **S** (`G7U_START_FRAME`, device runs only; run-gate7.sh's `G7U_DEVICE_START_FRAME_<kind>`):
  web **900**, gsw 300. The web export needs ~9.5 s from navigation to its connect on the g31
  (engine init 2.7 s incl. the 41 MB side module, start-game 6 s), so at S=300 it joined at frame
  581 (step 4) and never saw step 2's trigger (dev-d-web1); gsw joins before frame 308. Every
  derived frame moves with S (windows, motion windows S+20, quit S+780, the 30-s quit 3180+S-300,
  the sabotage frame); the lc hosts and the reference get `RS_FIXTURE_START_FRAME`; the daemon
  records it as lifecycle.json `device.fixture_start_frame` (null = 300). The checker reads S from
  the hosts' steps.jsonl (step 0's settle frame - 7), judges the run with `setG6lStartFrame(S)`
  (restored after) and fails `g7u-run` when a leg's recorded S differs. Desktop: always 300.
- **Checker device expectations** (desktop checks untouched): `browser-provenance` is Q13b's
  device verdict and must say `device-provenance`; `hello-recorded` takes the phone's
  presentation (dpr_milli = the page's DPR from provenance.json; backing = the canvas; CSS = the
  canvas for gsw, Godot's `backing * 1000 / dpr_milli` for web: 243x137); a real freeze's page
  resume measure starts at `resume`, not `visible`. `deviceRuns` lists directories only (the
  runner writes `lc-<kind>-<id>.log` beside the run).
- **Device results** (2026-10-18, g31, battery 100 %, 17.9-18.9 C, thermal none throughout;
  `artifacts/render-stream/gate7/g7u/device-{gsw,web}`): every hide took effect on the page
  (hidden event in the window, 0 rAF inside; gsw tab hides 7 / 1 start-edge callbacks) and every
  freeze (freeze/resume, 0 rAF, 0 timer ticks). gsw: hidden-2s, hidden-30s, reload, close,
  context-loss pass everything but the `unavailable` compositor check; the ack-while-hidden
  sabotage fails exactly its set; frozen-30s ends `live-disconnected` (1006 on `active`, the
  probe's fact) and fails socket-kept and what follows. web: hidden-2s, reload, close,
  context-loss pass; hidden-30s and frozen-30s end `replay-failure resource-unavailable`: a GET
  in flight across the suspension hits RS_RECEIVER_FETCH_TIMEOUT_MS (10 s, wall clock) on resume
  -- the web receiver's (part B's) finding, not the harness's. (Superseded on the tree merged with
  G7wf, `device-web-merged`: the browser `fetch()` completes during a hide, so hidden-30s passes,
  and frozen-30s ends `live-disconnected` 1006 like gsw; see results/gate7/g7u.md. The pre-merge
  `device-web` dir is deleted.) socket-kept now also fails on an
  applied.json `live-disconnected` failure (it passed a 1006 close before). A sabotage's exact
  set counts failed checks only; an `unavailable` one is listed, and makes the sabotage unproven
  only when the set needs it.
- **Trap**: run-gate6.sh and run-gate7.sh were replaced by rename (`mv` of an edited copy), not
  edited in place: a running bash reads its script incrementally, and the orchestrator's desktop
  runs were executing them. Sourced lib/legs.sh is read whole at `source`.

## As built, part E (the finisher: D14 as amended, a frozen page's lost socket)

Files: `web/gsw-receiver/{config,live}.ts`, `receiver/receiver.gd`, `receiver/rs_resource_fetcher.gd`,
`scripts/run-gate6.sh` (the frozen legs' word), `scripts/lib/gate7u-checks.ts`,
`scripts/test/self-test-gate7u.ts`.

- **The amendment (orchestrator's delegated call, 2026-10-18).** A frozen page may lose its
  transport. Recovery is gate 1d's reconnect: a new connection, a fresh session and hello, the
  newest state first, no burst, pending state bounded. The host treats the dead connection as
  gate 1d's killed receiver (it already does: it frees the connection and accepts the next one).
  Hidden pages keep "the WebSocket stays open", which the real hidden legs show.
- **`RS_RECEIVER_RECONNECT_ON_LOSS=1`** (both receivers; `run-gate6.sh` sets it on `frozen-30s`
  and `sim-frozen-30s` only). A connection that closes without an end record, other than a host
  1002/1008/1009 close, after a session, takes RS_RECEIVER_RECONNECT's part 2 instead of
  `live-disconnected`: dispose (the RIDs, the memory per RS_RECEIVER_RECONNECT_MEMORY, default
  drop), a new tap (`received-2.rs7`), then the next connection's fresh session. At most
  `LOSS_RECONNECTS_MAX` (3) per run. Each loss is a `live.loss_reconnects` entry (`connection`,
  `code`, `reason`, `after_seq`, `lost_us`, `opened_us`, `connect_attempts`, the dispose counts;
  GSW adds `visibility`). The key exists only when the word is set, so every other leg's
  applied.json keeps its keys. GSW and receiver.gd now fill one `reconnect record` (the scheduled
  `live.reconnect` or the newest loss entry) on dispose and connect retries. receiver.gd waits for
  a pending `submitted` (frame_post_draw) before it reconnects.
- **The web fetch timeout counts only running time** (`rs_resource_fetcher.gd`, web only). The
  first g31 web run with the reconnect showed the fetch trap: a GET issued 3 s before the freeze
  was served by the host before the freeze, but its promise callback had not run, and the first
  poll after `resume` was 31 s past the deadline (`resource-unavailable` at seq 65). Now a gap of
  more than `SUSPEND_GAP_MS` (1000) between two polls of a running GET is suspension time (the web
  main loop is rAF-driven, so a hidden or frozen page polls nothing) and moves the deadline by
  the gap; the receiver logs `fetch: GET ... spanned a <n> ms suspension`. Native receivers keep
  the wall-clock deadline. GSW's `fetcher.ts` timeout is a `setTimeout`, which a frozen page also
  fires on resume: not observed (no GSW GET was in flight at a freeze), recorded as a known gap.
- **The checker.** A frozen leg's `socket-kept` is now `socket-kept-or-reconnected`. The leg is
  judged *kept* (the old checks, unchanged) unless `transportLost`: a second host connection, an
  applied.json `live-disconnected`, a `live.loss_reconnects` entry, or host connection 1 closed
  other than the receiver's 1000 after the end record (the last catches a receiver that failed
  for another reason first, as the fetch timeout did). Then the same check ids judge the
  *lost* branch:
  - `leg-class`: G6l's class over both connections (connection 1 a prefix of its tap) is
    `success`.
  - `socket-kept-or-reconnected` (`evaluateLossReconnect`): exactly two host connections;
    connection 1 closed by the page's side (never the host) at least half the suspension after
    the trigger frame; connection 2 opened after that close, with a new stream_id, starting seq 1
    full; the receiver `ok`, two streams, the second with its end record; one loss reconnect from
    connection 1 that opened and left 0 RIDs; no scheduled reconnect; one document (a reconnect,
    not a reload).
  - `pending-bounded` (`evaluateLossPendingBounded`): both connections keep the window (in flight
    and pending at most 1, no send without credit, queued bytes in bounds), and connection 1 sends
    nothing between the suspension's start (gsw: the page window mapped through the acks; web:
    the close less half the suspension) and its close.
  - `stall-latest` (`evaluateNewestFirst`): connection 2's first applied transaction is its seq 1
    full, formed at or after connection 2 opened, and nothing of connection 1 is applied after it.
  - `fetch-latest-only`: TEXA's versions that landed between the suspension's start and connection
    2's first state are never fetched (TEXA is freed inside a 30-s suspension); G6l's rule over
    connection 2's fetches otherwise.
  - `resume-no-burst`: at most two applies in connection 2's first frame, none silent, and
    connection 1 lost at most the credit window (1) of sends with the socket.
  - `stall-recovery`: every connection 2 shot and the final shot equal the reference (Q7's band).
  - `host-unperturbed`, `raf-stopped`, `credit-from-paced-loop` and the compositor check as kept.
  Measures: `transport` (`kept`/`lost`), `resume_to_newest_host_us` (connection 1's host close,
  which Chrome sends on `active`, to connection 2's first credited ack), `loss_to_reconnect_open_ms`,
  `resume_to_visible_page_ms` and `visible_to_newest_page_ms` (gsw; the g31 page stays hidden
  after `active` until the harness's HOME + `am start` round trip and draws nothing until then),
  `lost_in_flight`, `loss_code_page`/`loss_close_host`, `connect_attempts`.
- **A frozen leg that neither keeps nor recovers its socket fails.** The pre-fix device-gsw run
  re-judged with this checker fails exactly the 7 frozen checks again (one connection, the
  `live-disconnected` failure, no `loss_reconnects`); the web run before the fetch rule fails 7
  (it judged `socket-kept-or-reconnected` kept and passed it until the 1001 host close counted as
  a loss). Self-test
  section 8 drives each lost-branch evaluator with an honest case and its failures.

**As built (G7uf, 2026-10-20).** The live `g7-6` `motion-monotonic@web` failures blamed on G7u
are not G7u's. The pre-G7u G7wf bundle and `main` with G7u's receiver hunks reversed fail the
same way at matched load. None of this part's receiver, fetcher or shell code runs on the
per-frame path. The failures come from two sources:

- load from outside the quiet lock;
- the check's microsecond hold threshold.

See [results/gate7/g7uf.md](../../results/gate7/g7uf.md).

**As built (G7mm, 2026-10-20).** The G7uf recommendation, with one change after the first live run.

- **Hold in frames.** Each receiver records `received_process_frame` (the receiver frame whose poll
  read the transaction) and `submitted_process_frame`: `receiver.gd` (native and the web export),
  and the GSW receiver (`live.ts`; the rAF callback that would first handle the record, so
  `processFrames + 1` at receipt). A fetch always defers its apply one frame, so the check now
  sees it as a hold whatever the frame jitter. The frozen core's decode and apply are untouched.
- **A frame count alone is too strict.** The first live web run failed 12 gaps of 3 that the
  microsecond rule excused: a frame iteration that took 20 ms for one process frame (receipt and
  `submitted` in the same frame). The check counts a hold if either rule holds, so no verdict that
  passed before fails now. Evidence without the frame fields has the microsecond rule only.
- **Timing check.** The g6l legs already ran in the `g6l` timing group. `run-gate6.sh`
  (`g6l_motion_leg`) now records the 1-min `/proc/loadavg` at each motion leg's start and end,
  judges the leg through `g6l-motion-leg.ts`, and reruns a failed leg once when either figure is
  above `G6L_RERUN_LOAD` (4). The first attempt's evidence moves to `<out>/g6l-attempts/`
  (gate 7's leg discovery skips it); `<leg>/attempts.json` lists both attempts and the check's
  note prints them.

See [results/gate7/g7mm.md](../../results/gate7/g7mm.md).
