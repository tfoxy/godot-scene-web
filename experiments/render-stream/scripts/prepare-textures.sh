#!/usr/bin/env bash
# The texture prepare step (texture-delivery-design.md D9b, G8kc): fills the persisted host texture
# cache (D8) from files, before any session runs, by loading each one exactly as a game would under
# the capture, on the pinned stock 4.5.1 release template, headless (never a window).
#
# Usage: experiments/render-stream/scripts/prepare-textures.sh --cache <dir> \
#          (--project <godot project dir> | --images <dir> | --list <file>) [options]
#   --cache DIR         the cache directory (GRC_TEXTURE_CACHE_DIR). Outside any repository.
#   --project DIR       every <DIR>/.godot/imported/*.ctex (the project must be imported)
#   --images DIR        every png/jpg/jpeg/webp/bmp/tga/svg file under DIR
#   --list FILE         an explicit list: one absolute path per line (.ctex, an Image saved as .res,
#                       or an image file). This is
#                       the form a later all-pack / selective-pack warming feeds (design K3).
#   --max-bytes N       GRC_TEXTURE_CACHE_MAX_BYTES (LRU budget; default unbounded)
#   --workers N         GRC_TEXTURE_WORKERS (default: synchronous)
#   --no-uastc          skip the UASTC warm-up (a /8 sink, as G8kc ran it)
#   --encode-workers N  GRC_TEXTURE_ENCODE_WORKERS, the UASTC encode pool (default: the capture's 2)
#   --uastc-level N     GRC_TEXTURE_UASTC_LEVEL 0..4 (default: the capture's; the cache is keyed by it)
#   --out DIR           keep the run's logs and the capture's evidence here (default: removed)
#   --binary PATH       the 4.5.1 release template (default: the pinned one)
#   --extension PATH    the capture's .gdextension (default: capture/build)
#   --calibration PATH  the calibration record (default: the committed one)
#
# What the capture does with a texture is what a live session does: the D7 source key (the SHA-256
# of the hooked image as a GRT1 payload in its own format) is computed, a block-compressed source's
# host decode is stored under (source key, decoded, params_id), and anything else is its own source
# (nothing to derive yet; the key is what a later Basis encode will be filed under). The summary
# printed at the end is the capture's own result.json `texture_cache` block.
#
# UASTC (G8kf): by default the sink is render-stream/9 under GRC_TEXTURE_DELIVERY=basis-uastc with
# GRC_TEXTURE_ENCODE_DRAIN=1, so every admitted texture (D12) is encoded and stored in the cache
# under (source key, uastc, params_id) and the run waits for the encode pool before it ends. A
# session on this cache (same level) then runs zero UASTC encodes. Encoding costs ~1 s per
# megapixel per thread at the default level, so a large pack takes minutes.
#
# The run strips every inherited GRC_*/RS_* variable and DISPLAY/WAYLAND_DISPLAY; the stream sink is
# a throwaway file under a private temp directory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT="$(cd "$HERE/.." && pwd)"

CACHE=""
MODE=""
SOURCE=""
MAX_BYTES=""
WORKERS=""
UASTC=1
ENCODE_WORKERS=""
UASTC_LEVEL=""
OUT_KEEP=""
BINARY="${HOME}/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
EXTENSION="$EXPERIMENT/capture/build/render_stream_capture.gdextension"
CALIBRATION="$EXPERIMENT/calibration/godot-4.5.1-stable-linux-release.json"
TIMEOUT_S="${PREPARE_TIMEOUT_S:-3600}"

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
die() { echo "prepare-textures: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
	case "$1" in
	--cache) CACHE="${2:-}"; shift 2 ;;
	--project) MODE=project; SOURCE="${2:-}"; shift 2 ;;
	--images) MODE=images; SOURCE="${2:-}"; shift 2 ;;
	--list) MODE=list; SOURCE="${2:-}"; shift 2 ;;
	--max-bytes) MAX_BYTES="${2:-}"; shift 2 ;;
	--workers) WORKERS="${2:-}"; shift 2 ;;
	--no-uastc) UASTC=0; shift ;;
	--encode-workers) ENCODE_WORKERS="${2:-}"; shift 2 ;;
	--uastc-level) UASTC_LEVEL="${2:-}"; shift 2 ;;
	--out) OUT_KEEP="${2:-}"; shift 2 ;;
	--binary) BINARY="${2:-}"; shift 2 ;;
	--extension) EXTENSION="${2:-}"; shift 2 ;;
	--calibration) CALIBRATION="${2:-}"; shift 2 ;;
	-h | --help) usage; exit 0 ;;
	*) die "unknown argument: $1" ;;
	esac
done

[ -n "$CACHE" ] || die "--cache <dir> is required"
[ -n "$MODE" ] && [ -n "$SOURCE" ] || die "one of --project, --images or --list is required"
[ -x "$BINARY" ] || die "binary not found or not executable: $BINARY"
[ -f "$EXTENSION" ] || die "extension not found: $EXTENSION (run scripts/build-capture.sh)"
[ -f "$CALIBRATION" ] || die "calibration not found: $CALIBRATION"
# Never inside a repository: the cache holds generated texture bytes. Checked on the nearest
# existing ancestor, before anything is created.
probe="$CACHE"
while [ ! -d "$probe" ]; do probe="$(dirname "$probe")"; done
if git -C "$probe" rev-parse --show-toplevel >/dev/null 2>&1; then
	die "--cache $CACHE is inside a git repository; use a directory outside every repository"
fi
mkdir -p "$CACHE"
CACHE="$(cd "$CACHE" && pwd)"
EXTENSION="$(realpath "$EXTENSION")"
CALIBRATION="$(realpath "$CALIBRATION")"
BINARY="$(realpath "$BINARY")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/prepare-textures.XXXXXX")"
cleanup() {
	if [ -n "${CHILD_PID:-}" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
		kill "$CHILD_PID" 2>/dev/null || true
	fi
	rm -rf "$WORK"
}
trap cleanup EXIT

LIST="$WORK/list.txt"
case "$MODE" in
project)
	[ -d "$SOURCE/.godot/imported" ] || die "$SOURCE has no .godot/imported (import the project first)"
	find "$(cd "$SOURCE" && pwd)/.godot/imported" -maxdepth 1 -name '*.ctex' | LC_ALL=C sort >"$LIST"
	;;
images)
	[ -d "$SOURCE" ] || die "--images $SOURCE is not a directory"
	find "$(cd "$SOURCE" && pwd)" -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \
		-o -iname '*.webp' -o -iname '*.bmp' -o -iname '*.tga' -o -iname '*.svg' \) |
		LC_ALL=C sort >"$LIST"
	;;
list)
	[ -f "$SOURCE" ] || die "--list $SOURCE is not a file"
	cp "$SOURCE" "$LIST"
	;;
esac
COUNT="$(wc -l <"$LIST" | tr -d ' ')"
[ "$COUNT" -gt 0 ] || die "no texture files found"

# A scratch project: the script loads files by absolute path, so it needs no project of its own.
PROJECT="$WORK/project"
mkdir -p "$PROJECT" "$WORK/evidence"
cat >"$PROJECT/project.godot" <<'PROJ'
config_version=5

[application]
config/name="prepare-textures"

[rendering]
renderer/rendering_method="gl_compatibility"
PROJ

ENVV=(
	GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
	GRC_EVIDENCE_DIR="$WORK/evidence" GRC_RESOURCE_STORE_DIR="$WORK/store"
	GRC_TEXTURE_DECODE=engine GRC_TEXTURE_CACHE_DIR="$CACHE"
	RS_PREPARE_LIST="$LIST" RS_PREPARE_LOG="$WORK/prepare.jsonl"
)
if [ "$UASTC" = 1 ]; then
	ENVV+=(GRC_STREAM_VERSION=9 GRC_STREAM_OUT="$WORK/prepare.rs9" GRC_TEXTURE_DELIVERY=basis-uastc
		GRC_TEXTURE_ENCODE_DRAIN=1)
	[ -n "$ENCODE_WORKERS" ] && ENVV+=(GRC_TEXTURE_ENCODE_WORKERS="$ENCODE_WORKERS")
	[ -n "$UASTC_LEVEL" ] && ENVV+=(GRC_TEXTURE_UASTC_LEVEL="$UASTC_LEVEL")
else
	ENVV+=(GRC_STREAM_VERSION=8 GRC_STREAM_OUT="$WORK/prepare.rs8")
fi
[ -n "$MAX_BYTES" ] && ENVV+=(GRC_TEXTURE_CACHE_MAX_BYTES="$MAX_BYTES")
[ -n "$WORKERS" ] && ENVV+=(GRC_TEXTURE_WORKERS="$WORKERS")

# Strip every inherited GRC_*/RS_* and any display; pass only ENVV.
UNSET=()
while IFS= read -r name; do UNSET+=(-u "$name"); done < <(env | sed -n 's/^\(\(GRC\|RS\)_[A-Za-z0-9_]*\)=.*/\1/p')
echo "prepare-textures: $COUNT files, cache $CACHE"
env "${UNSET[@]}" -u DISPLAY -u WAYLAND_DISPLAY "${ENVV[@]}" \
	timeout "$TIMEOUT_S" "$BINARY" --headless --path "$PROJECT" --script "$HERE/prepare_textures.gd" \
	>"$WORK/stdout.log" 2>&1 &
CHILD_PID=$!
RC=0
wait "$CHILD_PID" || RC=$?
CHILD_PID=""

if [ -n "$OUT_KEEP" ]; then
	mkdir -p "$OUT_KEEP"
	cp -r "$WORK/evidence" "$OUT_KEEP/"
	cp "$WORK/stdout.log" "$WORK/prepare.jsonl" "$WORK/list.txt" "$OUT_KEEP/" 2>/dev/null || true
	echo "$RC" >"$OUT_KEEP/exit-code.txt"
fi
if [ "$RC" != 0 ]; then
	echo "prepare-textures: the run exited $RC" >&2
	tail -20 "$WORK/stdout.log" >&2
	exit "$RC"
fi
grep -h '^\[prepare\] done' "$WORK/stdout.log" | sed 's/^\[prepare\] /prepare-textures: /' || true
if command -v jq >/dev/null 2>&1 && [ -f "$WORK/evidence/result.json" ]; then
	jq -c '.texture_cache // empty' "$WORK/evidence/result.json" |
		sed 's/^/prepare-textures: cache /'
fi
if [ -f "$CACHE/index-v1.jsonl" ]; then
	echo "prepare-textures: index rows $(wc -l <"$CACHE/index-v1.jsonl" | tr -d ' ')"
fi
