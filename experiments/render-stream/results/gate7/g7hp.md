## Gate 7hp result (2026-10-18)

G7hp ([protocol/gate7/g7hp.md](../../protocol/gate7/g7hp.md); [gate7-design.md](../../protocol/gate7-design.md)
"Increments") moves every gate 7 live leg's Chromium profile out of the evidence tree. Before
this change, `lib/gate7-live-legs.ts`'s `serveBrowserDaemon` wrote each leg's profile to
`<out>/gate7-browser/profiles/<n>` and never removed it; `runBrowserReceiver` (the one-shot
`browser-receiver` form) already used a system-temp-dir profile but never removed it either.
Neither GPUCache, ShaderCache nor GraphiteDawnCache (the bulk of a profile's bytes) has any
evidence value.

### What changed

- `scripts/lib/gate7-live-legs.ts`:
  - `serveBrowserDaemon` now `mkdtemp`s one `gsw-chromium-profile-*` root under `os.tmpdir()`
    per daemon instead of `join(dirname(readyFile), "profiles")`. Every leg's profile (and a
    warm leg's copy-from source) lives under that root for the whole daemon's lifetime — a warm
    leg discovers its cold leg's profile lazily, from that leg's own `page-config.json`, so no
    single profile can be retired before the daemon itself shuts down. The root is removed in
    `shutdown` (reached by the existing `SIGTERM` handler and the existing parent-gone poll), plus
    a synchronous `process.on("exit", …)` net (`rmSync`) for a crash that skips `shutdown`.
  - `runBrowserReceiver` keeps its already-temp-dir profile (renamed to the same
    `gsw-chromium-profile-*` prefix for consistency) but now wraps the whole leg in
    `try/finally` so the profile is removed after normal completion, a thrown error from
    `prepareBrowser`/`runBrowserLeg`, and SIGTERM (the existing `onTerm` handler now runs
    `cleanup()` before `process.exit(143)`).
- `scripts/lib/gate7-live.ts`: `grepTree`'s `gate7-browser/profiles/` skip comment is updated to
  say it is now a defensive no-op (nothing lands there any more); the skip itself, and the
  sibling `gate7-browser` skips in `discoverBrowserLegs`/`discoverTracedLegs`/`bandSubstitutions`,
  are left in place (harmless, and still correctly keep `daemon.json`/`daemon.log` out of leg
  discovery).
- No check, sabotage, or evidence file's *shape* changed — `provenance.json`, `console.jsonl`,
  `page-config.json`, `env.txt`, `argv.txt` and `timings.json` are unchanged. Confirmed nothing
  reads profile *content* as evidence: `checkBrowserProvenance` reads the Chromium binary
  (`sha256File(launched.executablePath)`) and CDP (`SystemInfo.getProcessInfo`), never the
  profile directory; no checker or report opens a file under `profiles/`.
- Docs: `protocol/gate7/g7hp.md` (new), a new row in `gate7-design.md`'s increments table, a new
  `### G7hp` subsection and one amended sentence in `scripts/README.md`.

### Checks

| Check | Result |
| --- | --- |
| `tsc --noEmit -p experiments/render-stream/tsconfig.json` | clean |
| `biome check` on both touched `.ts` files | clean |
| Every pure self-test (`scripts/test/self-test-*.ts`, 39 files) | 37/37 pass; `self-test-record-digest.ts` and `self-test-rs-core.ts` need `--inputs <bench-recordings.json>` this fresh worktree never captured and this change never touches `rs-core` or record-digest code, so they were not run (same exclusion G7r's result doc used) |
| `run-gate7.sh --legs g7-1 --make-sources` (file legs, GSW + web rust core, one run) | `gate_passed=true`; 0 `profiles/` directories under `--out`; web legs still use `launchHarnessBrowser`'s ephemeral per-call Playwright profile (unaffected code path) |
| `run-gate7.sh --live --legs g7-1` (live legs, GSW + web rust core, one run) | `check-gate7: gate_passed=true`, 0 FAIL lines across both kinds (39 `PASS …@web`, 39 `PASS …@gsw` plus cadence reports); confirmed 0 `profiles/` directories anywhere under `--out`, and 0 leftover `gsw-chromium-profile-*` directories under the system temp dir after the run |
| Manual daemon SIGTERM (`gate7-tool.ts browser-daemon`, killed right after its eager spare-browser profile was created) | the `gsw-chromium-profile-*` root is gone after the process exits |
| Manual one-shot SIGTERM, timed to land after `process.on("SIGTERM", onTerm)` is registered (`gate7-tool.ts browser-receiver`, killed mid-leg) | exits 143; the leg's `gsw-chromium-profile-*` directory is gone after `wait` returns |
| Manual one-shot leg with a dead WebSocket target (normal completion path, no signal) | leg finishes itself (236 ms) and its temp directory is gone, proving the plain `finally` path also fires |

### Scoped re-runs (and why the rest is out of scope)

Per gate7-design.md "Scoped re-runs and milestone sweeps": this diff touches only
`scripts/lib/gate7-live-legs.ts` (the live browser daemon/one-shot launcher) and
`scripts/lib/gate7-live.ts` (the live checker's evidence-tree walks). It reaches every receiver
and every web-export core that can run a live leg, so one live group plus one file group on GSW
and on the web export's rust core (the default) — g7-1, as the orchestrator specified — is the
representative check:

- **Not re-run, and why**: native gates (0-6; `gate7-live-legs.ts` is gate-7-only code, never on
  the native receiver's own path), the GDScript web core (frozen at /7, milestone-swept only, and
  this diff's temp-dir change is core-agnostic — it sits entirely below `webCoreOf`/`coreEnv`), and
  the g31/g86 device arms (`openHarnessDevice`/`perf-harness/src/device.ts` is a completely
  separate launch path from `launchHarnessBrowser`/`gate7-live-legs.ts` and was not touched; its
  own device-profile handling, if any, is out of scope for this increment).
- **Other `g7-*` live groups** (g7-2, g7-5, g7-55, g7-6) were not re-run: they share the exact
  same `serveBrowserDaemon`/`runBrowserReceiver` code path as g7-1, with no group-specific branch
  in the changed functions, so g7-1 is representative. A full sweep is the orchestrator's call at
  the next milestone.
- **`gate7-bench.ts`** and the file legs' `gate7-web-legs.ts`/`lib/gate7-gsw.ts` were not
  re-run beyond the g7-1 file-leg pass above: both call `launchHarnessBrowser()` (an ephemeral
  Playwright-managed profile Playwright itself disposes of on `browser.close()`), never
  `launchPersistentContext`, so they hold no on-disk profile this increment could move.

### Memory-worthy

- **`chromium.launch()` (used by `launchHarnessBrowser`, hence every file leg and bench arm) and
  `chromium.launchPersistentContext()` (used only by `gate7-live-legs.ts`'s live legs) have
  opposite default profile-lifecycle behavior.** The former gets an ephemeral profile Playwright
  creates and deletes itself on `browser.close()` — nothing to fix there. The latter requires an
  explicit, caller-owned directory that Playwright *never* deletes, by design (that is exactly
  what makes a warm leg's cache reuse possible) — only the live-leg code needed this increment.
- **Playwright installs its own process-wide SIGTERM/SIGINT handling to gracefully close any
  browser it spawned.** Sending SIGTERM to a `browser-receiver` process *before* this script's own
  `process.on("SIGTERM", onTerm)` call has run (e.g., while still inside `prepareBrowser`) does not
  skip cleanup: Playwright's own handler closes the context first, which surfaces as an ordinary
  thrown `Error` (`"Target page, context or browser has been closed"`) through the normal
  `await`/`try`/`finally` chain, so the profile is still removed — just via the plain `finally`,
  with `process.exitCode` ending up `1` rather than `143` for that one early race window. Not a
  regression (the pre-existing code had the same unregistered-handler window); just a reason a
  `kill -TERM` racing the very start of a leg can show exit 1 instead of 143 while still cleaning
  up correctly.
- `self-test-record-digest.ts`/`self-test-rs-core.ts` fail fast with a usage error, not a real
  failure, on a worktree that never captured G7x's four bench recordings — G7r's result doc
  already established excluding these two from "every self-test-*.ts" when the change doesn't
  touch `rs-core`/record-digest code; worth keeping as the standing exclusion rather than
  rediscovering it each time.
- A concurrent agent's own milestone-sweep-sized `quiet.sh` shared hold (observed here, label
  `run-gate1.sh @web`'s own self-test wrapping, labelled under a different worktree) can occupy
  the exclusive lock's queue for 10+ minutes at a stretch even though it is only ONE shared
  holder — the "shared holders cannot starve an exclusive waiter" guarantee is about new shared
  arrivals not cutting in line, not about a single long shared hold finishing faster. Budget wall
  time accordingly when another agent is mid-sweep.
