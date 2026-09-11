# Changelog

What changed in godot-scene-web, written for the people rendering scenes with it. `publish.yml`
creates no GitHub Release, so this file is the published record of what each npm version contains.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html) across every package in `packages/`,
which are released together on one tag. Sections are drafted from the `Changelog:` trailers on
commits — see [docs/commit-and-release.md](docs/commit-and-release.md).

## [Unreleased]

## [0.1.0] - 2026-09-10

First public release. A generic Godot scene-to-web toolkit: parse `.tscn` / `.tres` text into a
Godot-like AST, compute the documented Control layout subset, render it as DOM/CSS or canvas, and
validate the browser geometry against live Godot inspection.

[Unreleased]: https://github.com/tfoxy/godot-scene-web/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tfoxy/godot-scene-web/releases/tag/v0.1.0
