---
name: gsw-wgpu-renderer
description: Guide implementation, review, and profiling of godot-scene-web's Rust canvas renderer built on wgpu. Use for the Rust/WASM renderer; use gsw-perf for the separate TypeScript WebGPU effects path.
---

# GSW Rust/wgpu renderer

Use this skill for `packages/canvas/rust-prototype`, its WGSL, Wasm boundary, and the TypeScript code that feeds it. The separate canvas-effects WebGPU runtime follows the [GSW performance skill](../gsw-perf/SKILL.md).

## Establish the version and backend first

- Read `packages/canvas/rust-prototype/Cargo.toml` and `Cargo.lock` before using API examples. The wgpu API and its backend behavior change between versions.
- The prototype currently builds for `wasm32-unknown-unknown`, enables its `webgl` feature, and constructs a GL backend. Treat it as WebGL2 unless both the implementation and runtime backend diagnostics show otherwise. The fact that wgpu supports Browser WebGPU does not mean this renderer is using it.
- Before relying on a local API detail, check `artifacts/reference/wgpu/manifest.json`. If it is absent or stale, run `bash scripts/update-wgpu-reference.sh`. Browse `artifacts/reference/wgpu/source/` and `artifacts/reference/wgpu/docs/` first; the manifest records the exact lockfile versions and crate checksums.
- The updater needs the `wasm32-unknown-unknown` Rust target. If it is missing, install it with `rustup target add wasm32-unknown-unknown`, then rerun the updater. Its downloaded reference is local and ignored by Git.

## Implementation and review

- Query the active adapter's capabilities and limits. Request only features the active backend supports, and keep the renderer's WebGL2/downlevel limits in view when changing layouts, texture counts, formats, or shader requirements.
- Choose surface formats from the actual surface capabilities. Track whether each intermediate is linear or sRGB and how the final surface encodes it. A backend or format change needs a layered-color pixel check; a flat-color smoke does not cover blending and intermediate-space mistakes.
- Treat every acquired surface texture according to the active backend's initialization and load rules. Do not infer that the prior canvas pixels survive acquisition, or that `preserveDrawingBuffer` changes wgpu's present path. Consult the pinned wgpu and wgpu-core source before depending on backend behavior.
- Keep validation failures from committing staged renderer state. Preserve the last accepted picture when a staged operation fails; handle device loss and surface acquisition errors as distinct conditions rather than reporting them as successful presentation.
- `queue.submit`, `queue.present`, an awaited validation scope, and browser/compositor display are different events. Do not use one as proof of another. Check the current [Rust renderer README](../../packages/canvas/rust-prototype/README.md) for the result contract and the latest [renderer optimization ledger](../../../sts2-couch-coop/docs/agents/renderer-optimization-ledger.md) for profiler capability verdicts. Re-probe capabilities when the adapter or backend changes.

## Optimize with evidence

- Before proposing a change, search the [renderer optimization ledger](../../../sts2-couch-coop/docs/agents/renderer-optimization-ledger.md) for prior attempts and read the relevant outcome. Record failed or inconclusive attempts too.
- Separate producer/serialization, Wasm admission, resource upload, command encoding/submission, GPU execution, and actual content presentation. Use the [Rust profiling handoff](../../../sts2-couch-coop/docs/agents/handoff-rust-webgl-profiling.md) for Rust-stage attribution and the [renderer benchmark contract](../../../sts2-couch-coop/docs/renderer-benchmark-contract.md) for comparable WebGL, WebGPU, and native Vulkan evidence.
- Keep output and hit behavior in the acceptance gate. Use the pixel and integration checks listed in the Rust renderer README for changes to draw output, resource updates, retained patches, or rollback behavior.
- If the question is a GSW canvas-effects WebGPU A/B or phone performance measurement, follow the [GSW performance skill](../gsw-perf/SKILL.md) instead of applying this Rust renderer workflow.
