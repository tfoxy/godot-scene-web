### G7k — startup, memory, soak (sonnet)

- **Files**: the `g7-k` legs, the samplers' wiring and the soak checks (Q10).
- **Checks**: Q10's startup and soak checks.
- **Sabotages**: `no-evict` and `leak-gl-textures` with exact failure sets.
- *Amended 2026-10-15 (D29):* GSW reports its wasm heap (`rs-gsw-wasm`'s `memory.buffer`, which
  never shrinks) beside the JS heap. `RS_RECEIVER_MEMORY_BUDGET_BYTES` counts the core's payload
  cache in wasm memory and the GL textures.

