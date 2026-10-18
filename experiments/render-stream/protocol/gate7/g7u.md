### G7u — suspension and lifecycle (sonnet)

- **Files**: `g7-lc` legs and checks (Q10), using G7h's controller.
- **Checks**: Q10's lifecycle checks.
- **Sabotages**: `ack-while-hidden` and `css-opacity` with exact failure sets.
- *Amended 2026-10-15 (D29):* GSW's context restore is the renderer's in-place GL restore. The
  core re-uploads every live texture from its payload cache in wasm memory, refetching evicted
  hashes, and draws with no transaction.

- *Amended 2026-10-18 (user decision, D14 "As built (G7u)"):* headless=new Chromium has no
  occlusion or freeze model (G7h Finding 1). The real `hidden-*`/`frozen-30s` legs run on the
  g31's Chrome (adb serial ZY22FD8XP3): a new foreground tab or the home key hides the page, and
  `Page.setWebLifecycleState` freezes it. Each leg is trusted only when the page's own evidence
  shows it hidden or frozen. The desktop legs (`sim-*`) pause the page's own rAF loop through an
  injected test-only shim, are labelled `simulated-suspension`, and never count as a pass of
  hidden or frozen. A check no available mechanism can meet is typed `unavailable`.

- *Amended 2026-10-18 (orchestrator's delegated technical call, D14 "As amended"):* a frozen page
  may lose its transport: on the g31 a `Page.setWebLifecycleState` freeze closes the page's
  WebSocket on `active` (the page sees 1006, the host 1001). Recovery is gate 1d's reconnect: a new
  connection with a fresh session and hello, the newest state first, no burst, and bounded
  pending state; the host treats the dead connection as gate 1d's killed receiver. Both receivers
  do this under `RS_RECEIVER_RECONNECT_ON_LOSS=1`, which the frozen legs set. A frozen leg passes
  with its socket kept or with that recovery, never with neither; `socket-kept` is
  `socket-kept-or-reconnected` there. Hidden pages keep "the WebSocket stays open". The web
  export's payload fetch timeout counts only time while the page runs. Detail:
  [g7u-as-built.md](g7u-as-built.md), "As built, part E".
