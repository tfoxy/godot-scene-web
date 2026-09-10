# AGENTS.md

## Purpose

`godot-scene-web` is a generic Godot scene-to-web toolkit. It parses Godot text resources, computes a documented Control layout subset, renders DOM/CSS, exposes Vue components, and validates browser geometry against live Godot inspection.

## Godot References

Prefer local, version-matched Godot references over internet documentation:

- Use `../godot-4.5.1-stable` for Godot 4.5.1 engine source and implementation behavior.
- Use `../godot-docs-4.5` for Godot 4.5 documentation.
- Use internet documentation only when local source/docs are insufficient or when checking behavior outside Godot 4.5.

## Architecture Rules

- Keep the parser Unix-small: `.tscn` / `.tres` text in, Godot-like AST out.
- Do not add CouchCoop, spirectl, Slay the Spire 2, catalog, runtime-state, browser-envelope, or product-specific DTO concepts to parser/core packages.
- Preserve Godot property names in parser output: `layout_mode`, `anchors_preset`, `offset_left`, `horizontal_alignment`, etc.
- Put interpretation in consumers:
  - `layout` interprets Godot Control layout.
  - `effects` owns portable simulation, instance packing, shader compilation and numeric easing.
  - `canvas-effects` executes GPU effects in supplied contexts/devices; it depends on neither renderer.
  - `html` turns layout boxes into DOM/CSS and owns DOM effect binding through `html/runtime`.
  - `canvas` turns a Godot CanvasItem draw list into GPU draws, including a glyph path over `hb-gpu`. HTML and canvas are independent tracks with shared effects.
  - `hb-gpu` renders HarfBuzz Slug glyph outlines in a borrowed GL context. It creates no context and depends on no other package — the edge runs `canvas` -> `hb-gpu`, never back.
  - `vue` exposes Vue components over the HTML model.
  - `test-harness` compares live Godot facts with browser DOM facts.
- JSON from live Godot inspection is validation evidence, not a parser input contract.
- Generated artifacts, screenshots, browser dumps, Godot temporary project files, and build outputs must stay ignored.
- A build output stays ignored; a vendored third-party binary is committed — digest-pinned, with its license text and provenance beside it (`packages/hb-gpu/vendor/`).

## Control Feature Coverage

Some Godot properties are deliberately not modeled in the HTML/layout output. Treat these as intentional, not gaps to "fix" without a parity need:

- `[editable path="..."]` is parsed but not enforced. Instance-scene child overrides are applied permissively (any override node under a mounted instance is merged), which is what consuming scenes rely on; enforcing editability would only restrict.
- `mouse_filter` maps only `2` (IGNORE) to `pointer-events: none`. Values `0` (STOP) and `1` (PASS) are interaction-only and not visually meaningful in a static DOM render.
- `fit_content` and `scroll_active` (both `RichTextLabel`) are deferred: faithful support needs text measurement that the layout package does not yet have (only `TextureRect` has content-driven sizing).
- `layout_mode` (0–3) is parsed but not interpreted; container-managed vs free positioning is already derived from the parent container type.

`canvas`'s glyph path shapes through hb-gpu's own wasm (`fillRun`), so a page needs ONE HarfBuzz — do not reach for npm `harfbuzzjs` alongside it, which is a second build holding the same faces in a second heap. It wants `pixelsPerEm × devicePixelRatio >= 16`: below that HarfBuzz's coverage shader is measurably blurrier than the DOM text path it would replace (`docs/text-rendering.md`), so small text at DPR 1 is a reason to keep using `html`, not a bug to file.

Modeled behaviors worth noting: `bbcode_enabled` gates BBCode parsing for `RichTextLabel` (text renders literally unless the flag is set, matching Godot's default of `false`); the node header `index` attribute reorders siblings (append-then-`move_child`), affecting container flow and draw order; `anchors_preset` is expanded to explicit anchors when the scene did not serialize them.

## Tooling

Use mise-managed tools:

```bash
mise exec -- pnpm test
mise exec -- pnpm build
mise exec -- pnpm test:parity
mise exec -- godot --version
```

Do not run package managers outside the repo root unless a package-specific command requires it.

## Validation Expectations

- Parser changes need parser golden tests that prove raw Godot values are preserved.
- Layout changes need layout tests with rectangle-only fixtures where possible.
- DOM/Vue changes need stable `data-godot-*` assertions.
- Parity changes should preserve `artifacts/parity/<fixture>/godot-live-tree.json`, `browser-dom-tree.json`, and `comparison.json` for review, but those files must not be committed.
- Rendering changes need a consumer check — see below. Golden tests prove a value survived the parser; they do not prove the thing looks right.

## Downstream Consumers And How To Verify

This toolkit is generic, but it is not consumed generically. `../sts2-couch-coop` aliases these packages to
**TypeScript source** in its `frontend/vite.config.ts` — `@godot-scene-web/{core,tscn-parser,scene-graph,layout,effects,canvas-effects,html,canvas,project,vue}`
map straight at `packages/*/src`. No npm link, no workspace, no `dist/`. `../spirectl` does the same for its
presentation dev app and declares these packages as peer dependencies.

Three consequences:

1. **Your working tree is already what the consumer runs.** Verifying a rendering fix costs a dev server:
   `cd ../sts2-couch-coop/frontend && npx vite --host 127.0.0.1 --port 5190`. Appearance bugs in that product's
   game scene are _supposed_ to arrive here — its own rules forbid patching them with product-local CSS, so that
   every other consumer gets the fix too.
2. **Do not check this repo out onto a branch to test it downstream.** The consumer aliases this shared path, so a
   branch here silently changes what every other agent's dev server and vitest run against. Have the consumer point
   a scratch vite `--config` at your **worktree**, and leave this checkout on clean `main`.
3. **Some contracts are co-owned.** `perf-report/1` (`docs/perf-report-contract.md`) is emitted by all three repos
   and validated through `pnpm perf -- validate-report`. `packages/core`'s scene-state shape is mirrored by
   spirectl's C# DTOs (`bridge-mod/src/Spirectl.Sts2/Live/Sts2GodotSceneStateModels.cs`) — the consumer resolves
   those through hand-maintained ambient declarations, so a field added on one side and not the other is a silent
   renderer gap, not a type error.

## Consuming from source

Every package export and subpath has a `development` condition that points to its TypeScript source. Source
consumers should resolve that condition, rather than loading locally stale `dist/`; the HTML and canvas
export-surface tests pin the public runtime and type-only names because consumers may mirror them in ambient
declarations. Node's native TypeScript support cannot resolve this repository's extensionless source imports, so
Node probes need a TypeScript-aware loader (such as `tsx`) and a resolver hook that maps package specifiers through
the `development` condition.

Committed agent config lives at [`agents/`](agents/) and [`skills/`](skills/) (`.claude/`, `.agents/` and
`.codex/` are gitignored). Run `scripts/install-agent-config.sh` after cloning and in every new worktree: it
links them in for Claude Code, generates the Codex CLI config under `.codex/`, and registers the PreToolUse
guard for both — `scripts/claude-guard-bash.sh`, self-tested by `scripts/test-claude-guard.sh`, which blocks
nested `xvfb-run` and warns on a `tsx` call missing `--conditions=development` (that one silently tests
`dist/` instead of your edit). Add `--user` to mirror home-level config into `~/.codex/`.

Project memory is `.agents/memory/MEMORY.md` (in a worktree, a symlink to the main checkout's store). Read
that index before non-trivial work; record what you learn with the `project-memory` skill.
