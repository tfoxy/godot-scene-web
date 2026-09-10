# godot-scene-web

Generic Godot scene-to-web packages for parsing Godot text scenes, computing a web-oriented layout model, rendering HTML/CSS, exposing Vue components, and validating browser DOM geometry against live Godot tree inspection.

The parser is deliberately small: it converts `.tscn` and `.tres` text into a Godot-like AST. It does not know about Slay the Spire 2, CouchCoop, spirectl, catalogs, runtime state, or browser DTOs.

## Packages

- `@godot-scene-web/core`: shared Godot-like AST types and value helpers.
- `@godot-scene-web/tscn-parser`: `.tscn` / `.tres` text parser; its `core` AST reference is type-only, so the runtime package has no core dependency.
- `@godot-scene-web/layout`: Control subset layout interpreter.
- `@godot-scene-web/scene-graph`: scene graph derivation utilities.
- `@godot-scene-web/effects`: portable particle, shader, and easing utilities.
- `@godot-scene-web/canvas-effects`: WebGL and WebGPU effect execution.
- `@godot-scene-web/canvas`: GPU canvas renderer for Godot draw lists.
- `@godot-scene-web/hb-gpu`: HarfBuzz Slug glyph-outline renderer.
- `@godot-scene-web/html`: DOM model and base CSS renderer.
- `@godot-scene-web/vue`: Vue 3 components over the HTML model.
- `@godot-scene-web/project`: conditional resolver: fetch-backed in browsers and filesystem-backed in Node. Explicit `/fetch` and `/node` subpaths are also available.
- `@godot-scene-web/test-harness`: Godot live-tree and browser DOM-tree comparison helpers.
- `@godot-scene-web/perf-harness`: A/B rendering-mechanism instrument driven by headless Chrome over raw CDP.

## Commands

```bash
corepack pnpm install
corepack pnpm test
corepack pnpm build
corepack pnpm test:parity
```

`test:parity` currently tests the JSON comparator. A full Godot launch command can be layered on top of `godot/project/scripts/inspect_scene.gd` once a local Godot executable is configured.

## Publishing releases

Pushing a tag named `v<version>` (for example, `v0.1.0`) runs the npm publishing workflow. It publishes the public runtime packages only after typechecking, testing, building, and confirming that every public package has exactly the tag's version. Other tags cannot trigger publishing.

For the first release, add an npm automation token with access to the `@godot-scene-web` scope as the repository `NPM_TOKEN` secret. The workflow supplies it as `NODE_AUTH_TOKEN` only for this bootstrap publication.

After every public package exists on npm, configure npm Trusted Publishing for each of the 11 runtime packages: select GitHub Actions, repository `tfoxy/godot-scene-web`, workflow filename `publish.yml` (at `.github/workflows/publish.yml`), and permit direct publishing. Then delete `NPM_TOKEN`; npm will use the workflow's OIDC identity and automatically attach provenance to future releases.

## Docs

- [Architecture](docs/architecture.md)
- [Perf harness](docs/perf-harness.md)
- [Perf report contract](docs/perf-report-contract.md)
- [Layout](docs/layout.md)
- [Parser](docs/parser.md)
- [Parity validation](docs/parity.md)
- [Vue usage](docs/vue.md)
