### G7g — gate 6 scene and HD on both browsers (opus)

- **Files**: the gate 6 adapters; `g7-6` (file legs at 640×360, 1920×1080 and 960×540, and g6l
  live).
- **Checks**: gate 6's receiver and live checks `@web`, `@gsw` under Q7, every region including
  `HU`; `presentation-check` (each browser's backing store equals `presentation_size`).
- **Sabotages**: g6a's receiver sabotages and `ignore-presentation` / `ignore-canvas-stacking` with
  their native sets.

- **As built (G7g, 2026-10-17)**, details in the README's "Gate 7g result". `g7-6` passes on `gsw`
  (file and live, 38/38 and 25/25 gating checks) and on `web` on both cores (file 36/36 and live
  26/26, GDScript and Rust); every earlier `gsw` group (`g7-0`..`g7-55`, file and live) still
  passes under the rebuilt core. Four deviations from the plan:
  1. **The GSW backing store follows the leg's window** (`--resolution`, as receiver.gd's root),
     not the session's declared `presentation_size`: otherwise the presentation hazard (a 960x540
     window under a 1920x1080 presentation) could never be reproduced, because native types
     `presentation-mismatch` from the window, not from the backing store.
  2. **`animate`'s mask adds SC, LB, CD, TR and RT as `delta1`** on top of the default model: gate 6
     has no per-pixel animate model, and those regions' continuous writes (the scroll's triangle
     wave, the frame counter, TEXA's in-place updates) move or redraw inside the default model's
     "decided" shots. Observed drift is ≤1 everywhere once added.
  3. **The presentation hazard is judged under the half model with `keepUndecided`**, which forgives
     only `delta1`-sized (≤1) differences in otherwise-undecided (text) pixels; a larger
     undecided difference still counts, so the hazard's rasterization at oversampling 1 (its whole
     point) is still visible to `presentation-hazard-measured`.
  4. **`gate6l-checks.ts`'s browser adaptations follow G7l's precedent** for g2c/g5f/g55f:
     `received(-n).rs7` via `receivedFileName`, `getsVsFetches` given the cache mode and the cold
     leg's fetched hashes, a `warm-fetch` branch keyed off `cache.mode === "http-cache"` (the host
     serves only what live-scene's browser profile never fetched, and none of the static
     payloads), and the digest recording `served` hashes.

