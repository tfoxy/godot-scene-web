#!/usr/bin/env bash
# Record the shared headless file-sink table twice for native macOS comparisons.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RS="$(dirname "$SCRIPT_DIR")"
OUT=""
while [ "$#" -gt 0 ]; do
	case "$1" in
	--out) OUT="$2"; shift 2 ;;
	*) echo "mfile-linux-ref: unknown argument: $1" >&2; exit 2 ;;
	esac
done
if [ -z "$OUT" ]; then
	echo "usage: mfile-linux-ref.sh --out <dir>" >&2
	exit 2
fi
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
BUNDLE="$OUT/bundle"
QUIET="$SCRIPT_DIR/lib/quiet.sh"
if [ ! -f "$RS/capture/build/librender_stream_capture.so" ]; then
	bash "$SCRIPT_DIR/build-capture.sh"
fi
bash "$QUIET" shared -- python3 -I -B "$SCRIPT_DIR/lib/m1-bundle.py" --target linux --out "$BUNDLE"
bash "$QUIET" shared -- python3 -I -B "$SCRIPT_DIR/lib/mfile-bundle.py" --target linux --out "$BUNDLE"
rc=0
for rep in a b; do
	for gate in gate0 gate1 gate2 gate8; do
		# Fresh captures are mandatory; do not reuse a previous validation's recordings.
		rm -rf -- "$OUT/$rep/$gate"
		bash "$QUIET" shared --label "mfile-$gate-$rep" --log "$OUT/quiet-lock.jsonl" -- \
			python3 -I -B "$BUNDLE/mfile/mfile-driver.py" --config "$BUNDLE/mfile/mfile.json" \
			--gate "$gate" --rep "$rep" --out "$OUT" || rc=1
	done
done
# The artifact needs only recordings and evidence, not another template or library copy.
rm -rf -- "$BUNDLE"
exit "$rc"
