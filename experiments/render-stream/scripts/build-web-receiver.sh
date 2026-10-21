#!/usr/bin/env bash
# Builds the web-export receiver (gate7-design.md D5, Q4 "Bundle provenance", G7e).
#
#   bash build-web-receiver.sh [--out DIR] [--force] [--core rust]
#
# Exports experiments/render-stream/receiver/ with the NON-mono Godot 4.5.1 editor (D5: `mise exec
# -- godot` is the mono build, which has no web templates) and the pinned official
# web_dlink_nothreads_release.zip, through receiver/export_presets.cfg and receiver/web/shell.html.
# Both binaries are checked against their recorded sha256 first; a mismatch refuses the build.
#
# The source is the receiver's working-tree files that git does not ignore (so .godot/, *.uid
# and *.import never enter it), copied into <dir>/project/, where the preset's
# @RS_WEB_DLINK_TEMPLATE@ placeholder becomes the template's absolute path. <dir> defaults to
# artifacts/render-stream/web-receiver/<sha>/, <sha> being the first 16 hex digits of the sha256
# over the source files' paths and digests, the editor's and the template's digests; an existing
# complete build there is reused unless --force. The bundle is <dir>/bundle/ (receiver.html,
# .js, .wasm, .pck, the audio worklets) and <dir>/bundle/build.json records the editor, template,
# preset and source digests, every bundle file's size and sha256, and the .pck's file list (which
# no-source-scene checks). The last line printed is the bundle directory.
#
# The one preset, `Web (rust core)` (G7xw, Q14e), has GDExtension support: receiver/ext/ is staged
# without its .gdignore and with the side module scripts/build-rs-core-web.sh builds (run first;
# cargo and emcc are incremental) at ext/build/web/librs_core_ext.wasm, which the export copies
# beside the engine and the engine's loader preloads. The side module's sha256 joins the source
# digest and its build.json is copied into the bundle as rs-core-web-build.json. --core accepts
# only `rust` (G7gd removed the GDScript core and its `Web` preset, G7e's/G7b's build; G7b's
# preserved shots stay the web export's byte oracle).

set -euo pipefail

# Measurement isolation: the build holds the machine-wide quiet lock SHARED (lib/quiet.sh), so it
# pauses while a timing leg runs (and inside a runner's hold it nests as a no-op).
if [ -z "${RS_QUIET_BUILD_WRAPPED:-}" ]; then
	RS_QUIET_BUILD_WRAPPED=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh" shared \
		--label "$(basename "${BASH_SOURCE[0]}")" -- bash "${BASH_SOURCE[0]}" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"

EDITOR="$HOME/.local/share/mise/installs/godot/4.5.1-stable/Godot_v4.5.1-stable_linux.x86_64"
EXPECTED_EDITOR_SHA256="db07cae7de644278a1884d4552bdf2bca3f5d30131b18faf3a0c4d730080b199"
TEMPLATE="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/web_dlink_nothreads_release.zip"
EXPECTED_TEMPLATE_SHA256="68162ae9249ca3b7ce53dde8cdfab59463bd6518dca9123df41e5cc8fb1bd454"
SIDE_MODULE="$RECEIVER_DIR/ext/build/web/librs_core_ext.wasm"
EXPORT_TIMEOUT_S=300

OUT=""
FORCE=0
CORE=rust
while [ $# -gt 0 ]; do
	case "$1" in
	--out)
		OUT="${2:-}"
		shift 2
		;;
	--force)
		FORCE=1
		shift
		;;
	--core)
		CORE="${2:-}"
		shift 2
		;;
	--)
		shift
		;;
	-h | --help)
		sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		echo "build-web-receiver: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

if [ "$CORE" != rust ]; then
	echo "build-web-receiver: --core is rust, not '$CORE' (G7gd removed the GDScript core)" >&2
	exit 2
fi
PRESET="Web (rust core)"
PRESET_INDEX=0
echo "build-web-receiver: side module (build-rs-core-web.sh)" >&2
mkdir -p "$RECEIVER_DIR/ext/build"
if ! bash "$SCRIPT_DIR/build-rs-core-web.sh" >"$RECEIVER_DIR/ext/build/build-rs-core-web.log" 2>&1; then
	echo "build-web-receiver: build-rs-core-web.sh failed, see $RECEIVER_DIR/ext/build/build-rs-core-web.log" >&2
	exit 1
fi

for pair in "editor:$EDITOR:$EXPECTED_EDITOR_SHA256" "template:$TEMPLATE:$EXPECTED_TEMPLATE_SHA256"; do
	IFS=: read -r what path expected <<<"$pair"
	if [ ! -f "$path" ]; then
		echo "build-web-receiver: the $what is missing: $path (gate7-design.md D5)" >&2
		exit 1
	fi
	actual="$(sha256sum "$path" | awk '{print $1}')"
	if [ "$actual" != "$expected" ]; then
		echo "build-web-receiver: the $what $path has sha256 $actual, expected $expected; refusing" >&2
		exit 1
	fi
done

cd "$RECEIVER_DIR"
mapfile -t SOURCES < <(git ls-files --cached --others --exclude-standard -- . | LC_ALL=C sort)
if [ "${#SOURCES[@]}" -eq 0 ]; then
	echo "build-web-receiver: no source files under $RECEIVER_DIR" >&2
	exit 1
fi
SOURCE_MANIFEST="$(for f in "${SOURCES[@]}"; do printf '%s  %s\n' "$(sha256sum "$f" | awk '{print $1}')" "$f"; done)"
SIDE_MODULE_SHA256="$(sha256sum "$SIDE_MODULE" | awk '{print $1}')"
SOURCE_MANIFEST="$(printf '%s\n%s  %s\n' "$SOURCE_MANIFEST" "$SIDE_MODULE_SHA256" "ext/build/web/librs_core_ext.wasm")"
SOURCE_SHA256="$(printf '%s\neditor %s\ntemplate %s\n' "$SOURCE_MANIFEST" "$EXPECTED_EDITOR_SHA256" "$EXPECTED_TEMPLATE_SHA256" | sha256sum | awk '{print $1}')"
cd "$REPO_ROOT"

if [ -z "$OUT" ]; then
	OUT="$REPO_ROOT/artifacts/render-stream/web-receiver/${SOURCE_SHA256:0:16}"
fi
BUNDLE="$OUT/bundle"
if [ "$FORCE" = 0 ] && [ -f "$BUNDLE/build.json" ] && grep -q "\"source_sha256\": \"$SOURCE_SHA256\"" "$BUNDLE/build.json"; then
	echo "build-web-receiver: reusing $BUNDLE (source $SOURCE_SHA256)" >&2
	echo "$BUNDLE"
	exit 0
fi
rm -rf "$OUT"
mkdir -p "$OUT/project" "$BUNDLE"
OUT="$(realpath "$OUT")"
BUNDLE="$OUT/bundle"
printf '%s\n' "$SOURCE_MANIFEST" >"$OUT/source-manifest.txt"
for f in "${SOURCES[@]}"; do
	mkdir -p "$OUT/project/$(dirname "$f")"
	cp "$RECEIVER_DIR/$f" "$OUT/project/$f"
done
sed -i -e "s|@RS_WEB_DLINK_TEMPLATE@|$TEMPLATE|" "$OUT/project/export_presets.cfg"
# The editor must list rs_core.gdextension (extension_list.cfg) for the export plugin to copy its
# web.wasm32 library: stage ext/ without the .gdignore that keeps it out natively.
rm -f "$OUT/project/ext/.gdignore"
mkdir -p "$OUT/project/ext/build/web"
cp "$SIDE_MODULE" "$OUT/project/ext/build/web/librs_core_ext.wasm"
cp "$(dirname "$SIDE_MODULE")/build.json" "$OUT/rs-core-web-build.json"

run_editor() {
	local log="$1"
	shift
	set +e
	env -u DISPLAY -u WAYLAND_DISPLAY timeout "$EXPORT_TIMEOUT_S" "$EDITOR" --headless --path "$OUT/project" "$@" >"$log" 2>&1
	local code=$?
	set -e
	return "$code"
}

echo "build-web-receiver: import" >&2
start_ms="$(date +%s%3N)"
if ! run_editor "$OUT/import.log" --import; then
	echo "build-web-receiver: import failed, see $OUT/import.log" >&2
	exit 1
fi
echo "build-web-receiver: export" >&2
if ! run_editor "$OUT/export.log" --export-release "$PRESET" "$BUNDLE/receiver.html"; then
	echo "build-web-receiver: export failed, see $OUT/export.log" >&2
	exit 1
fi
end_ms="$(date +%s%3N)"
if [ ! -f "$BUNDLE/receiver.pck" ] || [ ! -f "$BUNDLE/receiver.wasm" ]; then
	echo "build-web-receiver: the export wrote no receiver.pck/.wasm, see $OUT/export.log" >&2
	exit 1
fi
if ! cmp -s "$SIDE_MODULE" "$BUNDLE/librs_core_ext.wasm"; then
	echo "build-web-receiver: the export did not copy the side module, see $OUT/export.log" >&2
	exit 1
fi
cp "$OUT/rs-core-web-build.json" "$BUNDLE/rs-core-web-build.json"

GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
GIT_DIRTY="$(git -C "$REPO_ROOT" status --porcelain -- "$EXPERIMENT_DIR/receiver" | wc -l)"
mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/web-build-json.ts" \
	--bundle "$BUNDLE" --project "$OUT/project" --source-sha256 "$SOURCE_SHA256" \
	--editor "$EDITOR" --editor-sha256 "$EXPECTED_EDITOR_SHA256" \
	--template "$TEMPLATE" --template-sha256 "$EXPECTED_TEMPLATE_SHA256" \
	--core "$CORE" --preset-index "$PRESET_INDEX" \
	--git-commit "$GIT_COMMIT" --git-dirty-files "$GIT_DIRTY" --build-ms "$((end_ms - start_ms))" >&2
echo "build-web-receiver: built $BUNDLE in $((end_ms - start_ms)) ms" >&2
echo "$BUNDLE"
