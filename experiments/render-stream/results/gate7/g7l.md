## Gate 7l result (2026-10-16)

G7l ([protocol/gate7/g7l.md](../../protocol/gate7/g7l.md); gate7-design.md Q2, Q3, Q4 "Live
client", Q5 "Credit and pacing", Q8, Q9) delivers the live legs of gates 1, 2, 5 (g5f) and 5.5
(g55f) to both browser receivers over render-stream/7. The capture's G7n listener serves both
browsers, and each sends the /7 hello with its token in the hello. **For `gsw`, `g7-1`, `g7-2`,
`g7-5` and `g7-55` live pass all 111 gating checks. For `web`, 106 of 111 pass. The five
failures are all `g7-5`'s mesh pixel checks, and each is G7b's typed `web-index-region-update`
refusal.** One run, no rerun:

```bash
bash experiments/render-stream/scripts/run-gate7.sh --live --legs g7-1,g7-2,g7-5,g7-55 \
  --out artifacts/render-stream/g7l/r1/gate7-live --skip-harness-selftest
```

| Group (live) | Browser legs | `web` | `gsw` |
| --- | --- | --- | --- |
| `g7-1` (g1c, g1d) | 11: live, live-headless, live-replay, live-rate-30, drop-message, stall, reconnect, resync, killed, ignore-credit, stale-coalesce | 38/38 | 38/38 |
| `g7-2` (g2c, g2e) | 15: live, live-headless, live-replay, warm, stall, reconnect, animate, unpin, drop-resource, wrong-hash, live-auth, no-token, bad-http-token, **origin-refused**, **no-cors** | 35/35 | 35/35 |
| `g7-5` (g5f) | 4: live-mesh, -warm, -stall, stale-coalesce | 14/19 | 19/19 |
| `g7-55` (g55f) | 4: live-shader, -warm, -stall, stale-coalesce | 19/19 | 19/19 |

**How a browser live leg runs.** A live leg cannot replay a source: its host paces against the
receiver it serves. `--live` therefore runs each gate's own runner again with
`GATE7_LIVE_KIND=web|gsw` (`--legs g1a,g1c,g1d` / `g2a,g2c,g2e` / `g5c,g5f` / `g55f`). In that
mode `lib/legs.sh` substitutes the browser for every live receiver and every `received.rs7`
replay, and gives each host the harness origin and one fixed port. A per-runner browser daemon
(`lib/gate7-live-legs.ts`) launches the browsers. The gate's own checker then judges the run
unforked. `check-gate7.ts --live` (`lib/gate7-live.ts`) runs that checker on three views: full,
blank (browser legs emptied) and banded (Q7). Every check whose verdict reads a browser leg is
reported `<id>@<kind>`, and every other check must pass (`native-legs@<kind>`, passed in all eight
runs). The protocol's "As built (G7l)" note has the mechanism.

**Gate 7's own checks, every group, both kinds:**

| Check | Result |
| --- | --- |
| `browser-provenance`, `console-clean` | Pass on all 34 browser legs per kind. |
| `hello-recorded` | Pass on 33 connections per kind: version 7, the kind, window 1 for 1, manifest, 640×360 at DPR 1000, the harness origin. |
| `credit-from-paced-loop` | Pass on 23 legs with submitted credit per kind, every ack checked. Web: `submitted_process_frame == process_frame`. GSW: applied and drawn in one rAF, acked from that rAF after the draw. |
| `token-not-logged` | Pass: 3 host tokens, none anywhere in either run tree. |
| `live-vs-replay` | Pass: gates 1 and 2's `live-replay-equals-live` on the browser's own file replay of `received.rs7`. |

**Supported, per receiver.** Both browsers do the following:

- **Hello and auth.** They speak /7 only. A `bearer` session gets the token in the hello, and
  the fragment carries it into the page, which removes it first. A 1008 `unauthorized` close
  before any session is `live-connect-failed`, and so is a 403 on the upgrade (`origin-refused`).
- **Resources.** They fetch cross-origin with `Authorization`, so Chromium sends one CORS
  preflight per hash URL. Under `no-cors` the receiver fails `resource-unavailable` at seq 1,
  after the host has served the GET.
- **Warm, stall, reconnect.** The warm legs fetch through the browser HTTP cache, copied from
  the cold leg's profile; the host saw 0 GETs on gate 2's live-warm. Stall, reconnect
  (`received-2.rs7`) and resync behave as the native receiver does.
- **Killed.** Killing the browser's processes gives host close 1006.

The receivers differ in these ways:

- **Web export.** It runs `receiver.gd` unchanged in semantics. `RS_RECEIVER_PROTOCOL=7` is the
  only value on the web; native keeps 6 as the default. **Refused**: the mesh index-region update
  (`web-index-region-update`, Godot 4.5.1's WebGL 2 bug, G7b). RM keeps its old triangles: 936 px
  from step 4. While RM fails in a checkpoint, g5f's per-checkpoint DF tolerance does not apply,
  so DF also differs (1 280 px) at step 5.
- **GSW.** New `live.ts` and `fetcher.ts` feed `gsw-rs`'s per-message API, one copy and one
  decode per message. A resync's full transaction is applied by a fresh applier, because the core
  applies deltas. GSW adds the `ack-on-receipt` sabotage: in a smoke run it failed
  `credit-from-paced-loop` on 155 of 155 transactions (`artifacts/render-stream/g7l/gsw/smoke/aor`;
  the full sabotage leg is G7r's). GSW refuses nothing in these groups.

**Pixels.** Gate 2's eight exact-pixel checks pass only in the banded view, in both browsers. Every
differing pixel is within one level (G7b's `delta1`/`readback` band): 42 shots replaced
whole, plus the static part of the animate leg's 12 shots snapped. Gates 1, 5.5 and (gsw) 5 are
exact.

**Live cadence** (host live summaries, `--max-fps 60` both ends, credit window 1). G6c's 60/60
phase lock shows in browsers too. Each run locks into one of two phases:

- **Good phase:** mean credit RTT 1 host frame, about 0.98 of offered frames published.
- **Bad phase:** 2 frames, about 0.5 to 0.6 published.

The `submitted` ack latency stays nearly constant within a run.

| Leg | `web` sent/offered, RTT frames p50 | `gsw` sent/offered, RTT frames p50 |
| --- | --- | --- |
| gate 1 live | 977/993, 1 (ack p50 7.0 ms) | 1056/1071, 1 (12.6 ms) |
| gate 1 resync | 495/994, 2 | 1068/1071, 1 |
| gate 2 live | 555/885, 2 (17.3 ms) | 952/963, 1 (2.9 ms) |
| gate 2 live-animate | 357/884, 2, p95 3 | 840/963, 1 |
| g5f live-mesh | 538/764, 1, **p95 5** (ack p95 69 ms) | 802/842, 1, p95 1 |
| g55f live-shader | 358/764, 2 | 827/841, 1 |

The web export's g5f tail, a credit RTT p95 of 5 frames, is not attributed here. GSW holds p95
at 1 frame on the same legs, so the tail is in the web receiver's per-transaction cost and not on
the wire. G7r's rate legs and G7v's benches own that measurement.

**Native gates re-run** (`receiver.gd`, `rs_live_client.gd`, `legs.sh`, the runners and the live
checkers changed; all on this tree, under the quiet-machine lock):

| Gate | Result | Evidence (ignored, `artifacts/render-stream/g7l/`) |
| --- | --- | --- |
| 0 | PASS 24/24 | `r1/native/gate0/` |
| 1 | PASS 66/66 (agent run on this tree) | `native/final/gate1/` |
| 2 | PASS 85/85, after the pins-rule change | `r1/native/gate2/` |
| 5 | PASS 116/116 | `r1/native/gate5/` |
| 5.5 | PASS 130/130 | `r1/native/gate55/` |
| 6, `--legs g6a,g6l,g6c` | g6a and g6l pass; g6c failed 5 timing checks; **rerun of g6c: 41/41** | `r1/native/gate6/`, `r1/native/gate6-g6c-rerun/` |

The first gate 6 run's g6c failures were `host-unperturbed` (frame interval p95 +6.6 %),
`rate-achieved` (55.5/s), `dual-independent`, the constrained sabotage's class and
`separation-gpu-heavy`. All five are listed load-sensitive checks. The desktop then carried load
from outside the lock: a .NET compile server and another product's test run. The rerun of
`--legs g6c` on a quieter machine passed every g6c check. Native runs never enter GATE7 mode, and
the receiver's /7 and web code paths sit behind `RS_RECEIVER_PROTOCOL=7` or `RsConfig.is_web()`.
Self-tests: gates 0, 1, 2, 5f, 55f, 6 (with 6l), 7b, 7e, 7l and rs2 all pass.

**After rebasing onto G7xn** (`c9f47553`; `receiver.gd` and `legs.sh` merged with its core
adapter), the web half ran again with the same counts: 38/38, 35/35 with the same eight
band-passed checks, 14/19 with the same five known failures, and 19/19 (`r2/gate7-live-web/`).
Native gates 1 (66/66) and 2 (85/85) passed again (`r2/native/`). GSW's files are untouched by
the merge.

**Checker change.** g2c's `pins-bounded` and `obsolete-retired` now use g5f's
`connTimelinesAtCallback`, moved to `gate2c-checks.ts`. G5f already found this race at its quit
frame 851. A browser closes within gate 2's quit frame 971, after that frame's callback, so the
last send is rightly still a base. Both checks failed on web live-animate in two runs before the
change and pass after it. Native gate 2 also passes with it (table above).

**G7f is void.** G6s fixed D20: `receiver.gd` resets `_data` per message. GSW decodes each message
on its own. Both browsers still keep `received.rs7` in memory until exit (MEMFS on the web, page
memory in GSW). That is G7k's soak concern, not a live-leg one.

**No device legs.** The contract names no g31 leg for G7l. The phone legs that need live browsers
are G7v's.

### What G7l does not prove

- **Window 2:** G7q, fork F1. Every hello asks for 1, and the host grants 1.
- **Q9's rate legs:** `phase-60`, `dual-*`, `constrained` and the `ack-on-receipt` leg are G7r's.
  Q10's lifecycle, startup and soak legs are G7u's and G7k's. Gate 6's g6l in a browser is G7g's.
- **Preflight caching:** an exact count of preflight-cache hits, beyond "one OPTIONS per new hash
  URL" (G7h's Finding 3 still stands).
- **Real displays:** headless Chromium only; presented frames stay `unavailable`.

Evidence (ignored): `artifacts/render-stream/g7l/r1/` (`gate7-live/`, `native/`, `selftests/`),
plus the agents' development runs under `artifacts/render-stream/g7l/{web,gsw}/`.
