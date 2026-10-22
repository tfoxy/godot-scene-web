#!/usr/bin/env bash
# remote-toolchain-smoke.sh -- build the four render-stream toolchain outputs and record the sha256 of
# each (docs/remote-compute.md, R0b). The same script runs on a hosted runner (remote-validate.sh
# --toolchain-smoke) and locally, so the two hash sets are comparable:
#
#   scripts/remote-toolchain-smoke.sh [--out DIR]
#
# Builds, in order: build-rs-core-ext.sh (native GDExtension), build-rs-core.sh (rs-core-check plus
# the gsw wasm), build-rs-core-web.sh (the web side module) and build-web-receiver.sh (the web
# export). Writes DIR/toolchain-smoke/{toolchain-hashes.json,rc,wall_s,run.log} plus plan.json and
# validate-summary.json in the validate-increment shape, so the remote merge job treats it as a run.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RS="$REPO/experiments/render-stream"
S="$RS/scripts"
OUT=""
while [ $# -gt 0 ]; do
	case "$1" in
	--out) OUT="$2" && shift 2 ;;
	*) echo "remote-toolchain-smoke: unknown argument $1" >&2 && exit 2 ;;
	esac
done
[ -n "$OUT" ] || OUT="$REPO/artifacts/render-stream/toolchain-smoke/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT/toolchain-smoke"
OUT="$(realpath "$OUT")"
D="$OUT/toolchain-smoke"
HASHES="$D/files.tsv"
TIMES="$D/steps.tsv"
: >"$HASHES"
: >"$TIMES"
secs() { python3 -c 'import sys; print(round(float(sys.argv[2].replace(",", ".")) - float(sys.argv[1].replace(",", ".")), 1))' "$1" "$2"; }
t0="$EPOCHREALTIME"
rc=0

hash_file() { # hash_file <step> <name> <file>: one tsv row if the file exists
	[ -f "$3" ] && printf '%s\t%s\t%s\n' "$1" "$2" "$(sha256sum "$3" | cut -d' ' -f1)" >>"$HASHES"
}
step() { # step <name> <command...>: run, time and log one build; a failure fails the run
	local name="$1" s0="$EPOCHREALTIME" r=0
	shift
	echo "== $name: $*" | tee -a "$D/run.log"
	"$@" >>"$D/run.log" 2>&1 || r=$?
	printf '%s\trc=%s\t%s\n' "$name" "$r" "$(secs "$s0" "$EPOCHREALTIME")" >>"$TIMES"
	[ "$r" = 0 ] || { echo "remote-toolchain-smoke: $name failed (rc $r)" >&2; rc=1; }
	return "$r"
}

cd "$REPO" || exit 2
if step build-rs-core-ext bash "$S/build-rs-core-ext.sh" --no-test; then
	hash_file ext librs_core_ext.so "$RS/receiver/ext/build/librs_core_ext.so"
fi
if step build-rs-core bash "$S/build-rs-core.sh"; then
	latest="$(readlink -f "$REPO/artifacts/render-stream/rs-core/latest")"
	hash_file core rs-core-check "$latest/bin/rs-core-check"
	hash_file core rs_gsw_wasm_bg.wasm "$latest/gsw-rs/rs_gsw_wasm_bg.wasm"
	hash_file core rs_gsw_wasm.js "$latest/gsw-rs/rs_gsw_wasm.js"
fi
if step build-rs-core-web bash "$S/build-rs-core-web.sh"; then
	hash_file coreweb web/librs_core_ext.wasm "$RS/receiver/ext/build/web/librs_core_ext.wasm"
fi
if step build-web-receiver bash "$S/build-web-receiver.sh" --out "$D/web-receiver" --force; then
	for f in "$D"/web-receiver/bundle/*; do
		case "$f" in */build.json | */rs-core-web-build.json) continue ;; esac
		hash_file webreceiver "web-receiver/$(basename "$f")" "$f"
	done
fi

python3 -I - "$HASHES" "$TIMES" "$D/toolchain-hashes.json" <<'PY'
import json, sys
h, t, out = sys.argv[1:4]
files = {}
for line in open(h):
    step, name, sha = line.rstrip("\n").split("\t")
    files[name] = {"step": step, "sha256": sha}
steps = {}
for line in open(t):
    n, rc, s = line.rstrip("\n").split("\t")
    steps[n] = {"rc": rc, "seconds": float(s)}
json.dump({"schema": "render-stream-toolchain-smoke/1", "files": files, "steps": steps}, open(out, "w"), indent=1, sort_keys=True)
PY
t1="$EPOCHREALTIME"
echo "$rc" >"$D/rc"
secs "$t0" "$t1" >"$D/wall_s"
echo '{"runs":[{"id":"toolchain-smoke","phase":"setup"}],"sabotage":{"run":false,"why":[]},"skipped_targets":[],"milestone":null,"base":null}' >"$OUT/plan.json"
python3 "$S/lib/validate-summary.py" "$OUT" "${t0/,/.}" "${t1/,/.}"
exit $?
