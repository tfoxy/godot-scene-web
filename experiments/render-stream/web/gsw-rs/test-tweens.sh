#!/usr/bin/env bash
# Run the browser adapter's tween lifecycle regressions in Node's WASM runtime.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
if [ -z "${RS_TWEEN_TEST_LOCKED:-}" ]; then
  RS_TWEEN_TEST_LOCKED=1 exec bash "$ROOT/experiments/render-stream/scripts/lib/quiet.sh" shared \
    --label tween-wasm-tests -- bash "${BASH_SOURCE[0]}" "$@"
fi
OUT="${1:?usage: test-tweens.sh /absolute/ignored-output}"
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
cd "$HERE"
cargo test --offline --release --target wasm32-unknown-unknown --lib --no-run \
  --message-format=json > "$OUT/build.jsonl"
TEST_WASM="$(python3 - "$OUT/build.jsonl" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    row = json.loads(line)
    if row.get('reason') == 'compiler-artifact' and (row.get('executable') or '').endswith('.wasm'):
        print(row['executable'])
PY
)"
[ -f "$TEST_WASM" ] || { echo "missing WASM test artifact" >&2; exit 1; }
wasm-bindgen --target nodejs --out-name tween_tests --out-dir "$OUT" "$TEST_WASM"
node "$HERE/test-tweens.mjs" "$OUT"
