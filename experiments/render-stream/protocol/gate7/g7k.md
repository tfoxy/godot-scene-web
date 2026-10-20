### G7k — startup, memory, soak (sonnet)

- **Files**: the `g7-k` legs, the samplers' wiring and the soak checks (Q10).
- **Checks**: Q10's startup and soak checks.
- **Sabotages**: `no-evict` and `leak-gl-textures` with exact failure sets.
- *Amended 2026-10-15 (D29):* GSW reports its wasm heap (`rs-gsw-wasm`'s `memory.buffer`, which
  never shrinks) beside the JS heap. `RS_RECEIVER_MEMORY_BUDGET_BYTES` counts the core's payload
  cache in wasm memory and the GL textures.


#### As built

Result: [results/gate7/g7k.md](../../results/gate7/g7k.md).

- **Legs.** `run-gate7.sh --legs g7-k --live` runs `run-gate6.sh --legs g6s` (soak) and
  `--legs g6l` (startup) once per browser kind, with `GATE7_MEM_SAMPLE=1` for the memory samplers
  (`gate7k-samplers.ts`). Knobs: `G7K_SKIP_SOAK`, `G7K_SKIP_STARTUP`, `G7K_SOAK_LEGS`,
  `G7K_STARTUP_LEGS`. Startup is `startup-cold-r0..r5` and `startup-warm-r0..r5`; `r0` is a cold
  load, `r1..r5` are the judged repeats. Warm needs HTTP validators, so run-gate7.sh sets
  `GATE7_STATIC_CACHE=1` for startup runs.
- **Budget.** GSW's budget is store payload bytes plus resident-texture GL bytes
  (`rs-core` accessors `Applier::resident_texture_hashes`, `PayloadStore::bytes_of`; output
  unchanged); the web export's is its GDScript payload cache. Staged payloads in the core (G7o3) are
  copies of cache entries and are unstaged on eviction, so they are not double counted; the wasm heap
  line shows them. The web export's received-bytes mirror is capped by
  `RS_RECEIVER_RECEIVED_MAX_BYTES` (1 MiB for soak legs).
- **Web soak pixels** are judged with G7b's `classifyShot` band against the native
  `reference-step11` (other must be 0; observed 9691/159/0 = G7b's oracle). GSW uses Q7.
- **Sabotage sets** are judged exactly (`G7K_SABOTAGE_SETS`). `leak-gl-textures` does not fail
  `gpu-mem-bounded` (`nvidia-smi` cannot see that allocation path), so that check is typed
  `unavailable` for the leg and the required set is `{residency-bounded:gl-textures}`.
- **Timing.** Startup distributions need a quiet machine (1-min load under about 4); an earlier
  pass under load 12-17 was superseded by a quiet rerun. A 12-leg startup run plus the soaks takes
  about 2 h wall when other agents hold the lock.
