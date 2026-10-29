#!/usr/bin/env bash
# The source tree id the render-stream client's core is built from (MIR-1, src/loader.ts): the
# first 12 hex of the SHA-256 over the git tree ids of the four Rust inputs of rs-gsw-wasm at HEAD,
# plus `-dirty` when any of them differs from HEAD (build-rs-core.sh's dirty rule over the same
# paths). It changes only when the wasm's sources change, unlike HEAD. build-web.sh writes it into
# build.json as `rs_core_tree`; a consumer runs this on the checkout it aliases and passes the
# result as the client's `core.expectedTree`.
#
# Usage: packages/render-stream-client/scripts/core-tree.sh [GSW_ROOT]
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
PATHS=(experiments/render-stream/rs-core experiments/render-stream/web/gsw-rs
	packages/canvas/rust-draw-list packages/canvas/rust-prototype)
ids=""
for p in "${PATHS[@]}"; do
	ids="${ids}$(git -C "$ROOT" rev-parse "HEAD:$p") $p"$'\n'
done
tree="$(printf '%s' "$ids" | sha256sum | cut -c1-12)"
if ! git -C "$ROOT" diff --quiet HEAD -- "${PATHS[@]}" 2>/dev/null ||
	[ -n "$(git -C "$ROOT" ls-files --others --exclude-standard -- "${PATHS[@]}")" ]; then
	tree="${tree}-dirty"
fi
echo "$tree"
