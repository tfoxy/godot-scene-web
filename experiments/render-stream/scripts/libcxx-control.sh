#!/usr/bin/env bash
# Compare file sinks from two GCC runs with a Linux libc++ control build.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
EXT="" CAL="" OUT="" SEAM=""
GATES=gate0,gate1:g1a,gate2:g2a,gate8:g8t
refuse() { echo "libcxx-control: $*" >&2; exit 2; }
while [ "$#" -gt 0 ]; do
	[ "$#" -ge 2 ] && [ -n "$2" ] && [[ "$2" != --* ]] || refuse "missing value for $1"
	case "$1" in
	--extension) EXT="$2" ;;
	--calibration) CAL="$2" ;;
	--out) OUT="$2" ;;
	--gates) GATES="$2" ;;
	--seam-libcxx-extension) SEAM="$2" ;;
	*) refuse "unknown argument $1" ;;
	esac
	shift 2
done
[ -f "$EXT" ] && [ -f "$CAL" ] && [ -n "$OUT" ] || refuse '--extension, --calibration and --out are required'
[ -z "$SEAM" ] || [ -f "$SEAM" ] || refuse 'seam extension missing'
if [ -e "$OUT" ]; then
	[ -d "$OUT" ] && [ -z "$(find "$OUT" -mindepth 1 -maxdepth 1 -print -quit)" ] || refuse 'output must be an empty directory'
fi
[[ "$GATES" =~ ^gate(0|1:g1a|2:g2a|8:g8t)(,gate(0|1:g1a|2:g2a|8:g8t))*$ ]] || refuse 'unsupported --gates selection'
if [ -z "$SEAM" ] && ! command -v clang++-20 >/dev/null 2>&1; then
	refuse 'libcxx-unavailable: install clang-20 libc++-20-dev libc++abi-20-dev'
fi
EXT="$(realpath "$EXT")" CAL="$(realpath "$CAL")"
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
IFS=, read -r -a SPECS <<<"$GATES"
GATE_NAMES="${GATES//:g1a/}"; GATE_NAMES="${GATE_NAMES//:g2a/}"; GATE_NAMES="${GATE_NAMES//:g8t/}"
VARGS=(--run "$OUT" --gates "$GATE_NAMES")
CTEST=pass
if [ -n "$SEAM" ]; then
	LIBCXX_EXT="$(realpath "$SEAM")"
	VARGS+=(--seam)
else
	rc=0
	bash "$HERE/build-capture.sh" --target linux-libcxx >"$OUT/build-libcxx.log" 2>&1 || rc=$?
	if [ "$rc" != 0 ]; then
		echo "libcxx-control: build/ctest exited $rc; first 40 error: lines from build-libcxx.log:" >&2
		grep -m 40 'error:' "$OUT/build-libcxx.log" >&2 || true
	fi
	LIBCXX_EXT="$HERE/../capture/build-libcxx/render_stream_capture.gdextension"
	if [ ! -f "$LIBCXX_EXT" ] || { [ "$rc" != 0 ] && ! grep -qE '[0-9]+ tests failed out of' "$OUT/build-libcxx.log"; }; then
		python3 "$HERE/lib/libcxx-verdict.py" "${VARGS[@]}" --ctest not-run --error libcxx-build-failed
		exit 1
	fi
	[ "$rc" = 0 ] || CTEST=fail
fi
# Resolve the libraries from the extension descriptors rather than assuming their locations.
python3 - "$EXT" "$LIBCXX_EXT" "$OUT" <<'PY'
import configparser, hashlib, json, os, re, subprocess, sys
from pathlib import Path
out = Path(sys.argv[3])
def command(argv):
    try:
        p = subprocess.run(argv, capture_output=True, text=True)
        return {"rc": p.returncode, "stdout": p.stdout, "stderr": p.stderr}
    except OSError as e:
        return {"rc": 127, "stdout": "", "stderr": str(e)}
def library(ext):
    ext = Path(ext)
    cfg = configparser.ConfigParser(); cfg.read(ext)
    value = cfg['libraries']['linux.x86_64'].strip('"')
    path = Path(value)
    if not path.is_absolute():
        path = ext.parent / path
    dynamic = command(['readelf', '-d', str(path)])
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "needed": re.findall(r'\(NEEDED\).*?\[(.*?)\]', dynamic['stdout']),
            "readelf": dynamic, "ldd": command(['ldd', str(path)])}
try:
    data = {"libraries": {k: library(v) for k, v in zip(('gcc', 'libcxx'), sys.argv[1:3])},
            "gcc": command(['gcc', '--version']), "clang": command(['clang++-20', '--version'])}
    setup = Path(os.environ.get('RUNNER_TEMP', '/nonexistent')) / 'libcxx-provenance.json'
    if setup.is_file():
        data['setup'] = json.loads(setup.read_text())
    (out / 'provenance.json').write_text(json.dumps(data, indent=2) + '\n')
except (OSError, KeyError, ValueError) as e:
    (out / 'provenance.json').write_text(json.dumps({"error": str(e)}) + '\n')
PY
for spec in "${SPECS[@]}"; do
	gate="${spec%%:*}"
	for label in gcc-a libcxx gcc-b; do
		ext="$EXT"; [ "$label" != libcxx ] || ext="$LIBCXX_EXT"
		dir="$OUT/$label/$gate"
		args=(--extension "$ext" --calibration "$CAL" --out "$dir")
		[ "$gate" = gate0 ] || args+=(--legs "${spec#*:}")
		mkdir -p "$(dirname "$dir")"
		rc=0
		env -u HC_SHADOW -u GRC_HC_SHADOW RS_RECEIVER_CORE=rust RS_SABOTAGE_TIER=skip \
			RS_SKIP_TIMING_GROUPS="${RS_SKIP_TIMING_GROUPS:-1}" \
			bash "$HERE/run-$gate.sh" "${args[@]}" >"$OUT/$label/$gate.log" 2>&1 || rc=$?
		mkdir -p "$dir"
		python3 "$HERE/lib/tier-verdict.py" --run "$dir" --sabotage-skipped --runner-rc "$rc" \
			>"$dir/tier-verdict.json" 2>"$OUT/$label/$gate-verdict.stderr" || true
	done
	mkdir -p "$OUT/comparisons/$gate"
	for pair in gcc-repeat:gcc-b libcxx:libcxx; do
		name="${pair%%:*}"; label="${pair#*:}"
		cmp_rc=0
		(cd "$REPO" && mise exec -- pnpm exec tsx --conditions=development "$HERE/cmp-rec.ts" \
			--tree --json "$OUT/gcc-a/$gate" "$OUT/$label/$gate") \
			>"$OUT/comparisons/$gate/$name.json" 2>"$OUT/comparisons/$gate/$name.stderr" || cmp_rc=$?
		printf '%s\n' "$cmp_rc" >"$OUT/comparisons/$gate/$name.rc"
	done
done
python3 "$HERE/lib/libcxx-verdict.py" "${VARGS[@]}" --ctest "$CTEST"
