### G7hp — browser-harness profile dirs out of evidence (sonnet, rs-increment agent)

`lib/browser-harness.ts`'s live-leg daemon and one-shot launcher
(`lib/gate7-live-legs.ts`) wrote each gate 7 live leg's Chromium profile under
`<out>/gate7-browser/profiles/<n>` — GPUCache, ShaderCache and GraphiteDawnCache, ~250 MB per
leg, with no evidence value, left in the run's evidence tree forever.

- **Files**:
  - `scripts/lib/gate7-live-legs.ts`: `serveBrowserDaemon` `mkdtemp`s one
    `gsw-chromium-profile-*` root under `os.tmpdir()` per daemon (never under `--out`); every
    leg's and warm leg's copy-from subdirectory lives there, removed whole at `shutdown`
    (SIGTERM or the parent-gone poll), plus a synchronous `process.on("exit", …)` net for a
    crash that skips `shutdown`. A warm leg still needs its cold leg's profile to survive until
    the daemon itself shuts down — it is discovered lazily from a sibling leg's
    `page-config.json`, so no single profile can be retired earlier. `runBrowserReceiver` (the
    one-shot `browser-receiver` form) already used a temp directory; it now removes it after its
    one leg on every exit path (normal return, a thrown error, SIGTERM after `leg.abort()`).
  - `scripts/lib/gate7-live.ts`: `grepTree`'s `gate7-browser/profiles/` skip, and the
    `gate7-browser` skip in `discoverBrowserLegs`/`discoverTracedLegs`/`bandSubstitutions`, stay
    as a defensive no-op (nothing reads profile content as evidence today; `checkBrowserProvenance`
    reads the Chromium binary and CDP, never the profile directory).
- **Checks**: no new check. Every pure self-test must still pass unchanged, since no leg's
  observable evidence (provenance.json, console.jsonl, page-config.json, env.txt, argv.txt,
  timings.json) changes shape.
- **Runs**: the browser/harness self-tests, every pure `self-test-*.ts`, and one landed live
  group plus one file group on GSW and on the web export (rust core) — e.g. g7-1 file and live —
  to prove no `profiles/` directory appears under evidence and no `gsw-chromium-profile-*` temp
  directory survives the run (including an aborted one).
- **Sabotage**: none named; this is an evidence-hygiene change, not a new protocol behavior.
- **Commit**: `test(render-stream): …` with `Changelog: none` (experiment code, no published
  package touched).
