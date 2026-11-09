#!/usr/bin/env bash
# Extract the Windows release template from the digest-pinned official archive.
set -euo pipefail

EXPECTED_WINDOWS_TEMPLATE_SHA256="78ccc576e8f8bffd7ef6ad6f36ebd72a41e609a1052225a55b3407c96ea84065"
WINDOWS_TEMPLATE="${GRC_WINDOWS_TEMPLATE:-${HOME}/.cache/godot-render-stream/templates/4.5.1-stable/windows_release_x86_64.exe}"

verify() {
	[[ -n "$EXPECTED_WINDOWS_TEMPLATE_SHA256" && -f "$WINDOWS_TEMPLATE" ]] &&
		printf '%s  %s\n' "$EXPECTED_WINDOWS_TEMPLATE_SHA256" "$WINDOWS_TEMPLATE" | sha256sum -c --quiet -
}

if verify 2>/dev/null; then
	printf 'windows template: %s sha256 %s (cached)\n' "$WINDOWS_TEMPLATE" "$EXPECTED_WINDOWS_TEMPLATE_SHA256"
	exit 0
fi

TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
curl -fsSL --retry 3 -o "$TEMP/t.tpz" \
	https://github.com/godotengine/godot/releases/download/4.5.1-stable/Godot_v4.5.1-stable_export_templates.tpz
printf '%s  %s\n' 1998af37f1387684e2c211cdb483daf492fc64dc6b12096bddcdca25b6910c86 "$TEMP/t.tpz" |
	sha256sum -c --quiet -
unzip -q -j -o "$TEMP/t.tpz" '*/windows_release_x86_64.exe' -d "$TEMP"
rm "$TEMP/t.tpz"
MEASURED_SHA256="$(sha256sum "$TEMP/windows_release_x86_64.exe" | cut -d ' ' -f 1)"
if [[ -n "$EXPECTED_WINDOWS_TEMPLATE_SHA256" && "$MEASURED_SHA256" != "$EXPECTED_WINDOWS_TEMPLATE_SHA256" ]]; then
	printf 'windows template sha256 mismatch: measured %s expected %s\n' "$MEASURED_SHA256" "$EXPECTED_WINDOWS_TEMPLATE_SHA256" >&2
	exit 1
fi
mkdir -p "$(dirname "$WINDOWS_TEMPLATE")"
mv "$TEMP/windows_release_x86_64.exe" "$WINDOWS_TEMPLATE"
if [[ -z "$EXPECTED_WINDOWS_TEMPLATE_SHA256" ]]; then
	printf 'measured sha256 %s; set EXPECTED_WINDOWS_TEMPLATE_SHA256\n' "$MEASURED_SHA256"
	exit 1
fi
verify
printf 'windows template: %s sha256 %s (downloaded)\n' "$WINDOWS_TEMPLATE" "$EXPECTED_WINDOWS_TEMPLATE_SHA256"
