### G7u — suspension and lifecycle (sonnet)

- **Files**: `g7-lc` legs and checks (Q10), using G7h's controller.
- **Checks**: Q10's lifecycle checks.
- **Sabotages**: `ack-while-hidden` and `css-opacity` with exact failure sets.
- *Amended 2026-10-15 (D29):* GSW's context restore is the renderer's in-place GL restore. The
  core re-uploads every live texture from its payload cache in wasm memory, refetching evicted
  hashes, and draws with no transaction.

