### G7h — browser harness, provenance, probes (sonnet)

- **Files**: `scripts/lib/browser-harness.ts` (Q6); `scripts/run-gate7.sh` skeleton
  (`--source`, `--make-sources`, `--legs`, `--out` defaulting to
  `artifacts/render-stream/gate7/<UTC>/`); `scripts/check-gate7.ts` skeleton;
  `package.json` `render-stream:gate7`; `scripts/lib/browser-probes/` (a minimal WebGL 2 page);
  `scripts/test/self-test-browser-harness.ts`.
- **Probes** (results written to `evidence/probes.json` and quoted "As built"):
  1. The renderer string and extensions under D9's flags.
  2. rAF rate when visible.
  3. Which Q1b mechanism hides a headless=new page, and the rAF count while hidden.
  4. That `Page.setWebLifecycleState` frozen stops tasks and keeps a WebSocket open.
  5. Preflight per URL and the preflight cache's lifetime across reload and across processes.
  6. HTTP-cache reuse for `Authorization` + `private, max-age` GETs.
  7. `EXT_disjoint_timer_query_webgl2` availability.
  8. Readback equals the CDP screenshot on an opaque WebGL frame.
- **Checks**: `browser-provenance` on the probe page; Wayland FD count 0 for every Chromium process;
  an evidence PUT outside the leg nonce rejected; a probe rect read back exactly.
- **Sabotage**: launching with `--use-angle=swiftshader` must make `browser-provenance` refuse.

