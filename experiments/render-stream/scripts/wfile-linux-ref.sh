#!/usr/bin/env bash
# Produce Linux references with the same bundled inputs used by hosted Windows.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RS="$(dirname "$SCRIPT_DIR")"
OUT=""
while [ "$#" -gt 0 ]; do
	case "$1" in
	--out) OUT="$2"; shift 2 ;;
	*) echo "wfile-linux-ref: unknown argument: $1" >&2; exit 2 ;;
	esac
done
if [ -z "$OUT" ]; then
	echo "usage: wfile-linux-ref.sh --out <dir>" >&2
	exit 2
fi
OUT="$(realpath -m "$OUT")"
mkdir -p "$OUT"
BUNDLE="$RS/capture/build-windows/linux-bundle"
QUIET="$SCRIPT_DIR/lib/quiet.sh"
if [ ! -f "$RS/capture/build/librender_stream_capture.so" ]; then
	bash "$QUIET" shared -- bash "$SCRIPT_DIR/build-capture.sh"
fi
bash "$QUIET" shared -- python3 -I "$SCRIPT_DIR/lib/w1-bundle.py" --target linux --out "$BUNDLE"
bash "$QUIET" shared -- python3 -I "$SCRIPT_DIR/lib/wfile-bundle.py" --target linux --out "$BUNDLE"
rc=0
for rep in a b; do
	for gate in gate0 gate1 gate2 gate8; do
		# Each validation writes fresh references; the driver refuses an existing gate output.
		rm -rf -- "$OUT/$rep/$gate"
		bash "$QUIET" shared --label "wfile-$gate-$rep" --log "$OUT-quiet.jsonl" -- \
			python3 -I "$BUNDLE/wfile/wfile-driver.py" --config "$BUNDLE/wfile/wfile.json" \
			--gate "$gate" --rep "$rep" --out "$OUT" || rc=1
	done
done
exit "$rc"
