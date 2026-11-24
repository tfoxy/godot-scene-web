#!/usr/bin/env bash
# Install the non-mono Android templates from the pinned official Godot archive.
set -euo pipefail
[[ $# = 0 ]] || { echo "usage: $0" >&2; exit 2; }
DEST="${GRC_ANDROID_TEMPLATES:-${HOME}/.local/share/godot/export_templates/4.5.1.stable}"
FILES=(android_debug.apk android_release.apk android_source.zip)
verify() {
  (cd "$DEST" && sha256sum -c --quiet - <<'SHA'
a94aa329eda7ef265ec5504324f45b2c4a97acf5b5786e32879f6ac3ad8d3e3b  android_debug.apk
5c65ea869de294d14738371089b38d2ccf6a101e904e79a1df9f9db37b237711  android_release.apk
1ca4af13143abc7ee9cf56e2790e51213ed8a3905d1cffcb7babe1a2537c338f  android_source.zip
SHA
  )
}
if verify 2>/dev/null; then
  printf 'android templates: %s (cached)\n' "$DEST"
  exit 0
fi
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
curl -fsSL --retry 3 -o "$TEMP/t.tpz" \
  https://github.com/godotengine/godot/releases/download/4.5.1-stable/Godot_v4.5.1-stable_export_templates.tpz
printf '%s  %s\n' 1998af37f1387684e2c211cdb483daf492fc64dc6b12096bddcdca25b6910c86 "$TEMP/t.tpz" |
  sha256sum -c --quiet -
for name in "${FILES[@]}"; do
  unzip -q -j "$TEMP/t.tpz" "templates/$name" -d "$TEMP"
done
mkdir -p "$DEST"
for name in "${FILES[@]}"; do mv "$TEMP/$name" "$DEST/$name"; done
verify
printf 'android templates: %s (downloaded, official archive sha256 verified)\n' "$DEST"
(cd "$DEST" && sha256sum "${FILES[@]}")
