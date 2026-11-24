#!/usr/bin/env bash
# Build the non-mono Android shell and a native-code-free downloadable script pack.
set -euo pipefail
ulimit -c 0
if [ -z "${RS_QUIET_BUILD_WRAPPED:-}" ]; then
  RS_QUIET_BUILD_WRAPPED=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh" shared \
    --label "$(basename "${BASH_SOURCE[0]}")" -- bash "${BASH_SOURCE[0]}" "$@"
fi
[[ $# = 0 ]] || { echo "usage: $0" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RS="$(cd "$HERE/.." && pwd)"
SHELL_SRC="$RS/android-shell"
OUT="$SHELL_SRC/build"
EDITOR="$(mise where godot@4.5.1-stable)/Godot_v4.5.1-stable_linux.x86_64"
[[ "$("$EDITOR" --version)" = 4.5.1.stable.official.* ]] || { echo 'non-mono Godot 4.5.1 required' >&2; exit 1; }
bash "$HERE/fetch-android-template.sh"
bash "$HERE/build-rs-core-ext-android.sh"
[[ -f "$RS/receiver/ext/build/librs_core_ext.so" ]] || {
  echo 'build the Linux adapter first: experiments/render-stream/scripts/build-rs-core-ext.sh' >&2
  exit 1
}
mkdir -p "$OUT"
rm -f "$OUT/shell.apk" "$OUT/pack-import.log" "$OUT/pack-export.log" \
  "$OUT/shell-import.log" "$OUT/android-export.log"
# Recreate only staging trees, leaving evidence and already-served content-addressed packs intact.
python3 - "$RS" "$OUT" <<'PY'
from pathlib import Path
import hashlib, json, shutil, sys
rs, out = map(Path, sys.argv[1:])
source = rs / 'android-shell'
for tree in ['shell', 'pack']:
    if (out / tree).exists():
        shutil.rmtree(out / tree)
    (out / tree).mkdir()
for name in ['project.godot', 'shell.gd', 'shell.tscn', 'export_presets.cfg']:
    shutil.copy2(source / name, out / 'shell' / name)
shutil.copytree(source / 'pack-demo', out / 'pack', dirs_exist_ok=True,
                ignore=shutil.ignore_patterns('.godot', '*.uid', '*.import'))
receiver = out / 'pack/demo/receiver'
receiver.mkdir()
copies = {}
for path in sorted((rs / 'receiver').glob('*.gd')):
    shutil.copy2(path, receiver / path.name)
    copies[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
shutil.copy2(rs / 'protocol/golden-8/inline.rs8', out / 'pack/demo/recording.rs8')
ext = out / 'shell/ext'
(ext / 'build/android/arm64').mkdir(parents=True)
# The adapter is used at runtime, not inside the editor. An Android-only descriptor
# lets the standard exporter discover its native library without preloading the Linux
# adapter into the editor. Restore the full descriptor for the desktop leg below.
descriptor = (rs / 'receiver/ext/rs_core.gdextension').read_text()
(ext / 'rs_core.gdextension').write_text('\n'.join(
    line for line in descriptor.splitlines() if not line.startswith(('linux.', 'web.'))
) + '\n')
for name in ['librs_core_ext.so', 'android/arm64/librs_core_ext.so']:
    shutil.copy2(rs / 'receiver/ext/build' / name, ext / 'build' / name)
(out / 'receiver-sources.json').write_text(json.dumps(copies, indent=2) + '\n')
PY
run_editor() {
  local project="$1" log="$2"
  shift 2
  if ! env -u DISPLAY -u WAYLAND_DISPLAY timeout 300 "$EDITOR" --headless --path "$project" "$@" > "$OUT/$log" 2>&1; then
    tail -n 50 "$OUT/$log" >&2
    return 1
  fi
  if grep -E 'SCRIPT ERROR:|Parse Error:|Failed to load script' "$OUT/$log"; then return 1; fi
}
run_editor "$OUT/pack" pack-import.log --import
run_editor "$OUT/pack" pack-export.log --export-pack Pack "$OUT/demo.pck"
mkdir -p "$OUT/client-pack"
# The existing PCK directory reader also proves no native code sneaked into the pack.
mise exec -- node --conditions=development "$SHELL_SRC/inspect-pack.mjs" "$OUT/demo.pck" > "$OUT/pack-files.json"
sha="$(sha256sum "$OUT/demo.pck" | cut -d ' ' -f1)"
mv "$OUT/demo.pck" "$OUT/client-pack/$sha.pck"
python3 - "$OUT/client-pack/manifest.json" "$sha" <<'PY'
import json, sys
with open(sys.argv[1], 'w') as f:
    json.dump({'packVersion': 'demo-1', 'sha256': sys.argv[2], 'entry': 'res://demo/entry.tscn'}, f, indent=2)
    f.write('\n')
PY
run_editor "$OUT/shell" shell-import.log --import
run_editor "$OUT/shell" android-export.log --export-debug Android "$OUT/shell.apk"
unzip -Z1 "$OUT/shell.apk" > "$OUT/apk-files.txt"
grep -Fx 'lib/arm64-v8a/librs_core_ext.so' "$OUT/apk-files.txt"
if grep -E '^lib/(armeabi-v7a|x86|x86_64)/' "$OUT/apk-files.txt"; then
  echo 'APK includes an unexpected ABI' >&2; exit 1
fi
# Check actual packaged bytes, rather than just the filename.
unzip -p "$OUT/shell.apk" lib/arm64-v8a/librs_core_ext.so | cmp - "$RS/receiver/ext/build/android/arm64/librs_core_ext.so"
# The desktop editor binary runs the game with runtime loading from the pack, matching
# the receiver's normal .gdignore path. The Android APK has its own exported descriptor.
cp "$RS/receiver/ext/rs_core.gdextension" "$OUT/shell/ext/rs_core.gdextension"
rm -f "$OUT/shell/.godot/extension_list.cfg"
echo "android shell: $OUT/shell.apk"
echo "script pack: $OUT/client-pack/$sha.pck"
echo "manifest: $OUT/client-pack/manifest.json"
