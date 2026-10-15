#!/usr/bin/env bash
# Gate 7 runner -- SKELETON (G7h; protocol/gate7-design.md "G7h" increment).
#
#   bash run-gate7.sh [--legs g7-0,g7-1,...] [--out DIR] \
#     [--source gate0=/abs/run/dir,gate1=/abs/run/dir,...] [--make-sources]
#
# Right now no `g7-*` leg group has landed (G7w, G7j, G7c, G7f, G7e, G7a, ... are later
# increments; see protocol/gate7-design.md "Increments"), so this script's job is the skeleton
# the contract asks for: parse `--source`, `--make-sources`, `--legs` and `--out` (default
# artifacts/render-stream/gate7/<UTC>/, refusing to reuse a non-empty one, same as run-gate6.sh),
# know the full `g7-*` vocabulary so a later increment extends `KNOWN_GROUPS`/`LANDED_GROUPS`
# rather than re-deriving it, and refuse any `--legs` entry that is not landed yet with a clear
# message instead of silently doing nothing.
#
# `--source <gate>=<dir>` (repeatable, comma-separated) names the native run each later browser
# leg replays (D21): gate N's recordings, references, `expected.json` and sabotage captures come
# from `<dir>`. `--make-sources` would instead invoke each native `run-gate<N>.sh` itself. NEITHER
# is implemented yet -- no leg group needs a source until G7a/G7e land -- so both flags are parsed
# and recorded in `<out>/sources.json` for forward compatibility, and refused with a clear message
# if a requested leg actually needs one.
#
# What this script DOES run today: G7h's own browser harness self-test
# (`scripts/test/self-test-browser-harness.ts`), into `<out>/g7h-probes/`, followed by
# `check-gate7.ts --out <out>`. That self-test is real (launches the pinned Chromium under D9 and
# exercises every G7h probe and check); it is not one of the `g7-*` gate groups, so it always
# runs, independent of `--legs`.
#
# NEVER Xvfb, never a desktop window, never headed Chromium (D9, memory
# xvfb-does-not-isolate-on-wayland) -- the self-test launches through `scripts/lib/browser-harness.ts`
# only.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"

# The final leg-group vocabulary (gate7-design.md "Gate 7 passes when…"); none have landed.
KNOWN_GROUPS=(g7-0 g7-1 g7-2 g7-3 g7-4 g7-5 g7-55 g7-6 g7-lc g7-r g7-k)
LANDED_GROUPS=()

OUT=""
LEGS_ARG=""
SOURCE_ARG=""
MAKE_SOURCES=0

usage() {
	sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
	--legs)
		LEGS_ARG="${2:-}"
		shift 2
		;;
	--out)
		OUT="${2:-}"
		shift 2
		;;
	--source)
		SOURCE_ARG="${2:-}"
		shift 2
		;;
	--make-sources)
		MAKE_SOURCES=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	--)
		# `pnpm render-stream:gate7 -- <flags>` forwards the separator itself (memory
		# pnpm-script-dashdash-forwarding).
		shift
		;;
	*)
		echo "run-gate7: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

GROUPS_RUN=()
if [ -n "$LEGS_ARG" ]; then
	IFS=',' read -r -a requested <<<"$LEGS_ARG"
	for group in "${requested[@]}"; do
		case " ${KNOWN_GROUPS[*]} " in
		*" $group "*) ;;
		*)
			echo "run-gate7: unknown leg group: $group (known: ${KNOWN_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		case " ${LANDED_GROUPS[*]+${LANDED_GROUPS[*]}} " in
		*" $group "*) ;;
		*)
			echo "run-gate7: leg group $group has not landed yet (no g7-* group has; see protocol/gate7-design.md \"Increments\")" >&2
			exit 2
			;;
		esac
		GROUPS_RUN+=("$group")
	done
fi

if [ -z "$OUT" ]; then
	OUT="$REPO_ROOT/artifacts/render-stream/gate7/$(date -u +%Y%m%dT%H%M%SZ)"
fi
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
	echo "run-gate7: $OUT already holds files; pass a fresh --out" >&2
	exit 1
fi
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
echo "run-gate7: evidence directory: $OUT (groups: ${GROUPS_RUN[*]:-none landed yet})"

{
	printf '{"source": "%s", "make_sources": %s, "note": "D21 source-run validation is not implemented yet -- no leg group needs one until G7a/G7e land"}\n' \
		"$SOURCE_ARG" "$([ "$MAKE_SOURCES" = 1 ] && echo true || echo false)"
} >"$OUT/sources.json"
if [ -n "$SOURCE_ARG" ] || [ "$MAKE_SOURCES" = 1 ]; then
	echo "run-gate7: --source/--make-sources recorded in $OUT/sources.json but not yet actionable (no leg group needs a source)" >&2
fi

# G7h's own harness self-test: always runs, independent of --legs (it is not a g7-* gate group).
echo "run-gate7: running the G7h browser-harness self-test into $OUT/g7h-probes" >&2
mise exec -- pnpm exec tsx --conditions=development \
	"$SCRIPT_DIR/test/self-test-browser-harness.ts" --out "$OUT/g7h-probes"

echo "run-gate7: running check-gate7.ts" >&2
mise exec -- pnpm exec tsx --conditions=development \
	"$SCRIPT_DIR/check-gate7.ts" --out "$OUT" --legs "$LEGS_ARG"
