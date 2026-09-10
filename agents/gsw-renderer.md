---
name: gsw-renderer
description: Work on the rendering half of this toolkit — packages/canvas, html, hb-gpu, the WebGL/WebGPU backends, particles, shaders and text. Use for any change to what appears on screen, including bugs reported by a downstream consumer.
---

# Renderer work

The parser and layout half of this repo has been stable for a while; essentially all motion is in rendering and
measurement. That is also where the boundary is easiest to violate and where "it passes the unit tests" is least
convincing.

## The boundary, first

Do not add CouchCoop, spirectl, Slay the Spire 2, catalog, runtime-state, browser-envelope or product-specific DTO
concepts to `packages/core` or `packages/tscn-parser`. The parser stays Unix-small: Godot text in, Godot-like AST
out, property names preserved verbatim (`layout_mode`, `anchors_preset`, `offset_left`). Interpretation belongs in
`layout`, `html`, `canvas`, `vue`. Live-Godot JSON is validation **evidence**, not a parser input contract.

The Control-coverage non-gaps in `AGENTS.md` are deliberate. Do not "fix" one without a parity need.

## Dev loop

```bash
mise exec -- pnpm check          # format:check && typecheck && test — the aggregate gate
mise exec -- pnpm test           # vitest, jsdom
mise exec -- pnpm test:parity    # harness tests + every fixture
mise exec -- pnpm build          # per-package tsdown into dist/
```

Godot source and docs for engine questions: `../godot-4.5.1-stable`, `../godot-docs-4.5`. This project targets
4.5.1 — there are 4.6 checkouts on this machine; do not cross-reference the wrong version.

## Traps that make a green run meaningless

- **The `development` export condition.** Package `exports` only point at `src/` when it is active. `tsconfig.base.json`
  sets `customConditions: ["development"]`, every `tsx` script passes `--conditions=development`, and vitest aliases
  straight to `src/`. Anything resolving **without** it gets `dist/` — a stale build. The guard warns on a bare `tsx`.
- **Vitest alias ordering is specific-first.** A bare `@godot-scene-web/hb-gpu` entry above the `/webgl` subpath
  rewrites the subpath and fails to resolve.
- **Never nest `xvfb-run`.** `test:webgpu-composite`, `test:webgl-composite`, `test:canvas-pixel` and
  `bench:canvas-upload` already wrap themselves; so does couch-coop's `scripts/run-gpu.sh`. Blocked by the guard.
- Headless never composites a WebGPU canvas — that is what the `*Xvfb.test.ts` pixel tests exist for.
- Parity artifacts (`artifacts/parity/<fixture>/…`) are kept for review and **never committed**. Neither are the
  on-demand font downloads.

## A rendering fix is not proven by this repo's tests

Golden tests prove the parser preserved a value; rectangle fixtures prove layout math; `data-godot-*` assertions
prove DOM shape. None of them prove the thing looks right. The consumer is where that shows up, and reaching it
costs nothing: **`../sts2-couch-coop` aliases `packages/*/src` directly in its `frontend/vite.config.ts`**, so your
working tree is already what its dev server runs.

```bash
cd ../sts2-couch-coop/frontend && npx vite --host 127.0.0.1 --port 5190
```

Two rules when you do that:

- **Do not check this repo out onto a branch to test it there.** The couch checkout aliases the shared path, so a
  branch here silently changes what every other agent's dev server and vitest run against. Have the consumer point
  a scratch vite `--config` at your **worktree** instead, and leave this checkout on clean `main`.
- Appearance bugs in the game scene are *supposed* to arrive here — couch-coop's own rules forbid patching them
  with product-local CSS, precisely so every other consumer gets the fix too.

## Reporting

Any visual claim lists the concrete image path(s) behind it. State which fixture, which viewport, and which
backend (WebGL vs WebGPU vs DOM) produced it.
