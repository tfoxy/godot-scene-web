#!/usr/bin/env bash
# Extract the universal macOS release template from the pinned official archive.
set -euo pipefail

EXPECTED_MACOS_TEMPLATE_SHA256="3bdfef756b735361fb3000832faa68f6c7bc2ddd0a03d61e9d2981f63f14469a"
MACOS_TEMPLATE="${GRC_MACOS_TEMPLATE:-${HOME}/.cache/godot-render-stream/templates/4.5.1-stable/godot_macos_release.universal}"

verify() {
	[[ -f "$MACOS_TEMPLATE" ]] &&
		printf '%s  %s\n' "$EXPECTED_MACOS_TEMPLATE_SHA256" "$MACOS_TEMPLATE" | sha256sum -c --quiet -
}

if [[ -e "$MACOS_TEMPLATE" ]]; then
	verify
	printf 'macos template: %s sha256 %s (cached)\n' "$MACOS_TEMPLATE" "$EXPECTED_MACOS_TEMPLATE_SHA256"
	exit 0
fi

CACHE_DIR="$(dirname "$MACOS_TEMPLATE")"
mkdir -p "$CACHE_DIR"
TEMP="$(mktemp -d "$CACHE_DIR/.macos-template.XXXXXX")"
trap 'rm -rf "$TEMP"' EXIT
curl -fsSL --retry 3 -o "$TEMP/t.tpz" \
	https://github.com/godotengine/godot/releases/download/4.5.1-stable/Godot_v4.5.1-stable_export_templates.tpz
printf '%s  %s\n' 1998af37f1387684e2c211cdb483daf492fc64dc6b12096bddcdca25b6910c86 "$TEMP/t.tpz" |
	sha256sum -c --quiet -
unzip -q -j -o "$TEMP/t.tpz" '*/macos.zip' -d "$TEMP"
rm "$TEMP/t.tpz"
unzip -p "$TEMP/macos.zip" 'macos_template.app/Contents/MacOS/godot_macos_release.universal' >"$TEMP/godot_macos_release.universal"
rm "$TEMP/macos.zip"
printf '%s  %s\n' "$EXPECTED_MACOS_TEMPLATE_SHA256" "$TEMP/godot_macos_release.universal" | sha256sum -c --quiet -
chmod +x "$TEMP/godot_macos_release.universal"
mv "$TEMP/godot_macos_release.universal" "$MACOS_TEMPLATE"
verify
printf 'macos template: %s sha256 %s (downloaded)\n' "$MACOS_TEMPLATE" "$EXPECTED_MACOS_TEMPLATE_SHA256"
