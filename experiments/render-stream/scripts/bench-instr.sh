#!/usr/bin/env bash
# Instruction-count bench for the Rust core's decode + apply path (R4, docs/remote-compute.md
# "Consistent benchmarks"): a CPU-regression signal machine load cannot disturb, so it also runs on
# GitHub-hosted runners (run id `bench-instr`).
#
#   bash experiments/render-stream/scripts/bench-instr.sh [--out DIR] [--baseline FILE]
#     [--threshold PCT] [--update-baseline] [--bin PATH] [--cases a,b]
#
# Builds rs-core's bench-instr binary (--release, --locked, pinned rustc 1.95.0, no RUSTFLAGS, so no
# target-cpu=native), runs each committed golden case in its own process under
# `valgrind --tool=cachegrind --cache-sim=no`, and parses the Ir total. Writes <out>/bench-instr.json
# (per-case Ir, rustc, valgrind, CPU model, the binary's sha256) and <out>/result.json (one check per
# case, read by lib/tier-verdict.py), compares against benches/instr-baseline.json (per-case
# threshold, default 1%) and exits 1 on a regression; improvements are reported, not failures.
# --update-baseline rewrites the baseline from this run (and still writes the results).
#
# Env: RS_BENCH_VALGRIND (default `valgrind`; the self-test points it at a fake), RS_BENCH_ALLOW_RUSTC=1
# (accept a rustc other than the pin, for the self-test only). No valgrind: exits 3, naming it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CRATE="$EXPERIMENT_DIR/rs-core"
PROTOCOL="$EXPERIMENT_DIR/protocol"
HELPER="$SCRIPT_DIR/lib/bench-instr.py"
PINNED_RUSTC="1.95.0"
REPEATS=3

OUT="" BASELINE="$EXPERIMENT_DIR/benches/instr-baseline.json" THRESHOLD="" UPDATE=0 BIN="" ONLY=""
while [ $# -gt 0 ]; do
	case "$1" in
	--out) OUT="$2" && shift 2 ;;
	--baseline) BASELINE="$2" && shift 2 ;;
	--threshold) THRESHOLD="$2" && shift 2 ;;
	--update-baseline) UPDATE=1 && shift ;;
	--bin) BIN="$2" && shift 2 ;;
	--cases) ONLY="$2" && shift 2 ;;
	-h | --help) sed -n 2,19p "${BASH_SOURCE[0]}" && exit 0 ;;
	*) echo "bench-instr: unknown argument $1" >&2 && exit 2 ;;
	esac
done
[ -n "$OUT" ] || OUT="$(cd "$EXPERIMENT_DIR/../.." && pwd)/artifacts/render-stream/bench-instr/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"

# Cases: name=recording under protocol/ (self-contained: inline payloads). Recordings of every wire
# version the applier serves, one scene-sized and one texture/mesh-heavy.
CASES=(
	"g3-inline=golden-3/inline.rs3"
	"g4-inline=golden-4/inline.rs4"
	"g5-inline=golden-5/inline.rs5"
	"g6-inline=golden-6/inline.rs6"
	"g6-snap=golden-6/snap.rs6"
	"g7-window2=golden-7/window2.rs7"
)

VALGRIND="${RS_BENCH_VALGRIND:-valgrind}"
if ! command -v "$VALGRIND" >/dev/null 2>&1; then
	echo "bench-instr: $VALGRIND is not installed (apt-get install valgrind); the remote job is the producer" >&2
	exit 3
fi
RUSTC_V="$(rustc --version 2>/dev/null || echo none)"
if [ -z "$BIN" ]; then
	case "$RUSTC_V" in
	"rustc $PINNED_RUSTC "*) ;;
	*) [ "${RS_BENCH_ALLOW_RUSTC:-}" = 1 ] || { echo "bench-instr: rustc is '$RUSTC_V', the pin is $PINNED_RUSTC" >&2 && exit 2; } ;;
	esac
	# no RUSTFLAGS of any kind: a target-cpu=native build would count different instructions per host
	(cd "$CRATE" && env -u RUSTFLAGS -u CARGO_ENCODED_RUSTFLAGS -u CARGO_BUILD_RUSTFLAGS \
		cargo build --release --locked --features bench-instr --bin rs-core-bench-instr) >"$OUT/build.log" 2>&1 || {
		tail -20 "$OUT/build.log" >&2
		echo "bench-instr: build failed" >&2
		exit 2
	}
	BIN="$CRATE/target/release/rs-core-bench-instr"
fi
[ -x "$BIN" ] || { echo "bench-instr: $BIN is not an executable" >&2 && exit 2; }
BIN_SHA="$(sha256sum "$BIN" | cut -d' ' -f1)"
VALGRIND_V="$("$VALGRIND" --version 2>/dev/null | head -1)"
CPU="$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')"
CPU_FAMILY="$(awk -F: '/^cpu family|^model\t|^stepping/ {gsub(/ /,"",$2); printf "%s ", $2}' /proc/cpuinfo 2>/dev/null | awk '{print "family="$1" model="$2" stepping="$3}')"

echo "bench-instr: $RUSTC_V; $VALGRIND_V; $CPU; binary $BIN_SHA"
RUNS="$OUT/cachegrind"
mkdir -p "$RUNS"
fail=0
: >"$OUT/cases.tsv"
for c in "${CASES[@]}"; do
	name="${c%%=*}" rel="${c#*=}"
	if [ -n "$ONLY" ] && ! [[ ",$ONLY," == *",$name,"* ]]; then continue; fi
	# the recording is passed relative to protocol/, so the argv is the same in every checkout
	if ! (cd "$PROTOCOL" && "$VALGRIND" --tool=cachegrind --cache-sim=no --cachegrind-out-file="$RUNS/$name.cg" \
		"$BIN" "$rel" "$REPEATS") >"$RUNS/$name.out" 2>"$RUNS/$name.err"; then
		echo "bench-instr: case $name failed to run:" >&2
		tail -5 "$RUNS/$name.err" "$RUNS/$name.out" >&2
		fail=1
		continue
	fi
	ir="$(python3 "$HELPER" parse "$RUNS/$name.cg" 2>/dev/null || python3 "$HELPER" parse "$RUNS/$name.err")" || {
		echo "bench-instr: case $name: no Ir in the cachegrind output" >&2
		fail=1
		continue
	}
	printf '%s\t%s\t%s\t%s\n' "$name" "$rel" "$ir" "$(tr -d '\n' <"$RUNS/$name.out")" >>"$OUT/cases.tsv"
done
[ "$fail" = 0 ] || { echo "bench-instr: FAIL (a case did not run)" >&2 && exit 1; }

python3 -I - "$OUT" "$RUSTC_V" "$VALGRIND_V" "$CPU" "$CPU_FAMILY" "$BIN_SHA" "$REPEATS" <<'PY'
import json, sys
out, rustc, valgrind, cpu, fam, sha, repeats = sys.argv[1:8]
cases = {}
for line in open(f"{out}/cases.tsv"):
    name, rel, ir, stdout = line.rstrip("\n").split("\t")
    cases[name] = {"recording": rel, "ir": int(ir), "stdout": stdout}
json.dump({"schema": "render-stream-instr-bench/1", "rustc": rustc, "valgrind": valgrind, "cpu_model": cpu,
           "cpu_family": fam, "binary_sha256": sha, "repeats": int(repeats), "cases": cases},
          open(f"{out}/bench-instr.json", "w"), indent=2)
PY

awk -F'\t' '{ printf "bench-instr: %-12s %14d Ir  (%s)\n", $1, $3, $2 }' "$OUT/cases.tsv"

if [ "$UPDATE" = 1 ]; then
	python3 -I - "$OUT/bench-instr.json" "$BASELINE" <<'PY'
import json, os, sys
res = json.load(open(sys.argv[1]))
path = sys.argv[2]
old = json.load(open(path))["cases"] if os.path.exists(path) else {}
cases = {}
for name, r in res["cases"].items():
    cases[name] = {"recording": r["recording"], "ir": r["ir"]}
    if "threshold_pct" in old.get(name, {}):
        cases[name]["threshold_pct"] = old[name]["threshold_pct"]
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump({"schema": "render-stream-instr-baseline/1", "rustc": res["rustc"], "valgrind": res["valgrind"],
           "cpu_model": res["cpu_model"], "repeats": res["repeats"], "cases": cases},
          open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
	echo "bench-instr: baseline rewritten: $BASELINE"
fi

[ -f "$BASELINE" ] || { echo "bench-instr: no baseline at $BASELINE (run with --update-baseline)" >&2 && exit 1; }
targs=()
[ -n "$THRESHOLD" ] && targs=(--threshold "$THRESHOLD")
python3 "$HELPER" compare --results "$OUT/bench-instr.json" --baseline "$BASELINE" --result-json "$OUT/result.json" "${targs[@]}"
