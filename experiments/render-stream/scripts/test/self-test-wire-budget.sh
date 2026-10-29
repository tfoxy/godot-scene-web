#!/usr/bin/env bash
# Pure self-test of lib/wire-budget.py (WB, results/p3/wb.md): its record reader, category split,
# churn counters, /11 approximation, delta and quantization arithmetic on a synthetic /10 recording
# with a payload store, and WB-D's proto13 (results/p3/wb-d.md): the /13 prototype's numeric modes
# and its round trips. The zstd rows need Python 3.14's compression.zstd: under mise's Python they
# run, under an older python3 they are skipped (and say so). Launches nothing.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY=(python3)
if mise exec -- python3 -c 'import compression.zstd' >/dev/null 2>&1; then
	PY=(mise exec -- python3)
fi
"${PY[@]}" -I "$SCRIPT_DIR/lib/wire-budget.py" self-test
